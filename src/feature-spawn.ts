/**
 * Integração real do FeatureRunner: spawna um WORKER child por step via `pi --print`
 * (processo novo = contexto fresco), o analog code-initiated do spawnWorkerSession do
 * runner de referência. Separado do engine (puro) pra mantê-lo 100% testável com SpawnFn
 * injetado. Aqui vivem: o system prompt do worker (worker-base + a skill, inline,
 * como o readiness faz com o auditor), os args do `pi --print` (puros) e o spawn real
 * que lê o handoff (EndFeatureRun) pra reportar success ao runner.
 */
import { spawn as cpSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureStep, SpawnCtx, SpawnFn, SpawnOutcome } from "./feature-runner.ts";
import { handoffOutcome } from "./handoff.ts";
import { buildWorkerBootstrap } from "./worker-bootstrap.ts";

export function resolvePiBin(): string {
	return process.env.PI_BIN || "pi";
}

/** Tasks editam código + chamam EndFeatureRun; ship-gates também spawnam reviewers (subagent). */
const TOOLS_TASK = "read,grep,find,ls,bash,edit,write,EndFeatureRun";
const TOOLS_GATE = "read,grep,find,ls,bash,edit,write,subagent,EndFeatureRun";

function harnessSkillsDir(): string {
	return fileURLToPath(new URL("../skills", import.meta.url));
}

function readSkill(absDir: string): string {
	try {
		return fs.readFileSync(path.join(absDir, "SKILL.md"), "utf8");
	} catch {
		return "";
	}
}

/**
 * System prompt do worker child: as skills relevantes inline (como o readiness inlina
 * o auditor) + o bootstrap + uma nota de runtime. Tasks recebem worker-base + a skill
 * do profile (.harness/profile/skills/<name>); ship-gates recebem a skill do validator
 * (skills/<code-review|qa-validator> deste pacote).
 */
export function buildWorkerSystemPrompt(step: FeatureStep, cwd: string, opts: { featureId: string; workerSessionId: string }): string {
	const parts: string[] = [];
	if (step.kind === "task") {
		const base = readSkill(path.join(harnessSkillsDir(), "worker-base"));
		const profileSkill = readSkill(path.join(cwd, ".harness", "profile", "skills", step.skillName));
		if (base) parts.push("# worker-base\n", base);
		if (profileSkill) parts.push(`\n# ${step.skillName}\n`, profileSkill);
	} else {
		const validator = readSkill(path.join(harnessSkillsDir(), step.skillName));
		if (validator) parts.push(`# ${step.skillName}\n`, validator);
	}
	parts.push("\n", buildWorkerBootstrap(step, opts));
	parts.push(
		`\n[runtime] Feature run dir: .harness/runs/${opts.featureId}/ · Profile: .harness/profile/`,
		`ALWAYS finish by calling EndFeatureRun with featureId="${opts.featureId}", taskId="${step.id}", workerSessionId="${opts.workerSessionId}".`,
	);
	return parts.join("\n");
}

/** Args do `pi --print` por step (puro — testável). `model` opcional (herda o do parent). */
export function piArgs(step: FeatureStep, systemPromptPath: string, model?: string): string[] {
	const tools = step.kind === "task" ? TOOLS_TASK : TOOLS_GATE;
	const task =
		step.kind === "task"
			? "Execute your assigned task per the appended instructions (worker-base, then your skill); call EndFeatureRun when done, then end your turn."
			: "Run the ship-gate validator per the appended instructions; call EndFeatureRun (returnToOrchestrator: true) when done, then end your turn.";
	const args = ["--print", "--mode", "json", "--no-session"];
	if (model) args.push("--model", model);
	args.push("--tools", tools, "--append-system-prompt", systemPromptPath, task);
	return args;
}

function writePromptFile(prompt: string): { file: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-feature-"));
	const file = path.join(dir, "system.md");
	fs.writeFileSync(file, prompt, { mode: 0o600 });
	return { file, dir };
}

export interface RealSpawnOpts {
	featureId: string;
	bin?: string;
	model?: string;
	onEvent?: (step: FeatureStep, evt: { type?: string; toolName?: string }) => void;
	spawnImpl?: typeof cpSpawn;
	/** gerador de worker session id (injetável p/ teste). */
	genSessionId?: () => string;
}

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
					// ruído não-JSON
				}
			}
			nl = buf.indexOf("\n");
		}
	};
}

/**
 * SpawnFn de produção pro FeatureRunner: spawna `pi --print` pro step no cwd do repo,
 * herdando env (model/auth). Depois do child fechar, LÊ o handoff (EndFeatureRun) pra
 * reportar success/returnToOrchestrator — o exit code sozinho não basta (espelha o
 * auditSucceeded do readiness).
 */
export function makeRealSpawn(opts: RealSpawnOpts): SpawnFn {
	const bin = opts.bin ?? resolvePiBin();
	const spawnImpl = opts.spawnImpl ?? cpSpawn;
	const genId = opts.genSessionId ?? (() => `ws_${randomUUID().slice(0, 8)}`);
	return (step: FeatureStep, ctx: SpawnCtx): Promise<SpawnOutcome> => {
		const workerSessionId = genId();
		const sys = buildWorkerSystemPrompt(step, ctx.cwd, { featureId: opts.featureId, workerSessionId });
		const { file, dir } = writePromptFile(sys);
		const args = piArgs(step, file, opts.model);
		return new Promise<SpawnOutcome>((resolve) => {
			const child = spawnImpl(bin, args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
			let settled = false;
			const done = (out: SpawnOutcome) => {
				if (settled) return;
				settled = true;
				try {
					fs.rmSync(dir, { recursive: true, force: true });
				} catch {
					// best-effort
				}
				if (onAbort) ctx.signal?.removeEventListener?.("abort", onAbort);
				resolve(out);
			};
			const onAbort = ctx.signal
				? () => {
						try {
							child.kill("SIGTERM");
						} catch {
							// ignore
						}
						done({ code: null, aborted: true });
					}
				: undefined;
			if (ctx.signal && onAbort) {
				if (ctx.signal.aborted) onAbort();
				else ctx.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (opts.onEvent && child.stdout) {
				const feed = makeLineParser((o) => opts.onEvent?.(step, o as { type?: string }));
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => feed(chunk));
			}
			// Sucesso/returnToOrchestrator vêm do handoff que o child escreveu via EndFeatureRun.
			const finish = (code: number | null) => {
				const out = handoffOutcome(ctx.cwd, opts.featureId, step.id);
				done({ code, success: out.success, returnToOrchestrator: out.returnToOrchestrator });
			};
			child.on("error", () => finish(1));
			child.on("close", (code) => finish(code));
		});
	};
}
