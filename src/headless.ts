/**
 * Caminho headless/CI (Fatia 3/5) — o elo converge→runner sem TUI. Encadeia:
 *   1. CONVERGE (model → plan.json): roda a harness-feature-converge em modo headless (sem usuário;
 *      gray-areas viram [assumido]) via uma ConvergeFn injetada (real: spawn `pi --print`;
 *      teste: fake que escreve plan.json).
 *   2. RUN (FeatureRunner determinístico): runLoop spawna 1 worker por task (sequencial),
 *      injeta o ship gate (harness-code-review → harness-qa-validator) e persiste o estado.
 *
 * Separado do engine puro pra ser 100% testável com ConvergeFn + SpawnFn injetados.
 * Idempotente: se plan.json já existe, pula o converge e só roda (resume).
 */
import { appendProgress } from "./handoff.ts";
import { type FeatureRun, type FeatureRunLoopDeps, type FeatureRunStatus, runLoop, type SpawnFn } from "./feature-runner.ts";
import { loadOrBuildFeatureRun, readPlan, writeFeatureRun } from "./plan.ts";

/** Heartbeat default do headless (doc 07: FTi=180000, 3 min) — beacon de vida em runs longos. */
const HEADLESS_HEARTBEAT_MS = 180000;

/** Produz plan.json a partir do request. Real: spawna `pi --print` rodando harness-feature-converge
 * (headless). Teste: escreve um plan.json fake. */
export type ConvergeFn = (cwd: string, request: string, featureId: string) => Promise<void>;

export interface HeadlessOpts {
	request: string;
	featureId: string;
	converge: ConvergeFn;
	spawn: SpawnFn;
	persist?: (run: FeatureRun) => void;
	log?: (ev: string, extra?: Record<string, unknown>) => void;
	signal?: AbortSignal;
	/** intervalo do heartbeat (default 3 min); 0 desliga. */
	heartbeatMs?: number;
}

export type HeadlessStage = "converge" | "run";

export interface HeadlessResult {
	ok: boolean;
	stage: HeadlessStage;
	status?: FeatureRunStatus;
	reason?: string;
	run?: FeatureRun;
}

/**
 * Executa a feature de ponta a ponta sem TUI: converge (se não houver plan.json) → runner.
 * `ok` só quando o run termina `completed` (todas as tasks + o ship gate verdes). Pausa do
 * runner (budget/abort/orchestrator_turn) → `ok:false` com o `reason` (pauseReason).
 */
export async function runHeadlessFeature(cwd: string, opts: HeadlessOpts): Promise<HeadlessResult> {
	const log = opts.log ?? ((ev, extra) => appendProgress(cwd, opts.featureId, ev, extra ?? {}));

	// 1. Converge (a menos que já exista plan.json — resume).
	if (!readPlan(cwd, opts.featureId)) {
		log("headless_converge_start", { featureId: opts.featureId });
		await opts.converge(cwd, opts.request, opts.featureId);
		log("headless_converge_done", { featureId: opts.featureId, planned: !!readPlan(cwd, opts.featureId) });
	}

	// 2. Run determinístico (FeatureRunner): CONTINUA o run persistido (resume graceful×hard) ou
	// constrói fresh do plano; workers sequenciais → ship gate.
	const rp = loadOrBuildFeatureRun(cwd, opts.featureId);
	if (!rp) {
		return { ok: false, stage: "converge", reason: "converge produced no plan.json (the feature did not converge)" };
	}
	const { run, resume } = rp;
	log("headless_run_start", { featureId: opts.featureId, steps: run.steps.length, resume });
	const deps: FeatureRunLoopDeps = {
		spawn: opts.spawn,
		persist: opts.persist ?? ((r) => writeFeatureRun(cwd, r)),
		log,
	};
	const final = await runLoop(cwd, run, deps, opts.signal, { resume, heartbeatMs: opts.heartbeatMs ?? HEADLESS_HEARTBEAT_MS });
	return {
		ok: final.status === "completed",
		stage: "run",
		status: final.status,
		reason: final.pauseReason,
		run: final,
	};
}
