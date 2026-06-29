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
	return path.join(cwd, ".harness", "runs", featureId);
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
export function handoffOutcome(cwd: string, featureId: string, taskId: string): { success: boolean; returnToOrchestrator: boolean } {
	const h = latestHandoff(cwd, featureId, taskId);
	if (!h) return { success: false, returnToOrchestrator: false };
	return { success: h.successState === "success", returnToOrchestrator: !!h.returnToOrchestrator };
}
