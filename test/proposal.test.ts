import { test } from "node:test";
import assert from "node:assert/strict";
import type { ControlModel } from "../src/control-model.ts";
import { featureOnboardingLines, PROPOSAL_OPTIONS, proposalCommentMessage, proposalRejectMessage, proposalSummaryLines } from "../src/proposal.ts";

function model(over: Partial<ControlModel> = {}): ControlModel {
	return {
		featureId: "feat-x",
		exists: true,
		state: "orchestrator_turn",
		gateInjected: false,
		assertions: { passed: 0, failed: 0, pending: 12, total: 12 },
		tasks: [
			{ id: "T1", skillName: "w", fulfills: [], description: "a", preconditions: [], expectedBehavior: [], status: "pending", active: false },
			{ id: "T2", skillName: "w", fulfills: ["A1"], description: "b", preconditions: [], expectedBehavior: [], status: "pending", active: false },
		],
		tasksDone: 0,
		tasksTotal: 2,
		active: null,
		workers: [],
		handoffsRaw: [],
		progress: [],
		coverage: [],
		...over,
	};
}

test("featureOnboardingLines: rebrand feature-scoped (orchestrator/workers/contract; sem 'mission' macro)", () => {
	const out = featureOnboardingLines().join("\n");
	assert.match(out, /How it works:/);
	assert.match(out, /Orchestrator — plans & manages; never implements/);
	assert.match(out, /Contract — frozen black-box assertions/);
	assert.match(out, /Feature-scoped & sequential/);
	assert.doesNotMatch(out, /Milestone/i, "dropou Milestones (não é nosso modelo)");
	assert.doesNotMatch(out, /credit/i, "dropou o aviso de credit usage do Droid");
});

test("PROPOSAL_OPTIONS: as 4 do propose_mission rebrandeadas", () => {
	assert.deepEqual(
		PROPOSAL_OPTIONS.map((o) => o.value),
		["proceed", "comment", "edit", "reject"],
	);
});

test("proposalSummaryLines: tasks · assertions · coverage + lista de ids", () => {
	const lines = proposalSummaryLines(model());
	assert.match(lines[0], /^2 tasks · 12 assertions · coverage invariant OK$/);
	assert.match(lines[1], /tasks: T1, T2$/);
	assert.deepEqual(proposalSummaryLines(null), ["(no plan found)"]);
});

test("proposalSummaryLines: trunca a 6 ids com reticências", () => {
	const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `T${i + 1}`, skillName: "w", fulfills: [], description: "x", preconditions: [], expectedBehavior: [], status: "pending" as const, active: false }));
	const lines = proposalSummaryLines(model({ tasks, tasksTotal: 8 }));
	assert.match(lines[1], /tasks: T1, T2, T3, T4, T5, T6, …$/);
});

test("proposalRejectMessage: instrui revisão + novo store_plan", () => {
	const msg = proposalRejectMessage("feat-x", "missing auth assertions");
	assert.match(msg, /did NOT approve/);
	assert.match(msg, /Reason: missing auth assertions/);
	assert.match(msg, /call `store_plan` again/);
	assert.match(proposalRejectMessage("feat-x", ""), /\(no reason given\)/);
});

test("proposalCommentMessage: aprovado + steering; execução começa automaticamente (sem /harness run)", () => {
	const msg = proposalCommentMessage("feat-x", "prefer in-memory store");
	assert.match(msg, /APPROVED the plan/);
	assert.match(msg, /prefer in-memory store/);
	assert.match(msg, /execution is starting/i);
	assert.doesNotMatch(msg, /\/harness run/);
});
