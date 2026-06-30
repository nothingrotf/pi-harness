import { test } from "node:test";
import assert from "node:assert/strict";
import type { ControlModel } from "../src/control-model.ts";
import { buildRunCard, runCardPlainLines, runPhase } from "../src/run-card.ts";

function model(over: Partial<ControlModel> = {}): ControlModel {
	return {
		featureId: "add-rate-limiter",
		exists: true,
		state: "running",
		activeMs: null,
		counts: { completed: 1, pending: 2, estimate: 2, cancelled: 0, total: 5 },
		gateInjected: false,
		assertions: { passed: 6, failed: 0, pending: 6, total: 12 },
		tasks: [
			{ id: "T1", skillName: "worker", fulfills: [], description: "x", preconditions: [], expectedBehavior: [], status: "completed", active: false },
			{ id: "T2", skillName: "worker", fulfills: ["A3"], description: "y", preconditions: [], expectedBehavior: [], status: "in_progress", active: true },
			{ id: "T3", skillName: "worker", fulfills: [], description: "z", preconditions: [], expectedBehavior: [], status: "pending", active: false },
		],
		tasksDone: 1,
		tasksTotal: 3,
		active: { id: "T2", kind: "task", label: "y", skillName: "worker", fulfills: ["A3"] },
		workers: [{ workerSessionId: "9f3a4b2c1d2e", taskId: "T2", status: "running" }],
		handoffsRaw: [],
		progress: [],
		coverage: [],
		...over,
	};
}

test("runPhase: mapeia estado do run → fase do cartão", () => {
	assert.equal(runPhase(null), "preparing");
	assert.equal(runPhase(model({ state: "running" })), "running");
	assert.equal(runPhase(model({ state: "paused" })), "paused");
	assert.equal(runPhase(model({ state: "orchestrator_turn" })), "returning");
	assert.equal(runPhase(model({ state: "completed" })), "completed");
	assert.equal(runPhase(model({ state: "ready" })), "ready");
	assert.equal(runPhase(model({ state: "unknown" })), "preparing");
});

test("buildRunCard(null): estado preparando, sem hint", () => {
	const c = buildRunCard(null);
	assert.equal(c.phase, "preparing");
	assert.equal(c.showHint, false);
	assert.equal(c.summary, "Preparing to start run…");
});

test("buildRunCard: Progress = work items (1:1 Droid) + linha Assertions; Current Task + Worker", () => {
	const c = buildRunCard(model());
	assert.equal(c.bar.completed, 1);
	assert.equal(c.bar.total, 5);
	assert.equal(c.rows.find((r) => r.label === "Progress")?.value, "1/5 [+2]");
	assert.equal(c.rows.find((r) => r.label === "Assertions")?.value, "6/12", "contrato fica numa linha secundária");
	assert.equal(c.rows.find((r) => r.label === "Current Task")?.value, "T2");
	assert.match(c.rows.find((r) => r.label === "Worker")?.value ?? "", /9f3a4b2c · #T2 · running/);
	assert.match(c.tasks, /✓T1 ●T2 ○T3/);
	assert.equal(c.showHint, true);
});

test("buildRunCard: sem assertions → sem linha Assertions; Progress segue os work items", () => {
	const c = buildRunCard(model({ assertions: { passed: 0, failed: 0, pending: 0, total: 0 } }));
	assert.equal(c.rows.find((r) => r.label === "Assertions"), undefined);
	assert.equal(c.rows.find((r) => r.label === "Progress")?.value, "1/5 [+2]");
});

test("buildRunCard: liveAgents (subagent rodando) viram o Worker row + Current Task", () => {
	const c = buildRunCard(model({ active: null, workers: [] }), {
		liveAgents: [{ index: 0, taskId: "T2", agent: "harness-worker", label: "Run T2 contracts-worker", status: "running", toolCount: 10, tokens: 72400 }],
	});
	assert.equal(c.rows.find((r) => r.label === "Current Task")?.value, "T2", "task vem do subagent ao vivo (sem feature-run)");
	const w = c.rows.find((r) => r.label === "Worker")?.value ?? "";
	assert.match(w, /#T2/);
	assert.match(w, /10 tools/);
	assert.match(w, /72k tokens/);
	assert.match(w, /running/);
});

test("runCardPlainLines: resumo ⛬ + rows + Tasks + hint", () => {
	const lines = runCardPlainLines(buildRunCard(model()));
	assert.equal(lines[0], "⛬ harness run · Run in progress…");
	assert.ok(lines.some((l) => l.includes("Progress: 1/5 [+2]")));
	assert.ok(lines.some((l) => l.includes("Assertions: 6/12")));
	assert.ok(lines.some((l) => l.includes("Tasks: ✓T1 ●T2 ○T3")));
	assert.equal(lines.at(-1), "  ctrl+t to enter Feature Control");
});

test("buildRunCard: Worker Activity vem do recentActivity do live agent", () => {
	const c = buildRunCard(model(), { liveAgents: [{ index: 0, taskId: "T2", agent: "w", label: "Run T2", status: "running", toolCount: 2, tokens: 100, recentActivity: ["Read: src/a.ts", "Edit: src/b.ts"] }] });
	assert.deepEqual(c.activity, ["Read: src/a.ts", "Edit: src/b.ts"]);
	const lines = runCardPlainLines(c);
	assert.ok(lines.includes("  Worker Activity:"));
	assert.ok(lines.some((l) => l.includes("Read: src/a.ts")));
});
