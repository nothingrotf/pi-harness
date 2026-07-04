import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsFromArgs, agentsFromDetails, clearAllLiveAgents, isSubagentTool, listLiveAgents, mergeActivity, parseTaskId, parseTokens, setLiveAgents } from "../src/live-agents.ts";

test("parseTaskId: ship-gate-* tem prioridade; senão T<n>; senão —", () => {
	assert.equal(parseTaskId("Run T1 contracts-worker"), "T1");
	assert.equal(parseTaskId('execute task "T12" for feature x'), "T12");
	assert.equal(parseTaskId("ship gate: ship-gate-qa-validator"), "ship-gate-qa-validator");
	assert.equal(parseTaskId("just some prose"), "—");
});

test("isSubagentTool: casa SÓ @tintinweb/pi-subagents (`Agent`); `subagent` (earendil) NÃO", () => {
	assert.equal(isSubagentTool("Agent"), true);
	assert.equal(isSubagentTool("subagent"), false, "earendil removido — só o `Agent` conta");
	assert.equal(isSubagentTool("agent"), false, "case-sensitive: a tool é `Agent`");
	assert.equal(isSubagentTool("bash"), false);
});

test("parseTokens: number passa; string formatada (33.8k / 1.2M / 950) vira number", () => {
	assert.equal(parseTokens(72400), 72400);
	assert.equal(parseTokens("33.8k"), 33800);
	assert.equal(parseTokens("1.2M"), 1_200_000);
	assert.equal(parseTokens("950"), 950);
	assert.equal(parseTokens(undefined), 0);
	assert.equal(parseTokens(""), 0);
});

test("agentsFromArgs: @tintinweb `Agent` { prompt, subagent_type, description } → 1 agent, id da description", () => {
	const live = agentsFromArgs({ prompt: "Read .harness/runs/x and implement", subagent_type: "harness-worker", description: "Run T6 web-worker" });
	assert.deepEqual(
		live.map((a) => [a.taskId, a.agent, a.status, a.toolCount]),
		[["T6", "harness-worker", "running", 0]],
	);
	// id pelo prompt quando a description é genérica
	assert.equal(agentsFromArgs({ prompt: "do task T9 now", subagent_type: "w", description: "work" })[0].taskId, "T9");
	// shape earendil (sem `prompt`) NÃO casa mais → vazio
	assert.deepEqual(agentsFromArgs({ agent: "w", task: "Run T1 y" }), []);
	assert.deepEqual(agentsFromArgs({}), []);
});

test("agentsFromDetails: @tintinweb AgentDetails → live só p/ running/background/queued; captura agentId + activity", () => {
	const running = agentsFromDetails({ status: "running", subagentType: "harness-worker", description: "Run T6 web-worker", toolUses: 20, tokens: "99.0k", activity: "editing src/index.tsx", agentId: "ag_abc123" });
	assert.equal(running.length, 1);
	assert.deepEqual([running[0].taskId, running[0].toolCount, running[0].tokens, running[0].currentTool, running[0].agentId], ["T6", 20, 99000, "editing src/index.tsx", "ag_abc123"]);
	assert.deepEqual(running[0].recentActivity, ["editing src/index.tsx"], "seed do buffer = a string activity");
	assert.equal(agentsFromDetails({ status: "queued", description: "Run T7 z", toolUses: 0, tokens: "0" })[0].status, "pending");
	assert.equal(agentsFromDetails({ status: "background", description: "Run T8 z", toolUses: 1, tokens: "1k" })[0].status, "running");
	// completed/steered/stopped/error/aborted NÃO são live (viram handoff em disco)
	assert.deepEqual(agentsFromDetails({ status: "completed", description: "Run T6 x", toolUses: 5, tokens: "1k" }), []);
	assert.deepEqual(agentsFromDetails({ status: "error", description: "Run T6 x", toolUses: 5, tokens: "1k" }), []);
	assert.deepEqual(agentsFromDetails({}), [], "sem status → vazio");
	assert.deepEqual(agentsFromDetails({ progress: [{ status: "running" }] }), [], "shape earendil (progress[]) ignorado");
});

test("mergeActivity: anexa novos, dedup consecutivo, ignora vazio, cap nos últimos N", () => {
	assert.deepEqual(mergeActivity([], ["a"]), ["a"]);
	assert.deepEqual(mergeActivity(["a"], ["a"]), ["a"], "dedup consecutivo");
	assert.deepEqual(mergeActivity(["a"], ["b"]), ["a", "b"]);
	assert.deepEqual(mergeActivity(["a", "b"], ["b", "c"]), ["a", "b", "c"], "não repete o tail 'b'");
	assert.deepEqual(mergeActivity(["a"], [""]), ["a"], "ignora vazio");
	assert.deepEqual(mergeActivity(["1", "2", "3"], ["4", "5"], 3), ["3", "4", "5"], "cap 3 = últimos 3");
});

test("setLiveAgents: acumula recentActivity num buffer rolante por agent (o @tintinweb só dá 1 string/frame)", () => {
	clearAllLiveAgents();
	setLiveAgents("call-x", agentsFromDetails({ status: "running", description: "Run T2 b", toolUses: 1, tokens: "1k", activity: "reading a.ts", agentId: "ag1" }));
	setLiveAgents("call-x", agentsFromDetails({ status: "running", description: "Run T2 b", toolUses: 2, tokens: "2k", activity: "editing b.ts", agentId: "ag1" }));
	setLiveAgents("call-x", agentsFromDetails({ status: "running", description: "Run T2 b", toolUses: 3, tokens: "3k", activity: "editing b.ts", agentId: "ag1" })); // repetido → dedup
	const a = listLiveAgents()[0];
	assert.deepEqual(a.recentActivity, ["reading a.ts", "editing b.ts"], "acumula distintos, dedup consecutivo");
	assert.equal(a.agentId, "ag1", "agentId preservado (→ localiza o .output do transcript real)");
	assert.equal(a.toolCount, 3, "stats do frame mais recente");
	clearAllLiveAgents();
});

test("store: set/clear por toolCallId, listLiveAgents achata e ordena por index", () => {
	clearAllLiveAgents();
	setLiveAgents("call-a", agentsFromArgs({ prompt: "x", subagent_type: "w", description: "Run T2 b" }).map((a) => ({ ...a, index: 1 })));
	setLiveAgents("call-b", agentsFromArgs({ prompt: "y", subagent_type: "w", description: "Run T1 a" }).map((a) => ({ ...a, index: 0 })));
	assert.deepEqual(
		listLiveAgents().map((a) => a.taskId),
		["T1", "T2"],
		"ordenado por index",
	);
	setLiveAgents("call-a", []); // vazio remove
	assert.equal(listLiveAgents().length, 1);
	clearAllLiveAgents();
	assert.equal(listLiveAgents().length, 0);
});
