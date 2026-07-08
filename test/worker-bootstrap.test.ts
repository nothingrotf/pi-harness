import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeatureStep } from "../src/feature-runner.ts";
import { buildWorkerBootstrap } from "../src/worker-bootstrap.ts";

const task: FeatureStep = { id: "T1", kind: "task", skillName: "backend-worker", fulfills: ["A-1"], status: "pending", attempts: 0, workerSessionIds: [] };
const gate: FeatureStep = { id: "ship-gate-code-review", kind: "ship-gate", skillName: "harness-code-review", status: "pending", attempts: 0, workerSessionIds: [] };
const impl: FeatureStep = {
	id: "implement",
	kind: "task",
	skillName: "backend-worker",
	tasks: [
		{ id: "T1", skillName: "backend-worker", description: "build A", fulfills: ["A-1"] },
		{ id: "T2", skillName: "frontend-worker", description: "build B", fulfills: ["A-2"] },
	],
	fulfills: ["A-1", "A-2"],
	status: "pending",
	attempts: 0,
		workerSessionIds: [],
};

test("buildWorkerBootstrap: task → harness-worker-base, depois a skill, depois EndFeatureRun", () => {
	const m = buildWorkerBootstrap(task, { featureId: "feat-x", workerSessionId: "ws-1" });
	assert.match(m, /worker session id is: ws-1/);
	assert.match(m, /'harness-worker-base' skill/);
	assert.match(m, /"skillName": "backend-worker"/);
	assert.match(m, /Call EndFeatureRun/);
	assert.match(m, /"id": "T1"/);
	assert.match(m, /feature "feat-x"/);
});

test("buildWorkerBootstrap: impl multi-task → loop next_task (uma sessão, sem lista inline, UM EndFeatureRun)", () => {
	const m = buildWorkerBootstrap(impl, { featureId: "feat-x", workerSessionId: "ws-1" });
	assert.match(m, /ONE continuous session for the WHOLE feature \(2 tasks\)/);
	assert.match(m, /next_task\(\{ featureId: "feat-x" \}\)/, "puxa cada task via next_task");
	assert.match(m, /You MUST commit/);
	assert.match(m, /EndFeatureRun \*\*once\*\*/);
	assert.match(m, /2 tasks \(T1, T2\)/, "lista os ids pra orientação");
	// a fonte de verdade é o tool: NADA de despejar a spec completa no bootstrap.
	assert.doesNotMatch(m, /```json/);
	assert.doesNotMatch(m, /"skillName": "frontend-worker"/);
});

test("buildWorkerBootstrap: batch step (K>1) → copy de BATCH k/K, next_task escopado, leia commits anteriores", () => {
	const batch2: FeatureStep = {
		id: "implement-2",
		kind: "task",
		skillName: "frontend-worker",
		tasks: [
			{ id: "T8", skillName: "frontend-worker", description: "ui", fulfills: ["A-8"] },
			{ id: "T9", skillName: "frontend-worker", description: "ui2", fulfills: ["A-9"] },
		],
		fulfills: ["A-8", "A-9"],
		status: "pending",
		attempts: 0,
		workerSessionIds: [],
		batchIndex: 2,
		batchTotal: 3,
	};
	const m = buildWorkerBootstrap(batch2, { featureId: "feat-x", workerSessionId: "ws-2" });
	assert.match(m, /BATCH 2\/3 of feature "feat-x"/);
	assert.match(m, /you own \*\*batch 2\*\*/);
	assert.match(m, /Earlier batches were already delivered and COMMITTED/);
	assert.match(m, /git log/, "orienta a reconstruir contexto dos commits anteriores");
	assert.match(m, /ONLY this batch's tasks/);
	assert.match(m, /taskId="implement-2"/, "EndFeatureRun usa o id do batch step");
	assert.match(m, /Batch 2\/3 has 2 tasks \(T8, T9\)/);
	// fonte de verdade = next_task; nada de spec completa inline.
	assert.doesNotMatch(m, /```json/);
	assert.doesNotMatch(m, /WHOLE feature/, "não usa a copy de feature inteira (K=1)");
});

test("buildWorkerBootstrap: ship gate pula harness-worker-base e invoca o validator direto", () => {
	const m = buildWorkerBootstrap(gate, { featureId: "feat-x", workerSessionId: "ws-9" });
	assert.doesNotMatch(m, /harness-worker-base/);
	assert.match(m, /'harness-code-review' skill \(ship-gate validator\)/);
	assert.match(m, /returnToOrchestrator: true/);
	assert.match(m, /"kind": "ship-gate"/);
});
