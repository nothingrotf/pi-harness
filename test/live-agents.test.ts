import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsFromArgs, agentsFromDetails, clearAllLiveAgents, isSubagentTool, listLiveAgents, parseTaskId, parseTokens, setLiveAgents } from "../src/live-agents.ts";

test("parseTaskId: ship-gate-* tem prioridade; senão T<n>; senão —", () => {
	assert.equal(parseTaskId("Run T1 contracts-worker"), "T1");
	assert.equal(parseTaskId('execute task "T12" for feature x'), "T12");
	assert.equal(parseTaskId("ship gate: ship-gate-qa-validator"), "ship-gate-qa-validator");
	assert.equal(parseTaskId("just some prose"), "—");
});

test("agentsFromArgs: single | tasks[] | chain[] — seed running com toolCount 0", () => {
	assert.deepEqual(
		agentsFromArgs({ agent: "harness-worker", task: "Run T1 contracts-worker" }).map((a) => [a.taskId, a.agent, a.status, a.toolCount]),
		[["T1", "harness-worker", "running", 0]],
	);
	const parallel = agentsFromArgs({ tasks: [{ agent: "harness-worker", task: "Run T1 x" }, { agent: "harness-worker", task: "Run T2 y" }] });
	assert.deepEqual(parallel.map((a) => a.taskId), ["T1", "T2"]);
	const chain = agentsFromArgs({ chain: [{ agent: "w", task: "Run T3 z" }] });
	assert.equal(chain[0].taskId, "T3");
	assert.deepEqual(agentsFromArgs({}), []);
});

test("isSubagentTool: casa pi-subagents (`subagent`) E @tintinweb/pi-subagents (`Agent`)", () => {
	assert.equal(isSubagentTool("subagent"), true);
	assert.equal(isSubagentTool("Agent"), true);
	assert.equal(isSubagentTool("agent"), false, "case-sensitive: a tool nativa é `Agent`");
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
	// não colide com o shape pi-subagents (task/tasks/chain têm prioridade)
	assert.equal(agentsFromArgs({ prompt: "x", task: "Run T1 y", agent: "w" })[0].taskId, "T1");
});

test("agentsFromDetails: @tintinweb AgentDetails único (sem progress[]) → live só p/ running/background/queued", () => {
	const running = agentsFromDetails({ status: "running", subagentType: "harness-worker", description: "Run T6 web-worker", toolUses: 20, tokens: "99.0k", activity: "editing src/index.tsx" });
	assert.equal(running.length, 1);
	assert.deepEqual([running[0].taskId, running[0].toolCount, running[0].tokens, running[0].currentTool], ["T6", 20, 99000, "editing src/index.tsx"]);
	assert.equal(agentsFromDetails({ status: "queued", description: "Run T7 z", toolUses: 0, tokens: "0" })[0].status, "pending");
	assert.equal(agentsFromDetails({ status: "background", description: "Run T8 z", toolUses: 1, tokens: "1k" })[0].status, "running");
	// completed/steered/stopped/error/aborted NÃO são live (viram handoff em disco)
	assert.deepEqual(agentsFromDetails({ status: "completed", description: "Run T6 x", toolUses: 5, tokens: "1k" }), []);
	assert.deepEqual(agentsFromDetails({ status: "error", description: "Run T6 x", toolUses: 5, tokens: "1k" }), []);
	assert.deepEqual(agentsFromDetails({}), [], "sem status → vazio");
});

test("agentsFromDetails: lê progress[] (AgentProgress), só running/pending, com stats", () => {
	const details = {
		progress: [
			{ index: 0, agent: "harness-worker", status: "running", task: "Run T1 contracts-worker", toolCount: 10, tokens: 72400, currentTool: "Read" },
			{ index: 1, agent: "harness-worker", status: "completed", task: "Run T0 done", toolCount: 5, tokens: 1000 },
		],
	};
	const live = agentsFromDetails(details);
	assert.equal(live.length, 1, "ignora completed (vira handoff em disco)");
	assert.deepEqual([live[0].taskId, live[0].toolCount, live[0].tokens, live[0].currentTool], ["T1", 10, 72400, "Read"]);
	assert.deepEqual(agentsFromDetails(undefined), []);
	assert.deepEqual(agentsFromDetails({ progress: "nope" }), []);
});

test("store: set/clear por toolCallId, listLiveAgents achata e ordena por index", () => {
	clearAllLiveAgents();
	setLiveAgents("call-a", agentsFromArgs({ agent: "w", task: "Run T2 b" }).map((a) => ({ ...a, index: 1 })));
	setLiveAgents("call-b", agentsFromArgs({ agent: "w", task: "Run T1 a" }).map((a) => ({ ...a, index: 0 })));
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

test("agentsFromDetails: recentActivity de recentTools + currentTool (últimas ~4)", () => {
	const live = agentsFromDetails({ progress: [{ index: 0, agent: "harness-worker", status: "running", task: "Run T1 x", toolCount: 3, tokens: 100, recentTools: [{ tool: "Read", args: "src/a.ts" }, { tool: "Edit", args: "src/b.ts" }], currentTool: "Execute", currentToolArgs: "go test ./..." }] });
	assert.deepEqual(live[0].recentActivity, ["Read: src/a.ts", "Edit: src/b.ts", "Execute: go test ./..."]);
});
