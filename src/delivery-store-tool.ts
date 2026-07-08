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
	repoFullName: Type.Optional(Type.String({ description: "owner/repo (from the git remote) — enables commits⋈issue joins downstream." })),
	draft: Type.Optional(Type.Boolean({ description: "PR opened as a draft (gh pr create --draft) — use to escalate ci_blocked without asking for merge." })),
	hasRemote: Type.Optional(Type.Boolean({ description: "Does the repo have a git remote? Pre-delivery check; false → no PR possible." })),
	prCreatedAt: Type.Optional(Type.String({ description: "ISO timestamp the PR was created." })),
	prMergedAt: Type.Optional(Type.String({ description: "ISO timestamp the PR merged." })),
	commitShas: Type.Optional(Type.Array(Type.String(), { description: "Full SHAs of the commits this delivery ships (git log %H base..HEAD)." })),
	diff: Type.Optional(
		Type.Object(
			{
				summary: Type.Optional(Type.String({ description: "AI semantic-diff summary (2–6 lines) of what this delivery changes — shown in the human merge gate. Generate it BEFORE state:awaiting_merge." })),
				filesChanged: Type.Optional(Type.Number()),
				insertions: Type.Optional(Type.Number()),
				deletions: Type.Optional(Type.Number()),
			},
			{ description: "Semantic diff summary + stats for the merge gate (droid's generate_semantic_diff analog)." },
		),
	),
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
				"Persists the harness-deliver record (PR + repo/commits + linked Linear/Jira issue + CI checks + fix-loop + semantic diff + merge state) to .harness/runs/<featureId>/validation/delivery/record.json — it drives the cockpit Delivery tab (Alt+T) live. Call at each transition (PR opened, CI changed, fix applied). Provide `diff.summary` + `commitShas` + `repoFullName` before setting state:\"awaiting_merge\" (CI green + mergeable), which pops the human merge gate overlay showing that diff summary (the agent must never merge on its own).",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const rec: DeliveryRecord = normalizeDeliveryRecord(params);
				writeDeliveryRecord(ctx.cwd, params.featureId, rec);
				const gate = rec.state === "awaiting_merge" ? " — merge gate will open (awaiting human decision)" : "";
				return {
					content: [{ type: "text", text: `✓ delivery record written — ${deliveryStateLabel(rec.state)}${rec.prNumber ? ` (PR #${rec.prNumber})` : ""}${gate}.` }],
					details: { featureId: params.featureId, state: rec.state, prNumber: rec.prNumber ?? null, ciState: rec.ci.state },
				};
			},
		}),
	);
}
