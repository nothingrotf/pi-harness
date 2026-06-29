/**
 * Worker bootstrap — a primeira mensagem injetada num child de worker/validator
 * (porte da função de bootstrap do worker, docs/02). Pra steps de TASK manda rodar
 * `worker-base` → a skill da task → `EndFeatureRun`. Pra steps de SHIP GATE
 * (code-review/qa-validator) pula o worker-base e invoca o validator direto (igual ao
 * referência: validators pulam o worker-base), sempre com returnToOrchestrator.
 *
 * Função pura (testável) — o spawn real injeta o retorno como primeira mensagem.
 */
import type { FeatureStep } from "./feature-runner.ts";

export interface BootstrapOpts {
	featureId: string;
	workerSessionId: string;
}

export function buildWorkerBootstrap(step: FeatureStep, opts: BootstrapOpts): string {
	const isGate = step.kind === "ship-gate";
	const noun = isGate ? "ship-gate step" : "task";
	const lines: string[] = [
		"<system-reminder>",
		`You are a worker assigned to execute ${noun} "${step.id}" for feature "${opts.featureId}".`,
		"## Worker Session",
		`Your worker session id is: ${opts.workerSessionId}`,
		"REMEMBER TO CALL EndFeatureRun WHEN YOU ARE DONE (even on errors). End your turn immediately after.",
		"</system-reminder>",
		"## Your Task",
	];
	if (isGate) {
		lines.push(
			`1. Invoke the '${step.skillName}' skill (ship-gate validator) and follow it.`,
			"2. Call EndFeatureRun (returnToOrchestrator: true) with your synthesis when done.",
		);
	} else {
		lines.push(
			"1. First, invoke the 'worker-base' skill for startup procedures.",
			`2. Then, invoke the '${step.skillName}' skill to complete your assigned task.`,
			"3. Call EndFeatureRun when done.",
		);
	}
	lines.push(
		`## Your Assigned ${isGate ? "Ship-Gate Step" : "Task"}`,
		"```json",
		JSON.stringify({ id: step.id, skillName: step.skillName, kind: step.kind, fulfills: step.fulfills ?? [] }, null, 2),
		"```",
	);
	return lines.join("\n");
}
