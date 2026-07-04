/**
 * Worker bootstrap — a primeira mensagem injetada num child de worker/validator
 * (porte da função de bootstrap do worker, docs/02).
 *
 * **Granularidade = FEATURE (paridade droid):** um step de implementação ("task") carrega a
 * LISTA INTEIRA de tasks do plan.json e UM worker as trabalha TODAS numa única sessão contínua —
 * roda `harness-worker-base` 1×, percorre as tasks em ordem (skill de cada task → implementa →
 * verifica → commit por task com o taskId), e chama `EndFeatureRun` UMA vez no fim. Um fix step
 * carrega uma única task. Steps de SHIP GATE (harness-code-review/harness-qa-validator/
 * harness-deliver) pulam o harness-worker-base e invocam o validator direto, sempre com
 * returnToOrchestrator.
 *
 * Função pura (testável) — o spawn real injeta o retorno como primeira mensagem.
 */
import type { FeatureStep, PlanTaskRef } from "./feature-runner.ts";

export interface BootstrapOpts {
	featureId: string;
	workerSessionId: string;
}

/** As tasks que o step cobre: `step.tasks` (impl/fix) ou, em fallback, uma sintética dos campos do step. */
function stepTasks(step: FeatureStep): PlanTaskRef[] {
	if (step.tasks?.length) return step.tasks;
	return [{ id: step.id, skillName: step.skillName, fulfills: step.fulfills }];
}

export function buildWorkerBootstrap(step: FeatureStep, opts: BootstrapOpts): string {
	const isGate = step.kind === "ship-gate";

	if (isGate) {
		return [
			"<system-reminder>",
			`You are a worker assigned to execute ship-gate step "${step.id}" for feature "${opts.featureId}".`,
			"## Worker Session",
			`Your worker session id is: ${opts.workerSessionId}`,
			"REMEMBER TO CALL EndFeatureRun WHEN YOU ARE DONE (even on errors). End your turn immediately after.",
			"</system-reminder>",
			"## Your Task",
			`1. Invoke the '${step.skillName}' skill (ship-gate validator) and follow it.`,
			"2. Call EndFeatureRun (returnToOrchestrator: true) with your synthesis when done.",
			"## Your Assigned Ship-Gate Step",
			"```json",
			JSON.stringify({ id: step.id, skillName: step.skillName, kind: step.kind, fulfills: step.fulfills ?? [] }, null, 2),
			"```",
		].join("\n");
	}

	// Worker de implementação: dono da feature inteira (ou de uma fix task). Trabalha TODAS as
	// tasks numa única sessão. Multi-task → loop `next_task` (o harness sequencia; fronteiras gravadas
	// por máquina). Single (fix) → a task única direto (sem loop).
	const tasks = stepTasks(step);
	const multi = tasks.length > 1;

	if (multi) {
		return [
			"<system-reminder>",
			`You are a worker assigned to deliver feature "${opts.featureId}" end-to-end.`,
			"## Worker Session",
			`Your worker session id is: ${opts.workerSessionId}`,
			`This is ONE continuous session for the WHOLE feature (${tasks.length} tasks). The harness hands you tasks ONE AT A TIME via the \`next_task\` tool and records progress DETERMINISTICALLY — it marks a task done only AFTER you commit (it re-hands you the same task until a commit lands). Do NOT split across sessions; your context carries across every task.`,
			"REMEMBER TO CALL EndFeatureRun **ONCE** WHEN `next_task` REPORTS ALL TASKS ARE DONE (even on errors). End your turn immediately after.",
			"</system-reminder>",
			"## Your Task",
			"1. Invoke the 'harness-worker-base' skill for startup procedures — run it **once** for the whole feature.",
			"2. LOOP until done:",
			`   a. Call \`next_task({ featureId: "${opts.featureId}" })\` to receive your next task (id, skillName, description, preconditions, expectedBehavior, fulfills).`,
			"   b. Invoke that task's `skillName` skill, implement it, and run its verification.",
			"   c. COMMIT the repo change with the task id in the message (e.g. `[<taskId>] <summary>`). You MUST commit — `next_task` will not advance you otherwise.",
			"   d. Call `next_task` again for the following task.",
			`3. When \`next_task\` reports all tasks are done, call EndFeatureRun **once** (taskId="${step.id}"), or with returnToOrchestrator:true if you are blocked.`,
			"4. On resume / re-run, just call `next_task` — it resumes at the next uncommitted task automatically. Never redo committed work.",
			"## Tasks",
			`This feature has ${tasks.length} tasks (${tasks.map((t) => t.id).join(", ")}). The full spec of each is delivered by \`next_task\` — the tool is the source of truth; the list is NOT inlined here on purpose.`,
		].join("\n");
	}

	const only = tasks[0];
	return [
		"<system-reminder>",
		`You are a worker assigned to deliver feature "${opts.featureId}" end-to-end.`,
		"## Worker Session",
		`Your worker session id is: ${opts.workerSessionId}`,
		"This is your worker session for the task below.",
		"REMEMBER TO CALL EndFeatureRun WHEN YOU ARE DONE (even on errors). End your turn immediately after.",
		"</system-reminder>",
		"## Your Task",
		"1. First, invoke the 'harness-worker-base' skill for startup procedures.",
		"2. Then invoke the task's `skillName` skill, implement it, run its verification, and commit the repo change (put the task id in the message).",
		`3. Call EndFeatureRun (taskId="${step.id}") when done, or with returnToOrchestrator:true if blocked.`,
		"4. On resume, check the repo state first and continue where you left off — don't restart from scratch.",
		"## Your Assigned Task",
		"```json",
		JSON.stringify({ id: only.id, description: only.description, skillName: only.skillName, fulfills: only.fulfills ?? [], preconditions: only.preconditions ?? [], expectedBehavior: only.expectedBehavior ?? [] }, null, 2),
		"```",
	].join("\n");
}
