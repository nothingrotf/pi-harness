/**
 * Native dispatch for Tier-2 feature EXECUTION — droid model, 100%. The live chat is the
 * ORCHESTRATOR (architect/manager, `harness-orchestrator` skill); implementation workers and
 * ship-gate validators are ALWAYS runner-driven sessions (`pi --mode rpc`) started by the
 * BLOCKING `run_feature` tool (the `start_mission_run` analog). The orchestrator NEVER
 * implements and NEVER spawns implementation workers via the `subagent` tool — `subagent` is
 * for analysis/investigation delegation only (contract review, root-cause, code reading).
 *
 * The runner enforces the semantics deterministically: ONE worker session owns the whole
 * feature (loops `next_task`, commit per task), the ship gate is injected once, attempt
 * budgets/pause/resume/orphan-cleanup are code, and per-role model config is applied to every
 * child. The orchestrator's job is what the reference gives it: manage the plan, analyze
 * handoffs on `orchestrator_turn`, insert fix tasks, and resume.
 */
import type { DispatchTools } from "./readiness-dispatch.ts";

/** Opções de resume vindas do Feature Control (teclas R · Shift+R · r em Workers). */
export interface ResumeDispatchOpts {
	restartFeature?: boolean;
	resumeWorkerSessionId?: string;
}

/**
 * Mensagem de RESUME disparada pelo Feature Control (paridade com a tecla R do Mission Control):
 * instrui o orchestrator no chat a chamar `run_feature` com o modo escolhido e a agir no report.
 */
export function buildResumeDispatch(featureId: string, opts: ResumeDispatchOpts = {}): string {
	const args: string[] = [`featureId="${featureId}"`];
	if (opts.restartFeature) args.push("restartFeature: true");
	if (opts.resumeWorkerSessionId) args.push(`resumeWorkerSessionId: "${opts.resumeWorkerSessionId}"`);
	const modeNote = opts.restartFeature
		? "RESTART: the in-progress step is requeued and re-runs FROM SCRATCH with a fresh worker (already-committed tasks are skipped via next_task)."
		: opts.resumeWorkerSessionId
			? `Re-attach the SPECIFIC worker session "${opts.resumeWorkerSessionId}" ("continue where you left off").`
			: 'Default resume: re-attach the paused worker session ("continue where you left off").';
	return [
		`Resume execution of feature "${featureId}" now (requested from Feature Control). You are the **harness orchestrator** — follow the \`harness-orchestrator\` skill.`,
		"",
		`1. Call the \`run_feature\` tool with ${args.join(", ")}. ${modeNote}`,
		`2. Act on the report per the skill: \`completed\` → verify status.json and summarize; \`orchestrator_turn\` → analyze the handoff and call run_feature again with fixTasks; \`paused\` → report the reason to the user.`,
	].join("\n");
}

/** Toggles do ship gate (skipScrutiny→code-review; skipUserTesting→qa-validator; skipDelivery→deliver). */
export interface GateSkips {
	skipScrutiny?: boolean;
	skipUserTesting?: boolean;
	skipDelivery?: boolean;
}

/** Builds the message that executes a converged feature's plan (runner-driven, droid model). */
export function buildRunDispatch(featureId: string, tools: DispatchTools = {}, gates: GateSkips = {}): string {
	const runDir = `.harness/runs/${featureId}/`;
	const gateNames: string[] = [];
	if (!gates.skipScrutiny) gateNames.push("harness-code-review");
	if (!gates.skipUserTesting) gateNames.push("harness-qa-validator");
	if (!gates.skipDelivery) gateNames.push("harness-deliver");
	const skipNote =
		gates.skipScrutiny || gates.skipUserTesting || gates.skipDelivery
			? ` (${[gates.skipScrutiny ? "scrutiny/code-review" : null, gates.skipUserTesting ? "user-testing/qa-validator" : null, gates.skipDelivery ? "delivery/deliver" : null].filter(Boolean).join(" + ")} SKIPPED by mission config — the runner skips them)`
			: "";

	const lines = [
		`Execute the converged feature's plan now. You are the **harness orchestrator** — follow the \`harness-orchestrator\` skill. You are the ARCHITECT/MANAGER in this chat; you NEVER implement. Implementation workers and ship-gate validators run as **runner-driven \`pi\` sessions** (started by the \`run_feature\` tool), NOT in this chat and NOT as \`subagent\` children.`,
		`Feature id: ${featureId}. Run directory: ${runDir}`,
		"",
		`1. Read ${runDir}plan.json (the ordered tasks) and status.json. If plan.json is missing, STOP — the feature isn't converged yet (the user must run /harness "<feature>" first).`,
	];
	let n = 2;
	lines.push(
		`${n++}. **Call the \`run_feature\` tool** with featureId="${featureId}" — it is BLOCKING and owns execution: it spawns ONE session-backed worker for the whole feature (it runs \`harness-worker-base\` once, then loops with \`next_task\` — commit per task; it can't advance without committing), then injects and runs the ship gate${skipNote ? skipNote : ` (${gateNames.join(" → ")}) as validator sessions`}. Attempt budgets, pause/resume and per-role model config are enforced by the runner. Watch progress in the cockpit (Alt+T).`,
	);
	const askOnBlock = tools.askUser ? "use the `ask_user_question` tool to ask the user (don't guess)" : "return to the user with the specific blocker (don't guess)";
	const delegate = tools.subagent ? "delegate root-cause analysis to `subagent` children (analysis ONLY — code reading, flow tracing; NEVER implementation; use `async: false`)" : "analyze the root cause from the handoff and the repo state";
	lines.push(
		`${n++}. **Act on the run_feature report** (its \`status\`):`,
		`   - \`completed\` → verify ${runDir}status.json (every assertion "passed"), then summarize what shipped.`,
		`   - \`orchestrator_turn\` → a worker/validator returned to you: read the handoff in the report (details in ${runDir}handoffs/), ${delegate}, then call \`run_feature\` again with \`fixTasks: [...]\` (each names a profile worker skill; they're inserted ABOVE the ship gate and run first). Cap at 5 rounds — if it still can't pass, ${askOnBlock}.`,
		`   - \`paused\` → report the pause reason to the user. Resume by calling \`run_feature\` again: the default re-attaches the paused worker session ("continue where you left off"); \`restartFeature: true\` re-runs it fresh; \`resumeWorkerSessionId\` re-attaches a specific recorded session. \`usage_limit\` needs the user to fix billing first; \`step_retry_limit_exceeded\` means analyze WHY before retrying.`,
	);
	if (gateNames.length === 0) {
		lines.push(`${n++}. The ship gate is fully SKIPPED by mission config — still verify the contract assertions on the real surface yourself and update ${runDir}status.json before declaring done.`);
	}
	lines.push(
		`${n++}. The feature is DONE when status.json has every assertion \`"passed"\`${gates.skipUserTesting ? " (you update status.json yourself — qa-validator is skipped)" : " and the gate is green"}. Summarize what shipped (assertions passed, tasks run, any deferred follow-ups).`,
	);
	const utils: string[] = ["`run_feature` (the runner — ALL implementation/validation goes through it)"];
	if (tools.subagent) utils.push("`subagent` (analysis/investigation delegation only — never implementation)");
	if (tools.askUser) utils.push("`ask_user_question` (ask on blockers instead of guessing)");
	lines.push("", `Use the available utilities: ${utils.join(", ")}.`);
	return lines.join("\n");
}
