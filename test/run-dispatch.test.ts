import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunDispatch } from "../src/run-dispatch.ts";

test("buildRunDispatch: todos os utilitários ativos → TODO + subagent + advisor + ask_user_question", () => {
	const m = buildRunDispatch("add-login", { todo: true, subagent: true, advisor: true, askUser: true });
	assert.match(m, /harness-orchestrator/);
	assert.match(m, /\.harness\/runs\/add-login\/plan\.json/);
	assert.match(m, /status\.json/);
	// TODO Plan: um por task + 2 ship-gate todos
	assert.match(m, /`todo` tool/);
	assert.match(m, /ship gate: harness-code-review/);
	assert.match(m, /ship gate: harness-qa-validator/);
	// worker via subagent (agente dedicado harness-worker), sequencial
	assert.match(m, /`subagent` tool/);
	assert.match(m, /agent: `harness-worker`/);
	assert.match(m, /harness-worker-base/);
	assert.match(m, /EndFeatureRun/);
	assert.match(m, /one at a time \(sequential\)/);
	// ship gate em ordem
	assert.match(m, /harness-code-review/);
	assert.match(m, /harness-qa-validator/);
	// utilitários reforçados
	assert.match(m, /`advisor`/);
	assert.match(m, /ask_user_question/);
	assert.match(m, /5 attempts per task/);
	assert.match(m, /Use the available utilities/);
});

test("buildRunDispatch: sem utilitários → degrada (in-session), ainda roda o ship gate", () => {
	const m = buildRunDispatch("x", {});
	assert.doesNotMatch(m, /`todo` tool/);
	assert.doesNotMatch(m, /`subagent` tool/);
	assert.doesNotMatch(m, /`advisor`/);
	assert.match(m, /run the task in-session/);
	assert.match(m, /harness-code-review/);
	assert.match(m, /harness-qa-validator/);
	assert.match(m, /plan\.json/);
	assert.match(m, /return to the user with the specific blocker/);
});
