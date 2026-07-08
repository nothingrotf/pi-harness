/**
 * Handoff — o relatório estruturado que um worker/validator devolve ao chamar
 * `EndFeatureRun` (analog do handoff do modelo de referência, Zod aYT). É o único ponto de saída
 * de um step: a persistência aqui é o "message bus" em disco que o FeatureRunner e
 * o scrutiny-feature-reviewer leem.
 *
 *   recordHandoff()      → grava handoffs/<taskId>__<wsid>.json + append em
 *                          worker-transcripts.jsonl (1 por tentativa, wsid único).
 *   latestHandoff()      → o handoff mais recente de um step (pra success).
 *   handoffOutcome()     → { success, returnToOrchestrator } pro SpawnOutcome do runner
 *                          (espelha auditSucceeded: o exit code não basta; o success
 *                          vem do successState reportado e persistido).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type SuccessState = "success" | "partial" | "failure";
export type IssueSeverity = "blocking" | "non_blocking" | "suggestion";

export interface Handoff {
	salientSummary?: string;
	whatWasImplemented: string;
	whatWasLeftUndone: string;
	verification: {
		commandsRun: { command: string; exitCode: number; observation: string }[];
		interactiveChecks?: { action: string; observed: string }[];
	};
	tests?: { added: { file: string; cases: { name: string; description: string }[] }[]; coverage?: string };
	discoveredIssues?: { severity: IssueSeverity; description: string; suggestedFix?: string }[];
	skillFeedback?: { followedProcedure: boolean; deviations?: { step: string; whatIDidInstead: string; why: string }[]; suggestedChanges?: string[] };
}

/** O payload do tool EndFeatureRun (o que o worker/validator chama no fim). */
export interface EndFeatureRunPayload {
	taskId: string;
	workerSessionId: string;
	successState: SuccessState;
	returnToOrchestrator: boolean;
	validatorsPassed: boolean;
	commitId?: string;
	repoPath?: string;
	handoff: Handoff;
}

/** Registro persistido (payload + timestamp). */
export interface PersistedHandoff extends EndFeatureRunPayload {
	recordedAt: string;
}

export function runDir(cwd: string, featureId: string): string {
	// Guard de path traversal NO CHOKEPOINT: featureId vem de tool calls de workers (EndFeatureRun,
	// next_task, store_*) — um id com separadores ou ".." escaparia de .harness/runs/. Ids legítimos
	// (slugs) passam intactos.
	let id = featureId.replace(/[\\/]/g, "-").replace(/\.{2,}/g, ".");
	if (!id || id === ".") id = "_invalid";
	return path.join(cwd, ".harness", "runs", id);
}

/**
 * Trilha de eventos do run (progress_log.jsonl analog do modelo de referência) — append determinístico.
 * Escrita pelos pontos de código confiáveis (store_plan, EndFeatureRun) pra o caminho
 * nativo ter durabilidade sem depender do modelo escrever JSONL.
 */
export function appendProgress(cwd: string, featureId: string, event: string, extra: Record<string, unknown> = {}, now: () => string = () => new Date().toISOString()): void {
	const dir = runDir(cwd, featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(path.join(dir, "progress_log.jsonl"), `${JSON.stringify({ ts: now(), event, ...extra })}\n`);
}
function handoffsDir(cwd: string, featureId: string): string {
	return path.join(runDir(cwd, featureId), "handoffs");
}

/** Sanitiza um id pra nome de arquivo (sem separadores). */
function safe(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "-");
}

/**
 * Persiste um handoff: handoffs/<taskId>__<wsid>.json (1 por tentativa) + append no
 * worker-transcripts.jsonl (history que o reviewer lê). Retorna o path do arquivo.
 */
export function recordHandoff(cwd: string, featureId: string, payload: EndFeatureRunPayload, now: () => string = () => new Date().toISOString()): string {
	const dir = handoffsDir(cwd, featureId);
	fs.mkdirSync(dir, { recursive: true });
	const record: PersistedHandoff = { ...payload, recordedAt: now() };
	const file = path.join(dir, `${safe(payload.taskId)}__${safe(payload.workerSessionId)}.json`);
	fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
	// transcript skeleton (append-only history)
	const transcripts = path.join(runDir(cwd, featureId), "worker-transcripts.jsonl");
	fs.appendFileSync(
		transcripts,
		`${JSON.stringify({ workerSessionId: payload.workerSessionId, taskId: payload.taskId, successState: payload.successState, recordedAt: record.recordedAt })}\n`,
	);
	// evento determinístico no progress_log (durabilidade do caminho nativo)
	const event = payload.successState === "success" ? "task_completed" : payload.returnToOrchestrator ? "task_returned" : "task_failed";
	appendProgress(cwd, featureId, event, { taskId: payload.taskId, workerSessionId: payload.workerSessionId, successState: payload.successState }, now);
	return file;
}

/** O handoff mais recente de um step (por mtime). null se nenhum. */
export function latestHandoff(cwd: string, featureId: string, taskId: string): PersistedHandoff | null {
	const dir = handoffsDir(cwd, featureId);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.startsWith(`${safe(taskId)}__`) && f.endsWith(".json"));
	} catch {
		return null;
	}
	if (files.length === 0) return null;
	const newest = files
		.map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
		.sort((a, b) => a.m - b.m)
		.at(-1);
	if (!newest) return null;
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, newest.f), "utf8")) as PersistedHandoff;
	} catch {
		return null;
	}
}

/**
 * Deriva o resultado do step pro SpawnOutcome do FeatureRunner a partir do handoff
 * persistido. Sem handoff (worker crashou sem reportar) → success:false. O exit code
 * sozinho não basta — o success vem do successState reportado (e o ship gate, sendo
 * ele mesmo um worker, reporta o veredito real).
 */
export function handoffOutcome(cwd: string, featureId: string, taskId: string, workerSessionId?: string): { success: boolean; returnToOrchestrator: boolean } {
	// Com wsid, lê EXATAMENTE o handoff desta tentativa — o lookup por mtime deixava um success
	// STALE de uma tentativa anterior completar uma tentativa que crashou sem EndFeatureRun.
	const h = workerSessionId ? readHandoffExact(cwd, featureId, taskId, workerSessionId) : latestHandoff(cwd, featureId, taskId);
	if (!h) return { success: false, returnToOrchestrator: false };
	return { success: h.successState === "success", returnToOrchestrator: !!h.returnToOrchestrator };
}

/** O handoff de UMA tentativa específica (taskId + wsid). null se não existe/corrupto. */
export function readHandoffExact(cwd: string, featureId: string, taskId: string, workerSessionId: string): PersistedHandoff | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(handoffsDir(cwd, featureId), `${safe(taskId)}__${safe(workerSessionId)}.json`), "utf8")) as PersistedHandoff;
	} catch {
		return null;
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Handoff item dismissal (droid: dismiss_handoff_items) — o orchestrator marca discoveredIssues
// que ele decidiu NÃO acionar, COM justificativa, pra não ressurgirem a cada run_feature. A trilha
// auditavel é o ponto: uma no-action decidida vira fato registrado, não esquecimento silencioso.

export interface DismissedItem {
	/** a assinatura do item (a `description` do discoveredIssue, normalizada) — chave de dedup/match. */
	ref: string;
	/** por que foi dispensado (obrigatório — a justificativa é o valor). */
	reason: string;
	at: string;
}

function dismissedPath(cwd: string, featureId: string): string {
	return path.join(runDir(cwd, featureId), "dismissed.json");
}

/** Normaliza a assinatura de um item dispensado (trim + colapsa espaço) — match tolerante a whitespace. */
export function dismissalRef(description: string): string {
	return String(description ?? "").replace(/\s+/g, " ").trim();
}

/** Lê os itens dispensados do run (tolerante: ausente/corrupto → []). */
export function readDismissed(cwd: string, featureId: string): DismissedItem[] {
	try {
		const arr = JSON.parse(fs.readFileSync(dismissedPath(cwd, featureId), "utf8"));
		return Array.isArray(arr) ? (arr as DismissedItem[]) : [];
	} catch {
		return [];
	}
}

/** dismissed.json existe mas não parseia → quarentena (preserva a evidência, não clobbera). */
function quarantineCorruptDismissed(cwd: string, featureId: string, now: () => string): void {
	const file = dismissedPath(cwd, featureId);
	try {
		if (!fs.existsSync(file)) return;
		JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		try {
			fs.renameSync(file, `${file}.corrupt-${now().replace(/[^0-9]/g, "").slice(0, 14)}`);
		} catch {
			// best-effort
		}
	}
}

/** O conjunto de refs dispensados (pra filtrar discoveredIssues no report). */
export function dismissedRefs(cwd: string, featureId: string): Set<string> {
	return new Set(readDismissed(cwd, featureId).map((d) => d.ref));
}

/**
 * Append de itens dispensados (dedup por ref — re-dispensar atualiza a razão) + evento
 * `handoff_items_dismissed` na trilha. Retorna a lista final. Escrita atômica (tmp+rename).
 */
export function appendDismissed(cwd: string, featureId: string, items: { description: string; reason: string }[], now: () => string = () => new Date().toISOString()): DismissedItem[] {
	// Corrupto → quarentena ANTES do merge: senão readDismissed devolve [] e o rewrite descartaria
	// silenciosamente todas as dismissals anteriores (que então ressurgiriam no report).
	quarantineCorruptDismissed(cwd, featureId, now);
	const existing = readDismissed(cwd, featureId);
	const byRef = new Map(existing.map((d) => [d.ref, d]));
	const added: DismissedItem[] = [];
	for (const it of items) {
		const ref = dismissalRef(it.description);
		if (!ref) continue;
		const rec: DismissedItem = { ref, reason: String(it.reason ?? "").trim() || "(no reason given)", at: now() };
		byRef.set(ref, rec);
		added.push(rec);
	}
	const final = [...byRef.values()];
	const dir = runDir(cwd, featureId);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `dismissed.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(final, null, 2)}\n`);
	fs.renameSync(tmp, dismissedPath(cwd, featureId));
	if (added.length) appendProgress(cwd, featureId, "handoff_items_dismissed", { count: added.length, refs: added.map((d) => d.ref) }, now);
	return final;
}
