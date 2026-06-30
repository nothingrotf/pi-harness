/**
 * Builders PUROS das views do overlay Feature Control (docs/03-tui.md §6) — sem value-import
 * de pi, testáveis isolados (test/control-rows.test.ts). control-view.ts liga isto a SelectList/
 * Text + teclas. Rebrand do Mission Control: Features→Tasks, +Coverage (nosso diferencial),
 * Workers, Task detail, Handoff viewer. Sub-views sem borda própria (renderizam na frame).
 */
import type { AssertionStatus } from "./plan.ts";
import { type ControlModel, type TaskRow, type TaskStatusV, formatDuration, taskIcon, type WorkerRow, workerIcon } from "./control-model.ts";
import { deliveryDisplayLines } from "./delivery.ts";
import type { LiveAgent } from "./live-agents.ts";
import { rangeLabel, truncate, twoColumn } from "./control-render.ts";

export interface Row {
	value: string;
	label: string;
	description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtros cicláveis (`T`) — inline ` │ `, sem `[ ]` (traced).

export type TaskFilter = "all" | "pending" | "in_progress" | "completed" | "cancelled";
export const TASK_FILTERS: TaskFilter[] = ["all", "pending", "in_progress", "completed", "cancelled"];

export type WorkerFilter = "all" | "active" | "completed" | "failed";
export const WORKER_FILTERS: WorkerFilter[] = ["all", "active", "completed", "failed"];

/** Avança um filtro ciclicamente. */
export function cycleFilter<T>(list: readonly T[], cur: T): T {
	const i = list.indexOf(cur);
	return list[(i + 1) % list.length];
}

const FILTER_LABEL: Record<string, string> = {
	all: "All",
	pending: "Pending",
	in_progress: "In Progress",
	completed: "Completed",
	cancelled: "Cancelled",
	active: "Active",
	failed: "Failed",
};
export function filterLabel(f: string): string {
	return FILTER_LABEL[f] ?? f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (F)

export function filterTasks(tasks: TaskRow[], f: TaskFilter): TaskRow[] {
	if (f === "all") return tasks;
	return tasks.filter((t) => t.status === f);
}

/** Linhas da sub-view Tasks: label `<icon> <id>  <desc>`, description `→ fulfills`. */
export function taskDisplayRows(model: ControlModel, f: TaskFilter): Row[] {
	return filterTasks(model.tasks, f).map((t) => ({
		value: t.id,
		label: `${taskIcon(t.status)} ${t.id}  ${truncate(t.description, 46)}`,
		description: t.fulfills.length ? `→ ${t.fulfills.join(", ")}` : "",
	}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Workers (W)

export function filterWorkers(workers: WorkerRow[], f: WorkerFilter): WorkerRow[] {
	if (f === "all") return workers;
	if (f === "active") return workers.filter((w) => w.status === "running");
	if (f === "completed") return workers.filter((w) => w.status === "success" || w.status === "partial");
	return workers.filter((w) => w.status === "failed" || w.status === "returned");
}

function shortId(id: string): string {
	return id === "—" ? id : id.slice(0, 8);
}

/** Linhas da sub-view Workers: label `<icon> #n <task>  <wsid>`, description `<status> · <duração>`. */
export function workerDisplayRows(model: ControlModel, f: WorkerFilter): Row[] {
	return filterWorkers(model.workers, f).map((w, i) => {
		const num = w.workerNumber ? `#${w.workerNumber} ` : "";
		const dur = formatDuration(w.durationMs);
		return {
			value: `${w.workerSessionId}__${w.taskId}__${i}`,
			label: `${workerIcon(w.status)} ${num}${w.taskId}  ${shortId(w.workerSessionId)}`,
			description: `${w.status}${dur ? ` · ${dur}` : ""}`,
		};
	});
}

/** Stats curtos de um live agent: "10 tools · 72k tokens" (omite zeros). */
function liveStats(a: LiveAgent): string {
	const parts: string[] = [];
	if (a.toolCount > 0) parts.push(`${a.toolCount} tool${a.toolCount === 1 ? "" : "s"}`);
	if (a.tokens > 0) parts.push(`${a.tokens >= 1000 ? `${Math.round(a.tokens / 1000)}k` : a.tokens} tokens`);
	if (a.currentTool) parts.push(a.currentTool);
	return parts.join(" · ");
}

/**
 * Linhas de Workers AO VIVO (subagents rodando agora, ainda sem handoff em disco) — prefixadas
 * à lista de Workers. value `live__<idx>` (não abre handoff: ainda não existe).
 */
export function liveAgentRows(live: LiveAgent[]): Row[] {
	return live.map((a, i) => ({
		value: `live__${i}`,
		label: `${workerIcon("running")} ${a.taskId}  ${truncate(a.label, 30)}`,
		description: `running · ${liveStats(a) || "starting…"}`,
	}));
}

/** Texto da faixa Active Worker pro live agent (ou null se não há live). */
export function liveActiveWorkerText(live: LiveAgent[]): string | null {
	if (live.length === 0) return null;
	const a = live[0];
	const stats = liveStats(a);
	const more = live.length > 1 ? `  (+${live.length - 1} more)` : "";
	return `#${a.taskId} · ${a.label}${stats ? ` · ${stats}` : ""}${more}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage (C) — nosso diferencial: assertion → task que a fulfills → status

const ASSERT_ICON: Record<AssertionStatus, string> = { passed: "✓", failed: "✘", pending: "○" };
export function assertIcon(s: AssertionStatus): string {
	return ASSERT_ICON[s];
}

export function coverageDisplayRows(model: ControlModel): Row[] {
	return model.coverage.map((c) => ({
		value: c.assertion,
		label: `${assertIcon(c.status)} ${c.assertion}`,
		description: `→ ${c.taskId ?? "—"} · ${c.status}`,
	}));
}

/** Resumo de cobertura "passed/total · M uncovered" pro cabeçalho da view. */
export function coverageSummary(model: ControlModel): string {
	const total = model.coverage.length;
	const covered = model.coverage.filter((c) => c.taskId !== null).length;
	const passed = model.assertions.passed;
	const orphan = total - covered;
	return `${passed}/${total} passed${orphan > 0 ? ` · ${orphan} uncovered` : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress Log

export interface ProgressLogView {
	lines: string[];
	range: string;
}

/** Últimas `max` entries (mais antiga → recente), com tempo relativo + range. */
export function progressLogLines(model: ControlModel, max: number, width = 60): ProgressLogView {
	const total = model.progress.length;
	const tail = model.progress.slice(Math.max(0, total - max));
	const start = total === 0 ? 0 : total - tail.length + 1;
	const lines = tail.map((e) => truncate(`${(e.rel || "·").padStart(8)}  ${e.text}`, width));
	return { lines: lines.length ? lines : ["(no progress entries yet)"], range: rangeLabel(start, total, total) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view (duas colunas) — partes plain; o caller pinta o header/barra à parte.

const ACTIVE_EDGE: Record<string, string> = {
	completed: "All tasks completed.",
	unknown: "Waiting to start…",
};

function activeTaskLines(model: ControlModel): string[] {
	const a = model.active;
	if (!a) return ["Active Task", `  ${ACTIVE_EDGE[model.state] ?? "Waiting for a task to start…"}`];
	const head = a.kind === "ship-gate" ? `  ship gate: ${a.skillName}` : `  [${a.id}] ${a.label}`;
	const meta = `  skill ${a.skillName}${a.fulfills.length ? ` · fulfills ${a.fulfills.join(", ")}` : ""}`;
	return ["Active Task", head, meta];
}

function taskListLines(model: ControlModel, cap: number): string[] {
	const out = [`Tasks (${model.tasksDone}/${model.tasksTotal})`];
	const shown = model.tasks.slice(0, cap);
	for (const t of shown) out.push(`  ${taskIcon(t.status)} ${t.id}  ${t.description}`);
	const more = model.tasks.length - shown.length;
	if (more > 0) out.push(`  +${more} more`);
	return out;
}

/** A linha "Active Worker" sob as colunas. */
export function activeWorkerLine(model: ControlModel): string {
	const running = model.workers.find((w) => w.status === "running");
	if (!running) return "Active Worker: —";
	return `Active Worker: ${shortId(running.workerSessionId)} · ${running.taskId} · running`;
}

/** Largura da coluna esquerda do main (clamp 24..width-18, ~52%). */
export function leftColWidth(width: number): number {
	return Math.max(24, Math.min(Math.floor(width * 0.52), width - 18));
}

/**
 * Corpo do main view (plain): duas colunas (Active Task + Tasks | Progress Log) + a linha
 * Active Worker. O caller desenha header/barra/footer à parte. Determinístico → testável.
 */
export function mainLines(model: ControlModel, width: number, opts: { taskCap?: number; logCap?: number } = {}): string[] {
	const leftW = leftColWidth(width);
	const rightW = Math.max(16, width - leftW - 3);
	const taskCap = opts.taskCap ?? 6;
	const left = [...activeTaskLines(model), "", ...taskListLines(model, taskCap)];
	const log = progressLogLines(model, opts.logCap ?? left.length, rightW);
	const right = [`Progress Log${log.range ? `   (${log.range})` : ""}`, ...log.lines];
	const cols = twoColumn(left, right, leftW);
	return [...cols, "", activeWorkerLine(model)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Drilldowns

function bullets(items: string[], cap: number): string[] {
	const out: string[] = [];
	const shown = items.slice(0, cap);
	for (const it of shown) out.push(`  • ${it}`);
	const more = items.length - shown.length;
	if (more > 0) out.push(`  … +${more} more`);
	if (out.length === 0) out.push("  —");
	return out;
}

const TASK_STATUS_LABEL: Record<TaskStatusV, string> = {
	completed: "Completed",
	in_progress: "In Progress",
	returned: "Returned to orchestrator",
	pending: "Pending",
	cancelled: "Cancelled",
};

/** Task detail (Enter numa task): descrição + preconditions + expected behavior + fulfills + workers. */
export function taskDetailLines(model: ControlModel, taskId: string, expanded: boolean): string[] {
	const t = model.tasks.find((x) => x.id === taskId);
	if (!t) return [`Task ${taskId} not found`];
	const lines: string[] = [];
	lines.push(`[${t.id}]  ${TASK_STATUS_LABEL[t.status]}  ·  skill ${t.skillName}`);
	lines.push("");
	lines.push("Description");
	const desc = t.description.split("\n");
	if (expanded || desc.length <= 3) for (const d of desc) lines.push(`  ${d}`);
	else {
		for (const d of desc.slice(0, 3)) lines.push(`  ${d}`);
		lines.push(`  … +${desc.length - 3} more line(s); space to expand`);
	}
	lines.push("");
	lines.push("Preconditions");
	lines.push(...bullets(t.preconditions, expanded ? 99 : 3));
	lines.push("");
	lines.push("Expected Behavior");
	lines.push(...bullets(t.expectedBehavior, expanded ? 99 : 3));
	lines.push("");
	lines.push(`fulfills: ${t.fulfills.length ? t.fulfills.join(", ") : "—"}`);
	lines.push("");
	lines.push("Worker Sessions");
	const ws = model.workers.filter((w) => w.taskId === taskId);
	if (ws.length === 0) lines.push("  (no worker sessions yet)");
	else for (const w of ws) lines.push(`  ${workerIcon(w.status)} ${shortId(w.workerSessionId)}  ${w.status}`);
	return lines;
}

/** Delivery viewer (aba `D`): PR + issue Linear + CI + fix-loop + estado de merge (read-only). */
export function deliveryLines(model: ControlModel): string[] {
	return deliveryDisplayLines(model.delivery);
}

/** Handoff viewer (`h`): renderiza o EndFeatureRun cru (Summary / Undone / Discovered Issues). */
export function handoffLines(model: ControlModel, workerSessionId: string): string[] {
	const h = model.handoffsRaw.find((x) => x.workerSessionId === workerSessionId);
	if (!h) return ["Worker Handoff", "", "Failed to load handoff (no record for this worker)."];
	const lines: string[] = [];
	lines.push(`Session: ${shortId(h.workerSessionId)}  ·  Feature: ${h.taskId}  ·  ${h.successState}`);
	lines.push("");
	lines.push("Summary");
	lines.push(`  ${h.handoff.salientSummary || h.handoff.whatWasImplemented || "(no summary provided)"}`);
	lines.push("");
	lines.push("What Was Left Undone");
	lines.push(`  ${h.handoff.whatWasLeftUndone?.trim() || "(nothing left undone)"}`);
	lines.push("");
	lines.push("Discovered Issues");
	const issues = h.handoff.discoveredIssues ?? [];
	if (issues.length === 0) lines.push("  (none)");
	else
		for (const it of issues) {
			lines.push(`  ⚠ [${it.severity}] ${it.description}`);
			if (it.suggestedFix) lines.push(`     Suggested fix: ${it.suggestedFix}`);
		}
	return lines;
}
