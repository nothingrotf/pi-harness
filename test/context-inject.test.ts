import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildWorkerTurnMessage, dedupeTurnMessage, readTurnContext, resetTurnMessageDedupe, type TurnContext } from "../src/context-inject.ts";

function seedRun(cwd: string, featureId: string): string {
	const dir = path.join(cwd, ".harness", "runs", featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "plan.json"),
		JSON.stringify({
			featureId,
			createdAt: "t",
			assertions: ["A1", "A2"],
			tasks: [
				{ id: "T1", description: "Build the API", skillName: "web-worker", fulfills: ["A1"] },
				{ id: "T2", description: "Build the UI", skillName: "web-worker", fulfills: ["A2"] },
			],
		}),
	);
	fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ featureId, assertions: { A1: "pending", A2: "passed" } }));
	fs.writeFileSync(path.join(dir, "contract.md"), ["# Contract", "### A1: API returns 200", "### A2: UI renders list"].join("\n"));
	return dir;
}

test("readTurnContext: monta do disco — task ativa, assertions do fulfills com status vivo, progresso", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ctx-"));
	const dir = seedRun(cwd, "feat-a");
	// sem nextTaskState → sem task ativa
	let tc = readTurnContext(cwd, "feat-a");
	assert.ok(tc);
	assert.equal(tc?.taskId, null);
	assert.equal(tc?.total, 2);
	// task ativa T2 → assertions = fulfills de T2 com status de status.json
	fs.writeFileSync(path.join(dir, "next-task.json"), JSON.stringify({ activeTaskId: "T2", head: "abc" }));
	tc = readTurnContext(cwd, "feat-a");
	assert.equal(tc?.taskId, "T2");
	assert.equal(tc?.skillName, "web-worker");
	assert.deepEqual(tc?.assertions, [{ id: "A2", status: "passed", text: "UI renders list" }]);
	assert.equal(tc?.isFix, false);
	// sem plano → null
	assert.equal(readTurnContext(cwd, "feat-missing"), null);
});

test("readTurnContext: fix task (FIX*) marca isFix (o finding verbatim vive na description)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ctx-fix-"));
	const dir = path.join(cwd, ".harness", "runs", "feat-f");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ featureId: "feat-f", createdAt: "t", assertions: [], tasks: [{ id: "FIX1", description: "finding: NPE at api.ts:10", skillName: "web-worker", fulfills: [] }] }));
	fs.writeFileSync(path.join(dir, "next-task.json"), JSON.stringify({ activeTaskId: "FIX1" }));
	const tc = readTurnContext(cwd, "feat-f");
	assert.equal(tc?.isFix, true);
});

test("buildWorkerTurnMessage: corpo derivado — task corrente + assertions + FROZEN; sem task → nudge de next_task", () => {
	const tc: TurnContext = {
		featureId: "feat-a",
		taskId: "T2",
		taskDescription: "Build the UI",
		skillName: "web-worker",
		assertions: [{ id: "A2", status: "pending", text: "UI renders list" }],
		done: 1,
		total: 2,
		lessons: "Lessons: L-001 — prefer plain dash.",
		isFix: false,
	};
	const msg = buildWorkerTurnMessage(tc);
	assert.match(msg, /CURRENT TASK: T2 \(skill: web-worker\)/);
	assert.match(msg, /1\/2 tasks committed/);
	assert.match(msg, /\[pending\] A2 — UI renders list/);
	assert.match(msg, /FROZEN.*contract\.md, plan\.json, status\.json/);
	assert.match(msg, /L-001/);
	const idle = buildWorkerTurnMessage({ ...tc, taskId: null, assertions: [] });
	assert.match(idle, /call next_task to start/);
	// fix → finding verbatim
	const fix = buildWorkerTurnMessage({ ...tc, isFix: true, taskDescription: "finding: NPE at api.ts:10" });
	assert.match(fix, /FIX — original finding, verbatim: finding: NPE at api\.ts:10/);
});

test("dedupeTurnMessage: byte-idêntico colapsa; mudança reexpande (estilo omp)", () => {
	resetTurnMessageDedupe();
	const a = dedupeTurnMessage("f", "body v1");
	assert.equal(a, "body v1", "primeiro turno → corpo inteiro");
	const b = dedupeTurnMessage("f", "body v1");
	assert.match(b, /unchanged — still in effect/);
	const c = dedupeTurnMessage("f", "body v2");
	assert.equal(c, "body v2", "mudou → reexpande");
	resetTurnMessageDedupe();
});
