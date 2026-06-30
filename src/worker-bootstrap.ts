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
	// tasks abaixo numa única sessão.
	const tasks = stepTasks(step);
	const multi = tasks.length > 1;
	const lines: string[] = [
		"<system-reminder>",
		`You are a worker assigned to deliver feature "${opts.featureId}" end-to-end.`,
		"## Worker Session",
		`Your worker session id is: ${opts.workerSessionId}`,
		multi
			? `This is ONE continuous session for the WHOLE feature — you own ALL ${tasks.length} tasks below. Do NOT split them across sessions; the startup runs once and your context carries across every task.`
			: "This is your worker session for the task below.",
		"REMEMBER TO CALL EndFeatureRun **ONCE** WHEN ALL TASKS ARE DONE (even on errors). End your turn immediately after.",
		"</system-reminder>",
		"## Your Task",
		"1. First, invoke the 'harness-worker-base' skill for startup procedures — run it **once** for the whole feature.",
		multi
			? "2. Then work through EVERY task below **in order, in THIS session**: for each task, invoke its `skillName` skill, implement it, run its verification, and commit the repo change with the task id in the message (e.g. `[<taskId>] <summary>`). Keep your own todo to track them."
			: "2. Then invoke the task's `skillName` skill, implement it, run its verification, and commit the repo change (put the task id in the message).",
		"3. Mark per-task progress with the `task_progress` tool (`status: \"started\"` then `\"completed\"`, with `taskId`) as you go, so progress is visible live.",
		multi
			? "4. On resume / re-run, check `git log --oneline` first to see which tasks are already committed and **skip them** — only do the remaining ones. Never redo committed work."
			: "4. On resume, check the repo state first and continue where you left off — don't restart from scratch.",
		`5. Call EndFeatureRun **once** when all tasks are done (taskId="${step.id}"), or with returnToOrchestrator:true if blocked.`,
		multi ? "## Your Tasks (ordered — work top to bottom, one EndFeatureRun at the end)" : "## Your Assigned Task",
		"```json",
		JSON.stringify(
			tasks.map((t) => ({ id: t.id, description: t.description, skillName: t.skillName, fulfills: t.fulfills ?? [], preconditions: t.preconditions ?? [], expectedBehavior: t.expectedBehavior ?? [] })),
			null,
			2,
		),
		"```",
	];
	return lines.join("\n");
}
