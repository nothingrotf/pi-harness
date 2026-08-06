import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_PHASES, buildAuditDispatch, buildFixDispatch } from "../src/readiness-dispatch.ts";

test("AUDIT_PHASES: 5 fases (roteiro do dispatch)", () => {
	assert.equal(AUDIT_PHASES.length, 5);
	assert.match(AUDIT_PHASES[0], /Phase 1/);
	assert.match(AUDIT_PHASES[4], /Store report/);
});

test("buildAuditDispatch: fases como roteiro; sempre skill + store; sem rpiv-todo", () => {
	const m = buildAuditDispatch({});
	assert.doesNotMatch(m, /`todo` tool/, "sem rpiv-todo — o harness não instrui Plan");
	for (const p of AUDIT_PHASES) assert.ok(m.includes(p), `falta a fase: ${p}`);
	assert.match(m, /harness-readiness-audit/);
	assert.match(m, /store_agent_readiness_report/);
	assert.match(m, /5 phases/);
	assert.match(m, /Do not modify the repository/);
	assert.doesNotMatch(m, /clear the plan/);
});

test("buildFixDispatch: args + subagent → match semântico + remediator isolado", () => {
	const m = buildFixDispatch("lint and tests", { subagent: true });
	assert.match(m, /matching "lint and tests"/);
	assert.match(m, /harness-readiness-remediator/);
	assert.match(m, /no gaming the metric/);
	assert.doesNotMatch(m, /`todo`/);
});

test("buildFixDispatch: sem subagent → não menciona delegação", () => {
	const m = buildFixDispatch("x", { subagent: false });
	assert.doesNotMatch(m, /harness-readiness-remediator/);
	assert.match(m, /GENUINE, substantive fix/);
});

test("buildFixDispatch: sem args → agrupa por categoria + AskUser", () => {
	const m = buildFixDispatch("", {});
	assert.match(m, /group them by category and ask the user/);
	assert.match(m, /ask_user_question/);
});
