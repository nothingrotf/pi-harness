import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunDispatch } from "../src/run-dispatch.ts";

test("buildRunDispatch: todos os utilitários ativos → TODO + subagent + advisor + ask_user_question", () => {
	const m = buildRunDispatch("add-login", { todo: true, subagent: true, advisor: true, askUser: true });
	assert.match(m, /harness-orchestrator/);
	assert.match(m, /\.harness\/runs\/add-login\/plan\.json/);
	assert.match(m, /status\.json/);
	// TODO Plan: um por task + 3 ship-gate todos (code-review, qa-validator, deliver)
	assert.match(m, /`todo` tool/);
	assert.match(m, /ship gate: harness-code-review/);
	assert.match(m, /ship gate: harness-qa-validator/);
	assert.match(m, /ship gate: harness-deliver/);
	// UM worker pra feature inteira (paridade droid), não um por task
	assert.match(m, /`subagent` tool/);
	assert.match(m, /agent: `harness-worker`/);
	assert.match(m, /harness-worker-base/);
	assert.match(m, /EndFeatureRun/);
	assert.match(m, /ONE worker that owns the whole feature/);
	assert.match(m, /FULL ordered task list/);
	assert.doesNotMatch(m, /one worker per task\b(?! \()/, "não instrui spawn por-task");
	// ship gate em ordem
	assert.match(m, /harness-code-review/);
	assert.match(m, /harness-qa-validator/);
	// utilitários reforçados
	assert.match(m, /`advisor`/);
	assert.match(m, /ask_user_question/);
	assert.match(m, /Cap at 5 attempts/);
	assert.match(m, /Use the available utilities/);
});

test("buildRunDispatch: sem utilitários → degrada (in-session), ainda roda o ship gate", () => {
	const m = buildRunDispatch("x", {});
	assert.doesNotMatch(m, /`todo` tool/);
	assert.doesNotMatch(m, /`subagent` tool/);
	assert.doesNotMatch(m, /`advisor`/);
	assert.match(m, /deliver the feature in-session/);
	assert.match(m, /harness-code-review/);
	assert.match(m, /harness-qa-validator/);
	assert.match(m, /harness-deliver/);
	assert.match(m, /plan\.json/);
	assert.match(m, /return to the user with the specific blocker/);
});

test("buildRunDispatch: gates pulam os passos do ship gate (skipScrutiny/skipUserTesting/skipDelivery)", () => {
	const full = buildRunDispatch("f", { todo: true, subagent: true });
	assert.match(full, /harness-code-review/);
	assert.match(full, /harness-qa-validator/);
	assert.match(full, /harness-deliver/);
	assert.match(full, /ship gate: harness-deliver/);
	const all = buildRunDispatch("f", { todo: true, subagent: true }, { skipScrutiny: true, skipUserTesting: true, skipDelivery: true });
	assert.doesNotMatch(all, /harness-code-review/);
	assert.doesNotMatch(all, /harness-qa-validator/);
	assert.doesNotMatch(all, /harness-deliver/);
	assert.match(all, /fully SKIPPED/);
	const partial = buildRunDispatch("f", { todo: true }, { skipScrutiny: true });
	assert.doesNotMatch(partial, /harness-code-review/);
	assert.match(partial, /harness-qa-validator/);
	assert.match(partial, /harness-deliver/);
	assert.match(partial, /SKIPPED by mission config/);
	// só delivery pulado → os outros dois rodam
	const noDelivery = buildRunDispatch("f", { todo: true, subagent: true }, { skipDelivery: true });
	assert.match(noDelivery, /harness-code-review/);
	assert.match(noDelivery, /harness-qa-validator/);
	assert.doesNotMatch(noDelivery, /harness-deliver/);
	assert.match(noDelivery, /delivery\/deliver SKIPPED/);
});
