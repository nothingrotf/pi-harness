/**
 * Live agents registry — os workers que estão RODANDO AGORA como `subagent` (pi-subagents),
 * que NÃO existem em disco ainda (sem handoff até o EndFeatureRun) e por isso não apareciam no
 * Feature Control. A extensão observa os eventos `tool_execution_*` do tool `subagent` e
 * popula este registro; o overlay (Active Worker + Workers) e o run card leem `listLiveAgents()`
 * e mostram os workers ao vivo (com #task, skill, tool/token counts).
 *
 * As funções de extração/parse são PURAS (testáveis: test/live-agents.test.ts); o store é um
 * Map em memória keyed por toolCallId (uma chamada `subagent` pode ter N tasks paralelas).
 */

export interface LiveAgent {
	index: number;
	/** task id parseado do prompt ("T1", "ship-gate-qa-validator") ou "—". */
	taskId: string;
	/** o agent type do subagent (ex.: "harness-worker"). */
	agent: string;
	/** rótulo curto pra UI (snippet do task). */
	label: string;
	status: "running" | "pending";
	toolCount: number;
	tokens: number;
	currentTool?: string;
	/** últimas ~4 atividades (o `recentActivity`/`Qb1` do doc 10) — tool calls + saída recente. */
	recentActivity: string[];
}

/**
 * Nomes do tool que spawna workers/reviewers como subagent. Dois fornecedores no ecossistema:
 * `subagent` (pi-subagents, args {agent,task}, details {progress[]}) e `Agent`
 * (@tintinweb/pi-subagents, args {prompt,subagent_type,description}, details AgentDetails único).
 * O caminho nativo do harness funciona com QUALQUER um — por isso casamos os dois.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent", "Agent"]);
export function isSubagentTool(name: string): boolean {
	return SUBAGENT_TOOL_NAMES.has(name);
}

/** Converte um count de tokens (number ou string formatada "33.8k"/"1.2M") em number. */
export function parseTokens(v: unknown): number {
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (typeof v !== "string") return 0;
	const m = v.match(/([\d.]+)\s*([kKmM])?/);
	if (!m) return 0;
	const n = Number.parseFloat(m[1]);
	if (!Number.isFinite(n)) return 0;
	const unit = m[2]?.toLowerCase();
	const mult = unit === "m" ? 1_000_000 : unit === "k" ? 1000 : 1;
	return Math.round(n * mult);
}

/** Extrai o task id do texto da task (o bootstrap referencia o id). ship-gate-* tem prioridade. */
export function parseTaskId(task: string): string {
	const gate = task.match(/ship-gate-[a-z0-9-]+/i);
	if (gate) return gate[0];
	const t = task.match(/\bT\d+\b/);
	if (t) return t[0];
	return "—";
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function snippet(s: string, n = 40): string {
	const t = oneLine(s);
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Constrói o feed de atividade recente do AgentProgress (recentTools + currentTool + recentOutput). */
function recentActivityFrom(p: Record<string, unknown>, max = 4): string[] {
	const out: string[] = [];
	const recentTools = Array.isArray(p?.recentTools) ? p.recentTools : [];
	for (const rt of recentTools) {
		const t = rt as Record<string, unknown>;
		if (typeof t?.tool === "string") out.push(`${t.tool}${typeof t?.args === "string" && t.args.trim() ? `: ${snippet(t.args, 38)}` : ""}`);
	}
	if (typeof p?.currentTool === "string") out.push(`${p.currentTool}${typeof p?.currentToolArgs === "string" && p.currentToolArgs.trim() ? `: ${snippet(p.currentToolArgs, 38)}` : ""}`);
	if (out.length === 0) {
		const recentOutput = Array.isArray(p?.recentOutput) ? p.recentOutput : [];
		for (const o of recentOutput) if (typeof o === "string" && o.trim()) out.push(snippet(o, 42));
	}
	return out.slice(-max);
}
function shortLabel(task: string, agent?: string): string {
	const s = oneLine(task);
	if (!s) return agent ?? "worker";
	return s.length > 44 ? `${s.slice(0, 43)}…` : s;
}

/** Coleta {agent, task} dos args do tool subagent (single | tasks[] | chain[] | parallel[]). */
function collectTasks(args: unknown): { agent: string; task: string }[] {
	const out: { agent: string; task: string }[] = [];
	const a = args as Record<string, unknown> | null | undefined;
	if (!a || typeof a !== "object") return out;
	const push = (x: unknown): void => {
		const o = x as Record<string, unknown> | null;
		if (o && typeof o.task === "string") out.push({ agent: typeof o.agent === "string" ? o.agent : "worker", task: o.task });
	};
	if (typeof a.task === "string") out.push({ agent: typeof a.agent === "string" ? a.agent : "worker", task: a.task });
	if (Array.isArray(a.tasks)) for (const t of a.tasks) push(t);
	if (Array.isArray(a.chain))
		for (const s of a.chain as unknown[]) {
			push(s);
			const so = s as Record<string, unknown>;
			if (Array.isArray(so?.parallel)) for (const p of so.parallel) push(p);
		}
	return out;
}

/** Seed inicial a partir dos args (no tool_execution_start, antes de haver progress). */
export function agentsFromArgs(args: unknown): LiveAgent[] {
	const a = args as Record<string, unknown> | null | undefined;
	// @tintinweb/pi-subagents `Agent`: { prompt, subagent_type, description } (um agent por chamada).
	// Sem os campos {task,tasks,chain} do pi-subagents — detecta pelo `prompt` e parseia o id da
	// `description` ("Run T6 web-worker") com fallback pro prompt.
	if (a && typeof a === "object" && typeof a.prompt === "string" && !("task" in a) && !("tasks" in a) && !("chain" in a)) {
		const desc = typeof a.description === "string" && a.description.trim() ? a.description : a.prompt;
		const agent = typeof a.subagent_type === "string" && a.subagent_type.trim() ? a.subagent_type : "worker";
		return [
			{
				index: 0,
				taskId: parseTaskId(`${desc} ${a.prompt}`),
				agent,
				label: shortLabel(desc, agent),
				status: "running" as const,
				toolCount: 0,
				tokens: 0,
				recentActivity: [],
			},
		];
	}
	return collectTasks(args).map((t, i) => ({
		index: i,
		taskId: parseTaskId(t.task),
		agent: t.agent,
		label: shortLabel(t.task, t.agent),
		status: "running" as const,
		toolCount: 0,
		tokens: 0,
		recentActivity: [],
	}));
}

/**
 * Extrai os agents RODANDO do `details.progress` (AgentProgress[]) do partialResult/result do
 * subagent. Só status running/pending; ignora completed/failed (esses viram handoffs em disco).
 */
export function agentsFromDetails(details: unknown): LiveAgent[] {
	const d = details as Record<string, unknown> | null | undefined;
	if (!d || typeof d !== "object") return [];
	const progress = d.progress;
	// @tintinweb/pi-subagents: details é UM AgentDetails (sem `progress[]`). Só running/background/queued
	// são live; completed/steered/stopped/error/aborted viram handoff em disco (tool_execution_end limpa).
	if (!Array.isArray(progress)) {
		const status = String(d.status ?? "");
		const live = status === "running" || status === "background" ? "running" : status === "queued" ? "pending" : null;
		if (!live) return [];
		const desc = String(d.description ?? d.displayName ?? "");
		const agent = String(d.subagentType ?? d.displayName ?? "worker");
		const activity = typeof d.activity === "string" && d.activity.trim() ? d.activity : "";
		return [
			{
				index: 0,
				taskId: parseTaskId(desc),
				agent,
				label: shortLabel(desc, agent),
				status: live,
				toolCount: typeof d.toolUses === "number" ? d.toolUses : 0,
				tokens: parseTokens(d.tokens),
				currentTool: activity ? snippet(activity, 38) : undefined,
				recentActivity: activity ? [snippet(activity, 42)] : [],
			},
		];
	}
	const out: LiveAgent[] = [];
	progress.forEach((raw, i) => {
		const p = raw as Record<string, unknown>;
		const status = String(p?.status ?? "");
		if (status !== "running" && status !== "pending") return;
		const task = String(p?.task ?? "");
		out.push({
			index: typeof p?.index === "number" ? p.index : i,
			taskId: parseTaskId(task),
			agent: String(p?.agent ?? "worker"),
			label: shortLabel(task, String(p?.agent ?? "")),
			status: status === "pending" ? "pending" : "running",
			toolCount: typeof p?.toolCount === "number" ? p.toolCount : 0,
			tokens: typeof p?.tokens === "number" ? p.tokens : 0,
			currentTool: typeof p?.currentTool === "string" ? p.currentTool : undefined,
			recentActivity: recentActivityFrom(p),
		});
	});
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store em memória (keyed por toolCallId)

const reg = new Map<string, LiveAgent[]>();

export function setLiveAgents(toolCallId: string, agents: LiveAgent[]): void {
	if (agents.length === 0) reg.delete(toolCallId);
	else reg.set(toolCallId, agents);
}
export function clearLiveAgents(toolCallId: string): void {
	reg.delete(toolCallId);
}
export function clearAllLiveAgents(): void {
	reg.clear();
}

/** Todos os agents rodando agora (achatado), ordenados por index. */
export function listLiveAgents(): LiveAgent[] {
	const all: LiveAgent[] = [];
	for (const list of reg.values()) all.push(...list);
	return all.sort((a, b) => a.index - b.index);
}
