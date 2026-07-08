/**
 * FeatureRunner — generaliza o motor do ReadinessRunner (= runner de referência 1:1, docs/02)
 * pro eixo de EXECUÇÃO DE FEATURE. **Granularidade = FEATURE, não task** (paridade com a
 * referência droid: 1 worker session = 1 feature inteira). O plan.json é decomposto em tasks
 * ordenadas, mas elas são a LISTA DE TASKS INTERNA de UM ÚNICO worker — não N spawns. O runner
 * monta UM step de implementação (id "implement") carregando TODAS as tasks; o worker roda o
 * startup do harness-worker-base 1×, trabalha todas as tasks numa sessão contínua (commit por
 * task), e chama EndFeatureRun uma vez. Quando o impl step completa INJETA o ship gate
 * (harness-code-review → harness-qa-validator → harness-deliver) UMA vez. Qualquer
 * failure/returnToOrchestrator → status "orchestrator_turn" (para; o orchestrator cria
 * fix tasks — steps de UMA task — e resume). Budget de 5 tentativas por step; pause/resume;
 * orphan cleanup.
 *
 * Por que 1 worker por feature (e não 1 por task): spawnar um worker por task perdia o
 * contexto entre tasks (sessões distintas), repetia o startup do worker-base (≈12 arquivos +
 * init.sh + serviços) N vezes e multiplicava o tempo de parede. Com 1 worker o startup é pago
 * 1×, o modelo mental persiste através das tasks, e a decomposição vira o TODO interno do
 * worker — exatamente o modelo da referência.
 *
 * Mapeamento runner de referência → FeatureRunner:
 *   features.json (fila)                 → steps[] (1 impl step c/ as tasks + ship gate)
 *   1 worker por FEATURE                  → 1 worker por feature (impl step carrega plan.tasks)
 *   milestone completa → injeta          → impl step completa → injeta ship gate
 *     scrutiny + user-testing               (harness-code-review + harness-qa-validator), 1x (gateInjected)
 *   _9H = 5                               → STEP_ATTEMPT_BUDGET = 5
 *   failure / returnToOrchestrator        → status "orchestrator_turn"
 *   cleanupOrphanedWorker()               → cleanupOrphan()
 *   state.json / progress_log.jsonl       → feature-run.json / progress_log.jsonl
 *
 * O loop é injetável (spawn + succeeded + persist) → 100% testável sem subprocesso
 * real (test/feature-runner.test.ts). A integração real de spawn vive à parte.
 */

import { batchBudget, batchTasks } from "./batch.ts";

/** Per-step attempt budget (referência: 5). */
export const STEP_ATTEMPT_BUDGET = 5;

export type FeatureRunStatus = "running" | "paused" | "orchestrator_turn" | "completed";
/** `cancelled` é RESERVADO (glifo ✓/●/○/✗ da TUI); o runner ainda não cancela steps — só pausa por budget. */
export type StepStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type StepKind = "task" | "ship-gate";

/** Id estável do step de implementação. K=1 (T ≤ budget) → este id exato (byte-idêntico ao
 * pré-batching). K>1 → os batches viram `implement-1..K` (ver `batchStepId`). */
export const IMPL_STEP_ID = "implement";

/** Id do step do batch `idx` (0-based) numa feature de `total` batches. total===1 → IMPL_STEP_ID. */
export function batchStepId(idx: number, total: number): string {
	return total <= 1 ? IMPL_STEP_ID : `${IMPL_STEP_ID}-${idx + 1}`;
}

/** true se `id` é um step de implementação/batch (o único "implement" ou um "implement-N"). */
export function isImplStepId(id: string): boolean {
	return id === IMPL_STEP_ID || /^implement-\d+$/.test(id);
}

/** Uma task do plan.json carregada DENTRO de um step de implementação (a lista interna do worker). */
export interface PlanTaskRef {
	id: string;
	skillName: string;
	description?: string;
	fulfills?: string[];
	preconditions?: string[];
	expectedBehavior?: string[];
	/** Trilho de coesão do batching (doc 05 §4): tasks consecutivas com a MESMA tag não-vazia
	 * nunca são rachadas entre batches (cluster coeso: auth-core, migration-seq). Opcional. */
	cohesion?: string;
	/** Força uma emenda de batch ANTES desta task (fronteira dura; doc 05 §4). Opcional. */
	batchBreakBefore?: boolean;
}

export interface FeatureStep {
	id: string;
	kind: StepKind;
	/** worker skill (task) | "harness-code-review" | "harness-qa-validator" (ship gate). Para o
	 * impl step é só um rótulo (a skill de cada task vem de `tasks[].skillName`). */
	skillName: string;
	/** assertion IDs que o step completa (impl = união das tasks; ship-gate = vazio). */
	fulfills?: string[];
	/** as tasks que ESTE step (de kind "task") executa numa única sessão de worker. O impl step
	 * carrega TODAS as tasks do plan.json; um fix step carrega a sua única task. Ausente em ship-gates. */
	tasks?: PlanTaskRef[];
	status: StepStatus;
	attempts: number;
	/** ids de sessão usados por tentativa (analog de feature.workerSessionIds, doc 07). O
	 * último = a sessão corrente/resumível (resume re-attacha; nova tentativa = id novo). */
	workerSessionIds: string[];
	/** Posição do batch (doc 05): 1-based. Presente só quando K>1 (feature rachada em batches). */
	batchIndex?: number;
	/** Total de batches (K) da feature. Presente só quando K>1. undefined → K=1 (feature inteira). */
	batchTotal?: number;
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
	/** por que o run devolveu controlo (status orchestrator_turn): completion_gate_failed | step_returned. */
	turnReason?: string;
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
	/**
	 * O child morreu/o wire quebrou no meio do turno (prompt rejeitado, evento de erro fatal) SEM
	 * agent_end — falha rápida + requeue, em vez de esperar o watchdog de inatividade (droid:
	 * ProcessExitError → failAndRequeue). Distinto de `inactivity` (que é silêncio, não morte).
	 */
	crashed?: boolean;
	/**
	 * O worker GRAVOU um handoff (EndFeatureRun) nesta tentativa — distingue uma falha REPORTADA
	 * (worker terminou e decidiu failure/partial → orchestrator_turn) de um wedge MECÂNICO do
	 * re-attach (transcript corrupto, sem handoff → degrade a restart fresh). Sem esta distinção,
	 * o degrade engolia falhas genuínas de workers resumidos até estourar o budget.
	 */
	reported?: boolean;
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
	/**
	 * Completion gate (droid: mission completa ⇔ toda assertion do contrato `passed`): chamado
	 * quando os steps acabam, ANTES de marcar `completed`. `ok:false` → orchestrator_turn (o
	 * orchestrator decide fix tasks / re-validar). undefined → completa direto (testes/compat).
	 */
	completionGate?: () => { ok: boolean; failing: string[] };
	/**
	 * Resolve o modelo+effort EFETIVO de um step (role override > fallback da sessão) — injetado
	 * pelo caller que tem o HarnessModelConfig. Gravado no `step_started` (source-of-truth do que
	 * REALMENTE rodou, correto mesmo se o config global mudar no meio do run). undefined → não loga.
	 */
	describeStepModel?: (step: FeatureStep) => { model?: string; thinking?: string };
	/**
	 * Reconciliação pós-HARD-kill (droid: completion é FATO em disco, nunca promessa em memória):
	 * `true` se a ÚLTIMA sessão do step já gravou um handoff `successState:"success"` — então o
	 * orphan cleanup marca o step `completed` em vez de re-rodar (um impl step de horas de trabalho
	 * não é re-executado só porque o processo morreu ANTES do runner avançar). Injetado pelo caller
	 * (lê handoffs/ com o wsid exato). undefined → comportamento antigo (requeue todo in_progress).
	 */
	reconcileCompleted?: (step: FeatureStep) => boolean;
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

/**
 * Recuperação de crash (HARD kill): steps in_progress órfãos voltam a pending PARA re-rodar —
 * EXCETO quando `reconcileCompleted` confirma que a última sessão do step já gravou um handoff de
 * sucesso em disco (aí marca `completed`, sem re-executar). Emite `step_reconciled`/`step_orphan_
 * requeued` na trilha (droid: orphan cleanup deixa rasto de auditoria — um re-run pós-crash não
 * pode ser indistinguível de um first run no log).
 */
export function cleanupOrphan(
	run: FeatureRun,
	opts: { reconcileCompleted?: (step: FeatureStep) => boolean; log?: (ev: string, extra?: Record<string, unknown>) => void } = {},
): void {
	for (const s of run.steps) {
		if (s.status !== "in_progress") continue;
		const workerSessionId = s.workerSessionIds?.at(-1);
		// Só steps de TASK reconciliam (é onde "horas de trabalho" se aplica). Ship-gates re-rodam:
		// eles reportam SEMPRE returnToOrchestrator:true (guidance triage, lessons) — reconciliá-los
		// como completed engoliria o turno do orchestrator que o caminho normal garante.
		if (s.kind === "task" && opts.reconcileCompleted?.(s)) {
			s.status = "completed";
			opts.log?.("step_reconciled", { id: s.id, kind: s.kind, reason: "handoff_success_on_disk", workerSessionId });
			// Impl/fix step reconciliado: cada task que ele cobre também conta como concluída (paridade
			// com o caminho de sucesso normal — a TUI por-task e o completion gate ficam coerentes).
			if (s.tasks?.length) for (const t of s.tasks) opts.log?.("task_completed", { taskId: t.id });
			continue;
		}
		s.status = "pending";
		opts.log?.("step_orphan_requeued", { id: s.id, kind: s.kind, reason: "orphan_cleanup", workerSessionId });
	}
}

/**
 * Plano de execução de uma feature: K steps de implementação (BATCHES por budget de contexto,
 * doc 05) carregando cada um a sua FATIA ordenada das tasks do plan.json — sem o ship gate ainda.
 *
 * K=1 (T ≤ budget, sem emenda dura) → UM step id "implement" = **byte-idêntico** ao pré-batching
 * (1 worker por feature). K>1 → `implement-1..K`, executados sequencialmente por workers frescos
 * (janela limpa por batch → sem compaction). O corte é dirigido por budget + coesão (`batchTasks`).
 *
 * `budget` default = env `HARNESS_TASK_BUDGET` (7; 0 desliga → um batch legado). Param p/ testes.
 */
export function planFeatureRun(featureId: string, tasks: PlanTaskRef[], now: () => string = defaultNow, budget: number = batchBudget()): FeatureRun {
	const ts = now();
	const batches = batchTasks(tasks, budget);
	const steps: FeatureStep[] = batches.map((slice, idx) => ({
		id: batchStepId(idx, batches.length),
		kind: "task" as const,
		skillName: slice[0].skillName,
		tasks: slice.map((t) => ({ ...t })),
		fulfills: [...new Set(slice.flatMap((t) => t.fulfills ?? []))],
		status: "pending" as const,
		attempts: 0,
		workerSessionIds: [],
		// K>1: carimba a posição do batch (o bootstrap do worker usa p/ "batch k/K"); K=1 fica limpo.
		...(batches.length > 1 ? { batchIndex: idx + 1, batchTotal: batches.length } : {}),
	}));
	return { runId: genRunId(now), featureId, status: "running", steps, gateInjected: false, createdAt: ts, updatedAt: ts };
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

/**
 * Insere uma fix task ANTES do primeiro step de ship gate (analog do insertFeatureAtTop pra
 * fixes). Um fix step é um step de UMA task (carrega `tasks:[task]`) — o worker o trata igual ao
 * impl step, mas com uma única task na lista.
 */
export function insertFixTask(run: FeatureRun, task: PlanTaskRef): void {
	const gateIdx = run.steps.findIndex((s) => s.kind === "ship-gate");
	const step: FeatureStep = { id: task.id, kind: "task", skillName: task.skillName, tasks: [{ ...task }], fulfills: task.fulfills, status: "pending", attempts: 0, workerSessionIds: [] };
	if (gateIdx < 0) run.steps.push(step);
	else run.steps.splice(gateIdx, 0, step);
	// RE-ARMA os ship gates já concluídos: uma fix task muda o código DEPOIS da validação — gates
	// completed têm de re-validar (senão as assertions da fix nunca viram `passed` → completion
	// gate deadlock). Attempts resetam: novo ciclo de validação, budget fresco.
	for (const s of run.steps) {
		if (s.kind === "ship-gate" && s.status === "completed") {
			s.status = "pending";
			s.attempts = 0;
		}
	}
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
	if (!opts.resume) cleanupOrphan(run, { reconcileCompleted: deps.reconcileCompleted, log: deps.log });
	run.status = "running";
	run.pauseReason = undefined; // limpa razão stale (um usage_limit antigo não pode contaminar o registo do próximo pause/complete)
	run.turnReason = undefined;
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
				// Completion gate (end-of-mission gate analog): só completa se o contrato está satisfeito
				// (todas as assertions `passed` no status.json). Senão devolve ao orchestrator — espelha o
				// "completed is self-healing" do droid (nunca declara done com assertion pendente/failed).
				const gate = deps.completionGate?.();
				if (gate && !gate.ok) {
					run.status = "orchestrator_turn";
					run.turnReason = "completion_gate_failed";
					deps.log?.("completion_gate_failed", { failing: gate.failing });
					break;
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
			const mdl = deps.describeStepModel?.(step);
			deps.log?.("step_started", { id: step.id, kind: step.kind, skillName: step.skillName, attempt: step.attempts, workerSessionId: wsid, ...(mdl?.model ? { model: mdl.model } : {}), ...(mdl?.thinking ? { thinking: mdl.thinking } : {}) });
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
		if (res.crashed) {
			// Morte do child (droid: ProcessExitError → failAndRequeue): requeue rápido (sem esperar o
			// watchdog), tentativa contada, o budget guard pega crash-loop. Razão distinta de inactivity.
			step.status = "pending";
			deps.log?.("step_failed", { id: step.id, kind: step.kind, reason: "worker_crashed" });
			touch(run, deps);
			continue;
		}

		// Conclusão vs controlo são sinais ORTOGONAIS: successState decide se o step COMPLETOU;
		// returnToOrchestrator decide só QUEM recebe o controlo a seguir. Ship gates reportam SEMPRE
		// returnToOrchestrator:true (skills/qa-validator:110, code-review:84) — sem este split, um
		// gate VERDE voltava a pending e re-corria até estourar o attempt budget (loop observado).
		if (res.code === 0 && res.success === true) {
			step.status = "completed";
			deps.log?.("step_completed", { id: step.id, kind: step.kind });
			// Worker único por feature: ao completar o impl/fix step, marca CADA task que ele cobre como
			// concluída (task_completed por taskId). Garante que a TUI por-task fica correta no fim mesmo
			// que o worker não tenha exaurido o loop `next_task` ao vivo; tasks individuais do plan.json viram ✓.
			if (step.tasks?.length) for (const t of step.tasks) deps.log?.("task_completed", { taskId: t.id });
			touch(run, deps);
			if (res.returnToOrchestrator) {
				// Step concluído MAS o worker/validator pediu o orchestrator (findings, merge gate humano,
				// guidance updates): devolve o controlo SEM regredir o step.
				run.status = "orchestrator_turn";
				run.turnReason = "step_returned";
				deps.log?.("step_returned", { id: step.id, kind: step.kind, code: res.code, returnToOrchestrator: true, completed: true });
				touch(run, deps);
				break;
			}
		} else if (reattach && !res.reported) {
			// RESUME falhou MECANICAMENTE (re-attach sem handoff nenhum: transcript corrupto/sessão
			// insustentável): NÃO wedge no orchestrator — degrada a um restart FRESH (nova sessão, nova
			// tentativa; o budget guard limita), espelhando o `resumeWorker` do droid ("resume can never
			// wedge", doc 07 §6). Falha REPORTADA (handoff failure/partial gravado) NÃO entra aqui — um
			// worker resumido que terminou e decidiu failure vai pro orchestrator como qualquer falha.
			step.status = "pending";
			deps.log?.("step_resume_degraded", { id: step.id, kind: step.kind, reason: "reattach_failed" });
			touch(run, deps);
			continue;
		} else {
			// Falha real (successState failure/partial ou exit != 0) numa tentativa FRESH: step volta a
			// pending (próxima tentativa = worker NOVO, do zero) e o run devolve controle ao orchestrator.
			step.status = "pending";
			run.status = "orchestrator_turn";
			run.turnReason = "step_returned";
			deps.log?.("step_returned", { id: step.id, kind: step.kind, code: res.code, returnToOrchestrator: !!res.returnToOrchestrator });
			touch(run, deps);
			break;
		}
	}

	touch(run, deps);
	return run;
}
