/**
 * Live agents registry — os workers que estão RODANDO AGORA como `subagent` (pi-subagents), que
 * NÃO existem em disco ainda (sem handoff até o EndFeatureRun) e por isso não apareciam no
 * Feature Control. A extensão observa os eventos `tool_execution_*` do tool `subagent` (runs
 * FOREGROUND, `async:false`) e os eventos `subagent:async-started`/`subagent:async-complete` do
 * `pi.events` (runs ASYNC); o overlay (Active Worker + Workers) e o run card leem
 * `listLiveAgents()` e mostram os workers ao vivo (com #task, skill, tool/token counts).
 *
 * PROVIDER ÚNICO: `pi-subagents` (o tool `subagent`). Contratos observados (v0.41):
 *   - args de execução: `{agent, task}` | `{tasks: [...]}` | `{chain: [...]}` | `{workflowScript}`
 *     (chamadas com `action` são management/status — NÃO são spawns);
 *   - partial results foreground: `details.progress: AgentProgress[]` — POR AGENTE: `index`,
 *     `agent`, `status`, `task`, `currentTool`, `recentTools[]`, `recentOutput[]`, `toolCount`,
 *     `tokens` (o provider mantém os buffers rolantes; não precisamos de merge por frame);
 *   - run async aceito: `details.asyncId` + `details.asyncDir` (o tool retorna já; o tracking vive
 *     no registro ASYNC, alimentado pelos eventos + refresh via `status.json` do asyncDir).
 *
 * O transcript real do child é a SESSÃO pi dele (`session.jsonl` sob a session-root do parent, ou
 * o `sessionFile` do status.json em async) — lido pelo painel via src/session-read.ts. O
 * `recentActivity` daqui é o FALLBACK do painel enquanto a sessão do child ainda não existe.
 *
 * As funções de extração/parse são PURAS (testáveis: test/live-agents.test.ts); os stores são
 * Maps em memória (foreground keyed por toolCallId; async keyed por runId, com um status-reader
 * INJETÁVEL pro refresh — a extensão injeta o leitor fs-based de session-read.ts).
 */

export interface LiveAgent {
	index: number;
	/** task id parseado do task/description ("T1", "ship-gate-qa-validator") ou "—". */
	taskId: string;
	/** o agent do subagent (o `agent`, ex.: "harness-correctness-review"). */
	agent: string;
	/** rótulo curto pra UI (snippet do task). */
	label: string;
	status: "running" | "pending";
	toolCount: number;
	tokens: number;
	currentTool?: string;
	/** feed das últimas atividades (recentTools/recentOutput do provider) — FALLBACK do painel. */
	recentActivity: string[];
	/** id do run ASYNC (subagent:async-started) — localiza status.json/sessionFile. */
	runId?: string;
	/** dir dos artefatos de lifecycle do run ASYNC (status.json/events.jsonl/output-N.log). */
	asyncDir?: string;
	/** epoch ms do primeiro frame visto (anchor da Duration ao vivo — o `activeDurationAnchorMs`). */
	startedAtMs?: number;
}

/**
 * Nome do tool que spawna workers/reviewers. PROVIDER ÚNICO: `pi-subagents` expõe o tool
 * `subagent` (case-sensitive). O caminho nativo do harness (Active Worker + Workers) casa por
 * este nome; chamadas de management (`action: status/steer/...`) são filtradas por args.
 */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent"]);
export function isSubagentTool(name: string): boolean {
	return SUBAGENT_TOOL_NAMES.has(name);
}

/** Converte um count de tokens (number, string formatada "33.8k"/"1.2M", ou TokenUsage) em number. */
export function parseTokens(v: unknown): number {
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (v && typeof v === "object") {
		const total = (v as { total?: unknown }).total;
		return typeof total === "number" && Number.isFinite(total) ? total : 0;
	}
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

/** Uma execução do tool `subagent`? (chamadas com `action` são management/status — não spawnam). */
export function isExecutionArgs(args: unknown): boolean {
	const a = args as Record<string, unknown> | null | undefined;
	if (!a || typeof a !== "object") return false;
	if (typeof a.action === "string" && a.action.trim()) return false;
	return typeof a.agent === "string" || typeof a.task === "string" || Array.isArray(a.tasks) || Array.isArray(a.chain) || typeof a.workflowScript === "string";
}

function liveFromSpec(index: number, agent: string, task: string, status: "running" | "pending"): LiveAgent {
	return {
		index,
		taskId: parseTaskId(task),
		agent: agent || "worker",
		label: shortLabel(task, agent),
		status,
		toolCount: 0,
		tokens: 0,
		recentActivity: [],
	};
}

/**
 * Seed inicial a partir dos args (no tool_execution_start, antes de haver details). pi-subagents
 * `subagent`: single `{agent, task}`; paralelo `{tasks: [{agent, task}, ...]}`; chain
 * `{chain: [{agent, task}, ...]}` (1º step running, resto pending); `{workflowScript}` (opaco —
 * um placeholder "workflow" até os details chegarem). Management (`action`) → [].
 */
export function agentsFromArgs(args: unknown): LiveAgent[] {
	if (!isExecutionArgs(args)) return [];
	const a = args as Record<string, unknown>;
	if (typeof a.agent === "string" && a.agent.trim()) {
		return [liveFromSpec(0, a.agent, typeof a.task === "string" ? a.task : "", "running")];
	}
	if (Array.isArray(a.tasks)) {
		const out: LiveAgent[] = [];
		for (const [i, t] of (a.tasks as Array<Record<string, unknown>>).entries()) {
			if (!t || typeof t !== "object") continue;
			out.push(liveFromSpec(i, typeof t.agent === "string" ? t.agent : "worker", typeof t.task === "string" ? t.task : "", "running"));
		}
		return out;
	}
	if (Array.isArray(a.chain)) {
		const out: LiveAgent[] = [];
		for (const [i, s] of (a.chain as Array<Record<string, unknown>>).entries()) {
			if (!s || typeof s !== "object") continue;
			const agent = typeof s.agent === "string" ? s.agent : "step";
			out.push(liveFromSpec(i, agent, typeof s.task === "string" ? s.task : "", i === 0 ? "running" : "pending"));
		}
		return out;
	}
	if (typeof a.workflowScript === "string") {
		return [liveFromSpec(0, "workflow", typeof a.task === "string" ? a.task : "workflow script", "running")];
	}
	return [];
}

/** Um `AgentProgress` do pi-subagents (details.progress[] / status.json steps[]). */
interface ProgressLike {
	index?: unknown;
	agent?: unknown;
	status?: unknown;
	task?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	recentTools?: unknown;
	recentOutput?: unknown;
	toolCount?: unknown;
	tokens?: unknown;
}

/** Formata o feed de atividade a partir de recentTools ({tool,args}) + recentOutput (linhas). */
function activityFeed(p: ProgressLike): string[] {
	const out: string[] = [];
	if (Array.isArray(p.recentTools)) {
		for (const t of p.recentTools as Array<Record<string, unknown>>) {
			if (!t || typeof t !== "object" || typeof t.tool !== "string") continue;
			const args = typeof t.args === "string" && t.args.trim() ? `: ${snippet(t.args, 34)}` : "";
			out.push(snippet(`${t.tool}${args}`, 42));
		}
	}
	if (out.length === 0 && Array.isArray(p.recentOutput)) {
		for (const line of p.recentOutput as unknown[]) {
			if (typeof line === "string" && line.trim()) out.push(snippet(line, 42));
		}
	}
	return out.slice(-8);
}

function liveFromProgress(p: ProgressLike): LiveAgent | null {
	const status = String(p.status ?? "");
	const live = status === "running" ? "running" : status === "pending" ? "pending" : null;
	if (!live) return null; // completed/failed/detached → viram handoff/resultado (o end limpa)
	const task = typeof p.task === "string" ? p.task : "";
	const agent = typeof p.agent === "string" && p.agent.trim() ? p.agent : "worker";
	const tool = typeof p.currentTool === "string" && p.currentTool.trim() ? p.currentTool : undefined;
	const toolArgs = typeof p.currentToolArgs === "string" && p.currentToolArgs.trim() ? snippet(p.currentToolArgs, 24) : undefined;
	return {
		index: typeof p.index === "number" ? p.index : 0,
		taskId: parseTaskId(task),
		agent,
		label: shortLabel(task, agent),
		status: live,
		toolCount: typeof p.toolCount === "number" ? p.toolCount : 0,
		tokens: parseTokens(p.tokens),
		currentTool: tool ? snippet(toolArgs ? `${tool}: ${toolArgs}` : tool, 38) : undefined,
		recentActivity: activityFeed(p),
	};
}

/**
 * Extrai os agents RODANDO do `details` (o `Details` do pi-subagents) do partialResult/result do
 * tool `subagent` (runs FOREGROUND). Fonte: `details.progress[]` (um `AgentProgress` por child;
 * o provider mantém `recentTools`/`recentOutput` rolantes — usamos direto, sem merge por frame).
 * Runs ASYNC aceitos (details.asyncId, sem progress) → [] (o tracking é do registro async).
 */
export function agentsFromDetails(details: unknown): LiveAgent[] {
	const d = details as Record<string, unknown> | null | undefined;
	if (!d || typeof d !== "object") return [];
	if (!Array.isArray(d.progress)) return [];
	const out: LiveAgent[] = [];
	for (const p of d.progress as ProgressLike[]) {
		const la = liveFromProgress(p);
		if (la) out.push(la);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store FOREGROUND (keyed por toolCallId) — anchors de início por agent

const reg = new Map<string, LiveAgent[]>();
/** Anchor de início (epoch ms) keyed por `${toolCallId}#${index}` — setado no primeiro frame. */
const startTimes = new Map<string, number>();

export function setLiveAgents(toolCallId: string, agents: LiveAgent[]): void {
	if (agents.length === 0) {
		reg.delete(toolCallId);
		for (const k of startTimes.keys()) if (k.startsWith(`${toolCallId}#`)) startTimes.delete(k);
		return;
	}
	for (const a of agents) {
		const key = `${toolCallId}#${a.index}`;
		// Anchor do primeiro frame → Duration ao vivo do Active Worker (Date.now() − anchor).
		let started = startTimes.get(key);
		if (started === undefined) {
			started = Date.now();
			startTimes.set(key, started);
		}
		a.startedAtMs = started;
	}
	reg.set(toolCallId, agents);
}
export function clearLiveAgents(toolCallId: string): void {
	reg.delete(toolCallId);
	for (const k of startTimes.keys()) if (k.startsWith(`${toolCallId}#`)) startTimes.delete(k);
}

// ─────────────────────────────────────────────────────────────────────────────
// Store ASYNC (keyed por runId) — alimentado pelos eventos subagent:async-started/-complete;
// stats refrescadas lazily via um status-reader INJETÁVEL (status.json do asyncDir).

/** Shape mínima do status.json que o refresh consome (subset do AsyncStatus do provider). */
export interface AsyncStatusLite {
	state: string;
	currentTool?: string;
	toolCount?: number;
	/** total de tokens do run ({input,output,total} → total). */
	tokens?: number;
	steps?: ProgressLike[];
	sessionFile?: string;
}

interface AsyncEntry {
	base: LiveAgent;
	lastRefreshMs: number;
}

const asyncReg = new Map<string, AsyncEntry>();
let asyncStatusReader: ((asyncDir: string) => AsyncStatusLite | null) | undefined;
const ASYNC_REFRESH_MS = 500;

/** Injeta o leitor de status.json (a extensão liga o fs-based; testes injetam fakes). */
export function setAsyncStatusReader(reader: ((asyncDir: string) => AsyncStatusLite | null) | undefined): void {
	asyncStatusReader = reader;
}

/** Registra um run ASYNC aceito (payload do subagent:async-started). */
export function registerAsyncRun(ev: { id?: unknown; agent?: unknown; task?: unknown; goal?: unknown; asyncDir?: unknown }): void {
	const runId = typeof ev.id === "string" && ev.id.trim() ? ev.id : undefined;
	if (!runId) return;
	const task = typeof ev.goal === "string" && ev.goal.trim() ? ev.goal : typeof ev.task === "string" ? ev.task : "";
	const agent = typeof ev.agent === "string" && ev.agent.trim() ? ev.agent : "worker";
	const base = liveFromSpec(asyncReg.size, agent, task, "running");
	base.runId = runId;
	base.asyncDir = typeof ev.asyncDir === "string" && ev.asyncDir.trim() ? ev.asyncDir : undefined;
	base.startedAtMs = Date.now();
	asyncReg.set(runId, { base, lastRefreshMs: 0 });
}

/** Remove um run ASYNC terminado (payload do subagent:async-complete, ou state terminal no refresh). */
export function completeAsyncRun(runId: unknown): void {
	if (typeof runId === "string") asyncReg.delete(runId);
}

function refreshAsync(entry: AsyncEntry): void {
	const dir = entry.base.asyncDir;
	if (!dir || !asyncStatusReader) return;
	const now = Date.now();
	if (now - entry.lastRefreshMs < ASYNC_REFRESH_MS) return;
	entry.lastRefreshMs = now;
	const st = asyncStatusReader(dir);
	if (!st) return;
	if (st.state && st.state !== "running" && st.state !== "queued") {
		// safety-net: o evento de complete pode se perder (reload) — o refresh limpa o terminal.
		if (entry.base.runId) asyncReg.delete(entry.base.runId);
		return;
	}
	entry.base.toolCount = typeof st.toolCount === "number" ? st.toolCount : entry.base.toolCount;
	entry.base.tokens = typeof st.tokens === "number" ? st.tokens : entry.base.tokens;
	if (typeof st.currentTool === "string" && st.currentTool.trim()) entry.base.currentTool = snippet(st.currentTool, 38);
	const step = st.steps?.find((s) => String(s.status ?? "") === "running") ?? st.steps?.[st.steps.length - 1];
	if (step) {
		const feed = activityFeed(step);
		if (feed.length > 0) entry.base.recentActivity = feed;
		if (!entry.base.currentTool && typeof step.currentTool === "string" && step.currentTool.trim()) entry.base.currentTool = snippet(step.currentTool, 38);
		if (typeof step.toolCount === "number" && !st.toolCount) entry.base.toolCount = step.toolCount;
		if (!st.tokens) {
			const t = parseTokens(step.tokens);
			if (t > 0) entry.base.tokens = t;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────

export function clearAllLiveAgents(): void {
	reg.clear();
	startTimes.clear();
	asyncReg.clear();
}

/** Todos os agents rodando agora (foreground + async, achatado), ordenados por index. */
export function listLiveAgents(): LiveAgent[] {
	const all: LiveAgent[] = [];
	for (const list of reg.values()) all.push(...list);
	for (const entry of Array.from(asyncReg.values())) {
		refreshAsync(entry);
		if (entry.base.runId && asyncReg.has(entry.base.runId)) all.push(entry.base);
	}
	return all.sort((a, b) => a.index - b.index);
}
