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

/** Lê a sessão do worker (runs/<id>/sessions/<...wsid>.jsonl) e folda. [] se não há ficheiro. */
export function readWorkerSession(cwd: string, featureId: string, wsid: string): WorkerEntry[] {
	if (!wsid || wsid === "—") return [];
	const dir = path.join(runDir(cwd, featureId), "sessions");
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f.includes(wsid));
	} catch {
		return [];
	}
	if (files.length === 0) return [];
	// o mais recente (timestamp no nome) com o wsid
	const file = files.sort().at(-1) as string;
	try {
		return foldTranscript(parseSessionJsonl(fs.readFileSync(path.join(dir, file), "utf8")));
	} catch {
		return [];
	}
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
	durationMs?: number;
	toolCount?: number;
	tokens?: number;
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
			toolCount: la.toolCount,
			tokens: la.tokens,
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

/** As entries do transcript do worker ativo: sessão (headless) com fallback ao live activity. */
export function workerEntries(cwd: string, featureId: string, aw: ActiveWorker): WorkerEntry[] {
	if (aw.source === "session" && aw.wsid) {
		const e = readWorkerSession(cwd, featureId, aw.wsid);
		if (e.length > 0) return e;
	}
	if (aw.recentActivity && aw.recentActivity.length > 0) return entriesFromActivity(aw.recentActivity);
	return [];
}
