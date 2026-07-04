/**
 * RPC wire worker driver — dirige cada worker do FeatureRunner pelo WIRE RPC NATIVO do pi
 * (`pi --mode rpc` via o RpcClient oficial, pi 0.80.3+), substituindo o antigo spawn `pi --print`.
 * Mantém o MESMO contrato SpawnFn (→ SpawnOutcome) que o runner já consome.
 *
 * Fluxo de um turno de worker:
 *   1. `RpcClient.start()` spawna `pi --mode rpc` no cwd do repo (session-backed: --session-id/-dir);
 *   2. `client.prompt(rpcWorkerPrompt(step, resume))` dispara o turno (a skill inline no system prompt
 *      faz harness-worker-base → skill → EndFeatureRun);
 *   3. observa os AgentEvents (`onEvent`): watchdog de inatividade event-based, 402/usage-limit
 *      (isUsageLimitEvent), abort (signal) e o `agent_end` (fim do turno);
 *   4. ao fim, lê o handoff que o EndFeatureRun persistiu em disco → success/returnToOrchestrator.
 *
 * O RpcClient é carregado por dynamic import LAZY e GUARDED (igual session-read.ts): nunca um
 * import estático que quebre o load; `clientFactory` é injetável → o driver é 100% testável sem o
 * pacote pi. A CONVERGE headless continua via `pi --print` (feature-spawn.ts: makeRealConvergeFn).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureStep, SpawnCtx, SpawnFn, SpawnOutcome } from "./feature-runner.ts";
import { buildWorkerSystemPrompt, isUsageLimitEvent, rpcWorkerArgs, rpcWorkerPrompt, workerInactivityMs, writePromptFile } from "./feature-spawn.ts";
import { handoffOutcome } from "./handoff.ts";
import { type HarnessModelConfig, resolveChoice, roleForStep } from "./model-config.ts";

/** O subconjunto do RpcClient que o driver usa — permite injetar um fake nos testes. */
export interface RpcWorkerClient {
	start(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
}
export interface RpcClientConfig {
	cwd: string;
	env?: Record<string, string | undefined>;
	args: string[];
}
export type RpcClientFactory = (cfg: RpcClientConfig) => Promise<RpcWorkerClient>;

export interface RpcSpawnOpts {
	featureId: string;
	/** Modelo herdado do parent (fallback quando o role não fixa um). */
	model?: string;
	/** Overrides de modelo+effort por role (worker/validator); ver model-config.ts. */
	config?: HarnessModelConfig;
	/** gerador de worker session id (fallback quando o ctx não traz um). */
	genSessionId?: () => string;
	/** timeout de inatividade do worker (ms); default workerInactivityMs(). 0 = desliga. */
	inactivityMs?: number;
	/** factory do client RPC (injetável p/ teste); default = o RpcClient oficial (lazy/guarded). */
	clientFactory?: RpcClientFactory;
	/** hook de observação dos AgentEvents (opcional). */
	onEvent?: (step: FeatureStep, event: unknown) => void;
	/** hook do client VIVO (→ run-registry pro steer, análogo do addUserMessage); null = terminou. */
	onClient?: (client: RpcWorkerClient | null, step: FeatureStep) => void;
}

// ── Carga lazy/guarded do RpcClient oficial ──────────────────────────────────
type ClientCtor = new (o: unknown) => RpcWorkerClient;
let ctor: ClientCtor | null | undefined; // undefined=não tentou; null=indisponível
let cliPath: string | undefined;

async function ensureRpcClient(): Promise<ClientCtor | null> {
	if (ctor !== undefined) return ctor;
	try {
		const m = (await import("@earendil-works/pi-coding-agent")) as { RpcClient?: ClientCtor };
		ctor = m.RpcClient ?? null;
		try {
			// cliPath = <pkg>/dist/cli.js (irmão do index.js resolvido) — RpcClient spawna `node <cliPath>`.
			const resolve = (import.meta as unknown as { resolve?: (s: string) => string }).resolve;
			const url = resolve?.("@earendil-works/pi-coding-agent");
			if (url) cliPath = fileURLToPath(new URL("cli.js", url));
		} catch {
			// sem cliPath → tenta o fallback abaixo
		}
		if (!cliPath || !fs.existsSync(cliPath)) cliPath = cliPathFromArgv(process.argv);
	} catch {
		ctor = null; // pacote pi indisponível neste contexto
	}
	return ctor;
}

/**
 * Fallback de cliPath: o entry script do PRÓPRIO pi em execução (process.argv[1], realpath p/
 * resolver o symlink do bin). Cobre o caso extension-source-load, onde import.meta.resolve não
 * enxerga o pacote (a extensão vive fora da node_modules do pi) e o default RELATIVO do RpcClient
 * ("dist/cli.js", cwd do repo) spawnaria um child morto — o worker silenciosamente devolvia code 0
 * sem handoff. Exportado p/ teste.
 */
export function cliPathFromArgv(argv: readonly string[]): string | undefined {
	const entry = argv?.[1];
	if (!entry) return undefined;
	try {
		const real = fs.realpathSync(entry);
		return /\bcli\.js$/.test(real) && fs.existsSync(real) ? real : undefined;
	} catch {
		return undefined;
	}
}

const defaultClientFactory: RpcClientFactory = async (cfg) => {
	const C = await ensureRpcClient();
	if (!C) throw new Error("pi RpcClient unavailable (@earendil-works/pi-coding-agent)");
	return new C({ cliPath, cwd: cfg.cwd, env: cfg.env, args: cfg.args });
};

function rm(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

/**
 * SpawnFn de produção: dirige um worker por step via `pi --mode rpc` (RpcClient). Sucesso/
 * returnToOrchestrator vêm do handoff (EndFeatureRun) — o turno terminar (`agent_end`) não basta.
 * usage_limit/inactivity/aborted mapeiam aos mesmos SpawnOutcome que o antigo spawn produzia.
 */
export function makeRpcSpawn(opts: RpcSpawnOpts): SpawnFn {
	const factory = opts.clientFactory ?? defaultClientFactory;
	const genId = opts.genSessionId ?? (() => `ws_${randomUUID().slice(0, 8)}`);
	const inMs = opts.inactivityMs ?? workerInactivityMs();
	return async (step: FeatureStep, ctx: SpawnCtx): Promise<SpawnOutcome> => {
		const workerSessionId = ctx.workerSessionId ?? genId();
		const sessionDir = path.join(ctx.cwd, ".harness", "runs", opts.featureId, "sessions");
		try {
			fs.mkdirSync(sessionDir, { recursive: true });
		} catch {
			// best-effort
		}
		const sys = buildWorkerSystemPrompt(step, ctx.cwd, { featureId: opts.featureId, workerSessionId });
		const { file, dir } = writePromptFile(sys);
		const args = rpcWorkerArgs(step, file, resolveChoice(opts.config, roleForStep(step), opts.model), { workerSessionId, sessionDir });

		let client: RpcWorkerClient;
		try {
			client = await factory({ cwd: ctx.cwd, env: process.env as Record<string, string | undefined>, args });
		} catch {
			rm(dir);
			return { code: 1 }; // RpcClient indisponível → failure (o runner re-tenta/escala)
		}

		let usageLimit = false;
		let aborted = false;
		let inactivity = false;
		let started = false;
		try {
			await client.start();
			started = true;
			opts.onClient?.(client, step);
			await new Promise<void>((resolve) => {
				let idle: ReturnType<typeof setTimeout> | null = null;
				let off: (() => void) | null = null;
				let onAbort: (() => void) | null = null;
				const finish = (): void => {
					if (idle) clearTimeout(idle);
					if (off) off();
					if (onAbort) ctx.signal?.removeEventListener?.("abort", onAbort);
					resolve();
				};
				const arm = (): void => {
					if (idle) clearTimeout(idle);
					if (inMs > 0) {
						idle = setTimeout(() => {
							inactivity = true;
							finish();
						}, inMs);
						(idle as { unref?: () => void }).unref?.();
					}
				};
				off = client.onEvent((ev) => {
					arm(); // watchdog event-based: cada evento reseta a inatividade
					opts.onEvent?.(step, ev);
					if (!usageLimit && isUsageLimitEvent(ev)) {
						usageLimit = true;
						finish();
						return;
					}
					if ((ev as { type?: string })?.type === "agent_end") finish();
				});
				onAbort = () => {
					aborted = true;
					finish();
				};
				if (ctx.signal) {
					if (ctx.signal.aborted) onAbort();
					else ctx.signal.addEventListener("abort", onAbort, { once: true });
				}
				arm();
				client.prompt(rpcWorkerPrompt(step, ctx.resume)).catch(() => finish());
			});
		} catch {
			// start/prompt falhou → trata como failure (o handoff abaixo virá vazio → success:false)
		} finally {
			if (started && (aborted || usageLimit || inactivity)) {
				try {
					await client.abort(); // pausa graceful: interrompe; o transcript --session-id fica p/ resume
				} catch {
					// ignore
				}
			}
			try {
				await client.stop();
			} catch {
				// ignore
			}
			opts.onClient?.(null, step);
			rm(dir);
		}

		if (aborted) return { code: null, aborted: true };
		if (usageLimit) return { code: null, usageLimit: true };
		if (inactivity) return { code: null, inactivity: true };
		// Sucesso/returnToOrchestrator vêm do handoff que o worker escreveu via EndFeatureRun.
		const out = handoffOutcome(ctx.cwd, opts.featureId, step.id, workerSessionId);
		return { code: 0, success: out.success, returnToOrchestrator: out.returnToOrchestrator };
	};
}
