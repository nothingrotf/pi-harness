/**
 * Active Worker — o modelo de dados do painel "live mini-transcript" do worker em execução
 * (recreate 1:1 do cap. 08a dos docs de referência: `dG0`/`g2H`/`S2H`/`M2H`/`tcT`/`KG0`).
 *
 * O painel mostra UM worker (o running/paused — `KG0`) como um mini-transcript ao vivo: as
 * últimas N entries do seu stream de mensagens/tools, cada uma de 2 linhas. Aqui vive a parte
 * PURA (fold do transcript + seleção do worker + síntese a partir do live agent) e o reader de
 * IO da sessão. A view (control-view.ts) pinta a banda; control-draw.ts dá a geometria (~35%).
 *
 * Duas fontes de transcript (o pi é o substrato de sessão — doc daemon):
 *   - headless SESSION-BACKED: o worker escreve runs/<id>/sessions/<...wsid>.jsonl (`--session-id`)
 *     → readWorkerSession lê + foldTranscript colapsa toolCall+toolResult (o `g2H`).
 *   - live-TUI SUBAGENT: o worker roda como `subagent` (sem jsonl próprio) → entriesFromActivity
 *     sintetiza entries do recentActivity que o stream do subagent já expõe (live-agents.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ControlModel } from "./control-model.ts";
import { runDir } from "./handoff.ts";
import type { LiveAgent } from "./live-agents.ts";

export type WorkerEntryKind = "message" | "tool";

/** Uma entry renderável do transcript (o `{kind:"message"|"tool"}` do `g2H`). */
export interface WorkerEntry {
	kind: WorkerEntryKind;
	/** message: papel (glyph). */
	role?: "user" | "assistant" | "system";
	/** message: texto. */
	text?: string;
	/** tool: nome do tool. */
	toolName?: string;
	/** tool: resumo dos params (o `CnR`). */
	params?: string;
	/** tool: resultado (texto), colapsado do tool_result correspondente. */
	result?: string;
	isError?: boolean;
}

function oneLine(s: string): string {
	return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Resumo curto dos params de um tool (o `CnR(toolName,toolInput)`): pega o arg mais saliente. */
export function summarizeToolParams(_name: string, args: unknown): string {
	if (args == null || typeof args !== "object") return typeof args === "string" ? oneLine(args) : "";
	const o = args as Record<string, unknown>;
	const pick = o.command ?? o.cmd ?? o.path ?? o.file ?? o.filePath ?? o.pattern ?? o.query ?? o.url ?? o.description ?? o.prompt ?? Object.values(o)[0];
	if (typeof pick === "string") return oneLine(pick);
	if (pick == null) return "";
	try {
		return oneLine(JSON.stringify(pick)).slice(0, 80);
	} catch {
		return "";
	}
}

interface RawPart {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
	is_error?: boolean;
}
interface RawMessage {
	role?: string;
	content?: RawPart[] | string;
	isError?: boolean;
}

/**
 * Folda a lista de mensagens cruas (pi session) em entries renderáveis — o `g2H`: colapsa
 * toolCall + o tool_result subsequente numa única entry de tool (call+result num painel só).
 * Parsing tolerante: ignora partes desconhecidas; ordem preservada.
 */
export function foldTranscript(messages: RawMessage[]): WorkerEntry[] {
	const entries: WorkerEntry[] = [];
	let lastTool: WorkerEntry | null = null;
	for (const m of messages ?? []) {
		const role = String(m?.role ?? "");
		const content: RawPart[] = Array.isArray(m?.content) ? m.content : typeof m?.content === "string" ? [{ type: "text", text: m.content }] : [];
		if (role === "toolResult" || role === "tool") {
			const text = content
				.filter((c) => c.type === "text" || c.type === undefined)
				.map((c) => String(c.text ?? ""))
				.join("")
				.trim();
			const isError = !!m?.isError || content.some((c) => c.is_error);
			if (lastTool) {
				lastTool.result = text;
				lastTool.isError = isError;
			} else if (text) {
				entries.push({ kind: "message", role: "system", text });
			}
			continue;
		}
		for (const c of content) {
			const t = String(c?.type ?? "");
			if (t === "toolCall" || t === "tool_use") {
				const tool: WorkerEntry = { kind: "tool", toolName: String(c.name ?? "tool"), params: summarizeToolParams(String(c.name ?? ""), c.arguments ?? c.input), result: undefined };
				entries.push(tool);
				lastTool = tool;
			} else if (t === "text" || t === "") {
				const text = oneLine(String(c.text ?? ""));
				if (text) {
					entries.push({ kind: "message", role: role === "user" ? "user" : "assistant", text });
					lastTool = null;
				}
			}
		}
	}
	return entries;
}

/** Parseia um .jsonl de sessão pi → as mensagens (`type:"message"`), em ordem. Tolerante. */
export function parseSessionJsonl(text: string): RawMessage[] {
	const out: RawMessage[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const o = JSON.parse(t) as { type?: string; message?: RawMessage };
			if (o.type === "message" && o.message) out.push(o.message);
		} catch {
			// linha parcial/corrompida — pula (a TUI é read-only e tolerante)
		}
	}
	return out;
}

/** Resolve o ficheiro de sessão do worker (runs/<id>/sessions/<...wsid>.jsonl). null se ausente. */
export function findWorkerSessionFile(cwd: string, featureId: string, wsid: string): string | null {
	if (!wsid || wsid === "—") return null;
	const dir = path.join(runDir(cwd, featureId), "sessions");
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f.includes(wsid));
	} catch {
		return null;
	}
	if (files.length === 0) return null;
	return path.join(dir, files.sort().at(-1) as string); // o mais recente (timestamp no nome) com o wsid
}

/**
 * Lê a sessão do worker (jsonl) e folda — o FALLBACK tolerante (nosso parser), usado quando o
 * reader nativo (SessionManager/get_entries, src/session-read.ts) não está disponível (testes/CI)
 * ou falha (ficheiro a ser escrito). [] se não há ficheiro.
 */
export function readWorkerSession(cwd: string, featureId: string, wsid: string): WorkerEntry[] {
	const file = findWorkerSessionFile(cwd, featureId, wsid);
	if (!file) return [];
	try {
		return foldTranscript(parseSessionJsonl(fs.readFileSync(file, "utf8")));
	} catch {
		return [];
	}
}

/** Uma SessionEntry do schema oficial (estrutural, p/ não acoplar ao pacote pi nos testes). */
export interface RawSessionEntry {
	type?: string;
	message?: RawMessage;
}

/**
 * Folda as SessionEntry[] do schema OFICIAL (get_entries/SessionManager.getEntries) em entries
 * renderáveis. Só `type:"message"` vira transcript — compaction/branch_summary/label/model_change/
 * thinking_level_change são ignoradas (não fazem parte do mini-transcript). PURA, testável.
 */
export function entriesFromSessionEntries(entries: RawSessionEntry[]): WorkerEntry[] {
	return foldTranscript((entries ?? []).filter((e) => e?.type === "message" && e.message).map((e) => e.message as RawMessage));
}

/** Sintetiza entries a partir do recentActivity de um live subagent ("bash: echo" → tool entry). */
export function entriesFromActivity(recentActivity: string[]): WorkerEntry[] {
	return (recentActivity ?? [])
		.map((a) => oneLine(a))
		.filter(Boolean)
		.map((a) => {
			const i = a.indexOf(": ");
			if (i > 0 && i < 24) return { kind: "tool" as const, toolName: a.slice(0, i), params: a.slice(i + 2), result: undefined };
			return { kind: "message" as const, role: "system" as const, text: a };
		});
}

// ─────────────────────────────────────────────────────────────────────────────
// Session viewer (droid §7b: "Worker Session") — densidade `[`/`]` + scroll/follow-tail. PURO.

/** Densidade do transcript (linhas por entry), 1..5 — default 4 (o do Droid). */
export const SESSION_DENSITY_MIN = 1;
export const SESSION_DENSITY_MAX = 5;
export const SESSION_DENSITY_DEFAULT = 4;

/** `[` = -1 (mais denso) · `]` = +1 (mais espaçado), clampado 1..5. */
export function cycleDensity(cur: number, delta: 1 | -1): number {
	return Math.max(SESSION_DENSITY_MIN, Math.min(SESSION_DENSITY_MAX, cur + delta));
}

export interface ScrollWindow {
	/** índice da primeira linha visível. */
	start: number;
	/** quantas linhas renderizar. */
	count: number;
	/** true = colado ao fim (follow-tail: novas linhas empurram a janela). */
	follow: boolean;
	/** "12-24 of 60" (1-based) — "" quando tudo cabe. */
	range: string;
}

/**
 * Janela de scroll do session viewer: `offset` null = FOLLOW TAIL (a janela cola no fim e
 * acompanha o stream); numérico = ancorada em `offset` (primeira linha visível). Um offset
 * que alcança o fim volta a follow (o "scroll to bottom re-engages follow" do Droid).
 */
export function sessionWindow(total: number, offset: number | null, capacity: number): ScrollWindow {
	const cap = Math.max(1, Math.floor(capacity));
	if (total <= cap) return { start: 0, count: total, follow: true, range: "" };
	const maxStart = total - cap;
	const follow = offset === null || offset >= maxStart;
	const start = follow ? maxStart : Math.max(0, offset as number);
	return { start, count: cap, follow, range: `${start + 1}-${start + cap} of ${total}` };
}

/** Novo offset ao rolar (`delta` linhas). null = estava em follow → ancora a partir do fim. */
export function scrollOffset(total: number, offset: number | null, capacity: number, delta: number): number | null {
	const cap = Math.max(1, Math.floor(capacity));
	if (total <= cap) return null;
	const maxStart = total - cap;
	const cur = offset === null ? maxStart : Math.min(offset, maxStart);
	const next = Math.max(0, cur + delta);
	return next >= maxStart ? null : next; // alcançou o fim → re-engaja follow
}

// ─────────────────────────────────────────────────────────────────────────────
// Seleção do worker ativo (o `KG0`: o ÚNICO running/paused) + suas entries

export interface ActiveWorker {
	/** ordinal (#N) — derivado, não armazenado (doc 07). */
	number: number;
	/** task/step id. */
	id: string;
	/** rótulo curto (descrição da task / label do subagent). */
	label: string;
	/** skill do worker (sem o prefixo harness-). */
	skill: string;
	status: "running" | "paused";
	source: "session" | "live";
	/** headless: o worker session id (→ readWorkerSession). */
	wsid?: string;
	/** live-TUI (@tintinweb): o agent record id → localiza o `.output` JSONL do transcript real. */
	agentId?: string;
	durationMs?: number;
	toolCount?: number;
	tokens?: number;
	/** live-TUI: o tool em execução agora (pro fallback da banda quando não há transcript). */
	currentTool?: string;
	/** live-TUI: atividades recentes do subagent (→ entriesFromActivity). */
	recentActivity?: string[];
}

/**
 * Escolhe o ÚNICO worker ativo (o `KG0`): prefere um subagent AO VIVO (live-TUI), senão a row
 * de worker `running` do disco (headless/nativo). null quando nada roda — a banda some.
 */
export function pickActiveWorker(model: ControlModel, live: LiveAgent[]): ActiveWorker | null {
	const la = live.find((a) => a.status === "running") ?? live[0];
	if (la) {
		return {
			number: la.index + 1,
			id: la.taskId,
			label: la.label,
			skill: la.agent.replace(/^harness-/, ""),
			status: "running",
			source: "live",
			agentId: la.agentId,
			toolCount: la.toolCount,
			tokens: la.tokens,
			currentTool: la.currentTool,
			recentActivity: la.recentActivity,
		};
	}
	const wr = model.workers.find((w) => w.status === "running");
	if (wr) {
		const paused = model.state === "paused";
		return {
			number: wr.workerNumber ?? 1,
			id: wr.taskId,
			label: model.active?.label ?? wr.taskId,
			skill: (model.active?.skillName ?? "worker").replace(/^harness-/, ""),
			status: paused ? "paused" : "running",
			source: "session",
			wsid: wr.workerSessionId === "—" ? undefined : wr.workerSessionId,
			durationMs: wr.durationMs,
		};
	}
	return null;
}

/**
 * O MAPA DE CASOS da fonte do transcript do worker ativo:
 *   "session"  → worker headless session-backed (lê o .jsonl: nativo get_entries c/ fallback ao
 *                nosso parser; src/session-read.ts + readWorkerSession);
 *   "activity" → subagent live-TUI (sem ficheiro próprio acessível) → recentActivity do stream;
 *   "none"     → sem fonte (task nativa sem wsid/atividade, ou nenhum worker) → só título/placeholder.
 */
export function transcriptSource(aw: ActiveWorker | null): "session" | "activity" | "none" {
	if (!aw) return "none";
	if (aw.source === "session" && aw.wsid) return "session";
	if (aw.recentActivity && aw.recentActivity.length > 0) return "activity";
	return "none";
}

/**
 * As entries do transcript do worker ativo (FALLBACK puro, sem o pacote pi): sessão em disco via
 * o nosso parser tolerante, com fallback ao live activity. O caminho NATIVO (get_entries) vive em
 * src/session-read.ts e é preferido pela view; este é o fallback quando o nativo é null.
 */
export function workerEntries(cwd: string, featureId: string, aw: ActiveWorker): WorkerEntry[] {
	switch (transcriptSource(aw)) {
		case "session": {
			const e = readWorkerSession(cwd, featureId, aw.wsid as string);
			if (e.length > 0) return e;
			return aw.recentActivity && aw.recentActivity.length > 0 ? entriesFromActivity(aw.recentActivity) : [];
		}
		case "activity":
			return entriesFromActivity(aw.recentActivity as string[]);
		default:
			return [];
	}
}
