import { test } from "node:test";
import assert from "node:assert/strict";
import type { ControlModel, TaskRow, WorkerRow } from "../src/control-model.ts";
import {
	coverageDisplayRows,
	coverageSummary,
	cycleFilter,
	deliveryLines,
	filterTasks,
	handoffLines,
	mainLines,
	progressLogLines,
	TASK_FILTERS,
	taskDetailLines,
	taskDisplayRows,
	WORKER_FILTERS,
	workerDisplayRows,
} from "../src/control-rows.ts";
import type { PersistedHandoff } from "../src/handoff.ts";

function task(over: Partial<TaskRow> = {}): TaskRow {
	return { id: "T1", skillName: "worker", fulfills: [], description: "do thing", preconditions: [], expectedBehavior: [], status: "pending", active: false, ...over };
}

function model(over: Partial<ControlModel> = {}): ControlModel {
	return {
		featureId: "feat-x",
		exists: true,
		state: "running",
		gateInjected: false,
		assertions: { passed: 1, failed: 0, pending: 1, total: 2 },
		tasks: [
			task({ id: "T1", status: "completed", description: "bootstrap" }),
			task({ id: "T2", status: "in_progress", active: true, description: "add middleware", fulfills: ["A1"], preconditions: ["repo ready"], expectedBehavior: ["limits requests"] }),
			task({ id: "T3", status: "pending", description: "wire routes", fulfills: ["A2"] }),
		],
		tasksDone: 1,
		tasksTotal: 3,
		active: { id: "T2", kind: "task", label: "add middleware", skillName: "worker", fulfills: ["A1"] },
		workers: [
			{ workerSessionId: "—", taskId: "T2", status: "running" },
			{ workerSessionId: "ws1abcdef00", taskId: "T1", status: "success", recordedAt: "2026-06-29T00:01:00.000Z" },
		],
		handoffsRaw: [],
		progress: [
			{ ts: "t1", rel: "3m", text: "plan stored: 3 tasks / 2 assertions" },
			{ ts: "t2", rel: "2m", text: "T1 completed ✓" },
			{ ts: "t3", rel: "1m", text: "T2 started" },
		],
		coverage: [
			{ assertion: "A1", taskId: "T2", status: "passed" },
			{ assertion: "A2", taskId: "T3", status: "pending" },
		],
		delivery: null,
		...over,
	};
}

test("deliveryLines: null → 'no PR yet'; com record → PR + CI + merge", () => {
	assert.match(deliveryLines(model()).join("\n"), /No PR yet/);
	const withPr = model({
		delivery: {
			prNumber: 7,
			prTitle: "feat: x",
			linkedIssues: { linearIssueIds: ["ENG-1"], jiraIssueKeys: [], candidateKeys: [] },
			ci: { state: "passed", iterations: 1, checks: [{ name: "test", state: "passed" }], primaryFailure: null },
			state: "awaiting_merge",
			fixesApplied: [],
		},
	});
	const out = deliveryLines(withPr).join("\n");
	assert.match(out, /PR #7  feat: x/);
	assert.match(out, /ENG-1 \(Linear\)/);
	assert.match(out, /awaiting human gate/);
});

test("cycleFilter: avança ciclicamente e dá a volta", () => {
	assert.equal(cycleFilter(TASK_FILTERS, "all"), "pending");
	assert.equal(cycleFilter(TASK_FILTERS, "cancelled"), "all");
	assert.equal(cycleFilter(WORKER_FILTERS, "failed"), "all");
});

test("filterTasks/taskDisplayRows: filtra por status + label com ícone e fulfills", () => {
	const m = model();
	assert.deepEqual(filterTasks(m.tasks, "completed").map((t) => t.id), ["T1"]);
	const rows = taskDisplayRows(m, "all");
	assert.equal(rows.length, 3);
	assert.match(rows[0].label, /^✓ T1 {2}bootstrap/);
	assert.match(rows[1].label, /^● T2/);
	assert.equal(rows[1].description, "→ A1");
});

test("workerDisplayRows: filtros active/completed/failed; ícone + status", () => {
	const m = model();
	assert.equal(workerDisplayRows(m, "active").length, 1);
	assert.equal(workerDisplayRows(m, "completed").length, 1);
	assert.equal(workerDisplayRows(m, "failed").length, 0);
	const all = workerDisplayRows(m, "all");
	assert.match(all[0].label, /^● T2 {2}—/);
	assert.match(all[1].label, /✓ T1 {2}ws1abcde/, "wsid truncado a 8");
});

test("coverageDisplayRows/coverageSummary: invariante assertion→task→status", () => {
	const m = model();
	const rows = coverageDisplayRows(m);
	assert.deepEqual(rows[0], { value: "A1", label: "✓ A1", description: "→ T2 · passed" });
	assert.deepEqual(rows[1], { value: "A2", label: "○ A2", description: "→ T3 · pending" });
	assert.equal(coverageSummary(m), "1/2 passed");
	// uncovered (assertion órfã)
	const m2 = model({ coverage: [{ assertion: "A1", taskId: null, status: "pending" }], assertions: { passed: 0, failed: 0, pending: 1, total: 1 } });
	assert.equal(coverageSummary(m2), "0/1 passed · 1 uncovered");
});

test("progressLogLines: tail das últimas N + range; vazio → placeholder", () => {
	const m = model();
	const v = progressLogLines(m, 2, 60);
	assert.equal(v.lines.length, 2, "só as 2 últimas");
	assert.match(v.lines[0], /T1 completed/);
	assert.equal(v.range, "2-3 of 3");
	const empty = progressLogLines(model({ progress: [] }), 5);
	assert.deepEqual(empty.lines, ["(no progress entries yet)"]);
	assert.equal(empty.range, "");
});

test("mainLines: duas colunas (divisor │) com Active Task, Tasks, Progress Log + Active Worker", () => {
	const out = mainLines(model(), 90).join("\n");
	assert.match(out, /Active Task/);
	assert.match(out, /\[T2\] add middleware/);
	assert.match(out, /Tasks \(1\/3\)/);
	assert.match(out, /Progress Log/);
	assert.match(out, /│/, "tem divisor de coluna");
	assert.match(out, /Active Worker: .* · T2 · running/);
});

test("taskDetailLines: seções + truncagem de descrição (expand)", () => {
	const m = model({
		tasks: [task({ id: "T9", description: "l1\nl2\nl3\nl4\nl5", preconditions: ["p1", "p2"], expectedBehavior: ["e1"], fulfills: ["A1"], status: "in_progress" })],
	});
	const collapsed = taskDetailLines(m, "T9", false).join("\n");
	assert.match(collapsed, /\[T9\] {2}In Progress/);
	assert.match(collapsed, /\+2 more line\(s\); space to expand/);
	assert.match(collapsed, /Preconditions/);
	assert.match(collapsed, /• p1/);
	assert.match(collapsed, /Expected Behavior/);
	assert.match(collapsed, /fulfills: A1/);
	const expanded = taskDetailLines(m, "T9", true).join("\n");
	assert.match(expanded, /l4/, "expandido mostra todas as linhas");
	assert.match(taskDetailLines(m, "nope", false).join("\n"), /not found/);
});

test("handoffLines: Summary/Undone/Discovered Issues do EndFeatureRun; vazios + faltando", () => {
	const h: PersistedHandoff = {
		taskId: "T1",
		workerSessionId: "ws1abcdef00",
		successState: "partial",
		returnToOrchestrator: false,
		validatorsPassed: false,
		recordedAt: "2026-06-29T00:01:00.000Z",
		handoff: {
			whatWasImplemented: "added limiter",
			salientSummary: "token-bucket on gateway",
			whatWasLeftUndone: "codecov upload",
			verification: { commandsRun: [] },
			discoveredIssues: [{ severity: "blocking", description: "toolchain pin old", suggestedFix: "bump to 1.23" }],
		},
	};
	const out = handoffLines(model({ handoffsRaw: [h] }), "ws1abcdef00").join("\n");
	assert.match(out, /Session: ws1abcde {2}· {2}Feature: T1 {2}· {2}partial/);
	assert.match(out, /Summary\n {2}token-bucket on gateway/);
	assert.match(out, /What Was Left Undone\n {2}codecov upload/);
	assert.match(out, /⚠ \[blocking\] toolchain pin old/);
	assert.match(out, /Suggested fix: bump to 1\.23/);

	const empty: PersistedHandoff = { taskId: "T2", workerSessionId: "ws2", successState: "success", returnToOrchestrator: false, validatorsPassed: true, recordedAt: "x", handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } } };
	const out2 = handoffLines(model({ handoffsRaw: [empty] }), "ws2").join("\n");
	assert.match(out2, /\(nothing left undone\)/);
	assert.match(out2, /Discovered Issues\n {2}\(none\)/);
	assert.match(handoffLines(model(), "missing").join("\n"), /Failed to load handoff/);
});
