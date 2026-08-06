import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResumeDispatch, buildRunDispatch } from "../src/run-dispatch.ts";

test("buildRunDispatch: droid model — orchestrator chama run_feature; NUNCA spawna worker via Agent", () => {
	const m = buildRunDispatch("add-login", { subagent: true, askUser: true });
	assert.match(m, /harness-orchestrator/);
	assert.match(m, /\.harness\/runs\/add-login\/plan\.json/);
	assert.match(m, /status\.json/);
	// o runner é o executor: run_feature BLOCKING
	assert.match(m, /`run_feature` tool/);
	assert.match(m, /BLOCKING/);
	assert.match(m, /ONE session-backed worker/);
	assert.match(m, /next_task/);
	// legacy REMOVIDO: nada de spawnar harness-worker via Agent
	assert.doesNotMatch(m, /subagent_type: `harness-worker`/);
	assert.doesNotMatch(m, /spawn ONE fresh worker via the `Agent` tool/);
	// Agent só para análise
	assert.match(m, /analysis\/investigation delegation only|analysis ONLY/);
	// sem rpiv-todo: progresso vivo é o run card + o cockpit
	assert.doesNotMatch(m, /`todo` tool/);
	// handling de retorno: os 3 status + modos de resume
	assert.match(m, /`completed`/);
	assert.match(m, /`orchestrator_turn`/);
	assert.match(m, /`paused`/);
	assert.match(m, /fixTasks/);
	assert.match(m, /restartFeature/);
	assert.match(m, /resumeWorkerSessionId/);
	assert.match(m, /Cap at 5 rounds/);
	// utilitários reforçados (advisor removido — rpiv fora do prompt surface)
	assert.doesNotMatch(m, /`advisor`/);
	assert.match(m, /ask_user_question/);
	assert.match(m, /Use the available utilities/);
});

test("buildRunDispatch: sem utilitários → ainda usa run_feature (o runner é o único executor)", () => {
	const m = buildRunDispatch("x", {});
	assert.match(m, /`run_feature` tool/);
	assert.doesNotMatch(m, /`todo` tool/);
	assert.doesNotMatch(m, /`Agent` \(/, "sem o util Agent na lista de utilitários");
	assert.doesNotMatch(m, /delegate root-cause analysis to `Agent`/);
	assert.match(m, /harness-code-review/);
	assert.match(m, /harness-qa-validator/);
	assert.match(m, /harness-deliver/);
	assert.match(m, /plan\.json/);
	assert.match(m, /return to the user with the specific blocker/);
});

test("buildResumeDispatch: 3 modos (continue · restart · sessão específica) → run_feature", () => {
	const def = buildResumeDispatch("feat-x");
	assert.match(def, /run_feature/);
	assert.match(def, /featureId="feat-x"/);
	assert.match(def, /re-attach the paused worker session/i);
	assert.doesNotMatch(def, /restartFeature: true/);

	const restart = buildResumeDispatch("feat-x", { restartFeature: true });
	assert.match(restart, /restartFeature: true/);
	assert.match(restart, /FROM SCRATCH/);

	const pick = buildResumeDispatch("feat-x", { resumeWorkerSessionId: "ws_abc" });
	assert.match(pick, /resumeWorkerSessionId: "ws_abc"/);
	assert.match(pick, /SPECIFIC worker session/);
});

test("buildRunDispatch: gates pulados são anotados (o runner os pula de fato)", () => {
	const full = buildRunDispatch("f", { subagent: true });
	assert.match(full, /harness-code-review/);
	assert.match(full, /harness-qa-validator/);
	assert.match(full, /harness-deliver/);
	assert.match(full, /\(harness-code-review → harness-qa-validator → harness-deliver\) as validator sessions/);
	const all = buildRunDispatch("f", { subagent: true }, { skipScrutiny: true, skipUserTesting: true, skipDelivery: true });
	assert.doesNotMatch(all, /as validator sessions/);
	assert.match(all, /fully SKIPPED/);
	const partial = buildRunDispatch("f", {}, { skipScrutiny: true });
	assert.match(partial, /scrutiny\/code-review SKIPPED by mission config/);
	// qa pulado → o orchestrator atualiza status.json ele mesmo
	const noQa = buildRunDispatch("f", {}, { skipUserTesting: true });
	assert.match(noQa, /you update status\.json yourself/);
});
