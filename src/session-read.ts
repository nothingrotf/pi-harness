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
import { entriesFromSessionEntries, findWorkerSessionFile, type RawSessionEntry, type WorkerEntry } from "./control-worker.ts";

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

const entryCache = new Map<string, { key: string; entries: WorkerEntry[] }>();

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
		entryCache.set(file, { key, entries });
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
