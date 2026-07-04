/**
 * Live agents registry — os workers que estão RODANDO AGORA como `Agent`
 * (@tintinweb/pi-subagents), que NÃO existem em disco ainda (sem handoff até o EndFeatureRun) e por
 * isso não apareciam no Feature Control. A extensão observa os eventos `tool_execution_*` do tool
 * `Agent` e popula este registro; o overlay (Active Worker + Workers) e o run card leem
 * `listLiveAgents()` e mostram os workers ao vivo (com #task, skill, tool/token counts).
 *
 * PROVIDER ÚNICO: `@tintinweb/pi-subagents` (o tool `Agent`, args `{prompt, subagent_type,
 * description}`, `details` = um `AgentDetails` com `agentId` + `activity`). O transcript real do
 * worker é lido pelo painel a partir do `.output` JSONL que o @tintinweb streama (localizado via
 * `agentId` + a sessão-pai; ver src/session-read.ts). O `AgentDetails` só expõe UMA string
 * `activity` por frame, então acumulamos um buffer rolante (mergeActivity) pro FALLBACK do painel
 * quando o `.output` ainda não existe.
 *
 * As funções de extração/parse são PURAS (testáveis: test/live-agents.test.ts); o store é um
 * Map em memória keyed por toolCallId (uma chamada `Agent` = um agent; buffer de activity keyed
 * por `${toolCallId}#${index}`).
 */

export interface LiveAgent {
	index: number;
	/** task id parseado do prompt/description ("T1", "ship-gate-qa-validator") ou "—". */
	taskId: string;
	/** o agent type do subagent (o `subagent_type`, ex.: "harness-worker"). */
	agent: string;
	/** rótulo curto pra UI (snippet do task/description). */
	label: string;
	status: "running" | "pending";
	toolCount: number;
	tokens: number;
	currentTool?: string;
	/** buffer rolante das últimas ~N atividades (o `recentActivity`) — FALLBACK do painel. */
	recentActivity: string[];
	/** o id do agent record do @tintinweb (→ localiza o `.output` JSONL do transcript real). */
	agentId?: string;
}

/**
 * Nome do tool que spawna workers/reviewers. PROVIDER ÚNICO: `@tintinweb/pi-subagents` expõe o
 * tool `Agent` (case-sensitive). O caminho nativo do harness (Active Worker + Workers) casa por
 * este nome.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent"]);
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

function shortLabel(task: string, agent?: string): string {
	const s = oneLine(task);
	if (!s) return agent ?? "worker";
	return s.length > 44 ? `${s.slice(0, 43)}…` : s;
}

/**
 * Merge rolante de atividade (PURO, testável): anexa os itens de `next` que não sejam repetição
 * do tail atual de `prev`, dedup consecutivo, cap nos últimos `cap`. É o que transforma a única
 * string `activity` do @tintinweb (uma por frame) num feed das últimas ~N atividades pro FALLBACK
 * do painel quando o `.output` real ainda não existe.
 */
export function mergeActivity(prev: string[], next: string[], cap = 8): string[] {
	const out = [...(prev ?? [])];
	for (const raw of next ?? []) {
		const item = oneLine(raw);
		if (!item) continue;
		if (out[out.length - 1] === item) continue; // dedup consecutivo
		out.push(item);
	}
	return out.length > cap ? out.slice(-cap) : out;
}

/**
 * Seed inicial a partir dos args (no tool_execution_start, antes de haver details). @tintinweb
 * `Agent`: `{ prompt, subagent_type, description }` (um agent por chamada). Parseia o id da
 * `description` ("Run T6 web-worker") com fallback pro prompt.
 */
export function agentsFromArgs(args: unknown): LiveAgent[] {
	const a = args as Record<string, unknown> | null | undefined;
	if (!a || typeof a !== "object" || typeof a.prompt !== "string") return [];
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

/**
 * Extrai o agent RODANDO do `details` (um `AgentDetails` do @tintinweb) do partialResult/result do
 * tool `Agent`. Só running/background/queued são live; completed/steered/stopped/error/aborted viram
 * handoff em disco (o tool_execution_end limpa). Captura `agentId` (→ localiza o `.output` do
 * transcript real) e a string `activity` (→ buffer rolante do fallback).
 */
export function agentsFromDetails(details: unknown): LiveAgent[] {
	const d = details as Record<string, unknown> | null | undefined;
	if (!d || typeof d !== "object") return [];
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
			agentId: typeof d.agentId === "string" ? d.agentId : undefined,
		},
	];
}

// ─────────────────────────────────────────────────────────────────────────────
// Store em memória (keyed por toolCallId) + buffer rolante de activity

const reg = new Map<string, LiveAgent[]>();
/** Buffer rolante de activity keyed por `${toolCallId}#${index}` (fallback do painel). */
const activityBuf = new Map<string, string[]>();

export function setLiveAgents(toolCallId: string, agents: LiveAgent[]): void {
	if (agents.length === 0) {
		reg.delete(toolCallId);
		for (const k of activityBuf.keys()) if (k.startsWith(`${toolCallId}#`)) activityBuf.delete(k);
		return;
	}
	// Acumula a activity de cada frame num buffer rolante por agent (o @tintinweb só dá 1 string
	// por update) — vira o feed do fallback do painel quando o `.output` real ainda não existe.
	for (const a of agents) {
		const key = `${toolCallId}#${a.index}`;
		const merged = mergeActivity(activityBuf.get(key) ?? [], a.recentActivity);
		activityBuf.set(key, merged);
		a.recentActivity = merged;
	}
	reg.set(toolCallId, agents);
}
export function clearLiveAgents(toolCallId: string): void {
	reg.delete(toolCallId);
	for (const k of activityBuf.keys()) if (k.startsWith(`${toolCallId}#`)) activityBuf.delete(k);
}
export function clearAllLiveAgents(): void {
	reg.clear();
	activityBuf.clear();
}

/** Todos os agents rodando agora (achatado), ordenados por index. */
export function listLiveAgents(): LiveAgent[] {
	const all: LiveAgent[] = [];
	for (const list of reg.values()) all.push(...list);
	return all.sort((a, b) => a.index - b.index);
}
