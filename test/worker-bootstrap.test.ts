import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeatureStep } from "../src/feature-runner.ts";
import { buildWorkerBootstrap } from "../src/worker-bootstrap.ts";

const task: FeatureStep = { id: "T1", kind: "task", skillName: "backend-worker", fulfills: ["A-1"], status: "pending", attempts: 0 };
const gate: FeatureStep = { id: "ship-gate-code-review", kind: "ship-gate", skillName: "harness-code-review", status: "pending", attempts: 0 };

test("buildWorkerBootstrap: task → harness-worker-base, depois a skill, depois EndFeatureRun", () => {
	const m = buildWorkerBootstrap(task, { featureId: "feat-x", workerSessionId: "ws-1" });
	assert.match(m, /worker session id is: ws-1/);
	assert.match(m, /'harness-worker-base' skill/);
	assert.match(m, /'backend-worker' skill/);
	assert.match(m, /Call EndFeatureRun/);
	assert.match(m, /"id": "T1"/);
	assert.match(m, /feature "feat-x"/);
});

test("buildWorkerBootstrap: ship gate pula harness-worker-base e invoca o validator direto", () => {
	const m = buildWorkerBootstrap(gate, { featureId: "feat-x", workerSessionId: "ws-9" });
	assert.doesNotMatch(m, /harness-worker-base/);
	assert.match(m, /'harness-code-review' skill \(ship-gate validator\)/);
	assert.match(m, /returnToOrchestrator: true/);
	assert.match(m, /"kind": "ship-gate"/);
});
