/**
 * Integração real do ReadinessRunner: spawna uma SESSÃO ISOLADA por passo via
 * `pi --print` (processo novo = contexto fresco), o analog code-initiated das
 * sessões dedicadas readiness-evaluation / readiness-remediation do referência.
 *
 * Separado do runner (motor puro) pra manter o engine 100% testável com SpawnFn
 * injetado. Aqui vivem: resolução do binário, prompts de sistema (audit/fix),
 * construção dos args do `pi --print` (puros, testáveis), e o spawn real.
 */
import { spawn as cpSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isUsageLimitEvent, workerInactivityMs } from "./feature-spawn.ts";
import type { RunStep, SpawnCtx, SpawnFn, SpawnOutcome } from "./readiness-runner.ts";

/** Binário do pi (PI_BIN override, senão `pi` no PATH). */
export function resolvePiBin(): string {
	return process.env.PI_BIN || "pi";
}

const TOOLS_AUDIT = "read,grep,find,ls,bash,store_agent_readiness_report";
const TOOLS_FIX = "read,grep,find,ls,bash,edit,write,exec,wait";

function skillDir(): string {
	return fileURLToPath(new URL("../skills/harness-readiness-audit", import.meta.url));
}

/**
 * System prompt do auditor pro child: o corpo VERBATIM do SKILL.md + o caminho
 * absoluto do criteria.json (o child roda no cwd do repo-alvo, não daqui).
 */
export function auditSystemPrompt(): string {
	const dir = skillDir();
	let body = "";
	try {
		body = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
	} catch {
		body = "Audit this repository against the Agent Readiness Model (82 criteria) and finish by calling store_agent_readiness_report.";
	}
	const criteriaPath = path.join(dir, "criteria.json");
	return `${body}\n\n[runtime] The 82-criterion catalog (with instructions) is at: ${criteriaPath}\nRead that file. ALWAYS finish by calling the store_agent_readiness_report tool.`;
}

/** Args do `pi --print` por tipo de passo (puro — testável). `model` opcional
 * (o child usa o mesmo modelo do parent; se omitido, herda o default do pi). */
export function piArgs(kind: RunStep["kind"], systemPromptPath: string, model?: string): string[] {
	const tools = kind === "audit" ? TOOLS_AUDIT : TOOLS_FIX;
	const task =
		kind === "audit"
			? "Audit this repository against the Agent Readiness Model following the appended auditor instructions; finish by calling store_agent_readiness_report. Do not modify the repository otherwise."
			: "Fix the failing readiness signal described in the appended instructions with a genuine, substantive improvement.";
	// --mode json: stream de eventos JSONL no stdout (pro progresso ao vivo).
	const args = ["--print", "--mode", "json", "--no-session"];
	if (model) args.push("--model", model);
	args.push("--tools", tools, "--append-system-prompt", systemPromptPath, task);
	return args;
}

/** Escreve o prompt do passo num arquivo temporário e devolve o caminho. */
function writePromptFile(prompt: string): { file: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-readiness-"));
	const file = path.join(dir, "prompt.md");
	fs.writeFileSync(file, prompt, { mode: 0o600 });
	return { file, dir };
}

export interface RealSpawnOpts {
	bin?: string;
	/** modelo do child (mesmo do parent); se omitido, herda o default do pi. */
	model?: string;
	/** recebe cada evento JSONL do child (pro widget ao vivo). */
	onEvent?: (step: RunStep, evt: { type?: string; toolName?: string; args?: unknown }) => void;
	/** injeções pra teste do spawn real */
	spawnImpl?: typeof cpSpawn;
}

/** Quebra um stream em linhas e entrega cada JSON parseado ao callback (puro). */
export function makeLineParser(onJson: (obj: unknown) => void): (chunk: string) => void {
	let buf = "";
	return (chunk: string) => {
		buf += chunk;
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) {
				try {
					onJson(JSON.parse(line));
				} catch {
					// linha não-JSON (ruído) — ignora
				}
			}
			nl = buf.indexOf("\n");
		}
	};
}

/**
 * SpawnFn de produção: spawna `pi --print` pro passo, no cwd do repo-alvo,
 * herdando o env (model/auth). Resolve com o exit code; honra abort (mata o child).
 */
export function makeRealSpawn(opts: RealSpawnOpts = {}): SpawnFn {
	const bin = opts.bin ?? resolvePiBin();
	const spawnImpl = opts.spawnImpl ?? cpSpawn;
	return (step: RunStep, ctx: SpawnCtx): Promise<SpawnOutcome> => {
		const { file, dir } = writePromptFile(step.prompt);
		const args = piArgs(step.kind, file, opts.model);
		return new Promise<SpawnOutcome>((resolve) => {
			const child = spawnImpl(bin, args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
			let settled = false;
			let idle: ReturnType<typeof setTimeout> | null = null;
			const done = (out: SpawnOutcome) => {
				if (settled) return;
				settled = true;
				if (idle) clearTimeout(idle);
				try {
					fs.rmSync(dir, { recursive: true, force: true });
				} catch {
					// best-effort
				}
				if (onAbort) ctx.signal?.removeEventListener?.("abort", onAbort);
				resolve(out);
			};
			const kill = () => {
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
			};
			// Watchdog de inatividade (paridade com o rpc-worker): sem eventos por N ms → mata o child
			// e reporta inactivity — antes, um child pendurado bloqueava o runLoop PARA SEMPRE.
			const inMs = workerInactivityMs();
			const arm = () => {
				if (idle) clearTimeout(idle);
				if (inMs > 0) {
					idle = setTimeout(() => {
						kill();
						done({ code: null, inactivity: true });
					}, inMs);
					(idle as { unref?: () => void }).unref?.();
				}
			};
			const onAbort = ctx.signal
				? () => {
						kill();
						done({ code: null, aborted: true });
					}
				: undefined;
			if (ctx.signal && onAbort) {
				if (ctx.signal.aborted) onAbort();
				else ctx.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (child.stdout) {
				const feed = makeLineParser((obj) => {
					arm(); // cada evento reseta a inatividade
					if (isUsageLimitEvent(obj)) {
						kill();
						done({ code: null, usageLimit: true });
						return;
					}
					opts.onEvent?.(step, obj as { type?: string });
				});
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => feed(chunk));
			}
			arm();
			child.on("error", () => done({ code: 1 }));
			child.on("close", (code) => done({ code }));
		});
	};
}
