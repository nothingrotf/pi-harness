import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressTracker, progressLines, type ProgressView } from "../src/readiness-progress.ts";
import { planAuditRun, planFixRun } from "../src/readiness-runner.ts";
import { makeLineParser } from "../src/readiness-spawn.ts";

test("progressLines: audit em andamento mostra ▸, tools, turn, clock e a ação", () => {
	const v: ProgressView = {
		title: "readiness audit",
		status: "running",
		steps: [{ id: "audit", kind: "audit", status: "in_progress" }],
		active: { stepId: "audit", toolCalls: 5, turns: 2, lastAction: "bash: gofmt -l .", elapsedMs: 65000 },
	};
	const lines = progressLines(v);
	assert.match(lines[0], /readiness audit · running/);
	assert.ok(lines.some((l) => /▸ audit/.test(l) && /5 tools/.test(l) && /turn 2/.test(l) && /1:05/.test(l)));
	assert.ok(lines.some((l) => /bash: gofmt -l \./.test(l)));
});

test("progressLines: marcadores ✓/▸/· por status", () => {
	const lines = progressLines({
		title: "readiness fix · 3",
		status: "running",
		steps: [
			{ id: "fix-a", kind: "fix", criterionId: "a", status: "completed" },
			{ id: "fix-b", kind: "fix", criterionId: "b", status: "in_progress" },
			{ id: "fix-c", kind: "fix", criterionId: "c", status: "pending" },
		],
		active: { stepId: "fix-b", toolCalls: 1, turns: 1, elapsedMs: 1000 },
	});
	assert.ok(lines.some((l) => /✓ fix a/.test(l)));
	assert.ok(lines.some((l) => /▸ fix b/.test(l)));
	assert.ok(lines.some((l) => /· fix c/.test(l)));
});

test("progressLines: modo denso colapsa completos e limita linhas", () => {
	const steps = Array.from({ length: 16 }, (_, i) => ({
		id: `fix-${i}`,
		kind: "fix" as const,
		criterionId: `c${i}`,
		status: i < 10 ? "completed" : "pending",
	}));
	const lines = progressLines({ title: "readiness fix · 16", status: "running", steps });
	assert.ok(lines.length <= 14, "limita a 14 linhas");
	assert.ok(lines.some((l) => /10\/16 done/.test(l)), "resume os completos");
});

test("ProgressTracker: acumula tool_execution_start/turn_start e projeta o passo ativo", () => {
	const run = planFixRun([
		{ criterionId: "a", prompt: "p" },
		{ criterionId: "b", prompt: "p" },
	]);
	run.steps[0].status = "in_progress";
	let t = 0;
	const tr = new ProgressTracker(run, "readiness fix · 2", () => (t += 1000));
	tr.onEvent("fix-a", { type: "turn_start" });
	tr.onEvent("fix-a", { type: "tool_execution_start", toolName: "read", args: { path: "src/x.ts" } });
	tr.onEvent("fix-a", { type: "tool_execution_start", toolName: "bash", args: { command: "go test ./..." } });
	const v = tr.view();
	assert.equal(v.active?.stepId, "fix-a");
	assert.equal(v.active?.toolCalls, 2);
	assert.equal(v.active?.turns, 1);
	assert.match(v.active?.lastAction ?? "", /bash: go test/);
	assert.equal(v.steps.length, 2);
});

test("ProgressTracker: sem passo in_progress → active undefined", () => {
	const run = planAuditRun("p"); // tudo pending
	assert.equal(new ProgressTracker(run, "readiness audit").view().active, undefined);
});

test("makeLineParser: bufferiza linhas parciais, parseia JSON, ignora ruído", () => {
	const got: unknown[] = [];
	const feed = makeLineParser((o) => got.push(o));
	feed('{"type":"a"}\n{"ty');
	feed('pe":"b"}\nnot json here\n{"type":"c"}\n');
	assert.deepEqual(got, [{ type: "a" }, { type: "b" }, { type: "c" }]);
});
