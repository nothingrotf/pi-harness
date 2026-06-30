/**
 * Fluxo de "gerar a feature" rebrandeado do mission-generation do Droid (docs/03-tui.md §9):
 *   1. Card de onboarding/intro  (analog de missionOnboarding)
 *   2. ... readiness gate (já existe) ...
 *   3. Proposal confirmation      (analog de missionProposalConfirmation): Proceed / Proceed
 *      with comment / Manually edit / No and explain  — após o store_plan persistir o plano.
 *
 * Lógica/copy PURA (sem pi), testável (test/proposal.test.ts). proposal-view.ts pinta;
 * o index.ts liga via eventos (tool_execution_end de store_plan → overlay no agent_end).
 */
import type { ControlModel } from "./control-model.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Card de onboarding (rebrand: feature-scoped, não "mission" macro)

export const ONBOARDING_TITLE = "Feature — spec-driven, contract-first execution";

/** Corpo do card (string[]); a view envolve em frame + footer "Enter continue · Esc cancel". */
export function featureOnboardingLines(): string[] {
	return [
		"How it works:",
		"  1. Describe the feature",
		"  2. Review & approve the frozen contract + task plan",
		"  3. Workers implement task-by-task (sequential)",
		"  4. The ship gate validates every assertion (code-review + QA)",
		"",
		"Key concepts:",
		"  • Orchestrator — plans & manages; never implements",
		"  • Workers — execute one task each",
		'  • Contract — frozen black-box assertions = the definition of "done"',
		"",
		"Notes:",
		"  • Feature-scoped & sequential (not a multi-day mission)",
		"  • Reuses the cached repo profile (.harness/profile/)",
		"  • Gray areas resolved up front (PUSH + ASK · [assumido]/[confirmado])",
	];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Proposal confirmation

export type ProposalChoice = { kind: "proceed" } | { kind: "comment"; comment: string } | { kind: "edit" } | { kind: "reject"; reason: string };

export interface ProposalOption {
	value: "proceed" | "comment" | "edit" | "reject";
	label: string;
	description: string;
}

/** As 4 opções (rebrand das do missionProposalConfirmation). */
export const PROPOSAL_OPTIONS: ProposalOption[] = [
	{ value: "proceed", label: "Proceed with the plan", description: "approve — starts running now" },
	{ value: "comment", label: "Proceed with comment", description: "approve + steering — starts running now" },
	{ value: "edit", label: "Manually edit plan", description: "open plan.json in the editor" },
	{ value: "reject", label: "No, and explain why", description: "send it back to revise" },
];

/** Linhas-resumo do plano proposto (tasks · assertions · cobertura). PURA. */
export function proposalSummaryLines(model: ControlModel | null): string[] {
	if (!model) return ["(no plan found)"];
	const a = model.assertions;
	const lines = [`${model.tasksTotal} tasks · ${a.total} assertions · coverage invariant OK`];
	const ids = model.tasks.slice(0, 6).map((t) => t.id);
	if (ids.length) lines.push(`tasks: ${ids.join(", ")}${model.tasks.length > ids.length ? ", …" : ""}`);
	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mensagens que o caller manda de volta ao modelo (sendUserMessage) — PURAS.

/** Reprovado: faz o modelo revisar e chamar store_plan de novo. */
export function proposalRejectMessage(featureId: string, reason: string): string {
	return [
		`The user reviewed the proposed plan for "${featureId}" and did NOT approve it.`,
		`Reason: ${reason || "(no reason given)"}`,
		"Revise feature.md / contract.md and the task decomposition accordingly, then call `store_plan` again with the corrected plan.",
	].join("\n");
}

/** Aprovado com comentário: steering pra incorporar na execução, que JÁ está começando (sem /harness run). */
export function proposalCommentMessage(featureId: string, comment: string): string {
	return [
		`The user APPROVED the plan for "${featureId}" and execution is starting now.`,
		"Apply this steering guidance throughout execution:",
		comment || "(empty comment)",
	].join("\n");
}
