/**
 * Progresso ao vivo do ReadinessRunner — o analog do "progresso ao vivo" do modelo de referência.
 * Lê os eventos JSONL do child (`pi --print --mode json`: tool_execution_start,
 * turn_start, agent_end) + o estado do run, e produz as linhas do widget
 * (setWidget aboveEditor). Tudo puro/testável; o extension só liga ao TUI.
 */
import type { ReadinessRun, RunStatus } from "./readiness-runner.ts";

export interface ActiveStepView {
	stepId: string;
	toolCalls: number;
	turns: number;
	lastAction?: string;
	elapsedMs: number;
}

export interface ProgressView {
	title: string; // "readiness audit" | "readiness fix · 2/5"
	status: RunStatus;
	steps: { id: string; kind: "audit" | "fix"; criterionId?: string; status: string }[];
	active?: ActiveStepView;
}

const MAX_LINES = 14;

function clock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function mark(status: string): string {
	if (status === "completed") return "✓";
	if (status === "in_progress") return "▸";
	if (status === "failed") return "✗";
	return "·";
}

/** Linhas do widget (puro). Colapsa completos quando passa de MAX_LINES. */
export function progressLines(v: ProgressView): string[] {
	const lines: string[] = [`⬢ pi-harness · ${v.title} · ${v.status}`];
	const completed = v.steps.filter((s) => s.status === "completed").length;

	// quando há muitos passos, mostra só um resumo + o ativo + pendentes próximos
	const dense = v.steps.length + 2 > MAX_LINES;
	for (const s of v.steps) {
		if (dense && s.status === "completed") continue; // colapsa completos no modo denso
		const label = s.kind === "audit" ? "audit" : `fix ${s.criterionId ?? ""}`.trim();
		let line = `  ${mark(s.status)} ${label}`;
		if (s.status === "in_progress" && v.active) {
			const turns = v.active.turns ? ` · turn ${v.active.turns}` : "";
			line += `   ◷ ${clock(v.active.elapsedMs)} · ${v.active.toolCalls} tools${turns}`;
		}
		lines.push(line);
		if (s.status === "in_progress" && v.active?.lastAction) lines.push(`      ${v.active.lastAction}`);
	}
	if (dense && completed > 0) lines.splice(1, 0, `  ✓ ${completed}/${v.steps.length} done`);
	return lines.slice(0, MAX_LINES);
}

/** Argumento curto de um tool call pra mostrar a ação corrente. */
function shortArg(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = a.command ?? a.path ?? a.pattern ?? a.file ?? a.target_file ?? a.query;
	const s = typeof pick === "string" ? pick : "";
	const one = s.replace(/\s+/g, " ").trim();
	return `${toolName}${one ? `: ${one.length > 60 ? `${one.slice(0, 57)}…` : one}` : ""}`;
}

interface Acc {
	toolCalls: number;
	turns: number;
	lastAction?: string;
	startedAt?: number;
}

/**
 * Acumula eventos do child por passo e projeta a ProgressView a partir do `run`
 * (referência viva). Injeção de `now` pra teste.
 */
export class ProgressTracker {
	private acc = new Map<string, Acc>();
	private readonly run: ReadinessRun;
	private readonly title: string;
	private readonly now: () => number;
	constructor(run: ReadinessRun, title: string, now: () => number = () => Date.now()) {
		this.run = run;
		this.title = title;
		this.now = now;
	}

	/** Consome um evento JSONL do child do passo `stepId`. */
	onEvent(stepId: string, evt: { type?: string; toolName?: string; args?: unknown }): void {
		const a = this.acc.get(stepId) ?? { toolCalls: 0, turns: 0 };
		if (a.startedAt === undefined) a.startedAt = this.now();
		if (evt.type === "tool_execution_start") {
			a.toolCalls++;
			a.lastAction = shortArg(evt.toolName ?? "tool", evt.args);
		} else if (evt.type === "turn_start") {
			a.turns++;
		}
		this.acc.set(stepId, a);
	}

	view(): ProgressView {
		const active = this.run.steps.find((s) => s.status === "in_progress");
		const a = active ? this.acc.get(active.id) : undefined;
		return {
			title: this.title,
			status: this.run.status,
			steps: this.run.steps.map((s) => ({ id: s.id, kind: s.kind, criterionId: s.criterionId, status: s.status })),
			active:
				active && a
					? {
							stepId: active.id,
							toolCalls: a.toolCalls,
							turns: a.turns,
							lastAction: a.lastAction,
							elapsedMs: a.startedAt !== undefined ? this.now() - a.startedAt : 0,
						}
					: undefined,
		};
	}

	lines(): string[] {
		return progressLines(this.view());
	}
}
