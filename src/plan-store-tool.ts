/**
 * Tool `store_plan` — o estágio "store" da convergência da feature, espelhando
 * store_profile / store_agent_readiness_report: a `harness-feature-converge` (LLM) autora
 * feature.md + contract.md e CHAMA esta tool no fim com as tasks estruturadas + os
 * ids das assertions do contract. O TS valida a INVARIANTE DE COBERTURA (cada assertion
 * reivindicada por exatamente uma task) e persiste plan.json + status.json.
 *
 * Recusa (THROW) se a cobertura quebrar — o loop devolve o erro pro modelo, que corrige
 * o plan e chama de novo.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Plan, storePlan } from "./plan.ts";

const TaskSchema = Type.Object({
	id: Type.String({ description: "Unique task id (e.g. T1)." }),
	description: Type.String({ description: "What to build (clear, specific)." }),
	skillName: Type.String({ description: "A profile worker skill in .harness/profile/skills/." }),
	fulfills: Type.Array(Type.String(), { description: "Contract assertion IDs this task COMPLETES (empty for foundational tasks)." }),
	preconditions: Type.Optional(Type.Array(Type.String())),
	expectedBehavior: Type.Optional(Type.Array(Type.String())),
	cohesion: Type.Optional(Type.String({ description: "Batching cohesion tag (doc 05): consecutive tasks with the SAME non-empty tag are never split across batches. Budget drives batch SIZE; cohesion only constrains WHERE the cut lands. Omit for free budget-driven cuts." })),
	batchBreakBefore: Type.Optional(Type.Boolean({ description: "Force a batch seam BEFORE this task (hard boundary; doc 05). Rare — use at a genuine dependency/domain frontier." })),
	weight: Type.Optional(Type.Number({ description: "Batch-budget weight (doc 05, token-aware). Default 1 (counts as one task). Set > 1 for an unusually heavy task so it consumes more budget → smaller batches around it. Omit for normal tasks." })),
});

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (selects .harness/runs/<featureId>/)." }),
	tasks: Type.Array(TaskSchema, { description: "Ordered tasks (foundational first). Topmost pending runs next." }),
	assertions: Type.Array(Type.String(), { description: "ALL assertion IDs from contract.md (to enforce coverage)." }),
});

export function registerPlanStoreTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "store_plan",
			label: "Store Feature Plan",
			description:
				"Validates the feature plan's coverage invariant (every contract assertion claimed by exactly one task's fulfills — no orphans, no duplicates) and persists .harness/runs/<featureId>/plan.json + status.json (assertions pending). Call at the END of harness-feature-converge. Rejects (throws) on a coverage violation — fix the plan and call again.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const plan: Plan = {
					featureId: params.featureId,
					tasks: params.tasks as Plan["tasks"],
					assertions: params.assertions,
					createdAt: new Date().toISOString(),
				};
				const res = storePlan(ctx.cwd, plan);
				if (!res.ok) {
					throw new Error(`Plan REJECTED (${res.issues.length} coverage problems):\n- ${res.issues.slice(0, 20).join("\n- ")}\nFix the plan and call store_plan again.`);
				}
				return {
					content: [{ type: "text", text: `✓ plan.json + status.json written — ${res.plan.tasks.length} tasks, ${res.plan.assertions.length} assertions (coverage OK).` }],
					// featureId nos details: o extension usa-o pra sincronizar o ponteiro de feature ativa
					// (.session.json + mode em memória) com a feature recém-convergida — senão o ponteiro
					// só-comando ficava stale quando o orchestrator converge via tool (não via /harness "...").
					details: { featureId: plan.featureId, tasks: res.plan.tasks.length, assertions: res.plan.assertions.length },
				};
			},
		}),
	);
}
