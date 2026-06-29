import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_PHASES, buildAuditDispatch, buildFixDispatch } from "../src/readiness-dispatch.ts";

test("AUDIT_PHASES: 5 fases (o Plan · X/5)", () => {
	assert.equal(AUDIT_PHASES.length, 5);
	assert.match(AUDIT_PHASES[0], /Phase 1/);
	assert.match(AUDIT_PHASES[4], /Store report/);
});

test("buildAuditDispatch: com todo ativo → cria o Plan de 5 fases; sempre skill + store", () => {
	const m = buildAuditDispatch({ todo: true });
	assert.match(m, /`todo` tool/);
	for (const p of AUDIT_PHASES) assert.ok(m.includes(p), `falta a fase: ${p}`);
	assert.match(m, /readiness-audit/);
	assert.match(m, /store_agent_readiness_report/);
	assert.match(m, /in_progress → completed/);
	assert.match(m, /Do not modify the repository/);
});

test("buildAuditDispatch: sem todo → sem Plan, mas ainda roda skill + store", () => {
	const m = buildAuditDispatch({ todo: false });
	assert.doesNotMatch(m, /`todo` tool/);
	assert.match(m, /readiness-audit/);
	assert.match(m, /store_agent_readiness_report/);
	assert.match(m, /5 phases/);
});

test("clear no fim: com todo, audit e fix mandam limpar o plano; sem todo, não", () => {
	assert.match(buildAuditDispatch({ todo: true }), /clear the plan with the `todo` tool/);
	assert.doesNotMatch(buildAuditDispatch({ todo: false }), /clear the plan/);
	assert.match(buildFixDispatch("x", { todo: true }), /clear the plan with the `todo` tool/);
	assert.doesNotMatch(buildFixDispatch("x", { todo: false }), /clear the plan/);
});

test("buildFixDispatch: args + todo + subagent → match semântico, todo por sinal, subagent", () => {
	const m = buildFixDispatch("lint and tests", { todo: true, subagent: true });
	assert.match(m, /matching "lint and tests"/);
	assert.match(m, /one `todo` per signal/);
	assert.match(m, /readiness-remediator/);
	assert.match(m, /no gaming the metric/);
});

test("buildFixDispatch: sem subagent → não menciona delegação; sem todo → sem todo", () => {
	const m = buildFixDispatch("x", { todo: false, subagent: false });
	assert.doesNotMatch(m, /readiness-remediator/);
	assert.doesNotMatch(m, /`todo`/);
	assert.match(m, /GENUINE, substantive fix/);
});

test("buildFixDispatch: sem args → agrupa por categoria + AskUser", () => {
	const m = buildFixDispatch("", { todo: true });
	assert.match(m, /group them by category and ask the user/);
	assert.match(m, /AskUser/);
});
