/**
 * F1 do doc 09 (§3.1) — reinjeção de contexto POR TURNO no worker, o transplante do
 * `#buildGoalModeMessage` do omp: uma CustomMessage OCULTA (`display:false`), RECONSTRUÍDA DO
 * DISCO a cada turno via `before_agent_start`. Nunca fica presa no histórico, nunca envelhece,
 * nunca é soterrada por 40 tool calls — mata a deriva do contrato (o contract era lido 1× no
 * startup e depois virava memória).
 *
 * Invariante: o conteúdo é DERIVADO, nunca acumulado. Se status.json/progress mudam, o próximo
 * turno já enxerga. Dedupe no estilo omp: conteúdo byte-idêntico ao turno anterior colapsa pra
 * "(unchanged — still in effect)"; o corpo reexpande quando muda.
 *
 * A extensão liga isto SÓ dentro de um processo de worker do harness (env
 * PI_HARNESS_WORKER_FEATURE, setado pelo spawn do runner em rpc-worker.ts). Builders PUROS
 * (testáveis); a leitura de disco vive em readTurnContext.
 */
import { readContractAssertions } from "./contract.ts";
import { lessonsBriefing, readLessonsStore } from "./lessons.ts";
import { completedTaskIds, readNextTaskState, readProgressEvents } from "./next-task.ts";
import { type AssertionStatus, readPlan, readStatus } from "./plan.ts";

export interface TurnAssertion {
	id: string;
	status: AssertionStatus;
	text: string;
}

export interface TurnContext {
	featureId: string;
	/** task ATIVA (nextTaskState.activeTaskId) — null antes do primeiro next_task. */
	taskId: string | null;
	taskDescription?: string;
	skillName?: string;
	/** assertions do `fulfills` da task ativa, com o status VIVO de status.json. */
	assertions: TurnAssertion[];
	/** progresso do batch (feito/total) — orienta sem inflar. */
	done: number;
	total: number;
	/** lições aplicáveis (briefing curto do lessons store). */
	lessons: string;
	/** fix task (FIX*): o finding verbatim vive na description — repetido à parte. */
	isFix: boolean;
}

/** Monta o TurnContext do DISCO (sempre fresco — derivado, nunca acumulado). null sem plano. */
export function readTurnContext(cwd: string, featureId: string): TurnContext | null {
	const plan = readPlan(cwd, featureId);
	if (!plan) return null;
	const status = readStatus(cwd, featureId);
	const state = readNextTaskState(cwd, featureId);
	const completed = completedTaskIds(readProgressEvents(cwd, featureId));
	const active = state?.activeTaskId ? plan.tasks.find((t) => t.id === state.activeTaskId) : undefined;
	const texts = readContractAssertions(cwd, featureId);
	const assertions: TurnAssertion[] = (active?.fulfills ?? []).map((id) => ({
		id,
		status: status?.assertions[id] ?? "pending",
		text: texts.get(id) ?? "",
	}));
	let lessons = "";
	try {
		lessons = lessonsBriefing(readLessonsStore(cwd));
	} catch {
		/* sem lições — briefing vazio */
	}
	return {
		featureId,
		taskId: active?.id ?? null,
		taskDescription: active?.description,
		skillName: active?.skillName,
		assertions,
		done: plan.tasks.filter((t) => completed.has(t.id)).length,
		total: plan.tasks.length,
		lessons,
		isFix: /^FIX/i.test(active?.id ?? ""),
	};
}

/** Constrói o corpo da mensagem de turno (PURO). */
export function buildWorkerTurnMessage(tc: TurnContext): string {
	const lines: string[] = [`[harness turn context — feature ${tc.featureId} · ${tc.done}/${tc.total} tasks committed]`];
	if (tc.taskId) {
		lines.push(`CURRENT TASK: ${tc.taskId}${tc.skillName ? ` (skill: ${tc.skillName})` : ""}`);
		if (tc.taskDescription) lines.push(tc.isFix ? `FIX — original finding, verbatim: ${tc.taskDescription}` : tc.taskDescription);
	} else {
		lines.push("No task pulled yet — call next_task to start.");
	}
	if (tc.assertions.length > 0) {
		lines.push("", "THIS TASK COMPLETES (contract assertions — live status):");
		for (const a of tc.assertions) lines.push(`- [${a.status}] ${a.id}${a.text ? ` — ${a.text}` : ""}`);
	}
	lines.push(
		"",
		"FROZEN (never edit by hand): contract.md, plan.json, status.json — tools own them.",
		"Commit per task ([<taskId>] <summary>); the harness will not advance you without a commit.",
	);
	if (tc.lessons.trim()) lines.push("", tc.lessons.trim());
	return lines.join("\n");
}

// Dedupe por feature: conteúdo byte-idêntico ao turno anterior → colapsa (economiza contexto sem
// perder a garantia — a regra continua "em vigor"; reexpande na primeira mudança).
const lastByFeature = new Map<string, string>();

export function dedupeTurnMessage(featureId: string, content: string): string {
	const prev = lastByFeature.get(featureId);
	if (prev === content) return `[harness turn context — feature ${featureId}] (unchanged — still in effect)`;
	if (lastByFeature.size > 8) lastByFeature.clear();
	lastByFeature.set(featureId, content);
	return content;
}

/** Reset do dedupe (testes). */
export function resetTurnMessageDedupe(): void {
	lastByFeature.clear();
}
