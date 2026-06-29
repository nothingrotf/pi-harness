/**
 * Native dispatch for the Tier-1 profile setup (Fatia 1) — model-driven, in-session,
 * live tool streaming + a Plan (rpiv-todo) of the setup phases. The model runs the
 * `harness-setup` skill and writes the profile artifacts under .harness/profile/.
 * The harness stamps profile.json (fingerprint) deterministically afterwards.
 */
import type { DispatchTools } from "./readiness-dispatch.ts";

/** The setup phases (one todo each — the "Plan · X/8"). */
export const SETUP_PHASES: readonly string[] = [
	"Phase 0: Brownfield extraction (what the repo declares)",
	"Phase 1: architecture.md",
	"Phase 2: services.yaml + init.sh",
	"Phase 3: harness.md (operational overlay)",
	"Phase 4: skills/<worker-type>/ (worker system)",
	"Phase 5: Profile readiness check (verify-by-execution)",
	"Phase 6: library/",
	"Phase 7: store_profile (validate + stamp profile.json)",
];

/** Builds the message that runs the profile setup live (Plan via rpiv-todo when active). */
export function buildSetupDispatch(tools: DispatchTools = {}): string {
	const lines = ["Set up the Tier-1 Repo Profile for THIS repository now, live in this session.", ""];
	let n = 1;
	if (tools.todo) {
		lines.push(
			`${n++}. First, create a plan with the \`todo\` tool — one todo per phase:`,
			...SETUP_PHASES.map((p) => `   - ${p}`),
			`${n++}. Invoke the \`harness-setup\` skill and work through the phases in order, marking each todo in_progress → completed as you go.`,
		);
	} else {
		lines.push(`${n++}. Invoke the \`harness-setup\` skill and work through its phases in order.`);
	}
	lines.push(
		`${n++}. **Readiness first (consume + trigger):** if .harness/profile/readiness.json is absent, run the \`readiness-audit\` skill to compute it (store the snapshot). Then READ readiness.json and let it inform the profile — its level + weakest categories show where the repo is thin; record them in repo-facts.md and let them focus the conventions-map.`,
		`${n++}. Author the profile artifacts under .harness/profile/: architecture.md, services.yaml, init.sh, harness.md, skills/<worker-type>/SKILL.md, library/*.md (incl. conventions-map.md). Extract from what the repo already declares first (brownfield); do NOT rewrite the repo's own AGENTS.md/.agents/rules. Verify the commands by executing them before trusting them.`,
		`${n++}. Finish by calling the \`store_profile\` tool — it validates the artifacts exist and stamps .harness/profile/profile.json. Do NOT hand-write profile.json.`,
		`${n++}. Then give a short summary of what you authored and the commands the profile standardizes.`,
	);
	if (tools.todo) {
		lines.push(`${n++}. Finally, clear the plan with the \`todo\` tool (\`action: "clear"\`) so it doesn't linger.`);
	}
	return lines.join("\n");
}
