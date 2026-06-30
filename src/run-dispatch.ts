/**
 * Native dispatch for Tier-2 feature EXECUTION (Fatia 3, execução) — model-driven,
 * in-session, TUI-first, with a live TODO Plan. The model acts as the harness
 * orchestrator: reads plan.json, runs each task in a fresh worker subagent (sequential),
 * reacts to handoffs, then runs the ship gate (harness-code-review → harness-qa-validator
 * → harness-deliver).
 *
 * Pattern parity with the readiness/setup/converge dispatches: adaptive on which
 * companion utilities are ACTIVE (todo / subagent / advisor / ask-user-question) and
 * reinforces their use. The deterministic engine (FeatureRunner) stays the headless
 * alternative; THIS is the TUI default (a blocking code loop would freeze the TUI).
 */
import type { DispatchTools } from "./readiness-dispatch.ts";

/** Toggles do ship gate (skipScrutiny→code-review; skipUserTesting→qa-validator; skipDelivery→deliver). */
export interface GateSkips {
	skipScrutiny?: boolean;
	skipUserTesting?: boolean;
	skipDelivery?: boolean;
}

/** Builds the message that executes a converged feature's plan live (TODO Plan when active). */
export function buildRunDispatch(featureId: string, tools: DispatchTools = {}, gates: GateSkips = {}): string {
	const runDir = `.harness/runs/${featureId}/`;
	const lines = [
		`Execute the converged feature's plan now, live in this session. You are the **harness orchestrator** — follow the \`harness-orchestrator\` skill. You run HERE in this chat (your tool calls stream live); every worker and reviewer you orchestrate runs as a \`subagent\` (pi-subagents) — visible live in the UI.`,
		`Feature id: ${featureId}. Run directory: ${runDir}`,
		"",
		`1. Read ${runDir}plan.json (the ordered tasks) and status.json. If plan.json is missing, STOP — the feature isn't converged yet (the user must run /harness "<feature>" first).`,
	];
	let n = 2;
	const gateTodos: string[] = [];
	if (!gates.skipScrutiny) gateTodos.push('"ship gate: harness-code-review"');
	if (!gates.skipUserTesting) gateTodos.push('"ship gate: harness-qa-validator"');
	if (!gates.skipDelivery) gateTodos.push('"ship gate: harness-deliver"');
	if (tools.todo) {
		const trailing = gateTodos.length ? `, then ${gateTodos.length === 1 ? "a trailing todo" : `${gateTodos.length} trailing todos`}: ${gateTodos.join(" and ")}` : "";
		lines.push(
			`${n++}. **Create the Plan with the \`todo\` tool** — one todo per task (in plan.json order)${trailing}. This Plan is the live source of truth; it survives /reload and compaction — keep it updated at EVERY transition.`,
		);
	}
	const spawn = tools.subagent
		? "spawn a fresh worker via the `subagent` tool (agent: `harness-worker`), passing the feature id, the task ({id, description, skillName, fulfills}) and a fresh worker session id — it runs `harness-worker-base` → the task's profile skill → `EndFeatureRun`"
		: "run the task in-session (`harness-worker-base` → the task's profile skill → `EndFeatureRun`), passing the feature id + task id so EndFeatureRun records the handoff";
	const markStart = tools.todo ? "mark its todo in_progress; " : "";
	const markDone = tools.todo ? " mark the todo completed;" : "";
	const askOnBlock = tools.askUser
		? " use the `ask_user_question` tool to ask the user (don't guess)"
		: " return to the user with the specific blocker (don't guess)";
	lines.push(
		`${n++}. For each pending task, **in plan.json order, one at a time (sequential)**: ${markStart}${spawn}. Then read the task's handoff (${runDir}handoffs/): on \`successState: "success"\` →${markDone} continue. On failure / \`returnToOrchestrator\` → do NOT mark done; create a fix task at the TOP of the plan${tools.todo ? " (a new todo)" : ""}, address it, then resume. Cap at 5 attempts per task — if it still can't pass,${askOnBlock}.`,
	);
	const escalate = tools.advisor
		? " Use the `advisor` tool to escalate the verdict to a stronger reviewer model where it's high-stakes (fresh-context verification beats same-model self-review)."
		: "";
	const gateSteps: string[] = [];
	if (!gates.skipScrutiny)
		gateSteps.push(
			`   a. **harness-code-review** — invoke the \`harness-code-review\` skill: it runs the programmatic gate once (services.yaml test/typecheck/lint over the integrated result), then ${tools.subagent ? "spawns the three review axes (`harness-correctness-review`, `harness-quality-review`, `harness-conventions-review`) via `subagent`" : "runs the three review axes (correctness, quality, conventions)"} over the feature diff, and synthesizes.${escalate} Any blocking finding → create fix tasks${tools.todo ? " (new todos at the top)" : ""}, address them, then re-run only what failed.`,
		);
	if (!gates.skipUserTesting) gateSteps.push(`   b. **harness-qa-validator** — invoke the \`harness-qa-validator\` skill: verify the contract assertions on the real surface and update ${runDir}status.json.`);
	if (!gates.skipDelivery)
		gateSteps.push(
			`   c. **harness-deliver** — invoke the \`harness-deliver\` skill: open/assemble the PR, scrape the linked Linear issue (branch + commits + PR body), watch CI, run a bounded safe fix-loop until green, calling \`store_delivery\` at each transition (it drives the cockpit Delivery tab). When mergeable, write \`store_delivery\` \`state:"awaiting_merge"\` to pop the human merge-gate overlay, then act on the injected decision. Never merge without explicit user confirmation.`,
		);
	const skipNote =
		gates.skipScrutiny || gates.skipUserTesting || gates.skipDelivery
			? ` (${[gates.skipScrutiny ? "scrutiny/code-review" : null, gates.skipUserTesting ? "user-testing/qa-validator" : null, gates.skipDelivery ? "delivery/deliver" : null].filter(Boolean).join(" + ")} SKIPPED by mission config)`
			: "";
	if (gateSteps.length > 0) {
		lines.push(`${n++}. When every task todo is completed, run the **ship gate**${skipNote}, in order:`, ...gateSteps);
	} else {
		lines.push(`${n++}. When every task todo is completed: the ship gate is fully SKIPPED by mission config — still verify the contract assertions on the real surface yourself and update ${runDir}status.json before declaring done.`);
	}
	lines.push(
		`${n++}. The feature is DONE when status.json has every assertion \`"passed"\`${gates.skipUserTesting ? " (you update status.json yourself — qa-validator is skipped)" : " and the gate is green"}.${tools.todo ? " Clear the Plan with the `todo` tool (`action: \"clear\"`)." : ""} Summarize what shipped (assertions passed, tasks run, any deferred follow-ups).`,
	);
	// Reinforce utility usage explicitly.
	const utils: string[] = [];
	if (tools.todo) utils.push("`todo` (keep the Plan live at every transition)");
	if (tools.subagent) utils.push("`subagent` (isolate each worker/reviewer in a fresh-context session)");
	if (tools.advisor) utils.push("`advisor` (escalate verification at the gate)");
	if (tools.askUser) utils.push("`ask_user_question` (ask on blockers instead of guessing)");
	if (utils.length > 0) lines.push("", `Use the available utilities: ${utils.join(", ")}.`);
	return lines.join("\n");
}
