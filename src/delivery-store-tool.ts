/**
 * Tool `store_delivery` — o "store" do passo de entrega (ship-gate step 3, `harness-deliver`),
 * espelhando store_plan/store_profile. A skill chama esta tool a cada transição relevante (PR
 * aberto, CI mudou, fix aplicado, e — crucial — quando o CI fica verde e o PR mergeable, com
 * `state:"awaiting_merge"`). Persiste `validation/delivery/record.json`.
 *
 * Quando `state === "awaiting_merge"`, a EXTENSÃO (index.ts) detecta no `tool_execution_end` e
 * abre o overlay de merge humano (showMergeGate) no próximo `agent_end` — o merge NUNCA é
 * autônomo. As outras transições só alimentam a aba Delivery do cockpit (read-only, ao vivo).
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DeliveryRecord, deliveryStateLabel, normalizeDeliveryRecord, writeDeliveryRecord } from "./delivery.ts";

const CheckSchema = Type.Object({
	name: Type.String(),
	state: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("pending"), Type.Literal("skipped")]),
	link: Type.Optional(Type.String()),
});

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (selects .harness/runs/<featureId>/)." }),
	prNumber: Type.Optional(Type.Number()),
	prUrl: Type.Optional(Type.String()),
	prTitle: Type.Optional(Type.String()),
	baseBranch: Type.Optional(Type.String()),
	headBranch: Type.Optional(Type.String()),
	linkedIssues: Type.Optional(
		Type.Object({
			linearIssueIds: Type.Optional(Type.Array(Type.String())),
			jiraIssueKeys: Type.Optional(Type.Array(Type.String())),
			candidateKeys: Type.Optional(Type.Array(Type.String())),
		}),
	),
	ci: Type.Optional(
		Type.Object({
			state: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("pending"), Type.Literal("ci_blocked")]),
			iterations: Type.Optional(Type.Number({ description: "fix-loop iterations consumed (cap 3)." })),
			checks: Type.Optional(Type.Array(CheckSchema)),
			primaryFailure: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
	),
	state: Type.Union([Type.Literal("preparing"), Type.Literal("open"), Type.Literal("awaiting_merge"), Type.Literal("merged"), Type.Literal("cancelled"), Type.Literal("ci_blocked")], {
		description: "Delivery state. Set 'awaiting_merge' when CI is green and the PR is mergeable — this pops the human merge gate overlay.",
	}),
	fixesApplied: Type.Optional(Type.Array(Type.String())),
	salientSummary: Type.Optional(Type.String()),
});

export function registerDeliveryStoreTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "store_delivery",
			label: "Store Delivery Record",
			description:
				"Persists the harness-deliver record (PR + linked Linear/Jira issue + CI checks + fix-loop + merge state) to .harness/runs/<featureId>/validation/delivery/record.json — it drives the cockpit Delivery tab (Ctrl+T) live. Call at each transition (PR opened, CI changed, fix applied). Set state:\"awaiting_merge\" once CI is green and the PR is mergeable to trigger the human merge gate overlay (the agent must never merge on its own).",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const rec: DeliveryRecord = normalizeDeliveryRecord(params);
				writeDeliveryRecord(ctx.cwd, params.featureId, rec);
				const gate = rec.state === "awaiting_merge" ? " — merge gate will open (awaiting human decision)" : "";
				return {
					content: [{ type: "text", text: `✓ delivery record written — ${deliveryStateLabel(rec.state)}${rec.prNumber ? ` (PR #${rec.prNumber})` : ""}${gate}.` }],
					details: { state: rec.state, prNumber: rec.prNumber ?? null, ciState: rec.ci.state },
				};
			},
		}),
	);
}
