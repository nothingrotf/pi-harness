/**
 * Feature Control — o view-model + render PURO do dashboard da TUI (docs/03-tui.md).
 * Sem dependência do Pi: lê os ficheiros do feature run e projeta num modelo tipado +
 * helpers de render (barra de progresso, ícones, formatação do progress log). Testável
 * isolado (test/control-model.test.ts); a view fina (control-view.ts) só pinta isto.
 *
 * Princípio (docs/03-tui.md §1): portamos as LEIS de DX do Mission Control do Droid,
 * rebrandeadas pro nosso domínio feature-scoped. A barra mapeia o NOSSO "done":
 * assertions passed/total (o contrato congelado), sem `%` e sem segmento estimado.
 */
import {
	type AssertionStatus,
	type Plan,
	type PlanStatus,
	readFeatureRun,
	readPlan,
	readStatus,
} from "./plan.ts";
import { isImplStepId } from "./feature-runner.ts";
import type { FeatureRun, FeatureRunStatus, StepStatus } from "./feature-runner.ts";
import { type PersistedHandoff, runDir } from "./handoff.ts";
import { loadModelConfig } from "./model-config.ts";
import { type DeliveryRecord, readDeliveryRecord } from "./delivery.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Estado do run (rebrand: "mission state" → run state)

// Estados (rebrand do mission state machine do Droid: initializing|planning|running|paused|
// orchestrator_turn|completed). `ready` = plan FROZEN, run ainda não começou (o analog do
// "planning/initializing" pós-accept do Droid). `unknown` é só fallback sem nenhum sinal.
export type RunState = FeatureRunStatus | "ready" | "unknown";

const STATE_ICON: Record<RunState, string> = {
	running: "●",
	paused: "⏸",
	orchestrator_turn: "◑",
	completed: "✓",
	ready: "◆",
	unknown: "○",
};
const STATE_LABEL: Record<RunState, string> = {
	running: "Running",
	paused: "Paused",
	orchestrator_turn: "Orch. Turn",
	completed: "Completed",
	ready: "Ready",
	unknown: "Unknown",
};

/** Estado cru a partir do feature-run.json (headless). null → "unknown" (sem sinal nenhum). */
export function runState(run: FeatureRun | null): RunState {
	return run ? run.status : "unknown";
}

/**
 * Estado do run DERIVADO de TODOS os sinais em disco — robusto ao caminho NATIVO (que NÃO
 * escreve feature-run.json; o estado vem de status.json + handoffs/ + progress_log). Era a
 * causa do "State: Unknown" persistente pós-convergência. Precedência:
 *   feature-run.json (headless, autoritativo)
 *   → completed   (todas as assertions do contrato passed = "done")
 *   → orchestrator_turn (algum handoff returnToOrchestrator/failure, ou task/step bounce)
 *   → running     (qualquer atividade de worker: run_started, handoff, task/step event)
 *   → ready       (plan FROZEN, run ainda não começou — só plan_stored no log)
 */
export function deriveRunState(input: {
	run: FeatureRun | null;
	status: PlanStatus | null;
	handoffs?: PersistedHandoff[];
	progressRaw?: ProgressRaw[];
	/** O worker está VIVO? (readControlModel checa o pid do run.lock.) undefined = desconhecido. */
	workerAlive?: boolean;
}): RunState {
	const vals = input.status ? Object.values(input.status.assertions) : [];
	const allPassed = vals.length > 0 && vals.every((v) => v === "passed");
	if (input.run) {
		// feature-run.json é autoritativo, MAS corrige estados que ficavam PRESOS:
		//   (1) worker VIVO a correr → "running" (o ship gate/deliver pode ainda estar a decorrer).
		//   (2) acceptance CUMPRIDA (todas as assertions do contrato passed) e não pausado de propósito
		//       → "completed". O step de deliver/merge pode ficar 'pending'/'in_progress' (o motor NÃO
		//       resolve quando o merge é feito POR FORA do merge-gate) — o CONTRATO passado é o sinal de
		//       "done", não o step. Corrige o "8/8 tudo passed mas preso em Orch. Turn".
		//   (3) "running" preso sem worker vivo (pid do run.lock morto) → "paused": o "● Running"
		//       fantasma que sobra após um crash/kill do worker.
		if (input.run.status === "running" && input.workerAlive === true) return "running";
		if (allPassed && input.run.status !== "paused") return "completed";
		if (input.run.status === "running" && input.workerAlive === false) return "paused";
		return input.run.status;
	}
	if (allPassed) return "completed";
	const handoffs = input.handoffs ?? [];
	const ev = new Set((input.progressRaw ?? []).map((e) => String(e.event)));
	const bounced = handoffs.some((h) => h.returnToOrchestrator || h.successState === "failure") || ev.has("task_returned") || ev.has("task_failed") || ev.has("step_returned") || ev.has("step_error");
	if (bounced) return "orchestrator_turn";
	const started = handoffs.length > 0 || ev.has("run_started") || ev.has("task_started") || ev.has("task_completed") || ev.has("step_started") || ev.has("step_completed") || ev.has("ship_gate_injected");
	if (started) return "running";
	return "ready";
}
export function stateIcon(s: RunState): string {
	return STATE_ICON[s];
}
export function stateLabel(s: RunState): string {
	return STATE_LABEL[s];
}

// ─────────────────────────────────────────────────────────────────────────────
// Barra de progresso (§5): 2 segmentos, sem `%`, sem estimado. A cor é do caller.

export interface ProgressSegments {
	/** `█` completed. */
	completed: number;
	/** `▒` pending (existe mas não terminou). */
	pending: number;
	/** `░` estimate (trabalho previsto ainda não materializado — o ship gate). */
	estimate: number;
}

export interface ProgressBar {
	/** `█` × completed — caller pinta (state color). */
	filled: string;
	/** `▒` × pending — caller pinta de secondary. */
	pending: string;
	/** `░` × estimate — caller pinta de dim (barEmpty). */
	estimate: string;
	completed: number;
	/** denominador = completed + pending + estimate. */
	total: number;
	width: number;
}

const BAR_FILLED = "█";
const BAR_PENDING = "▒";
const BAR_ESTIMATE = "░";

/**
 * Aporta {completed,pending,estimate} em EXATAMENTE `width` chars via largest-remainder
 * (Hamilton), com mínimo 1 char por segmento NÃO-zero (assim "1 de 50" pinta um sliver visível).
 * Espelha o `mkH` do Droid (doc UI 11 §4). Soma sempre = width (sem drift de arredondamento).
 */
export function apportion(seg: ProgressSegments, width: number): ProgressSegments {
	const w = Math.max(0, Math.floor(width));
	const h = [Math.max(0, seg.completed), Math.max(0, seg.pending), Math.max(0, seg.estimate)];
	const sum = h[0] + h[1] + h[2];
	if (w <= 0) return { completed: 0, pending: 0, estimate: 0 };
	if (sum === 0) return { completed: 0, pending: 0, estimate: w }; // nada começou → barra toda ░
	const nonzero = h.filter((x) => x > 0).length;
	const base = w >= nonzero ? h.map((x) => (x > 0 ? 1 : 0)) : h.map(() => 0);
	const rest = Math.max(0, w - base.reduce((a, b) => a + b, 0));
	const exact = h.map((x) => (x > 0 ? (x / sum) * rest : 0));
	const floors = exact.map((x) => Math.floor(x));
	let leftover = rest - floors.reduce((a, b) => a + b, 0);
	const order = exact
		.map((x, idx) => ({ idx, rem: x - Math.floor(x), wgt: h[idx] }))
		.filter((o) => o.wgt > 0)
		.sort((a, b) => b.rem - a.rem || b.wgt - a.wgt || a.idx - b.idx);
	for (let k = 0; leftover > 0 && order.length > 0; k++, leftover--) floors[order[k % order.length].idx] += 1;
	return { completed: base[0] + floors[0], pending: base[1] + floors[1], estimate: base[2] + floors[2] };
}

/** Barra de 3 segmentos (█ completed · ▒ pending · ░ estimate) — 1:1 com o Droid. Largura mín 10. */
export function progressBar(seg: ProgressSegments, width = 24): ProgressBar {
	const w = Math.max(10, Math.floor(width));
	const a = apportion(seg, w);
	const completed = Math.max(0, seg.completed);
	return {
		filled: BAR_FILLED.repeat(a.completed),
		pending: BAR_PENDING.repeat(a.pending),
		estimate: BAR_ESTIMATE.repeat(a.estimate),
		completed,
		total: completed + Math.max(0, seg.pending) + Math.max(0, seg.estimate),
		width: w,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (rebrand: "features" → tasks; ícones traced do Droid)

export type TaskStatusV = "completed" | "in_progress" | "returned" | "pending" | "cancelled";

const TASK_ICON: Record<TaskStatusV, string> = {
	completed: "✓",
	in_progress: "●",
	returned: "↩",
	pending: "○",
	cancelled: "✗", // glifo 1:1 com o Droid (lnu/onu) e consistente com delivery/readiness
};
export function taskIcon(s: TaskStatusV): string {
	return TASK_ICON[s];
}

export interface TaskRow {
	id: string;
	skillName: string;
	fulfills: string[];
	description: string;
	preconditions: string[];
	expectedBehavior: string[];
	status: TaskStatusV;
	active: boolean;
}

function stepStatusToTask(s: StepStatus | undefined): TaskStatusV {
	if (s === "completed") return "completed";
	if (s === "in_progress") return "in_progress";
	if (s === "cancelled") return "cancelled";
	return "pending";
}

// Sinais de progresso em disco (caminho NATIVO, sem feature-run.json): o orquestrador-em-chat
// nunca escreve feature-run.json, então o status das tasks vem dos handoffs + progress_log —
// os MESMOS sinais que `deriveRunState` já funde pro badge de estado.
export interface DiskSignals {
	handoffs?: PersistedHandoff[];
	progressRaw?: ProgressRaw[];
}

const STARTED_EVENTS = new Set(["task_started", "step_started"]);
const TERMINAL_EVENTS = new Set(["task_completed", "task_returned", "task_failed", "step_completed", "step_returned", "step_error"]);

function handoffToTaskStatus(h: PersistedHandoff): TaskStatusV {
	if (h.successState === "success") return "completed";
	if (h.returnToOrchestrator) return "returned"; // bounce explícito ao orquestrador (não está rodando)
	if (h.successState === "failure") return "cancelled";
	return "returned"; // partial sem return → incompleto, voltou ao orquestrador
}

/**
 * Status de cada task derivado dos sinais EM DISCO (caminho nativo). progress_log dá o estado
 * provisório (task_started → in_progress; terminais → completed/cancelled), e os handoffs (o
 * EndFeatureRun real) sobrepõem com o successState preciso. Último handoff por task (recordedAt)
 * vence. Vazio quando não há sinal nenhum (→ as tasks ficam pending no caller).
 */
export function deriveTaskStatuses(handoffs: PersistedHandoff[], progressRaw: ProgressRaw[]): Map<string, TaskStatusV> {
	const m = new Map<string, TaskStatusV>();
	for (const e of progressRaw) {
		const id = str(e.id ?? e.taskId);
		if (!id) continue;
		const ev = str(e.event);
		if (STARTED_EVENTS.has(ev)) m.set(id, "in_progress");
		else if (ev === "task_completed" || ev === "step_completed") m.set(id, "completed");
		else if (ev === "task_failed" || ev === "step_error") m.set(id, "cancelled");
		else if (ev === "task_returned" || ev === "step_returned") m.set(id, "returned");
	}
	const byTask = new Map<string, PersistedHandoff>();
	for (const h of handoffs) {
		const prev = byTask.get(h.taskId);
		if (!prev || (h.recordedAt ?? "") >= (prev.recordedAt ?? "")) byTask.set(h.taskId, h);
	}
	for (const [id, h] of byTask) m.set(id, handoffToTaskStatus(h));
	return m;
}

/** A task com `task_started`/`step_started` mais recente SEM terminal posterior (= worker vivo no nativo). */
function latestStartedTask(progressRaw: ProgressRaw[]): string | null {
	let active: string | null = null;
	for (const e of progressRaw) {
		const id = str(e.id ?? e.taskId);
		if (!id) continue;
		const ev = str(e.event);
		if (STARTED_EVENTS.has(ev)) active = id;
		else if (TERMINAL_EVENTS.has(ev) && id === active) active = null;
	}
	return active;
}

/** Constrói um ActiveItem a partir de um id (ship-gate-* vs task do plano). */
function activeFromId(plan: Plan | null, id: string): ActiveItem {
	if (id.startsWith("ship-gate-")) {
		const skillName = `harness-${id.slice("ship-gate-".length)}`;
		return { id, kind: "ship-gate", label: skillName, skillName, fulfills: [] };
	}
	const task = plan?.tasks.find((t) => t.id === id);
	return { id, kind: "task", label: task?.description ?? id, skillName: task?.skillName ?? "worker", fulfills: task?.fulfills ?? [] };
}

/**
 * Junta plan.tasks (descrição/fulfills) com o status. Precedência: feature-run.json (headless,
 * autoritativo) → senão os sinais em disco (handoffs + progress_log, caminho nativo) → pending.
 */
export function buildTaskRows(plan: Plan | null, run: FeatureRun | null, disk: DiskSignals = {}): TaskRow[] {
	if (!plan) return [];
	const stepById = new Map<string, StepStatus>();
	for (const s of run?.steps ?? []) if (s.kind === "task") stepById.set(s.id, s.status);
	const derived = deriveTaskStatuses(disk.handoffs ?? [], disk.progressRaw ?? []);
	// Backstop FINAL (git-free) — paridade com o headless FeatureRunner: um handoff de SUCESSO de um
	// batch step marca as tasks DAQUELE batch (não todas — doc 05: com K batches, um sucesso de
	// implement-1 NÃO implica implement-2 feito). A fonte de verdade AO VIVO por task é o tool
	// `next_task` (grava task_started/task_completed nas fronteiras); este é só o coalesce do fim.
	const succeededSteps = new Set((disk.handoffs ?? []).filter((h) => h.successState === "success").map((h) => h.taskId));
	const batchDone = new Set<string>();
	for (const s of run?.steps ?? []) if (s.kind === "task" && succeededSteps.has(s.id)) for (const t of s.tasks ?? []) batchDone.add(t.id);
	// Legado sem run (nativo, sem feature-run.json p/ mapear batch→tasks): um sucesso do impl step
	// cobre todas as tasks (comportamento antigo, só quando não há steps p/ escopar).
	const legacyImplSuccess = !run?.steps?.length && [...succeededSteps].some(isImplStepId);
	return plan.tasks.map((t) => {
		const stepSt = stepById.get(t.id);
		let status: TaskStatusV = stepSt !== undefined ? stepStatusToTask(stepSt) : derived.get(t.id) ?? "pending";
		if (status !== "completed" && status !== "cancelled" && (batchDone.has(t.id) || legacyImplSuccess)) status = "completed";
		return {
			id: t.id,
			skillName: t.skillName,
			fulfills: t.fulfills ?? [],
			description: t.description,
			preconditions: t.preconditions ?? [],
			expectedBehavior: t.expectedBehavior ?? [],
			status,
			active: status === "in_progress",
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Item ativo (pode ser uma task OU um step de ship gate)

export interface ActiveItem {
	id: string;
	kind: "task" | "ship-gate";
	label: string;
	skillName: string;
	fulfills: string[];
}

/**
 * O item ativo. Headless: o step in_progress (ou o próximo pendente se running). Nativo (sem
 * feature-run.json): a task com `task_started` mais recente sem terminal posterior — o worker
 * que está RODANDO segundo o progress_log. null quando nada está ativo.
 */
export function activeItem(plan: Plan | null, run: FeatureRun | null, disk: DiskSignals = {}): ActiveItem | null {
	if (run) {
		const inProgress = run.steps.find((s) => s.status === "in_progress");
		const step = inProgress ?? (run.status === "running" ? run.steps.find((s) => s.status === "pending") : undefined);
		if (!step) return null;
		// 1 worker por feature: o impl/fix step (kind "task" com `tasks`) entrega várias tasks numa
		// única sessão — a "current task" real é a sub-task com task_started mais recente (o tool
		// `next_task` grava um por task), não o step "implement". Cai pra 1ª sub-task ainda não
		// concluída quando ainda não chegou um task_started.
		if (step.kind === "task" && step.tasks?.length) {
			const subId = latestStartedTask(disk.progressRaw ?? []);
			if (subId && step.tasks.some((t) => t.id === subId)) return activeFromId(plan, subId);
			const done = deriveTaskStatuses(disk.handoffs ?? [], disk.progressRaw ?? []);
			const nextSub = step.tasks.find((t) => (done.get(t.id) ?? "pending") !== "completed");
			if (nextSub) return activeFromId(plan, nextSub.id);
		}
		const task = plan?.tasks.find((t) => t.id === step.id);
		return {
			id: step.id,
			kind: step.kind,
			label: task?.description ?? step.skillName,
			skillName: step.skillName,
			fulfills: step.fulfills ?? task?.fulfills ?? [],
		};
	}
	const id = latestStartedTask(disk.progressRaw ?? []);
	return id ? activeFromId(plan, id) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions + coverage (§ diferencial nosso: a invariante 1:1)

export interface AssertionCounts {
	passed: number;
	failed: number;
	pending: number;
	total: number;
}

export function assertionCounts(status: PlanStatus | null): AssertionCounts {
	const c: AssertionCounts = { passed: 0, failed: 0, pending: 0, total: 0 };
	if (!status) return c;
	for (const v of Object.values(status.assertions)) {
		c.total++;
		if (v === "passed") c.passed++;
		else if (v === "failed") c.failed++;
		else c.pending++;
	}
	return c;
}

export interface CoverageRow {
	assertion: string;
	taskId: string | null;
	status: AssertionStatus;
}

/** Cada assertion → a task que a `fulfills` (a invariante de cobertura) → seu status. */
export function coverageRows(plan: Plan | null, status: PlanStatus | null): CoverageRow[] {
	if (!plan) return [];
	const byAssertion = new Map<string, string>();
	for (const t of plan.tasks) for (const a of t.fulfills ?? []) byAssertion.set(a, t.id);
	return plan.assertions.map((a) => ({
		assertion: a,
		taskId: byAssertion.get(a) ?? null,
		status: status?.assertions[a] ?? "pending",
	}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Counts da barra (kDH analog, doc UI 11 §2) — work items = tasks + ship-gate steps.
//
// O ship gate (harness-code-review = scrutiny + harness-qa-validator = user-testing) é o análogo
// EXATO dos validators auto-injetados do Droid: até materializar conta como `░` estimate; ao
// materializar (todas as tasks terminam / gateInjected) vira `▒` pending; ao completar vira `█`.
// Denominador = (tasks − cancelled) + gateSteps — CONSTANTE → barra MONOTÔNICA (estimate só
// converte em materializado, sem salto). Acaba o salto 100%→9% que a métrica tasks→assertions dava.

export interface ProgressCounts extends ProgressSegments {
	cancelled: number;
	/** denominador = completed + pending + estimate. */
	total: number;
}

/** Passos de ship gate já completos: handoffs `ship-gate-*` success, ou (nativo) assertions todas passed. */
export function gateDoneCount(handoffs: PersistedHandoff[], status: PlanStatus | null, gateSteps: number): number {
	const fromHandoffs = handoffs.filter((h) => h.taskId.startsWith("ship-gate-") && h.successState === "success").length;
	const vals = status ? Object.values(status.assertions) : [];
	const allPassed = vals.length > 0 && vals.every((v) => v === "passed");
	return Math.max(0, Math.min(gateSteps, Math.max(fromHandoffs, allPassed ? gateSteps : 0)));
}

export interface CountsInput {
	tasks: TaskRow[];
	/** quantos passos de ship gate vão rodar = 2 − skips (0..2). */
	gateSteps: number;
	/** o gate já materializou (gateInjected / ship_gate_injected / todas as tasks terminais). */
	gateMaterialized: boolean;
	/** passos de ship gate completos. */
	gateDone: number;
	/** run em estado `completed` (contrato satisfeito = todas as assertions passed) → barra cheia. */
	complete?: boolean;
}

/** Segmentos {completed,pending,estimate} + cancelled. Denominador constante → monotônico. */
export function progressCounts(input: CountsInput): ProgressCounts {
	const completedTasks = input.tasks.filter((t) => t.status === "completed").length;
	const cancelled = input.tasks.filter((t) => t.status === "cancelled").length;
	const totalTasks = input.tasks.length;
	const gateSteps = Math.max(0, Math.min(2, Math.floor(input.gateSteps)));
	const gateDone = Math.max(0, Math.min(gateSteps, Math.floor(input.gateDone)));
	// Denominador CONSTANTE = (tasks − cancelled) + gateSteps. É o conjunto de work items que
	// define "done"; constante ⇒ barra monotônica (estimate só converte, sem reescalar o total).
	const total = Math.max(0, totalTasks - cancelled) + gateSteps;
	// Contrato satisfeito (state completed): barra CHEIA. Uma task `returned` superada pela conclusão
	// do contrato (ex.: parcial aceite + assertions todas passed) não deve travar a barra < 100%.
	if (input.complete) return { completed: total, pending: 0, estimate: 0, cancelled, total };
	// Um passo de gate concluído IMPLICA gate materializado — não pode contar como `█` done E `░`
	// estimate ao mesmo tempo (era o bug do "7/9": gateDone empurrava completed enquanto o estimate
	// ainda somava os mesmos passos, inflando o denominador).
	const materialized = input.gateMaterialized || gateDone > 0;
	const estimate = materialized ? 0 : gateSteps;
	const completed = Math.min(total, completedTasks + gateDone);
	const pending = Math.max(0, total - estimate - completed);
	return { completed, pending, estimate, cancelled, total };
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Tempo ativo (d$R analog, doc UI 11 §5): Σ dos intervalos run_started/resumed → paused.
// Pausas EXCLUÍDAS. Estado ativo → o intervalo aberto corre até `now` (vivo); senão congela.

const ACTIVE_STATES = new Set<RunState>(["running", "orchestrator_turn", "ready", "unknown"]);
const RESUME_EVENTS = new Set(["run_started", "run_resumed", "mission_resumed"]);
const PAUSE_EVENTS = new Set(["run_paused", "mission_paused", "step_paused"]);

export function activeElapsedMs(state: RunState, progressRaw: ProgressRaw[], now: number): number | null {
	let acc = 0;
	let open: number | null = null;
	let last: number | null = null;
	let started = false;
	for (const e of progressRaw) {
		const t = e.ts ? Date.parse(String(e.ts)) : Number.NaN;
		if (Number.isNaN(t)) continue;
		last = t;
		const ev = str(e.event);
		if (RESUME_EVENTS.has(ev)) {
			started = true;
			if (open === null) open = t;
		} else if (PAUSE_EVENTS.has(ev)) {
			if (open !== null) {
				acc += Math.max(0, t - open);
				open = null;
			}
		}
	}
	if (open !== null) acc += Math.max(0, (ACTIVE_STATES.has(state) ? now : last ?? open) - open);
	return started ? Math.max(0, acc) : null;
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// Workers (do feature-run + handoffs; sem Credits/Duration que não temos confiáveis)

export type WorkerStatusV = "running" | "success" | "partial" | "failed" | "returned";

const WORKER_ICON: Record<WorkerStatusV, string> = {
	running: "●",
	success: "✓",
	partial: "◐",
	failed: "✗", // 1:1 com o enu do Droid
	returned: "↩",
};
export function workerIcon(s: WorkerStatusV): string {
	return WORKER_ICON[s];
}

export interface WorkerRow {
	workerSessionId: string;
	taskId: string;
	status: WorkerStatusV;
	recordedAt?: string;
	/** ordem de início (1-based) — o análogo do "Worker #n" do Droid (derivado, não armazenado). */
	workerNumber?: number;
	/** ISO do task_started (o `worker_started` analog do doc 07). */
	startedAt?: string;
	/** duração ms (completados: recordedAt−startedAt; rodando: now−startedAt). */
	durationMs?: number;
	/** modelo EFETIVO com que o step rodou (ref "provider/id") — do step_started. undefined = herdou a sessão. */
	model?: string;
	/** effort/thinking efetivo (do step_started). */
	thinking?: string;
}

/**
 * Modelo+effort EFETIVO por ROLE (task→worker, ship-gate→validator), extraído dos `step_started`
 * gravados pelo runner (source-of-truth do que rodou). Como o config é per-role, todo step do
 * mesmo kind compartilha o modelo — indexamos por kind. ÚLTIMO visto vence: o config per-role
 * pode mudar no meio do run (ex.: worker sonnet → opus) e o Active Worker deve refletir o atual.
 */
export function modelByKind(progressRaw: ProgressRaw[]): Map<string, { model?: string; thinking?: string }> {
	const m = new Map<string, { model?: string; thinking?: string }>();
	for (const e of progressRaw) {
		if (str(e.event) !== "step_started") continue;
		const kind = str(e.kind) || "task";
		const model = str(e.model) || undefined;
		const thinking = str(e.thinking) || undefined;
		if (model || thinking) m.set(kind, { model, thinking });
	}
	return m;
}

function handoffStatus(h: PersistedHandoff): WorkerStatusV {
	if (h.successState === "success") return "success";
	if (h.successState === "partial") return "partial";
	if (h.returnToOrchestrator) return "returned";
	return "failed";
}

/** Primeiro task_started por taskId (o `worker_started` do doc 07) — base do startedAt/#n/duração. */
function startTimesByTask(progressRaw: ProgressRaw[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const e of progressRaw) {
		const ev = str(e.event);
		if (ev !== "task_started" && ev !== "step_started") continue;
		const id = str(e.id ?? e.taskId);
		if (id && !m.has(id)) m.set(id, str(e.ts));
	}
	return m;
}

/**
 * Workers = um por handoff persistido + o running (step in_progress do feature-run OU a task com
 * `task_started` sem terminal, caminho nativo). `#n`/duração derivados dos tempos de início
 * (doc 07: "worker numbers, durations are derived, not stored"). Running primeiro no display.
 */
export function buildWorkerRows(run: FeatureRun | null, handoffs: PersistedHandoff[], progressRaw: ProgressRaw[] = [], now: number = Date.now()): WorkerRow[] {
	const startByTask = startTimesByTask(progressRaw);
	const mByKind = modelByKind(progressRaw);
	// Kind (role) de uma row: se o taskId é um step conhecido usa o kind dele; sub-tasks (T1..) do
	// impl step herdam "task" (worker). Cada kind mapeia ao modelo per-role gravado no step_started.
	const modelFor = (taskId: string): { model?: string; thinking?: string } => {
		const kind = run?.steps.find((s) => s.id === taskId)?.kind ?? "task";
		return mByKind.get(kind) ?? mByKind.get("task") ?? {};
	};
	const dur = (start: string | undefined, end: string | undefined): number | undefined => {
		if (!start) return undefined;
		const s = Date.parse(start);
		if (Number.isNaN(s)) return undefined;
		const e = end ? Date.parse(end) : now;
		return Math.max(0, e - s);
	};
	const rows: WorkerRow[] = handoffs.map((h) => ({
		workerSessionId: h.workerSessionId,
		taskId: h.taskId,
		status: handoffStatus(h),
		recordedAt: h.recordedAt,
		startedAt: startByTask.get(h.taskId),
		durationMs: dur(startByTask.get(h.taskId), h.recordedAt),
		...modelFor(h.taskId),
	}));
	// 1 worker por feature: quando o step in_progress é o impl/fix step (kind "task" com `tasks`), o
	// worker "running" está na sub-task com task_started mais recente — não no id "implement".
	const ipStep = run?.steps.find((s) => s.status === "in_progress");
	const subActive = ipStep?.kind === "task" && ipStep.tasks?.length ? latestStartedTask(progressRaw) : null;
	const activeId = (subActive && ipStep?.tasks?.some((t) => t.id === subActive) ? subActive : ipStep?.id) ?? latestStartedTask(progressRaw);
	if (activeId && !rows.some((r) => r.status === "running" && r.taskId === activeId)) {
		const start = startByTask.get(activeId);
		// wsid da sessão VIVA: a row running é keyed à sub-task ativa (T1..), mas a SESSÃO pertence ao
		// step in_progress (1 worker por feature) — sem isto o Active Worker não acha o .jsonl e cai
		// no placeholder "working…" mesmo com o transcript a crescer em disco.
		rows.push({ workerSessionId: ipStep?.workerSessionIds?.at(-1) ?? "—", taskId: activeId, status: "running", startedAt: start, durationMs: dur(start, undefined), ...modelFor(activeId) });
	}
	// #n por ordem de início (startedAt → recordedAt) ascendente — estável.
	[...rows].sort((a, b) => (a.startedAt ?? a.recordedAt ?? "").localeCompare(b.startedAt ?? b.recordedAt ?? "")).forEach((r, i) => {
		r.workerNumber = i + 1;
	});
	return rows.sort((a, b) => {
		const ar = a.status === "running" ? 1 : 0;
		const br = b.status === "running" ? 1 : 0;
		if (ar !== br) return br - ar;
		return (b.recordedAt ?? b.startedAt ?? "").localeCompare(a.recordedAt ?? a.startedAt ?? "");
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress log (formatação determinística dos eventos do runner/handoff/store)

export interface ProgressRaw {
	ts?: string;
	event?: string;
	[k: string]: unknown;
}

export interface ProgressEntry {
	ts: string;
	rel: string;
	text: string;
	/** segmentos coloridos (o Enu do Droid) — a view pinta cada um com o seu tom. */
	segments: ProgressSegment[];
}

/** Tempo relativo curto: "just now" / "2m" / "1h" / "3d". */
export function relTime(ts: string | undefined, now: number): string {
	if (!ts) return "";
	const t = Date.parse(ts);
	if (Number.isNaN(t)) return "";
	const s = Math.max(0, Math.floor((now - t) / 1000));
	if (s < 45) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function str(v: unknown): string {
	return v === undefined || v === null ? "" : String(v);
}

/** Duração curta: "45s" / "2m 14s" / "1h 03m". undefined/negativo → "". */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || ms < 0) return "";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

// Coloração por-segmento do progress log (o `Enu` do Droid, doc UI 08b §1d). Rebrand task/step:
// id como "ref" (accent), ícones por estado (✓ success / ✗ error / ↩ warning), verbo secundário.
// Tons = ThemeColor válidos do pi (NB: não existe "secondary" no tema — fg() lança; usa "muted").
export type SegTone = "accent" | "success" | "error" | "warning" | "muted" | "dim";

export interface ProgressSegment {
	text: string;
	tone: SegTone;
}

const SEG = (text: string, tone: SegTone): ProgressSegment => ({ text, tone });

/**
 * Segmentos coloridos de um evento (o analog do `Enu`): o id da task em `accent` (o "ref" teal do
 * Droid), o ícone terminal por estado, o verbo em `secondary`. O join dos `.text` é IDÊNTICO ao
 * `formatProgressEntry` (a view colore; o texto plano continua o mesmo p/ fallback/testes).
 */
export function progressSegments(e: ProgressRaw): ProgressSegment[] {
	const id = str(e.id ?? e.taskId);
	switch (e.event) {
		case "plan_stored":
			return [SEG("plan stored: ", "muted"), SEG(`${str(e.tasks)} tasks`, "accent"), SEG(" / ", "dim"), SEG(`${str(e.assertions)} assertions`, "accent")];
		case "run_started":
			return e.message ? [SEG("run started", "muted"), SEG(`: ${str(e.message)}`, "dim")] : [SEG("run started", "muted")];
		case "branch_ready":
			return e.branch ? [SEG("branch ready", "muted"), SEG(`: ${str(e.branch)}`, "accent")] : [SEG("branch ready", "muted")];
		case "ports_preflight": {
			const ports = Array.isArray(e.ports) ? (e.ports as { listening?: boolean }[]) : [];
			const busy = ports.filter((p) => p.listening).length;
			const dupes = Array.isArray(e.duplicates) ? e.duplicates.length : 0;
			return [
				SEG("ports ", "muted"),
				SEG(`${busy}/${ports.length} in use`, busy > 0 ? "accent" : "dim"),
				...(dupes > 0 ? [SEG(` · ${dupes} duplicated in services.yaml`, "error")] : []),
			];
		}
		case "gate_round_cap":
			return [SEG("ship-gate round cap", "warning"), SEG(`: ${str(e.rounds)}/${str(e.cap)} — orchestrator must decide`, "muted")];
		case "commit_gate_zero_tests":
			return [SEG("commit gate", "error"), SEG(": command collected ZERO tests", "muted")];
		case "step_started":
			return [SEG(id, "accent"), SEG(" started", "muted"), ...(e.attempt ? [SEG(` (attempt ${str(e.attempt)})`, "dim")] : [])];
		case "task_started":
			return [SEG("task ", "muted"), SEG(id, "accent"), SEG(" started", "muted")];
		case "step_completed":
			return [SEG(id, "accent"), SEG(" completed ", "muted"), SEG("✓", "success")];
		case "task_completed":
			return [SEG("task ", "muted"), SEG(id, "accent"), SEG(" completed ", "muted"), SEG("✓", "success")];
		case "step_returned":
			return [SEG(id, "accent"), SEG(" returned", "warning"), ...(e.returnToOrchestrator ? [SEG(" → orchestrator", "dim")] : [])];
		case "task_returned":
			return [SEG("task ", "muted"), SEG(id, "accent"), SEG(" returned → orchestrator", "warning")];
		case "step_error":
			return [SEG(id, "accent"), SEG(` error: ${str(e.error)}`, "error")];
		case "task_failed":
			return [SEG("task ", "muted"), SEG(id, "accent"), SEG(" failed", "error")];
		case "step_paused":
			return [SEG(id, "accent"), SEG(` paused (${str(e.reason)})`, "warning")];
		case "step_failed":
			return [SEG(id, "accent"), SEG(` failed (${str(e.reason)})`, "error")];
		case "step_resumed":
			return [SEG(id, "accent"), SEG(" resumed", "muted")];
		case "step_preempted":
			return [SEG(id, "accent"), SEG(" preempted (fix runs first)", "warning")];
		case "step_reconciled":
			return [SEG(id, "accent"), SEG(" reconciled ✓", "success"), SEG(" (success on disk after kill)", "dim")];
		case "step_orphan_requeued":
			return [SEG(id, "accent"), SEG(" requeued", "warning"), SEG(" (orphan cleanup)", "dim")];
		case "step_resume_degraded":
			return [SEG(id, "accent"), SEG(" resume failed → fresh restart", "warning")];
		case "handoff_items_dismissed":
			return [SEG("dismissed ", "muted"), SEG(`${str(e.count)} handoff item(s)`, "accent")];
		case "completion_gate_failed":
			return [SEG("completion gate: ", "muted"), SEG("assertions still pending", "warning")];
		case "ship_gate_injected":
			return [SEG("ship gate injected ", "muted"), SEG("(code-review → qa-validator)", "dim")];
		default:
			return [SEG(str(e.event) || "(event)", "dim")];
	}
}

/**
 * A linha humana de um evento cru = o JOIN dos segmentos coloridos (fonte ÚNICA de verdade:
 * `progressSegments`). Antes eram dois switches gêmeos mantidos em sincronia à mão (um teste até
 * afirmava a igualdade); derivar aqui elimina a duplicação e faz casos novos aparecerem nos dois
 * lugares automaticamente. A view pinta os segmentos; isto é o texto plano (fallback/testes).
 */
export function formatProgressEntry(e: ProgressRaw): string {
	return progressSegments(e).map((s) => s.text).join("");
}

/** Projeta os eventos crus em entries renderizáveis (ordem preservada: mais antigo → recente). */
export function buildProgressEntries(raw: ProgressRaw[], now: number): ProgressEntry[] {
	return raw.map((e) => ({ ts: str(e.ts), rel: relTime(e.ts, now), text: formatProgressEntry(e), segments: progressSegments(e) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// O modelo completo

export interface ControlModel {
	featureId: string;
	/** plan.json presente — false = feature não convergiu ainda. */
	exists: boolean;
	state: RunState;
	/** ISO do início do run (primeiro run_started; fallback plan.createdAt). */
	startedAt?: string;
	/** tempo ATIVO em ms (pausas excluídas) — o "Time" do header (doc 11 §5); null se não iniciou. */
	activeMs: number | null;
	/** segmentos da barra (work items = tasks + ship gate; denominador constante → monotônico). */
	counts: ProgressCounts;
	pauseReason?: string;
	gateInjected: boolean;
	assertions: AssertionCounts;
	tasks: TaskRow[];
	tasksDone: number;
	tasksTotal: number;
	active: ActiveItem | null;
	workers: WorkerRow[];
	/** os handoffs crus (pro handoff viewer renderizar Summary/Undone/Issues). */
	handoffsRaw: PersistedHandoff[];
	progress: ProgressEntry[];
	coverage: CoverageRow[];
	/** record da entrega (PR + CI + merge) — null até o passo harness-deliver correr. */
	delivery: DeliveryRecord | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Faixa sempre-visível (§2): partes PURAS pro widget aboveEditor (a view pinta).

export interface StripParts {
	icon: string;
	state: RunState;
	bar: ProgressBar;
	/** "3/8" (work items completed/total). */
	ratio: string;
	/** estimate (`[+N]`) — passos de ship gate ainda não materializados. */
	estimate: number;
	/** "task T2" · "ship gate: qa-validator" · "all done" · "idle". */
	active: string;
	/** mostra ● Live (run em andamento, não completo). */
	live: boolean;
}

/**
 * Projeta o model nas partes da faixa. Barra: enquanto o ship gate ainda NÃO decidiu nenhuma
 * assertion (passed+failed=0), segue as TASKS (o trabalho visível) — evita o "0/N assertions"
 * enquanto tasks completam. Quando o gate começa a decidir, passa pra assertions (a definição
 * contratual de "done"). Fallback a tasks quando não há assertions.
 */
export function stripParts(model: ControlModel, barWidth = 16): StripParts {
	const c = model.counts;
	let active = "idle";
	if (model.active) {
		active = model.active.kind === "ship-gate" ? `ship gate: ${model.active.skillName.replace("harness-", "")}` : `task ${model.active.id}`;
		// vai pra statusline via setStatus (sem clip downstream garantido): task ids longos truncam
		if (active.length > 32) active = `${active.slice(0, 31)}…`;
	} else if (model.state === "completed") {
		active = "all done";
	}
	return {
		icon: stateIcon(model.state),
		state: model.state,
		bar: progressBar(c, barWidth),
		ratio: `${c.completed}/${c.total}`,
		estimate: c.estimate,
		active,
		live: model.state !== "completed",
	};
}

export interface ControlInputs {
	featureId: string;
	plan: Plan | null;
	status: PlanStatus | null;
	run: FeatureRun | null;
	/** O worker está VIVO? (pid do run.lock) — corrige o "running" fantasma pós-crash. */
	workerAlive?: boolean;
	handoffs: PersistedHandoff[];
	progressRaw: ProgressRaw[];
	/** passos de ship gate a contar na barra (2 − skips); default 2. readControlModel lê do config. */
	gateSteps?: number;
	/** record da entrega (validation/delivery/record.json) — null se ainda não existe. */
	delivery?: DeliveryRecord | null;
	now?: number;
}

/** ISO do início do run: primeiro `run_started` no log; fallback `plan.createdAt`. */
function runStartedAt(progressRaw: ProgressRaw[], plan: Plan | null): string | undefined {
	const ev = progressRaw.find((e) => str(e.event) === "run_started" && e.ts);
	return (ev?.ts as string | undefined) ?? plan?.createdAt;
}

/** Builder PURO: dados já parseados → ControlModel. */
export function buildControlModel(input: ControlInputs): ControlModel {
	const now = input.now ?? Date.now();
	const disk: DiskSignals = { handoffs: input.handoffs, progressRaw: input.progressRaw };
	const tasks = buildTaskRows(input.plan, input.run, disk);
	const active = activeItem(input.plan, input.run, disk);
	// Destaque ÚNICO e CONSISTENTE com o painel Active Task: a flag `active` da row segue
	// EXCLUSIVAMENTE o activeItem (o `next_task` emite um task_started por task, então o ativo anda
	// sozinho). Quando não há sinal de qual corre (activeItem null) NENHUMA row fica destacada.
	for (const t of tasks) t.active = active !== null && t.id === active.id;
	const tasksTotal = input.plan?.tasks.length ?? 0;
	const tasksDone = tasks.filter((t) => t.status === "completed").length;
	const state = deriveRunState(input);
	// Barra (work items = tasks + ship gate): o gate materializa quando todas as tasks terminam
	// (ou gateInjected / ship_gate_injected); até lá conta como `░` estimate.
	const gateSteps = input.gateSteps ?? 2;
	const tasksTerminal = tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "cancelled");
	const gateMaterialized = (input.run?.gateInjected ?? false) || input.progressRaw.some((e) => str(e.event) === "ship_gate_injected") || (gateSteps > 0 && tasksTerminal);
	const counts = progressCounts({ tasks, gateSteps, gateMaterialized, gateDone: gateDoneCount(input.handoffs, input.status, gateSteps), complete: state === "completed" });
	return {
		featureId: input.featureId,
		exists: input.plan !== null,
		state,
		startedAt: runStartedAt(input.progressRaw, input.plan),
		activeMs: activeElapsedMs(state, input.progressRaw, now),
		counts,
		pauseReason: input.run?.pauseReason,
		gateInjected: input.run?.gateInjected ?? false,
		assertions: assertionCounts(input.status),
		tasks,
		tasksDone,
		tasksTotal,
		active,
		workers: buildWorkerRows(input.run, input.handoffs, input.progressRaw, now),
		handoffsRaw: input.handoffs,
		progress: buildProgressEntries(input.progressRaw, now),
		coverage: coverageRows(input.plan, input.status),
		delivery: input.delivery ?? null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// IO: lê os ficheiros do run e constrói o modelo. null se não há plan (não existe).

/** Lê todos os handoffs persistidos de um run (handoffs/<task>__<wsid>.json). */
export function readHandoffs(cwd: string, featureId: string): PersistedHandoff[] {
	const dir = path.join(runDir(cwd, featureId), "handoffs");
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: PersistedHandoff[] = [];
	for (const f of files) {
		try {
			out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as PersistedHandoff);
		} catch {
			// ficheiro corrompido — ignora (a TUI é read-only e tolerante)
		}
	}
	return out;
}

/** Lê e parseia progress_log.jsonl (linhas inválidas são puladas). */
export function readProgressLog(cwd: string, featureId: string): ProgressRaw[] {
	const file = path.join(runDir(cwd, featureId), "progress_log.jsonl");
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: ProgressRaw[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			out.push(JSON.parse(t) as ProgressRaw);
		} catch {
			// linha parcial/corrompida — pula
		}
	}
	return out;
}

/** Lê tudo do disco e constrói o ControlModel. null se não há plan.json (feature não convergiu). */
/** Passos de ship gate a contar na barra = 3 − skips (do config global). Falha tolerante → 3. */
function configGateSteps(): number {
	try {
		const g = loadModelConfig().gates;
		return 3 - (g.skipScrutiny ? 1 : 0) - (g.skipUserTesting ? 1 : 0) - (g.skipDelivery ? 1 : 0);
	} catch {
		return 3;
	}
}

/**
 * O worker do run está VIVO? Só devolve um sinal DEFINITIVO quando há um run.lock com pid: `true`
 * (pid vivo) ou `false` (pid morto — o "● Running" fantasma pós-crash, ex.: o worker foi morto sem
 * libertar o lock). `undefined` = sem lock / lock ilegível → sinal incerto, o caller NÃO faz
 * downgrade (o runner adquire o lock ao iniciar e liberta-o ao sair limpo, então "sem lock" não
 * prova morte; evita degradar fixtures/estados sem lock).
 */
function workerAliveOnDisk(cwd: string, featureId: string): boolean | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(cwd, ".harness", "runs", featureId, "run.lock"), "utf8");
	} catch {
		return undefined; // sem run.lock → incerto (não prova que morreu)
	}
	try {
		const pid = (JSON.parse(raw) as { pid?: number }).pid;
		if (typeof pid !== "number") return undefined;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false; // pid morto → stale "running"
		}
	} catch {
		return undefined; // lock corrompido → incerto
	}
}

export function readControlModel(cwd: string, featureId: string, now?: number): ControlModel | null {
	const plan = readPlan(cwd, featureId);
	if (!plan) return null;
	return buildControlModel({
		featureId,
		plan,
		status: readStatus(cwd, featureId),
		run: readFeatureRun(cwd, featureId),
		workerAlive: workerAliveOnDisk(cwd, featureId),
		handoffs: readHandoffs(cwd, featureId),
		progressRaw: readProgressLog(cwd, featureId),
		gateSteps: configGateSteps(),
		delivery: readDeliveryRecord(cwd, featureId),
		now,
	});
}
