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
import * as os from "node:os";
import * as path from "node:path";
import { entriesFromSessionEntries, findWorkerSessionFile, foldTranscript, type RawSessionEntry, type WorkerEntry } from "./control-worker.ts";

interface PiSessionApi {
	parseSessionEntries: (content: string) => RawSessionEntry[];
	migrateSessionEntries?: (entries: RawSessionEntry[]) => void;
	SessionManager?: { open: (file: string) => { getTree: () => unknown } };
}

// undefined = ainda não tentou; null = indisponível; objeto = pronto.
let api: PiSessionApi | null | undefined;
/** Promise da carga do pacote pi (fire-and-forget) — exportada p/ os testes aguardarem. */
export const sessionApiReady: Promise<void> = (async () => {
	try {
		const m = (await import("@earendil-works/pi-coding-agent")) as unknown as PiSessionApi;
		api = m && typeof m.parseSessionEntries === "function" ? m : null;
	} catch {
		api = null; // pi não disponível neste contexto → o caller usa o fallback
	}
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

/** Encode um cwd como nome de dir filesystem-safe — o `encodeCwd` do @tintinweb output-file.ts. */
function encodeCwd(cwd: string): string {
	return cwd
		.replace(/[/\\]/g, "-") // ambos separadores → dash
		.replace(/^[A-Za-z]:-/, "") // strip prefixo de drive Windows ("C:-")
		.replace(/^-+/, ""); // strip dashes iniciais (raiz POSIX/UNC)
}

/**
 * Caminho do `.output` JSONL que o @tintinweb streama por subagent (o `createOutputFilePath` do
 * pacote): `{tmpdir}/pi-subagents-{uid}/{encodeCwd(cwd)}/{sessionId}/tasks/{agentId}.output`.
 * `sessionId` = a sessão-PAI (orchestrator, `ctx.sessionManager.getSessionId()`); `agentId` = o
 * `details.agentId` do AgentDetails. PURO (testável).
 */
export function agentOutputFilePath(cwd: string, sessionId: string, agentId: string): string {
	const uid = process.getuid?.() ?? 0;
	const root = path.join(os.tmpdir(), `pi-subagents-${uid}`);
	return path.join(root, encodeCwd(cwd), sessionId, "tasks", `${agentId}.output`);
}

/** Lista as pastas `<session>/tasks` sob o root do cwd (p/ quando o sessionId é desconhecido). */
function sessionTasksDirs(root: string): string[] {
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(root, d.name, "tasks"));
	} catch {
		return [];
	}
}

/**
 * Resolve o `.output` do worker ATIVO. **@tintinweb NÃO streama o `agentId` no update do agent
 * FOREGROUND** (só no background — ver index.ts streamUpdate), então o caminho exato quase nunca
 * está disponível ao vivo. Caminho: (1) exato por agentId quando conhecido; (2) senão, o `.output`
 * MAIS RECENTE (mtime) na pasta `tasks/` da sessão — a banda é singular (KG0), o mais fresco é o
 * worker vivo; (3) se o sessionId for desconhecido, varre qualquer sessão do cwd. null se nada. PURO.
 */
const resolveMemo = new Map<string, { at: number; file: string | null }>();
const RESOLVE_MEMO_MS = 500;

export function resolveAgentOutputFile(cwd: string, sessionId: string | null | undefined, agentId: string | null | undefined): string | null {
	const uid = process.getuid?.() ?? 0;
	const root = path.join(os.tmpdir(), `pi-subagents-${uid}`, encodeCwd(cwd));
	// Memo curto (500ms): isto corre A CADA FRAME do TUI e o scan estata todos os .output de todas
	// as sessões — sem memo, o custo cresce com o histórico de subagents.
	const memoKey = `${root}|${sessionId ?? ""}|${agentId ?? ""}`;
	const memo = resolveMemo.get(memoKey);
	if (memo && Date.now() - memo.at < RESOLVE_MEMO_MS) return memo.file;
	const remember = (file: string | null): string | null => {
		if (resolveMemo.size > 16) resolveMemo.clear();
		resolveMemo.set(memoKey, { at: Date.now(), file });
		return file;
	};
	if (sessionId && agentId) {
		const exact = path.join(root, sessionId, "tasks", `${agentId}.output`);
		try {
			if (fs.statSync(exact).isFile()) return remember(exact);
		} catch {
			/* cai pro scan por mtime */
		}
	}
	const dirs = sessionId ? [path.join(root, sessionId, "tasks")] : sessionTasksDirs(root);
	let best: { p: string; m: number } | null = null;
	for (const dir of dirs) {
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".output"));
		} catch {
			continue;
		}
		for (const f of files) {
			const p = path.join(dir, f);
			try {
				const m = fs.statSync(p).mtimeMs;
				if (!best || m > best.m) best = { p, m };
			} catch {
				/* skip */
			}
		}
	}
	return remember(best?.p ?? null);
}

/**
 * Transcript nativo do SUBAGENT @tintinweb (o análogo do `tcT`/`dG0` do Droid 08a §6): lê o
 * `.output` JSONL que o @tintinweb streama AO VIVO (flush por turn_end), READ-ONLY (seguro num
 * ficheiro que o subagent ainda escreve), e folda com o `foldTranscript` (colapsa toolCall+toolResult).
 * Cada linha é `{ type, message, agentId, ... }` — extraímos `.message` (a mensagem pi). Self-contido
 * (fs + JSON + foldTranscript, SEM o pacote pi). Cacheado por mtime/size. O ficheiro é resolvido por
 * `resolveAgentOutputFile` (exato por agentId, ou o mais recente da sessão — o agentId não vem no
 * stream foreground). null quando não há ficheiro → o caller cai pro fallback do recentActivity.
 */
export function readAgentOutputEntries(cwd: string, sessionId: string | null | undefined, agentId: string | null | undefined): WorkerEntry[] | null {
	const file = resolveAgentOutputFile(cwd, sessionId, agentId);
	if (!file) return null;
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return null; // ainda não escrito (1º frame) → fallback
	}
	const key = `${st.mtimeMs}:${st.size}`;
	const hit = entryCache.get(file);
	if (hit && hit.key === key) return hit.entries;
	try {
		const content = fs.readFileSync(file, "utf8");
		const messages: unknown[] = [];
		for (const line of content.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				const o = JSON.parse(t) as { message?: unknown };
				if (o.message) messages.push(o.message);
			} catch {
				// linha parcial (ficheiro a ser escrito) — pula (read-only, tolerante)
			}
		}
		const entries = foldTranscript(messages as Parameters<typeof foldTranscript>[0]);
		cacheSet(file, { key, entries });
		return entries;
	} catch {
		return null; // ficheiro parcial/erro → fallback
	}
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
