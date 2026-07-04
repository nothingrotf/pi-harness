/**
 * ReadinessRunner — port 1:1 do modelo do runner de referência (modelo de referência,
 * docs/02-runtime-and-state-machine.md): um motor DETERMINÍSTICO (código, NÃO um
 * LLM) que roda um loop sequencial, spawna uma SESSÃO ISOLADA por passo
 * (code-initiated), monitora até o fim, e reage via uma state machine em disco.
 *
 * Mapeamento runner de referência → ReadinessRunner:
 *   features.json (fila)            → steps[] (1 audit, ou N fixes — um por critério)
 *   spawnWorker() spawna sessão     → spawn(step) spawna `pi --print` (readiness-spawn.ts)
 *   EndFeatureRun (handoff)         → exit code do child + (audit) snapshot válido
 *   _9H = 5 (attempt budget)        → STEP_ATTEMPT_BUDGET = 5
 *   pause (SIGINT / budget)         → status="paused" (aborted / step_retry_limit_exceeded)
 *   cleanupOrphanedWorker()         → cleanupOrphan() (in_progress → pending no start)
 *   state.json / progress_log.jsonl → readiness-run.json / readiness.jsonl
 *   sequencial, 1 worker por vez    → sequencial, 1 child por vez
 *
 * O loop é injetável (SpawnFn + persist + auditSucceeded) → 100% testável sem
 * subprocesso real (test/readiness-runner.test.ts). A integração real (spawn de
 * `pi --print`) vive em readiness-spawn.ts.
 */

/** Per-step attempt budget (referência: 5). */
export const STEP_ATTEMPT_BUDGET = 5;

export type RunStatus = "running" | "paused" | "completed";
export type StepStatus = "pending" | "in_progress" | "completed" | "failed";
export type StepKind = "audit" | "fix";

export interface RunStep {
	id: string;
	kind: StepKind;
	criterionId?: string; // para steps de fix
	prompt: string; // system prompt do child (audit ou fix por critério)
	status: StepStatus;
	attempts: number;
}

export interface ReadinessRun {
	runId: string;
	status: RunStatus;
	steps: RunStep[];
	createdAt: string;
	updatedAt: string;
	pauseReason?: string;
	/** budget extra por step concedido no resume após esgotamento (paridade com o FeatureRunner). */
	retryBudgetBonus?: Record<string, number>;
}

/** Resultado de spawnar um child. `aborted` = interrompido (SIGINT/abort). */
export interface SpawnOutcome {
	code: number | null;
	aborted?: boolean;
	/** 402/usage-limit detectado no stream do child → pausa resumível (não é falha do step). */
	usageLimit?: boolean;
	/** watchdog de inatividade matou o child → requeue (a tentativa já foi contada). */
	inactivity?: boolean;
}

export interface SpawnCtx {
	cwd: string;
	signal?: AbortSignal;
}

export type SpawnFn = (step: RunStep, ctx: SpawnCtx) => Promise<SpawnOutcome>;

export interface RunLoopDeps {
	/** Spawna a sessão isolada do passo e resolve quando ela termina. */
	spawn: SpawnFn;
	/** Checagem determinística de sucesso do audit (snapshot existe + válido). `sinceIso` = início do
	 * step: implementações DEVEM exigir snapshot mais novo que isso — um readiness.json PRÉ-EXISTENTE
	 * fazia um child que não gravou nada "passar". */
	auditSucceeded: (cwd: string, sinceIso?: string) => boolean;
	/** Persiste o record (state.json analog). */
	persist?: (run: ReadinessRun) => void;
	/** Trilha de eventos (progress_log.jsonl analog). */
	log?: (ev: string, extra?: Record<string, unknown>) => void;
	/** Re-render do progresso ao vivo (progresso ao vivo) a cada transição de estado. */
	onProgress?: (run: ReadinessRun) => void;
	now?: () => string;
	budget?: number;
}

let counter = 0;
function genRunId(now: () => string): string {
	counter = (counter + 1) % 1e6;
	return `rdy_${now().replace(/[^0-9]/g, "").slice(8, 17)}${counter}`;
}

function touch(run: ReadinessRun, deps: RunLoopDeps): void {
	run.updatedAt = (deps.now ?? defaultNow)();
	deps.persist?.(run);
	deps.onProgress?.(run);
}

const defaultNow = (): string => new Date().toISOString();

/** Próximo passo pendente (ordem do array — sequencial). */
export function nextPending(run: ReadinessRun): RunStep | undefined {
	return run.steps.find((s) => s.status === "pending");
}

/** Recuperação de crash: passos in_progress órfãos voltam a pending (cleanupOrphanedWorker). */
export function cleanupOrphan(run: ReadinessRun): void {
	for (const s of run.steps) if (s.status === "in_progress") s.status = "pending";
}

/** Plano de 1 passo de auditoria (estágio create). */
export function planAuditRun(auditPrompt: string, now: () => string = defaultNow): ReadinessRun {
	const ts = now();
	return {
		runId: genRunId(now),
		status: "running",
		steps: [{ id: "audit", kind: "audit", prompt: auditPrompt, status: "pending", attempts: 0 }],
		createdAt: ts,
		updatedAt: ts,
	};
}

/** Plano de N passos de fix (um por critério falhando, sequencial). */
export function planFixRun(items: { criterionId: string; prompt: string }[], now: () => string = defaultNow): ReadinessRun {
	const ts = now();
	return {
		runId: genRunId(now),
		status: "running",
		steps: items.map((it) => ({
			id: `fix-${it.criterionId}`,
			kind: "fix" as const,
			criterionId: it.criterionId,
			prompt: it.prompt,
			status: "pending" as const,
			attempts: 0,
		})),
		createdAt: ts,
		updatedAt: ts,
	};
}

/**
 * O loop determinístico (porte do runLoop/spawnWorker do runner de referência).
 * Sequencial; cada passo spawna um child; budget de tentativas; pausa em
 * abort/budget; orphan cleanup no início. Muta e persiste `run`.
 */
export async function runLoop(cwd: string, run: ReadinessRun, deps: RunLoopDeps, signal?: AbortSignal): Promise<ReadinessRun> {
	const budget = deps.budget ?? STEP_ATTEMPT_BUDGET;
	cleanupOrphan(run);
	// Resume após esgotamento: bônus DISCIPLINADO (compara com o budget efetivo, teto 2×base) —
	// sem isto o resume re-pausava imediatamente (attempts nunca resetam) e o run ficava encalhado.
	if (run.pauseReason === "step_retry_limit_exceeded") {
		run.retryBudgetBonus = run.retryBudgetBonus ?? {};
		for (const s of run.steps) {
			const bonus = run.retryBudgetBonus[s.id] ?? 0;
			if (s.attempts >= budget + bonus && bonus < budget * 2) run.retryBudgetBonus[s.id] = bonus + budget;
		}
	}
	run.status = "running";
	run.pauseReason = undefined; // limpa razão stale (paridade com o FeatureRunner)
	touch(run, deps);

	while (run.status === "running") {
		if (signal?.aborted) {
			run.status = "paused";
			run.pauseReason = "aborted";
			break;
		}
		const step = nextPending(run);
		if (!step) {
			run.status = "completed";
			break;
		}
		if (step.attempts >= budget + (run.retryBudgetBonus?.[step.id] ?? 0)) {
			run.status = "paused";
			run.pauseReason = "step_retry_limit_exceeded";
			deps.log?.("step_paused", { id: step.id, reason: "step_retry_limit_exceeded", attempts: step.attempts });
			break;
		}

		step.status = "in_progress";
		step.attempts++;
		const stepStartedAt = (deps.now ?? defaultNow)();
		touch(run, deps);
		deps.log?.("step_started", { id: step.id, kind: step.kind, attempt: step.attempts });

		let res: SpawnOutcome;
		try {
			res = await deps.spawn(step, { cwd, signal });
		} catch (e) {
			res = { code: 1 };
			deps.log?.("step_error", { id: step.id, error: (e as Error).message });
		}

		if (res.aborted) {
			step.status = "pending";
			// abort NÃO consome budget: 5 Ctrl+C não podem esgotar as tentativas silenciosamente.
			step.attempts = Math.max(0, step.attempts - 1);
			run.status = "paused";
			run.pauseReason = "aborted";
			deps.log?.("step_paused", { id: step.id, reason: "aborted" });
			touch(run, deps);
			break;
		}
		if (res.usageLimit) {
			step.status = "pending";
			step.attempts = Math.max(0, step.attempts - 1); // não é falha do step
			run.status = "paused";
			run.pauseReason = "usage_limit";
			deps.log?.("step_paused", { id: step.id, reason: "usage_limit" });
			touch(run, deps);
			break;
		}
		if (res.inactivity) {
			step.status = "pending"; // requeue — a tentativa foi contada; o budget guard pega runaway
			deps.log?.("step_failed", { id: step.id, kind: step.kind, reason: "inactivity_timeout" });
			touch(run, deps);
			continue;
		}

		const ok = res.code === 0 && (step.kind !== "audit" || deps.auditSucceeded(cwd, stepStartedAt));
		if (ok) {
			step.status = "completed";
			deps.log?.("step_completed", { id: step.id, kind: step.kind });
		} else {
			step.status = "pending"; // re-tenta até o budget (runner de referência: feature volta a pending)
			deps.log?.("step_failed", { id: step.id, kind: step.kind, code: res.code });
		}
		touch(run, deps);
	}

	touch(run, deps);
	return run;
}
