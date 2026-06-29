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
	"Phase 1: Understand the feature (clarify + gray-area decisions)",
	"Phase 2: feature.md (intent + scope)",
	"Phase 3: contract.md (frozen, black-box assertions)",
	"Phase 4: decompose into ordered tasks (each → assertion)",
	"Phase 5: store_plan (validate coverage + persist)",
];

/** Builds the message that converges a feature live (Plan via rpiv-todo when active). */
export function buildConvergeDispatch(request: string, featureId: string, tools: DispatchTools = {}): string {
	const lines = [
		`Converge the feature into its run artifacts now, live in this session.`,
		`Feature id: ${featureId}. Run directory: .harness/runs/${featureId}/. User request: ${request}`,
		"",
	];
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
