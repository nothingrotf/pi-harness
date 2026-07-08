/**
 * Run card in-chat (cap. 09 — "Running a mission: the in-chat runtime UX") rebrandeado.
 * PURO, pi-free, testável (test/run-card.test.ts). Projeta o ControlModel num cartão compacto
 * e AUTO-ATUALIZÁVEL que vive no transcript (como o tool-card `start_mission_run` do Droid):
 * Preparing → live State/Progress/Current Task/Worker/Tasks → Done. Alt+T abre o Feature
 * Control full-screen (opt-in, nunca auto-navega).
 *
 * A view (registerMessageRenderer) lê um snapshot vivo deste cartão e re-renderiza a cada
 * ciclo do TUI — então o cartão "tica" no chat sem reenviar a mensagem.
 */
import { type ControlModel, type ProgressBar, progressBar, stateLabel, taskIcon } from "./control-model.ts";
import { activeWorkerModelLabel } from "./control-worker.ts";
import type { LiveAgent } from "./live-agents.ts";

export type RunPhase = "preparing" | "ready" | "running" | "paused" | "returning" | "completed";

const PHASE_SUMMARY: Record<RunPhase, string> = {
	preparing: "Preparing to start run…",
	ready: "Plan ready — run /harness run to execute",
	running: "Run in progress…",
	paused: "Run paused",
	returning: "Returning to orchestrator",
	completed: "Run completed successfully",
};

/** Fase do cartão a partir do estado do run (ready = plan FROZEN; unknown = ainda preparando). */
export function runPhase(model: ControlModel | null): RunPhase {
	if (!model) return "preparing";
	switch (model.state) {
		case "ready":
			return "ready";
		case "running":
			return "running";
		case "paused":
			return "paused";
		case "orchestrator_turn":
			return "returning";
		case "completed":
			return "completed";
		default:
			return "preparing";
	}
}

export interface RunCardRow {
	label: string;
	value: string;
}

export interface RunCard {
	phase: RunPhase;
	/** linha-resumo (ao lado do glifo ⛬): "Run in progress…", etc. */
	summary: string;
	/** linhas label→value: State · Progress · Current Task · Worker. */
	rows: RunCardRow[];
	/** mini-barra (mesma métrica do overlay: assertions passed/total, fallback tasks). */
	bar: ProgressBar;
	paused: boolean;
	/** ícones de task numa linha: "✓T1 ●T2 ○T3 …" (+N). */
	tasks: string;
	/** últimas atividades do worker vivo (o "Worker Activity" do doc 09/10). */
	activity: string[];
	/** mostra o hint "alt+t to enter Feature Control" (só quando o run está vivo). */
	showHint: boolean;
}

function workerValue(model: ControlModel): string {
	const running = model.workers.find((w) => w.status === "running");
	if (!running) return "—";
	const sid = running.workerSessionId === "—" ? "—" : running.workerSessionId.slice(0, 8);
	// Modelo EFETIVO do worker (gravado no step_started) — omitido quando herda a sessão/desconhecido.
	const mdl = activeWorkerModelLabel(running);
	return `${sid} · #${running.taskId} · running${mdl ? ` · ${mdl}` : ""}`;
}

/** Worker row a partir dos subagents AO VIVO (sem handoff em disco). null se não há live. */
function liveWorkerValue(live: LiveAgent[]): string | null {
	if (live.length === 0) return null;
	const a = live[0];
	const stats: string[] = [];
	if (a.toolCount > 0) stats.push(`${a.toolCount} tool${a.toolCount === 1 ? "" : "s"}`);
	if (a.tokens > 0) stats.push(`${a.tokens >= 1000 ? `${Math.round(a.tokens / 1000)}k` : a.tokens} tokens`);
	const label = a.label.length > 24 ? `${a.label.slice(0, 23)}…` : a.label;
	const more = live.length > 1 ? ` (+${live.length - 1})` : "";
	return `#${a.taskId} · ${label}${stats.length ? ` · ${stats.join(" · ")}` : ""} · running${more}`;
}

function tasksIcons(model: ControlModel, max: number): string {
	const shown = model.tasks.slice(0, max).map((t) => `${taskIcon(t.status)}${t.id}`);
	const more = model.tasks.length - Math.min(model.tasks.length, max);
	return shown.join(" ") + (more > 0 ? `  +${more}` : "");
}

/** Constrói o cartão a partir do model (ou null = preparando) + os subagents AO VIVO. */
export function buildRunCard(model: ControlModel | null, opts: { barWidth?: number; maxTaskIcons?: number; liveAgents?: LiveAgent[] } = {}): RunCard {
	const phase = runPhase(model);
	const barWidth = opts.barWidth ?? 18;
	if (!model) {
		return { phase, summary: PHASE_SUMMARY[phase], rows: [{ label: "State", value: "preparing" }], bar: progressBar({ completed: 0, pending: 0, estimate: 0 }, barWidth), paused: false, tasks: "", activity: [], showHint: false };
	}
	// Barra 1:1 com o Droid: work items = tasks + ship gate (model.counts, monotônico). As
	// assertions (o nosso contrato) ficam numa linha secundária.
	const c = model.counts;
	const a = model.assertions;
	const live = opts.liveAgents ?? [];
	const rows: RunCardRow[] = [
		{ label: "State", value: stateLabel(model.state) },
		{ label: "Progress", value: `${c.completed}/${c.total}${c.estimate > 0 ? ` [+${c.estimate}]` : ""}` },
	];
	if (a.total > 0) rows.push({ label: "Assertions", value: `${a.passed}/${a.total}` });
	// Current Task: o step in_progress (disco) ou, no caminho nativo (sem feature-run), o task
	// do subagent rodando agora.
	const currentTask = model.active ? (model.active.kind === "ship-gate" ? `ship gate: ${model.active.skillName.replace("harness-", "")}` : model.active.id) : live[0] && live[0].taskId !== "—" ? live[0].taskId : undefined;
	if (currentTask) rows.push({ label: "Current Task", value: currentTask });
	rows.push({ label: "Worker", value: liveWorkerValue(live) ?? workerValue(model) });
	return {
		phase,
		summary: PHASE_SUMMARY[phase],
		rows,
		bar: progressBar(c, barWidth),
		paused: model.state === "paused",
		tasks: tasksIcons(model, opts.maxTaskIcons ?? 8),
		activity: live[0]?.recentActivity ?? [],
		showHint: model.exists,
	};
}

/** Render PLANO do cartão (sem ANSI) — pra testes e p/ o fallback sem tema. */
export function runCardPlainLines(card: RunCard): string[] {
	const lines: string[] = [`⛬ harness run · ${card.summary}`];
	for (const r of card.rows) lines.push(`  ${r.label}: ${r.value}`);
	if (card.tasks) lines.push(`  Tasks: ${card.tasks}`);
	if (card.activity.length) {
		lines.push("  Worker Activity:");
		for (const a of card.activity) lines.push(`    ${a}`);
	}
	if (card.showHint) lines.push("  alt+t to enter Feature Control");
	return lines;
}
