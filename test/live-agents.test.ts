import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsFromArgs, agentsFromDetails, clearAllLiveAgents, completeAsyncRun, isExecutionArgs, isSubagentTool, listLiveAgents, parseTaskId, parseTokens, registerAsyncRun, setAsyncStatusReader, setLiveAgents } from "../src/live-agents.ts";

test("parseTaskId: ship-gate-* tem prioridade; senão T<n>; senão —", () => {
	assert.equal(parseTaskId("Run T1 contracts-worker"), "T1");
	assert.equal(parseTaskId('execute task "T12" for feature x'), "T12");
	assert.equal(parseTaskId("ship gate: ship-gate-qa-validator"), "ship-gate-qa-validator");
	assert.equal(parseTaskId("just some prose"), "—");
});

test("isSubagentTool: casa SÓ pi-subagents (`subagent`); `Agent` (provider antigo) NÃO", () => {
	assert.equal(isSubagentTool("subagent"), true);
	assert.equal(isSubagentTool("Agent"), false, "@tintinweb removido — só o `subagent` conta");
	assert.equal(isSubagentTool("Subagent"), false, "case-sensitive: a tool é `subagent`");
	assert.equal(isSubagentTool("bash"), false);
});

test("parseTokens: number passa; TokenUsage ({total}) e string formatada viram number", () => {
	assert.equal(parseTokens(72400), 72400);
	assert.equal(parseTokens({ input: 10, output: 20, total: 30 }), 30);
	assert.equal(parseTokens("33.8k"), 33800);
	assert.equal(parseTokens("1.2M"), 1_200_000);
	assert.equal(parseTokens("950"), 950);
	assert.equal(parseTokens(undefined), 0);
	assert.equal(parseTokens(""), 0);
});

test("isExecutionArgs: execução ({agent,task}/{tasks}/{chain}/{workflowScript}) sim; management (action) não", () => {
	assert.equal(isExecutionArgs({ agent: "w", task: "x" }), true);
	assert.equal(isExecutionArgs({ tasks: [{ agent: "a", task: "t" }] }), true);
	assert.equal(isExecutionArgs({ workflowScript: "await runs.run(...)" }), true);
	assert.equal(isExecutionArgs({ action: "status" }), false);
	assert.equal(isExecutionArgs({ action: "steer", id: "r1", message: "m" }), false);
	assert.equal(isExecutionArgs({}), false);
});

test("agentsFromArgs: pi-subagents `subagent` {agent, task} → 1 agent running, id do task", () => {
	const live = agentsFromArgs({ agent: "harness-correctness-review", task: "Review T6 diff for feature x" });
	assert.deepEqual(
		live.map((a) => [a.taskId, a.agent, a.status, a.toolCount]),
		[["T6", "harness-correctness-review", "running", 0]],
	);
	// paralelo {tasks: [...]} → um agent por item, index posicional
	const par = agentsFromArgs({ tasks: [{ agent: "a", task: "Run T1" }, { agent: "b", task: "Run T2" }] });
	assert.deepEqual(
		par.map((a) => [a.index, a.taskId, a.status]),
		[
			[0, "T1", "running"],
			[1, "T2", "running"],
		],
	);
	// chain → 1º step running, resto pending
	const chain = agentsFromArgs({ chain: [{ agent: "scout", task: "Scan T3" }, { agent: "planner", task: "Plan T3" }] });
	assert.deepEqual(
		chain.map((a) => [a.agent, a.status]),
		[
			["scout", "running"],
			["planner", "pending"],
		],
	);
	// workflowScript → placeholder "workflow"
	assert.deepEqual(
		agentsFromArgs({ workflowScript: "await runs.all([...])" }).map((a) => [a.agent, a.status]),
		[["workflow", "running"]],
	);
	// management (action) NÃO é spawn → vazio; shape do provider antigo também não
	assert.deepEqual(agentsFromArgs({ action: "status" }), []);
	assert.deepEqual(agentsFromArgs({ prompt: "x", subagent_type: "w", description: "Run T6" }), []);
	assert.deepEqual(agentsFromArgs({}), []);
});

test("agentsFromDetails: details.progress[] → live só p/ running/pending; feed de recentTools", () => {
	const details = {
		mode: "single",
		results: [],
		progress: [
			{
				index: 0,
				agent: "harness-worker",
				status: "running",
				task: "Run T6 web-worker",
				currentTool: "edit",
				currentToolArgs: "src/index.tsx",
				recentTools: [
					{ tool: "read", args: "a.ts", endMs: 1 },
					{ tool: "edit", args: "b.ts", endMs: 2 },
				],
				recentOutput: ["compiling…"],
				toolCount: 20,
				tokens: 99000,
				durationMs: 1000,
			},
		],
	};
	const running = agentsFromDetails(details);
	assert.equal(running.length, 1);
	assert.deepEqual([running[0].taskId, running[0].toolCount, running[0].tokens], ["T6", 20, 99000]);
	assert.equal(running[0].currentTool, "edit: src/index.tsx");
	assert.deepEqual(running[0].recentActivity, ["read: a.ts", "edit: b.ts"], "feed dos recentTools do provider");
	// pending → pending; completed/failed/detached NÃO são live
	assert.equal(agentsFromDetails({ progress: [{ status: "pending", agent: "a", task: "Run T7 z", toolCount: 0, tokens: 0 }] })[0].status, "pending");
	assert.deepEqual(agentsFromDetails({ progress: [{ status: "completed", agent: "a", task: "x", toolCount: 5, tokens: 1 }] }), []);
	assert.deepEqual(agentsFromDetails({ progress: [{ status: "failed", agent: "a", task: "x", toolCount: 5, tokens: 1 }] }), []);
	// recentOutput vira o feed quando não há recentTools
	assert.deepEqual(agentsFromDetails({ progress: [{ status: "running", agent: "a", task: "t", recentOutput: ["line 1"], toolCount: 0, tokens: 0 }] })[0].recentActivity, ["line 1"]);
	assert.deepEqual(agentsFromDetails({}), [], "sem progress → vazio (ex.: async aceito, details.asyncId)");
	assert.deepEqual(agentsFromDetails({ status: "running", subagentType: "w", activity: "x" }), [], "shape do provider antigo (AgentDetails) ignorado");
});

test("setLiveAgents: startedAtMs é o anchor do PRIMEIRO frame e persiste entre updates (Duration ao vivo)", () => {
	clearAllLiveAgents();
	const frame = (toolCount: number) => agentsFromDetails({ progress: [{ index: 0, status: "running", agent: "w", task: "Run T3 x", toolCount, tokens: 1000 }] });
	setLiveAgents("call-t", frame(1));
	const first = listLiveAgents()[0].startedAtMs;
	assert.ok(typeof first === "number" && first > 0, "anchor setado no primeiro frame");
	setLiveAgents("call-t", frame(2));
	assert.equal(listLiveAgents()[0].startedAtMs, first, "anchor NÃO re-anda em frames seguintes");
	assert.equal(listLiveAgents()[0].toolCount, 2, "stats do frame mais recente");
	clearAllLiveAgents();
	setLiveAgents("call-t", frame(1));
	assert.ok((listLiveAgents()[0].startedAtMs as number) >= (first as number), "clear limpa o anchor (novo run → novo anchor)");
	clearAllLiveAgents();
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

test("async: registerAsyncRun/completeAsyncRun + refresh via status reader injetável", () => {
	clearAllLiveAgents();
	registerAsyncRun({ id: "run-1", agent: "harness-qa-flow-validator", task: "Validate T4 flows", goal: "ship-gate-qa-validator: validate flows", asyncDir: "/tmp/fake-async/run-1" });
	let live = listLiveAgents();
	assert.equal(live.length, 1);
	assert.deepEqual([live[0].runId, live[0].agent, live[0].taskId, live[0].status], ["run-1", "harness-qa-flow-validator", "ship-gate-qa-validator", "running"]);
	// refresh: o reader injetado devolve o status.json lite → stats atualizadas
	setAsyncStatusReader((dir) => (dir === "/tmp/fake-async/run-1" ? { state: "running", currentTool: "bash", toolCount: 7, tokens: 12000, steps: [{ status: "running", agent: "harness-qa-flow-validator", recentTools: [{ tool: "bash", args: "curl localhost", endMs: 1 }], toolCount: 7, tokens: 12000 }] } : null));
	live = listLiveAgents();
	assert.equal(live[0].toolCount, 7);
	assert.equal(live[0].tokens, 12000);
	assert.deepEqual(live[0].recentActivity, ["bash: curl localhost"]);
	// evento de complete remove
	completeAsyncRun("run-1");
	assert.equal(listLiveAgents().length, 0);
	// state terminal no refresh também remove (safety-net p/ evento perdido)
	registerAsyncRun({ id: "run-2", agent: "a", task: "Run T9", asyncDir: "/tmp/fake-async/run-2" });
	setAsyncStatusReader(() => ({ state: "complete" }));
	assert.equal(listLiveAgents().length, 0, "run terminal some no refresh");
	setAsyncStatusReader(undefined);
	clearAllLiveAgents();
});

test("async: id ausente é ignorado; goal tem prioridade sobre task no label/id", () => {
	clearAllLiveAgents();
	registerAsyncRun({ agent: "a", task: "x" });
	assert.equal(listLiveAgents().length, 0, "sem id → não registra");
	registerAsyncRun({ id: "r", agent: "a", task: "truncated…", goal: "Run T5 full goal" });
	assert.equal(listLiveAgents()[0].taskId, "T5", "goal (120 chars) sobre task (50 chars)");
	clearAllLiveAgents();
});
