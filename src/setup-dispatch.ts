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
		`${n++}. **Readiness first (consume + trigger):** if .harness/profile/readiness.json is absent, run the \`harness-readiness-audit\` skill to compute it (store the snapshot). Then READ readiness.json and let it inform the profile — its level + weakest categories show where the repo is thin; record them in repo-facts.md and let them focus the conventions-map.`,
		`${n++}. Author the profile artifacts under .harness/profile/: architecture.md, services.yaml, init.sh, harness.md, skills/<worker-type>/SKILL.md, library/*.md (incl. conventions-map.md). Extract from what the repo already declares first (brownfield); do NOT rewrite the repo's own AGENTS.md/.agents/rules. Verify the commands by executing them before trusting them.`,
		`${n++}. Finish by calling the \`store_profile\` tool — it validates the artifacts exist and stamps .harness/profile/profile.json. Do NOT hand-write profile.json.`,
		`${n++}. Then give a short summary of what you authored and the commands the profile standardizes.`,
	);
	if (tools.todo) {
		lines.push(`${n++}. Finally, clear the plan with the \`todo\` tool (\`action: "clear"\`) so it doesn't linger.`);
	}
	return lines.join("\n");
}

/**
 * Focused Phase-9 dispatch: (re)generate JUST the cached conventions-map the ship-gate
 * conventions-review consumes — so it never re-discovers the repo's rules per feature.
 * Reusable standalone: full setup (Phase 9), a `rules`-drift refresh (reconcile marks
 * conventions-map.md → regenerate), and the smoke. Model-driven (deep mapping delegated).
 */
export function buildConventionsMapDispatch(tools: DispatchTools = {}): string {
	const lines = [
		"Build (or refresh) the cached conventions-map for THIS repository — the index the ship-gate conventions-review reads so it never re-discovers the repo's rules per feature.",
		"",
		"Do a thorough pass (search broadly by term, not just fixed paths) and index the repo's review-enforced conventions:",
		"- ADRs (docs/adr/, docs/decisions/, **/ADR-*.md, an ADR index): id, title, status (accepted/superseded/proposed), what it decides, and a file:line anchor.",
		"- Rule files (.agents/rules/, .cursor/rules/, CONVENTIONS.md, CONTRIBUTING.md, AGENTS.md/CLAUDE.md sections): what each governs + key terms to cite.",
		"- House patterns in code a linter can't enforce (layering, API boundary, naming, error/logging contracts, enum style): the pattern + a canonical example reference.",
		"- Gate-enforced vs review-enforced: note which checks are script-gated (lint/format/typecheck) so the reviewer DEFERS them and spends findings only on what review must catch.",
		"",
		"Write the index to .harness/profile/library/conventions-map.md (per entry: path, title, status, governs, key terms, canonical example). If the repo documents NO conventions, write a thin map saying so (the axis degrades to AGENTS.md-only — graceful, not a block).",
		"Do NOT rewrite the repo's own AGENTS.md / .agents/rules / docs/adr — read and index them, never edit.",
	];
	if (tools.subagent) {
		lines.push("", "Delegate the broad search and extraction to a subagent; require the written file path back.");
	}
	return lines.join("\n");
}
