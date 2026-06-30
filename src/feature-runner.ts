/**
 * FeatureRunner — generaliza o motor do ReadinessRunner (= runner de referência 1:1, docs/02)
 * pro eixo de EXECUÇÃO DE FEATURE: roda as tasks do plan.json em sequência, cada uma num
 * worker (bootstrap = harness-worker-base + a skill da task + EndFeatureRun), e quando TODAS as
 * tasks completam INJETA o ship gate (harness-code-review → harness-qa-validator) UMA vez. Qualquer
 * failure/returnToOrchestrator → status "orchestrator_turn" (para; o orchestrator cria
 * fix tasks e resume). Budget de 5 tentativas por step; pause/resume; orphan cleanup.
 *
 * Mapeamento runner de referência → FeatureRunner:
 *   features.json (fila)                 → steps[] (tasks do plan.json)
 *   milestone completa → injeta          → todas as tasks completam → injeta ship gate
 *     scrutiny + user-testing               (harness-code-review + harness-qa-validator), 1x (gateInjected)
 *   _9H = 5                               → STEP_ATTEMPT_BUDGET = 5
 *   failure / returnToOrchestrator        → status "orchestrator_turn"
 *   cleanupOrphanedWorker()               → cleanupOrphan()
 *   state.json / progress_log.jsonl       → feature-run.json / progress_log.jsonl
 *   sequencial, 1 worker por vez          → sequencial, 1 child por vez
 *
 * O loop é injetável (spawn + succeeded + persist) → 100% testável sem subprocesso
 * real (test/feature-runner.test.ts). A integração real de spawn vive à parte.
 */

/** Per-step attempt budget (referência: 5). */
export const STEP_ATTEMPT_BUDGET = 5;

export type FeatureRunStatus = "running" | "paused" | "orchestrator_turn" | "completed";
export type StepStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type StepKind = "task" | "ship-gate";

export interface FeatureStep {
	id: string;
	kind: StepKind;
	/** worker skill (task) | "harness-code-review" | "harness-qa-validator" (ship gate). */
	skillName: string;
	/** assertion IDs que a task completa (tasks). */
	fulfills?: string[];
	status: StepStatus;
	attempts: number;
	/** ids de sessão usados por tentativa (analog de feature.workerSessionIds, doc 07). O
	 * último = a sessão corrente/resumível (resume re-attacha; nova tentativa = id novo). */
	workerSessionIds: string[];
}

export interface FeatureRun {
	runId: string;
	featureId: string;
	status: FeatureRunStatus;
	steps: FeatureStep[];
	/** o ship gate é injetado no máx 1x (analog do hasValidationPlannerRun). */
	gateInjected: boolean;
	createdAt: string;
	updatedAt: string;
	pauseReason?: string;
	/** budget extra por step concedido no resume após esgotamento (doc 07: featureRetryBudgetBonus). */
	retryBudgetBonus?: Record<string, number>;
}

/** Resultado de spawnar um child. `aborted` = interrompido (SIGINT/abort). */
export interface SpawnOutcome {
	code: number | null;
	aborted?: boolean;
	/** o spawn lê o handoff (EndFeatureRun) do child: successState==='success'. Espelha auditSucceeded. */
	success?: boolean;
	/** o worker/validator pediu retorno ao orchestrator (EndFeatureRun.returnToOrchestrator). */
	returnToOrchestrator?: boolean;
	/** 402/usage-limit detectado no stream → auto-pausa resumível (doc 07: unrecoverable_usage_402). */
	usageLimit?: boolean;
	/** watchdog matou o child por inatividade → morte do worker, requeue (doc 07: session_inactivity). */
	inactivity?: boolean;
}

export interface SpawnCtx {
	cwd: string;
	signal?: AbortSignal;
	/** id de sessão do worker desta tentativa (engine-owned). O spawn real abre `--session-id <id>`. */
	workerSessionId?: string;
	/** re-attacha a sessão existente ("continue where you left off") em vez de começar do zero. */
	resume?: boolean;
}

export type SpawnFn = (step: FeatureStep, ctx: SpawnCtx) => Promise<SpawnOutcome>;

export interface FeatureRunLoopDeps {
	/** Spawna a sessão do step e resolve quando ela termina (lendo o handoff p/ success). */
	spawn: SpawnFn;
	/** Persiste o record (feature-run.json analog). */
	persist?: (run: FeatureRun) => void;
	/** Trilha de eventos (progress_log.jsonl analog). */
	log?: (ev: string, extra?: Record<string, unknown>) => void;
	/** Re-render do progresso ao vivo a cada transição. */
	onProgress?: (run: FeatureRun) => void;
	now?: () => string;
	budget?: number;
	/** ship-gate skills a pular (skipScrutiny/skipUserTesting) — de skippedGateSkills(config). */
	gateSkip?: ReadonlySet<string>;
	/** gerador de worker session id (injetável p/ teste; default aleatório). */
	genSessionId?: () => string;
	/** intervalo do heartbeat (toca updatedAt enquanto um spawn longo roda; doc 07: 180000). off por default. */
	heartbeatMs?: number;
}

/** Opções do runLoop. `resume` = continuar um run persistido (não reclama órfãos; re-attacha in_progress). */
export interface RunLoopOpts {
	resume?: boolean;
	heartbeatMs?: number;
}

/** Os steps do ship gate, em ordem (scrutiny → user-testing → delivery). */
export const SHIP_GATE: readonly { id: string; skillName: string }[] = [
	{ id: "ship-gate-code-review", skillName: "harness-code-review" },
	{ id: "ship-gate-qa-validator", skillName: "harness-qa-validator" },
	{ id: "ship-gate-deliver", skillName: "harness-deliver" },
];

const defaultNow = (): string => new Date().toISOString();
const defaultGenSessionId = (): string => `ws_${Math.random().toString(36).slice(2, 10)}`;

let counter = 0;
function genRunId(now: () => string): string {
	counter = (counter + 1) % 1e6;
	return `ftr_${now().replace(/[^0-9]/g, "").slice(8, 17)}${counter}`;
}

/** O step deixado in_progress (graceful pause / resume pendente). undefined se nenhum. */
export function inProgressStep(run: FeatureRun): FeatureStep | undefined {
	return run.steps.find((s) => s.status === "in_progress");
}

/** Concede budget extra a um step esgotado (analog do grantRetryBudgetForExhaustedFeatures, doc 07). */
export function grantRetryBudget(run: FeatureRun, stepId: string, n: number = STEP_ATTEMPT_BUDGET): void {
	run.retryBudgetBonus = run.retryBudgetBonus ?? {};
	run.retryBudgetBonus[stepId] = (run.retryBudgetBonus[stepId] ?? 0) + n;
}

function touch(run: FeatureRun, deps: FeatureRunLoopDeps): void {
	run.updatedAt = (deps.now ?? defaultNow)();
	deps.persist?.(run);
	deps.onProgress?.(run);
}

/** Próximo step pendente (ordem do array — sequencial). */
export function nextPending(run: FeatureRun): FeatureStep | undefined {
	return run.steps.find((s) => s.status === "pending");
}

/** Recuperação de crash: steps in_progress órfãos voltam a pending. */
export function cleanupOrphan(run: FeatureRun): void {
	for (const s of run.steps) if (s.status === "in_progress") s.status = "pending";
}

/** Plano de execução de uma feature: N tasks (do plan.json), sem o ship gate ainda. */
export function planFeatureRun(
	featureId: string,
	tasks: { id: string; skillName: string; fulfills?: string[] }[],
	now: () => string = defaultNow,
): FeatureRun {
	const ts = now();
	return {
		runId: genRunId(now),
		featureId,
		status: "running",
		steps: tasks.map((t) => ({
			id: t.id,
			kind: "task" as const,
			skillName: t.skillName,
			fulfills: t.fulfills,
			status: "pending" as const,
			attempts: 0,
			workerSessionIds: [],
		})),
		gateInjected: false,
		createdAt: ts,
		updatedAt: ts,
	};
}

/** Injeta o ship gate (harness-code-review → harness-qa-validator) no fim da fila. Idempotente via gateInjected. */
export function injectShipGate(run: FeatureRun, skip: ReadonlySet<string> = new Set()): void {
	if (run.gateInjected) return;
	for (const g of SHIP_GATE) {
		if (skip.has(g.skillName)) continue; // skipScrutiny→code-review; skipUserTesting→qa-validator
		run.steps.push({ id: g.id, kind: "ship-gate", skillName: g.skillName, status: "pending", attempts: 0, workerSessionIds: [] });
	}
	run.gateInjected = true;
}

/** Insere uma fix task ANTES do primeiro step de ship gate (analog do insertFeatureAtTop pra fixes). */
export function insertFixTask(run: FeatureRun, task: { id: string; skillName: string; fulfills?: string[] }): void {
	const gateIdx = run.steps.findIndex((s) => s.kind === "ship-gate");
	const step: FeatureStep = { id: task.id, kind: "task", skillName: task.skillName, fulfills: task.fulfills, status: "pending", attempts: 0, workerSessionIds: [] };
	if (gateIdx < 0) run.steps.push(step);
	else run.steps.splice(gateIdx, 0, step);
}

function nextWorkerSessionId(step: FeatureStep, gen: () => string): string {
	const wsid = gen();
	step.workerSessionIds = [...(step.workerSessionIds ?? []), wsid];
	return wsid;
}

/**
 * O loop determinístico (porte do runLoop/spawnWorker do runner de referência, eixo feature).
 * Sequencial; cada step spawna um child; budget de tentativas; ship gate injetado quando
 * as tasks acabam; failure/returnToOrchestrator → orchestrator_turn; pausa em abort/budget;
 * orphan cleanup no início. Muta e persiste `run`.
 */
export async function runLoop(cwd: string, run: FeatureRun, deps: FeatureRunLoopDeps, signal?: AbortSignal, opts: RunLoopOpts = {}): Promise<FeatureRun> {
	const base = deps.budget ?? STEP_ATTEMPT_BUDGET;
	const genId = deps.genSessionId ?? defaultGenSessionId;
	const heartbeatMs = opts.heartbeatMs ?? deps.heartbeatMs;
	// Fresh start → reclama órfãos (recuperação de HARD kill: in_progress → pending, re-roda do zero).
	// Resume → preserva o in_progress (re-attacha a sessão do worker = "continue where you left off").
	if (!opts.resume) cleanupOrphan(run);
	run.status = "running";
	touch(run, deps);

	// Preempção por ordenação (doc 07): no resume, se um pending está ACIMA do in_progress
	// (ex.: fix task inserida no topo), requeue o in_progress → a fix corre primeiro.
	if (opts.resume) {
		const ip = inProgressStep(run);
		if (ip) {
			const ipIdx = run.steps.indexOf(ip);
			const firstPendingIdx = run.steps.findIndex((s) => s.status === "pending");
			if (firstPendingIdx >= 0 && firstPendingIdx < ipIdx) {
				ip.status = "pending";
				deps.log?.("step_preempted", { id: ip.id });
				touch(run, deps);
			}
		}
	}

	while (run.status === "running") {
		if (signal?.aborted) {
			run.status = "paused";
			run.pauseReason = "aborted";
			break;
		}

		// Re-attach: um step in_progress (graceful pause / resume) continua sua sessão existente,
		// SEM consumir uma nova tentativa. Senão, pega o próximo pending (tentativa nova).
		let step = inProgressStep(run);
		const reattach = step != null;
		if (!step) {
			step = nextPending(run);
			if (!step) {
				// Tasks acabaram: injeta o ship gate 1x; depois disso → completo.
				if (!run.gateInjected) {
					injectShipGate(run, deps.gateSkip);
					deps.log?.("ship_gate_injected", { steps: run.steps.filter((s) => s.kind === "ship-gate").map((s) => s.id) });
					touch(run, deps);
					continue;
				}
				run.status = "completed";
				break;
			}
			const budget = base + (run.retryBudgetBonus?.[step.id] ?? 0);
			if (step.attempts >= budget) {
				run.status = "paused";
				run.pauseReason = "step_retry_limit_exceeded";
				deps.log?.("step_paused", { id: step.id, reason: "step_retry_limit_exceeded", attempts: step.attempts });
				break;
			}
			step.status = "in_progress";
			step.attempts++;
			const wsid = nextWorkerSessionId(step, genId);
			touch(run, deps);
			deps.log?.("step_started", { id: step.id, kind: step.kind, skillName: step.skillName, attempt: step.attempts, workerSessionId: wsid });
		}

		const workerSessionId = step.workerSessionIds.at(-1) ?? nextWorkerSessionId(step, genId);
		if (reattach) deps.log?.("step_resumed", { id: step.id, workerSessionId });

		// Heartbeat: enquanto o spawn roda, toca updatedAt periodicamente (beacon de vida, doc 07).
		const beat = heartbeatMs
			? setInterval(() => {
					run.updatedAt = (deps.now ?? defaultNow)();
					deps.persist?.(run);
					deps.log?.("heartbeat", { id: step.id });
				}, heartbeatMs)
			: null;
		(beat as { unref?: () => void } | null)?.unref?.();

		let res: SpawnOutcome;
		try {
			res = await deps.spawn(step, { cwd, signal, workerSessionId, resume: reattach });
		} catch (e) {
			res = { code: 1 };
			deps.log?.("step_error", { id: step.id, error: (e as Error).message });
		} finally {
			if (beat) clearInterval(beat);
		}

		if (res.aborted) {
			// Pause GRACEFUL (SIGTERM nosso): preserva o step in_progress → resume re-attacha o MESMO worker.
			run.status = "paused";
			run.pauseReason = "aborted";
			deps.log?.("step_paused", { id: step.id, reason: "aborted" });
			touch(run, deps);
			break;
		}
		if (res.usageLimit) {
			// 402/usage-limit: auto-pausa resumível (doc 07: unrecoverable_usage_402) — mantém in_progress.
			run.status = "paused";
			run.pauseReason = "usage_limit";
			deps.log?.("step_paused", { id: step.id, reason: "usage_limit" });
			touch(run, deps);
			break;
		}
		if (res.inactivity) {
			// Morte por inatividade (doc 07: session_inactivity → failAndRequeue): requeue, segue o loop
			// (a tentativa já foi contada; o budget guard pega runaway).
			step.status = "pending";
			deps.log?.("step_failed", { id: step.id, kind: step.kind, reason: "inactivity_timeout" });
			touch(run, deps);
			continue;
		}

		const ok = res.code === 0 && res.success === true && !res.returnToOrchestrator;
		if (ok) {
			step.status = "completed";
			deps.log?.("step_completed", { id: step.id, kind: step.kind });
			touch(run, deps);
		} else {
			// Falha/returnToOrchestrator: step volta a pending (próxima tentativa = worker NOVO,
			// do zero) e o run devolve controle ao orchestrator (que cria fix tasks e resume).
			step.status = "pending";
			run.status = "orchestrator_turn";
			deps.log?.("step_returned", { id: step.id, kind: step.kind, code: res.code, returnToOrchestrator: !!res.returnToOrchestrator });
			touch(run, deps);
			break;
		}
	}

	touch(run, deps);
	return run;
}
