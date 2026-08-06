/**
 * Native session reader (pi 0.80.3+) — lê o transcript ESTRUTURADO do worker pela API NATIVA do
 * pi (`get_entries`/`get_tree`), em vez do nosso parser de jsonl à mão. Desde a 0.80.3 o pacote
 * exporta `parseSessionEntries`/`migrateSessionEntries`/`SessionManager` (os mesmos que o modo RPC
 * `get_entries`/`get_tree` expõem). Usamos `parseSessionEntries` (READ-ONLY, sem lock/escrita —
 * seguro num ficheiro que um worker vivo ainda está a escrever); `SessionManager.open().getTree()`
 * fica disponível pra a árvore de branches (NÃO no caminho ao vivo — open() pode abrir p/ continuação).
 *
 * RESILIÊNCIA (garante que nada quebra): o pacote pi é carregado por **dynamic import lazy e
 * guarded** — nunca um import estático que pudesse quebrar o LOAD da extensão se a versão do pi
 * não expuser estes símbolos. Enquanto o import não resolveu (1º frame) ou se for indisponível
 * (testes/CI, pi antigo), os readers devolvem `null` e o caller (control-view) cai pro fallback
 * tolerante (control-worker). Por isso este módulo é seguro de importar em qualquer contexto.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { entriesFromSessionEntries, findWorkerSessionFile, type RawSessionEntry, type WorkerEntry } from "./control-worker.ts";
import type { AsyncStatusLite } from "./live-agents.ts";

interface PiSessionApi {
	parseSessionEntries: (content: string) => RawSessionEntry[];
	migrateSessionEntries?: (entries: RawSessionEntry[]) => void;
	SessionManager?: { open: (file: string) => { getTree: () => unknown } };
}

// undefined = ainda não tentou; null = indisponível; objeto = pronto.
let api: PiSessionApi | null | undefined;
/** Promise da carga do pacote pi (fire-and-forget) — exportada p/ os testes aguardarem.
 * Resolve com a DISPONIBILIDADE (true = API nativa pronta, false = fallback). */
export const sessionApiReady: Promise<boolean> = (async () => {
	try {
		const m = (await import("@earendil-works/pi-coding-agent")) as unknown as PiSessionApi;
		api = m && typeof m.parseSessionEntries === "function" ? m : null;
	} catch {
		api = null; // pi não disponível neste contexto → o caller usa o fallback
	}
	return api !== null;
})();

// Cache por ficheiro com TETO (insertion-order eviction): sem ele, um entry por transcript de
// worker/subagent ficava em memória PARA SEMPRE (sessões longas, múltiplas features).
const ENTRY_CACHE_MAX = 32;
const entryCache = new Map<string, { key: string; entries: WorkerEntry[] }>();
function cacheSet(file: string, value: { key: string; entries: WorkerEntry[] }): void {
	if (!entryCache.has(file) && entryCache.size >= ENTRY_CACHE_MAX) {
		const oldest = entryCache.keys().next().value;
		if (oldest !== undefined) entryCache.delete(oldest);
	}
	entryCache.set(file, value);
}

/** Lê + folda as entries nativas de um ficheiro de sessão (read-only, cacheado por mtime/size). null em falha/indisponível. */
export function readNativeSessionFile(file: string): WorkerEntry[] | null {
	if (!api) return null; // ainda a carregar (1º frame) ou indisponível → fallback
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return null;
	}
	const key = `${st.mtimeMs}:${st.size}`;
	const hit = entryCache.get(file);
	if (hit && hit.key === key) return hit.entries;
	try {
		const content = fs.readFileSync(file, "utf8");
		const fe = api.parseSessionEntries(content);
		try {
			api.migrateSessionEntries?.(fe); // normaliza formatos antigos (best-effort)
		} catch {
			// best-effort
		}
		const entries = entriesFromSessionEntries(fe);
		cacheSet(file, { key, entries });
		return entries;
	} catch {
		return null; // ficheiro parcial/erro → o caller faz fallback (parser tolerante)
	}
}

/**
 * Transcript nativo do worker headless (get_entries) por feature/wsid. null quando não há ficheiro,
 * o pacote pi não está disponível, ou o parse falha — o caller (control-view) cai pro fallback
 * `workerEntries`/`readWorkerSession`.
 */
export function readNativeWorkerEntries(cwd: string, featureId: string, wsid: string): WorkerEntry[] | null {
	const file = findWorkerSessionFile(cwd, featureId, wsid);
	if (!file) return null;
	return readNativeSessionFile(file);
}

/**
 * Session-root dos children do pi-subagents pra uma sessão-pai: o provider deriva
 * `<sessionsDir>/<basename-sem-.jsonl>/` do session FILE do parent e grava cada child em
 * `<root>/<runId>/run-<index>/session.jsonl` (o `getSubagentSessionRoot` do pacote). PURO.
 */
export function subagentSessionRoot(parentSessionFile: string | null | undefined): string | null {
	if (!parentSessionFile) return null;
	const base = path.basename(parentSessionFile, ".jsonl");
	if (!base) return null;
	return path.join(path.dirname(parentSessionFile), base);
}

/**
 * Resolve o `session.jsonl` do child ATIVO sob a session-root do parent. Caminho: (1) com runId
 * conhecido (async), só `<root>/<runId>`; (2) senão o `session.jsonl` MAIS RECENTE (mtime) de
 * qualquer `<root>/<run>/<child>` — a banda é singular (KG0), o mais fresco é o child vivo.
 * Memo curto (500ms): corre a cada frame do TUI. null se nada.
 */
const resolveMemo = new Map<string, { at: number; file: string | null }>();
const RESOLVE_MEMO_MS = 500;

export function resolveSubagentSessionFile(rootDir: string, runId?: string | null): string | null {
	const memoKey = `${rootDir}|${runId ?? ""}`;
	const memo = resolveMemo.get(memoKey);
	if (memo && Date.now() - memo.at < RESOLVE_MEMO_MS) return memo.file;
	const remember = (file: string | null): string | null => {
		if (resolveMemo.size > 16) resolveMemo.clear();
		resolveMemo.set(memoKey, { at: Date.now(), file });
		return file;
	};
	const runDirs: string[] = [];
	if (runId) {
		runDirs.push(path.join(rootDir, runId));
	} else {
		try {
			for (const d of fs.readdirSync(rootDir, { withFileTypes: true })) {
				if (d.isDirectory()) runDirs.push(path.join(rootDir, d.name));
			}
		} catch {
			return remember(null);
		}
	}
	let best: { p: string; m: number } | null = null;
	for (const runDir of runDirs) {
		let children: fs.Dirent[];
		try {
			children = fs.readdirSync(runDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const c of children) {
			if (!c.isDirectory()) continue;
			const p = path.join(runDir, c.name, "session.jsonl");
			try {
				const m = fs.statSync(p).mtimeMs;
				if (!best || m > best.m) best = { p, m };
			} catch {
				/* sem session.jsonl neste subdir — skip */
			}
		}
	}
	return remember(best?.p ?? null);
}

/** Shape mínima do status.json de um run async (subset do AsyncStatus do provider). */
interface AsyncStatusJson {
	state?: unknown;
	currentTool?: unknown;
	toolCount?: unknown;
	totalTokens?: { total?: unknown } | null;
	sessionFile?: unknown;
	steps?: Array<Record<string, unknown>>;
}

const statusCache = new Map<string, { key: string; value: AsyncStatusLite | null }>();

/**
 * Lê o `status.json` de um run ASYNC do pi-subagents (asyncDir dos eventos/details) → a shape
 * lite que o live-agents refresca (state/currentTool/toolCount/tokens/steps/sessionFile).
 * Cacheado por mtime/size; null em falha/ausência (run recém-aceito, 1º frame).
 */
export function readAsyncStatusLite(asyncDir: string): AsyncStatusLite | null {
	const file = path.join(asyncDir, "status.json");
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return null;
	}
	const key = `${st.mtimeMs}:${st.size}`;
	const hit = statusCache.get(file);
	if (hit && hit.key === key) return hit.value;
	let value: AsyncStatusLite | null = null;
	try {
		const o = JSON.parse(fs.readFileSync(file, "utf8")) as AsyncStatusJson;
		value = {
			state: typeof o.state === "string" ? o.state : "running",
			currentTool: typeof o.currentTool === "string" ? o.currentTool : undefined,
			toolCount: typeof o.toolCount === "number" ? o.toolCount : undefined,
			tokens: typeof o.totalTokens?.total === "number" ? o.totalTokens.total : undefined,
			sessionFile: typeof o.sessionFile === "string" ? o.sessionFile : undefined,
			steps: Array.isArray(o.steps) ? o.steps : undefined,
		};
	} catch {
		value = null; // parcial/corrompido — tenta de novo no próximo mtime
	}
	if (statusCache.size > 16) statusCache.clear();
	statusCache.set(file, { key, value });
	return value;
}

/** sessionFile de um step do status.json (prefere o step running; senão o último com ficheiro). */
function stepSessionFile(st: AsyncStatusLite): string | null {
	if (!st.steps) return null;
	const running = st.steps.find((s) => String((s as Record<string, unknown>).status ?? "") === "running");
	const pick = (s: unknown): string | null => {
		const f = (s as Record<string, unknown> | undefined)?.sessionFile;
		return typeof f === "string" && f ? f : null;
	};
	if (running) {
		const f = pick(running);
		if (f) return f;
	}
	for (let i = st.steps.length - 1; i >= 0; i--) {
		const f = pick(st.steps[i]);
		if (f) return f;
	}
	return null;
}

/**
 * Transcript nativo do SUBAGENT pi-subagents (o análogo do `tcT`/`dG0` do Droid 08a §6): o child
 * é uma sessão pi REAL — lemos o `session.jsonl` dele com o parser nativo (readNativeSessionFile,
 * READ-ONLY, cacheado por mtime). Resolução: run ASYNC → `sessionFile` do status.json (root ou
 * step); FOREGROUND → o session.jsonl mais recente sob a session-root do parent (o provider não
 * expõe o runId nos partials). null quando nada existe → o caller cai pro recentActivity.
 */
export function readLiveAgentEntries(parentSessionFile: string | null | undefined, agent: { runId?: string; asyncDir?: string }): WorkerEntry[] | null {
	if (agent.asyncDir) {
		const st = readAsyncStatusLite(agent.asyncDir);
		const file = st ? (st.sessionFile ?? stepSessionFile(st)) : null;
		if (file) {
			const entries = readNativeSessionFile(file);
			if (entries && entries.length > 0) return entries;
		}
	}
	const root = subagentSessionRoot(parentSessionFile);
	if (!root) return null;
	const file = resolveSubagentSessionFile(root, agent.runId ?? null);
	if (!file) return null;
	return readNativeSessionFile(file);
}

/**
 * Árvore de sessão nativa (get_tree) — opcional, p/ inspeção de branches. Usa SessionManager.open
 * (que pode abrir p/ continuação), então NÃO chamar no caminho ao vivo de um worker a correr.
 * null quando indisponível/erro.
 */
export function readNativeWorkerTree(cwd: string, featureId: string, wsid: string): unknown | null {
	if (!api?.SessionManager) return null;
	const file = findWorkerSessionFile(cwd, featureId, wsid);
	if (!file) return null;
	try {
		return api.SessionManager.open(file).getTree();
	} catch {
		return null;
	}
}
