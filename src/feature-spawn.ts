/**
 * Builders PUROS da integração real do FeatureRunner. O WORKER é dirigido pelo WIRE RPC
 * (`pi --mode rpc` via o RpcClient oficial) em src/rpc-worker.ts; aqui ficam só as peças
 * PURAS e testáveis: o system prompt do worker (harness-worker-base + a skill inline), os
 * args de launch do `pi --mode rpc` (rpcWorkerArgs), a mensagem do prompt (rpcWorkerPrompt),
 * o detector de usage-limit (isUsageLimitEvent, sobre os AgentEvents do stream RPC) e o
 * timeout de inatividade. A CONVERGE headless continua via `pi --print` (makeRealConvergeFn)
 * — um one-shot que só autora artefatos + chama store_plan, sem transcript ao vivo a observar.
 */
import { spawn as cpSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConvergeDispatch } from "./converge-dispatch.ts";
import type { FeatureStep } from "./feature-runner.ts";
import type { ConvergeFn } from "./headless.ts";
import { type HarnessModelConfig, type ResolvedChoice, resolveChoice } from "./model-config.ts";
import { buildWorkerBootstrap } from "./worker-bootstrap.ts";

export function resolvePiBin(): string {
	return process.env.PI_BIN || "pi";
}

/** Tasks editam código + chamam EndFeatureRun; ship-gates também spawnam reviewers (subagent). */
const TOOLS_TASK = "read,grep,find,ls,bash,edit,write,EndFeatureRun";
const TOOLS_GATE = "read,grep,find,ls,bash,edit,write,subagent,EndFeatureRun";
/** Converge autora os artefatos + delega a contract a subagents + chama store_plan. */
const TOOLS_CONVERGE = "read,grep,find,ls,bash,edit,write,subagent,store_plan";

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
 * o auditor) + o bootstrap + uma nota de runtime. Tasks recebem harness-worker-base + a skill
 * do profile (.harness/profile/skills/<name>); ship-gates recebem a skill do validator
 * (skills/<harness-code-review|harness-qa-validator> deste pacote).
 */
export function buildWorkerSystemPrompt(step: FeatureStep, cwd: string, opts: { featureId: string; workerSessionId: string }): string {
	const parts: string[] = [];
	if (step.kind === "task") {
		const base = readSkill(path.join(harnessSkillsDir(), "harness-worker-base"));
		const profileSkill = readSkill(path.join(cwd, ".harness", "profile", "skills", step.skillName));
		if (base) parts.push("# harness-worker-base\n", base);
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

/**
 * Args de LAUNCH do `pi --mode rpc` por step (puro — testável). NÃO inclui `--mode rpc` (o
 * RpcClient adiciona) nem o prompt posicional (vai pelo comando `prompt`, ver rpcWorkerPrompt).
 * `choice` = modelo+effort resolvidos pro role do step; ambos opcionais (undefined → herda do parent).
 */
export function rpcWorkerArgs(step: FeatureStep, systemPromptPath: string, choice: ResolvedChoice = {}, opts: { workerSessionId?: string; sessionDir?: string } = {}): string[] {
	const tools = step.kind === "task" ? TOOLS_TASK : TOOLS_GATE;
	const args: string[] = [];
	if (opts.workerSessionId) {
		// Worker SESSION-BACKED: `--session-id` reusa a sessão se existir (transcript persistente) →
		// resume real ("continue where you left off") + o painel Active Worker lê o `.jsonl`.
		args.push("--session-id", opts.workerSessionId);
		if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
	}
	if (choice.model) args.push("--model", choice.model);
	if (choice.thinking) args.push("--thinking", choice.thinking);
	args.push("--tools", tools, "--append-system-prompt", systemPromptPath);
	return args;
}

/** A mensagem do comando `prompt` RPC do worker: task normal vs resume ("continue where you left off"). PURA. */
export function rpcWorkerPrompt(step: FeatureStep, resume = false): string {
	if (resume)
		return "You were interrupted mid-work. Continue EXACTLY where you left off: check the repo state (git status, modified files), review what you already implemented, and finish the task. Do NOT restart from scratch. Call EndFeatureRun when done, then end your turn.";
	return step.kind === "task"
		? "Execute your assigned task per the appended instructions (harness-worker-base, then your skill); call EndFeatureRun when done, then end your turn."
		: "Run the ship-gate validator per the appended instructions; call EndFeatureRun (returnToOrchestrator: true) when done, then end your turn.";
}

/**
 * Heurística pura (testável) p/ detectar um evento de usage-limit/402 no stream de AgentEvents do
 * `pi --mode rpc` (analog do unrecoverable_usage_402 do doc 07). Conservadora: só dispara em
 * eventos que parecem ERRO e mencionam billing/quota/402.
 */
export function isUsageLimitEvent(obj: unknown): boolean {
	if (!obj || typeof obj !== "object") return false;
	const o = obj as Record<string, unknown>;
	const type = typeof o.type === "string" ? o.type.toLowerCase() : "";
	const blob = JSON.stringify(o).toLowerCase();
	const billing = /\b402\b|payment required|usage limit|quota|insufficient_quota|no active subscription|over.?(the.?)?limit|billing/.test(blob);
	if (!billing) return false;
	// exige aspecto de erro p/ não disparar em output normal de tool que cite "rate limit".
	return /error|failed|fatal/.test(type) || o.error != null || /"(error|fatal)"/.test(blob);
}

/** Escreve o system prompt num ficheiro temporário (lido pelo `--append-system-prompt`). Exportado p/ o rpc-worker. */
export function writePromptFile(prompt: string): { file: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-feature-"));
	const file = path.join(dir, "system.md");
	fs.writeFileSync(file, prompt, { mode: 0o600 });
	return { file, dir };
}

/** Inatividade default do worker (doc 07: sB_=600000, 10 min). Override por env. */
export function workerInactivityMs(): number {
	const raw = Number(process.env.HARNESS_WORKER_INACTIVITY_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 600000;
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

// ─────────────────────────────────────────────────────────────────────────────
// Converge child (o elo headless converge→runner — src/headless.ts)

/** System prompt do converge child: a skill harness-feature-converge inline + nota de runtime. */
export function buildConvergeSystemPrompt(featureId: string): string {
	const skill = readSkill(path.join(harnessSkillsDir(), "harness-feature-converge"));
	const parts: string[] = [];
	if (skill) parts.push("# harness-feature-converge\n", skill);
	parts.push(
		`\n[runtime] Run dir: .harness/runs/${featureId}/ · Profile: .harness/profile/ (read-only).`,
		"Author feature.md + contract.md (FROZEN) + decompose ordered tasks, then call store_plan. Headless: resolve gray areas as [assumido]; NEVER call ask_user_question.",
	);
	return parts.join("\n");
}

/** Args do `pi --print` pro converge headless (puro — testável). `choice` = role orchestrator. */
export function convergePiArgs(systemPromptPath: string, request: string, featureId: string, choice: ResolvedChoice = {}): string[] {
	const prompt = buildConvergeDispatch(request, featureId, {}, { headless: true });
	const args = ["--print", "--mode", "json", "--no-session"];
	if (choice.model) args.push("--model", choice.model);
	if (choice.thinking) args.push("--thinking", choice.thinking);
	args.push("--tools", TOOLS_CONVERGE, "--append-system-prompt", systemPromptPath, prompt);
	return args;
}

export interface RealConvergeOpts {
	bin?: string;
	/** Modelo herdado do parent (fallback do role orchestrator). */
	model?: string;
	/** Overrides de modelo+effort por role; o converge usa o role `orchestrator`. */
	config?: HarnessModelConfig;
	spawnImpl?: typeof cpSpawn;
	onEvent?: (evt: { type?: string; toolName?: string }) => void;
}

/**
 * ConvergeFn de produção: spawna `pi --print` rodando harness-feature-converge headless no cwd do
 * repo → autora os artefatos e chama store_plan (grava plan.json). Resolve quando o child
 * fecha; o sucesso (plan.json existe) é checado pelo runHeadlessFeature depois.
 */
export function makeRealConvergeFn(opts: RealConvergeOpts = {}): ConvergeFn {
	const bin = opts.bin ?? resolvePiBin();
	const spawnImpl = opts.spawnImpl ?? cpSpawn;
	return (cwd: string, request: string, featureId: string): Promise<void> =>
		new Promise<void>((resolve) => {
			const sys = buildConvergeSystemPrompt(featureId);
			const { file, dir } = writePromptFile(sys);
			const args = convergePiArgs(file, request, featureId, resolveChoice(opts.config, "orchestrator", opts.model));
			const child = spawnImpl(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
			const cleanup = () => {
				try {
					fs.rmSync(dir, { recursive: true, force: true });
				} catch {
					// best-effort
				}
			};
			if (opts.onEvent && child.stdout) {
				const feed = makeLineParser((o) => opts.onEvent?.(o as { type?: string }));
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (c: string) => feed(c));
			}
			child.on("error", () => {
				cleanup();
				resolve();
			});
			child.on("close", () => {
				cleanup();
				resolve();
			});
		});
}

