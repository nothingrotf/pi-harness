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
}

/** Resultado de spawnar um child. `aborted` = interrompido (SIGINT/abort). */
export interface SpawnOutcome {
	code: number | null;
	aborted?: boolean;
	/** o spawn lê o handoff (EndFeatureRun) do child: successState==='success'. Espelha auditSucceeded. */
	success?: boolean;
	/** o worker/validator pediu retorno ao orchestrator (EndFeatureRun.returnToOrchestrator). */
	returnToOrchestrator?: boolean;
}

export interface SpawnCtx {
	cwd: string;
	signal?: AbortSignal;
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
}

/** Os steps do ship gate, em ordem (scrutiny → user-testing → delivery). */
export const SHIP_GATE: readonly { id: string; skillName: string }[] = [
	{ id: "ship-gate-code-review", skillName: "harness-code-review" },
	{ id: "ship-gate-qa-validator", skillName: "harness-qa-validator" },
	{ id: "ship-gate-deliver", skillName: "harness-deliver" },
];

const defaultNow = (): string => new Date().toISOString();

let counter = 0;
function genRunId(now: () => string): string {
	counter = (counter + 1) % 1e6;
	return `ftr_${now().replace(/[^0-9]/g, "").slice(8, 17)}${counter}`;
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
		run.steps.push({ id: g.id, kind: "ship-gate", skillName: g.skillName, status: "pending", attempts: 0 });
	}
	run.gateInjected = true;
}

/** Insere uma fix task ANTES do primeiro step de ship gate (analog do insertFeatureAtTop pra fixes). */
export function insertFixTask(run: FeatureRun, task: { id: string; skillName: string; fulfills?: string[] }): void {
	const gateIdx = run.steps.findIndex((s) => s.kind === "ship-gate");
	const step: FeatureStep = { id: task.id, kind: "task", skillName: task.skillName, fulfills: task.fulfills, status: "pending", attempts: 0 };
	if (gateIdx < 0) run.steps.push(step);
	else run.steps.splice(gateIdx, 0, step);
}

/**
 * O loop determinístico (porte do runLoop/spawnWorker do runner de referência, eixo feature).
 * Sequencial; cada step spawna um child; budget de tentativas; ship gate injetado quando
 * as tasks acabam; failure/returnToOrchestrator → orchestrator_turn; pausa em abort/budget;
 * orphan cleanup no início. Muta e persiste `run`.
 */
export async function runLoop(cwd: string, run: FeatureRun, deps: FeatureRunLoopDeps, signal?: AbortSignal): Promise<FeatureRun> {
	const budget = deps.budget ?? STEP_ATTEMPT_BUDGET;
	cleanupOrphan(run);
	run.status = "running";
	touch(run, deps);

	while (run.status === "running") {
		if (signal?.aborted) {
			run.status = "paused";
			run.pauseReason = "aborted";
			break;
		}
		const step = nextPending(run);
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
		if (step.attempts >= budget) {
			run.status = "paused";
			run.pauseReason = "step_retry_limit_exceeded";
			deps.log?.("step_paused", { id: step.id, reason: "step_retry_limit_exceeded", attempts: step.attempts });
			break;
		}

		step.status = "in_progress";
		step.attempts++;
		touch(run, deps);
		deps.log?.("step_started", { id: step.id, kind: step.kind, skillName: step.skillName, attempt: step.attempts });

		let res: SpawnOutcome;
		try {
			res = await deps.spawn(step, { cwd, signal });
		} catch (e) {
			res = { code: 1 };
			deps.log?.("step_error", { id: step.id, error: (e as Error).message });
		}

		if (res.aborted) {
			step.status = "pending";
			run.status = "paused";
			run.pauseReason = "aborted";
			deps.log?.("step_paused", { id: step.id, reason: "aborted" });
			touch(run, deps);
			break;
		}

		const ok = res.code === 0 && res.success === true && !res.returnToOrchestrator;
		if (ok) {
			step.status = "completed";
			deps.log?.("step_completed", { id: step.id, kind: step.kind });
			touch(run, deps);
		} else {
			// Falha/returnToOrchestrator: step volta a pending (re-tenta até o budget) e o
			// run devolve controle ao orchestrator (que cria fix tasks e resume).
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
