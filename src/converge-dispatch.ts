/**
 * Native dispatch for Tier-2 feature convergence (Fatia 3) — model-driven, in-session,
 * with a Plan (rpiv-todo) of the convergence phases. The model runs the `feature-converge`
 * skill and authors feature.md + contract.md (frozen) + plan.json under
 * .harness/runs/<feature-id>/, finishing by calling `store_plan` (which validates the
 * coverage invariant and persists plan.json + status.json the FeatureRunner consumes).
 */
import type { DispatchTools } from "./readiness-dispatch.ts";

/** The convergence phases (one todo each — the "Plan · X/5"). */
export const CONVERGE_PHASES: readonly string[] = [
	"Phase 1: Size + understand the feature (Small/Medium/Large/Complex → depth; structure invariant) + gray-area",
	"Phase 2: feature.md (intent + scope)",
	"Phase 3: contract.md (frozen, black-box assertions)",
	"Phase 4: decompose into ordered tasks (each → assertion)",
	"Phase 5: store_plan (validate coverage + persist)",
];

/** Builds the message that converges a feature live (Plan via rpiv-todo when active).
 * `opts.headless` = CI mode (no interactive user): every gray area resolves as `[assumido]`
 * and `ask_user_question` is forbidden (there is nobody to answer). */
export function buildConvergeDispatch(request: string, featureId: string, tools: DispatchTools = {}, opts: { headless?: boolean } = {}): string {
	const lines = [
		`Converge the feature into its run artifacts now, live in this session.`,
		`Feature id: ${featureId}. Run directory: .harness/runs/${featureId}/. User request: ${request}`,
		"",
	];
	if (opts.headless) {
		lines.push(
			"**Headless mode (no interactive user).** There is NOBODY to answer questions:",
			"- Do NOT call `ask_user_question`. Run the gray-area policy's dimensions sweep, but resolve EVERY gray area yourself as `[assumido]` with a conservative default + rationale (cite profile/codebase evidence).",
			"- Tag HIGH-risk assumptions clearly in feature.md's `## Gray-area decisions` table (Status `[assumido]`, Risk `HIGH`) so a human can review them later; do not block on them.",
			"- Author the artifacts and call `store_plan` directly — do not pause for confirmation.",
			"",
		);
	}
	let n = 1;
	if (tools.todo) {
		lines.push(
			`${n++}. First, create a plan with the \`todo\` tool — one todo per phase:`,
			...CONVERGE_PHASES.map((p) => `   - ${p}`),
			`${n++}. Invoke the \`feature-converge\` skill and work through the phases in order, marking each todo in_progress → completed.`,
		);
	} else {
		lines.push(`${n++}. Invoke the \`feature-converge\` skill and work through its phases in order.`);
	}
	lines.push(
		`${n++}. **Size the feature first** (Small/Medium/Large/Complex — see feature-converge Phase 0): it scales the convergence depth, NOT the structure. contract.md (≥1 frozen black-box assertion), the store_plan coverage invariant, and the ship gate ALWAYS run regardless of size; when in doubt, size up (a thin contract ships unvalidated behavior).`,
		`${n++}. Read the cached profile (.harness/profile/: architecture.md, services.yaml, harness.md, skills/, library/) — do NOT re-derive it. If the profile is absent, stop and tell the user to run /harness setup.`,
		`${n++}. Author under .harness/runs/${featureId}/: feature.md (intent + scope + captured requirements + gray-area decisions), then contract.md (FROZEN, black-box assertions via subagents + at least one review pass). Then **decompose into ordered tasks** (each names a profile worker skill + the assertion IDs it fulfills) — the tasks are persisted by store_plan as plan.json, NOT hand-written as markdown.`,
		`${n++}. Finish by calling the \`store_plan\` tool with featureId="${featureId}", the structured tasks, and ALL assertion IDs from contract.md. It enforces the coverage invariant (every assertion claimed by exactly one task) and persists plan.json + status.json. Do NOT hand-write plan.json/status.json.`,
		`${n++}. Then give a short summary: what the feature delivers, the assertions, and the task count — and tell the user to run \`/harness run\` to execute the plan.`,
	);
	if (tools.todo) {
		lines.push(`${n++}. Finally, clear the plan with the \`todo\` tool (\`action: "clear"\`) so it doesn't linger.`);
	}
	return lines.join("\n");
}
