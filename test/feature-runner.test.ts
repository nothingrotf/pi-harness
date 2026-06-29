import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanupOrphan,
	type FeatureRun,
	type FeatureRunLoopDeps,
	injectShipGate,
	insertFixTask,
	nextPending,
	planFeatureRun,
	runLoop,
	type SpawnFn,
	type SpawnOutcome,
} from "../src/feature-runner.ts";

const NOW = () => "2026-06-29T00:00:00.000Z";

function tasks(...ids: string[]) {
	return ids.map((id) => ({ id, skillName: "backend-worker", fulfills: [`A-${id}`] }));
}

/** spawn que reporta success por step.id via um mapa; default success. */
function spawnFrom(outcomes: Record<string, SpawnOutcome>): SpawnFn {
	return async (step) => outcomes[step.id] ?? { code: 0, success: true };
}

function deps(spawn: SpawnFn, extra: Partial<FeatureRunLoopDeps> = {}): FeatureRunLoopDeps {
	return { spawn, now: NOW, ...extra };
}

test("planFeatureRun: tasks viram steps pending, sem gate ainda", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	assert.equal(run.featureId, "feat-x");
	assert.equal(run.steps.length, 2);
	assert.equal(run.gateInjected, false);
	assert.ok(run.steps.every((s) => s.kind === "task" && s.status === "pending"));
});

test("runLoop: roda tasks em sequência, injeta ship gate 1x, completa", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	const order: string[] = [];
	const spawn: SpawnFn = async (step) => {
		order.push(step.id);
		return { code: 0, success: true };
	};
	await runLoop("/repo", run, deps(spawn));
	assert.equal(run.status, "completed");
	// 2 tasks + code-review + qa-validator, nessa ordem
	assert.deepEqual(order, ["T1", "T2", "ship-gate-code-review", "ship-gate-qa-validator"]);
	assert.equal(run.gateInjected, true);
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("runLoop: task falha → orchestrator_turn (step volta a pending)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ T1: { code: 0, success: false } })));
	assert.equal(run.status, "orchestrator_turn");
	const t1 = run.steps.find((s) => s.id === "T1");
	assert.equal(t1?.status, "pending", "falha reseta pra pending (re-tenta no resume)");
	assert.equal(t1?.attempts, 1);
	assert.equal(run.gateInjected, false, "não injeta o gate enquanto há task pendente");
});

test("runLoop: returnToOrchestrator também devolve controle", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ T1: { code: 0, success: true, returnToOrchestrator: true } })));
	assert.equal(run.status, "orchestrator_turn");
});

test("runLoop: ship gate falha (code-review) → orchestrator_turn; fix task corre antes do gate no resume", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	// 1ª passada: T1 ok, code-review falha
	await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": { code: 0, success: false } })));
	assert.equal(run.status, "orchestrator_turn");
	assert.equal(run.gateInjected, true);
	// orchestrator insere fix task antes do gate, resume
	insertFixTask(run, { id: "FIX1", skillName: "backend-worker" });
	const idxFix = run.steps.findIndex((s) => s.id === "FIX1");
	const idxGate = run.steps.findIndex((s) => s.kind === "ship-gate");
	assert.ok(idxFix < idxGate, "fix task fica antes do ship gate");
	const order: string[] = [];
	await runLoop("/repo", run, deps(async (s) => {
		order.push(s.id);
		return { code: 0, success: true };
	}));
	assert.equal(run.status, "completed");
	// no resume corre a fix, depois code-review (que estava pending) e qa-validator
	assert.deepEqual(order, ["FIX1", "ship-gate-code-review", "ship-gate-qa-validator"]);
});

test("runLoop: budget esgotado → paused (step_retry_limit_exceeded)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	// sempre falha; cada runLoop gasta 1 tentativa e para em orchestrator_turn → resume
	for (let i = 0; i < 5; i++) await runLoop("/repo", run, deps(spawnFrom({ T1: { code: 1, success: false } })));
	const last = await runLoop("/repo", run, deps(spawnFrom({ T1: { code: 1, success: false } })));
	assert.equal(last.status, "paused");
	assert.equal(last.pauseReason, "step_retry_limit_exceeded");
	assert.equal(run.steps[0].attempts, 5, "não passa do budget");
});

test("runLoop: abort → paused (aborted), step volta a pending", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	const spawn: SpawnFn = async () => {
		ac.abort();
		return { code: 0, aborted: true };
	};
	await runLoop("/repo", run, deps(spawn), ac.signal);
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "aborted");
	assert.equal(run.steps[0].status, "pending");
});

test("cleanupOrphan: in_progress órfão volta a pending", () => {
	const run: FeatureRun = planFeatureRun("feat-x", tasks("T1"), NOW);
	run.steps[0].status = "in_progress";
	cleanupOrphan(run);
	assert.equal(run.steps[0].status, "pending");
});

test("injectShipGate: idempotente", () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	injectShipGate(run);
	injectShipGate(run);
	assert.equal(run.steps.filter((s) => s.kind === "ship-gate").length, 2);
});

test("nextPending: ordem do array", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	run.steps[0].status = "completed";
	assert.equal(nextPending(run)?.id, "T2");
});
