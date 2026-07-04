/**
 * Tool `EndFeatureRun` — o único ponto de saída de um worker/validator (porte do
 * EndFeatureRun do modelo de referência). O child a chama no fim com o handoff estruturado; o TS
 * persiste em handoffs/ + worker-transcripts.jsonl (handoff.ts). O FeatureRunner lê
 * esse handoff (handoffOutcome) pra decidir success/returnToOrchestrator do step.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type EndFeatureRunPayload, readHandoffExact, recordHandoff } from "./handoff.ts";

const Issue = Type.Object({
	severity: Type.Union([Type.Literal("blocking"), Type.Literal("non_blocking"), Type.Literal("suggestion")]),
	description: Type.String(),
	suggestedFix: Type.Optional(Type.String()),
});

const Handoff = Type.Object({
	salientSummary: Type.Optional(Type.String({ description: "1–4 sentence concrete summary." })),
	whatWasImplemented: Type.String({ description: "What was built (min ~50 chars)." }),
	whatWasLeftUndone: Type.String({ description: "Incomplete work — empty string if truly done." }),
	verification: Type.Object({
		commandsRun: Type.Array(Type.Object({ command: Type.String(), exitCode: Type.Integer(), observation: Type.String() })),
		interactiveChecks: Type.Optional(Type.Array(Type.Object({ action: Type.String(), observed: Type.String() }))),
	}),
	tests: Type.Optional(
		Type.Object({
			added: Type.Array(Type.Object({ file: Type.String(), cases: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })) })),
			coverage: Type.Optional(Type.String()),
		}),
	),
	discoveredIssues: Type.Optional(Type.Array(Issue)),
	skillFeedback: Type.Optional(
		Type.Object({
			followedProcedure: Type.Boolean(),
			deviations: Type.Optional(Type.Array(Type.Object({ step: Type.String(), whatIDidInstead: Type.String(), why: Type.String() }))),
			suggestedChanges: Type.Optional(Type.Array(Type.String())),
		}),
	),
});

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (from your bootstrap) — selects the run directory." }),
	taskId: Type.String({ description: "Your assigned task/ship-gate step id (from your bootstrap)." }),
	workerSessionId: Type.String({ description: "Your worker session id (from your bootstrap)." }),
	successState: Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failure")]),
	returnToOrchestrator: Type.Boolean(),
	validatorsPassed: Type.Boolean({ description: "Must be true if successState === 'success'." }),
	commitId: Type.Optional(Type.String({ description: "Include when repository code changed." })),
	repoPath: Type.Optional(Type.String({ description: "Include with commitId." })),
	handoff: Handoff,
});

export function registerEndFeatureRunTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "EndFeatureRun",
			label: "End Feature Run",
			description:
				"The single exit point of a worker/ship-gate session. Records your structured handoff to the feature run (.harness/runs/<featureId>/handoffs/). Call exactly once when done, then end your turn immediately.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { featureId, ...rest } = params as { featureId: string } & EndFeatureRunPayload;
				// "Call exactly once" É enforçado: um segundo call da MESMA sessão flipava o outcome que o
				// runner lê (last-write-wins) e duplicava task_completed/task_failed no progress_log.
				const dup = readHandoffExact(ctx.cwd, featureId, rest.taskId, rest.workerSessionId);
				if (dup) {
					return {
						content: [{ type: "text", text: `Handoff already recorded for this session (${dup.successState}) — EndFeatureRun is once-only. End your turn now.` }],
						details: { error: "duplicate_handoff", successState: dup.successState },
					};
				}
				const file = recordHandoff(ctx.cwd, featureId, rest as EndFeatureRunPayload);
				return {
					content: [{ type: "text", text: `✓ handoff recorded (${rest.successState}${rest.returnToOrchestrator ? ", returnToOrchestrator" : ""}) → ${file}` }],
					details: { successState: rest.successState, returnToOrchestrator: rest.returnToOrchestrator },
				};
			},
		}),
	);
}
