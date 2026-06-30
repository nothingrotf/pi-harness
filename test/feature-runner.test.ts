import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanupOrphan,
	type FeatureRun,
	type FeatureRunLoopDeps,
	grantRetryBudget,
	IMPL_STEP_ID,
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

test("planFeatureRun: N tasks viram UM impl step (1 worker por feature), sem gate ainda", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	assert.equal(run.featureId, "feat-x");
	assert.equal(run.steps.length, 1, "um único impl step carrega as N tasks (não N steps)");
	assert.equal(run.steps[0].id, IMPL_STEP_ID);
	assert.equal(run.steps[0].kind, "task");
	assert.equal(run.steps[0].status, "pending");
	assert.deepEqual(run.steps[0].tasks?.map((t) => t.id), ["T1", "T2"], "a lista de tasks vira o TODO interno do worker");
	assert.deepEqual(run.steps[0].fulfills, ["A-T1", "A-T2"], "fulfills = união das tasks");
	assert.equal(run.gateInjected, false);
});

test("runLoop: UM worker entrega todas as tasks, injeta ship gate 1x, completa", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	const order: string[] = [];
	const doneTasks: string[] = [];
	const spawn: SpawnFn = async (step) => {
		order.push(step.id);
		return { code: 0, success: true };
	};
	await runLoop("/repo", run, deps(spawn, { log: (ev, extra) => { if (ev === "task_completed") doneTasks.push(String(extra?.taskId)); } }));
	assert.equal(run.status, "completed");
	// 1 impl spawn (todas as tasks numa sessão) + os 3 passos do ship gate
	assert.deepEqual(order, [IMPL_STEP_ID, "ship-gate-code-review", "ship-gate-qa-validator", "ship-gate-deliver"]);
	// o runner emite task_completed por sub-task ao completar o impl step (TUI por-task fica correta)
	assert.deepEqual(doneTasks, ["T1", "T2"]);
	assert.equal(run.gateInjected, true);
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("runLoop: impl falha → orchestrator_turn (step volta a pending)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 0, success: false } })));
	assert.equal(run.status, "orchestrator_turn");
	const impl = run.steps.find((s) => s.id === IMPL_STEP_ID);
	assert.equal(impl?.status, "pending", "falha reseta pra pending (re-tenta no resume)");
	assert.equal(impl?.attempts, 1);
	assert.equal(run.gateInjected, false, "não injeta o gate enquanto a implementação não terminou");
});

test("runLoop: returnToOrchestrator também devolve controle", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 0, success: true, returnToOrchestrator: true } })));
	assert.equal(run.status, "orchestrator_turn");
});

test("runLoop: ship gate falha (harness-code-review) → orchestrator_turn; fix task corre antes do gate no resume", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	// 1ª passada: T1 ok, harness-code-review falha
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
	// no resume corre a fix, depois harness-code-review (que estava pending), harness-qa-validator e harness-deliver
	assert.deepEqual(order, ["FIX1", "ship-gate-code-review", "ship-gate-qa-validator", "ship-gate-deliver"]);
});

test("runLoop: budget esgotado → paused (step_retry_limit_exceeded)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	// sempre falha; cada runLoop gasta 1 tentativa e para em orchestrator_turn → resume
	for (let i = 0; i < 5; i++) await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	const last = await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	assert.equal(last.status, "paused");
	assert.equal(last.pauseReason, "step_retry_limit_exceeded");
	assert.equal(run.steps[0].attempts, 5, "não passa do budget");
});

test("runLoop: abort (graceful) → paused, step fica in_progress (resumível) + registra a sessão", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	const spawn: SpawnFn = async () => {
		ac.abort();
		return { code: 0, aborted: true };
	};
	await runLoop("/repo", run, deps(spawn), ac.signal);
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "aborted");
	assert.equal(run.steps[0].status, "in_progress", "graceful → mantém in_progress p/ re-attach");
	assert.equal(run.steps[0].workerSessionIds.length, 1);
	assert.equal(run.steps[0].attempts, 1);
});

test("runLoop: resume re-attacha a MESMA sessão (sem nova tentativa) e continua", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	await runLoop("/repo", run, deps(async () => {
		ac.abort();
		return { code: 0, aborted: true };
	}), ac.signal);
	const wsid = run.steps[0].workerSessionIds.at(-1);
	const seen: { resume?: boolean; wsid?: string }[] = [];
	await runLoop("/repo", run, deps(async (_s, ctx) => {
		seen.push({ resume: ctx.resume, wsid: ctx.workerSessionId });
		return { code: 0, success: true };
	}), undefined, { resume: true });
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].attempts, 1, "re-attach NÃO consome nova tentativa");
	assert.equal(seen[0]?.resume, true);
	assert.equal(seen[0]?.wsid, wsid, "re-attacha a mesma sessão do worker");
});

test("runLoop: 402/usage-limit → paused (usage_limit), step resumível", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: null, usageLimit: true } })));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "usage_limit");
	assert.equal(run.steps[0].status, "in_progress");
});

test("runLoop: inactivity → requeue (step pending, tentativa contada) e segue até completar", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	let n = 0;
	await runLoop("/repo", run, deps(async () => {
		n++;
		return n === 1 ? { code: null, inactivity: true } : { code: 0, success: true };
	}));
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].attempts, 2, "inactivity contou 1 tentativa; a 2ª teve sucesso");
});

test("runLoop: retry-budget bonus permite re-rodar um step esgotado", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	for (let i = 0; i < 5; i++) await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "step_retry_limit_exceeded");
	grantRetryBudget(run, IMPL_STEP_ID);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 0, success: true } })), undefined, { resume: true });
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].attempts, 6, "consumiu 1 do budget bônus");
});

test("runLoop: preempção no resume — pending acima do in_progress roda primeiro", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	await runLoop("/repo", run, deps(async () => {
		ac.abort();
		return { code: 0, aborted: true };
	}), ac.signal);
	assert.equal(run.steps[0].status, "in_progress");
	run.steps.unshift({ id: "PRE", kind: "task", skillName: "w", tasks: [{ id: "PRE", skillName: "w" }], status: "pending", attempts: 0, workerSessionIds: [] });
	const order: string[] = [];
	await runLoop("/repo", run, deps(async (s) => {
		order.push(s.id);
		return { code: 0, success: true };
	}), undefined, { resume: true });
	assert.equal(run.status, "completed");
	assert.equal(order[0], "PRE", "a task preemptora corre primeiro");
	assert.ok(order.includes(IMPL_STEP_ID), "o impl step preemptado re-roda depois");
});

test("runLoop: heartbeat toca durante um spawn longo", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	let beats = 0;
	const slow: SpawnFn = () => new Promise((res) => setTimeout(() => res({ code: 0, success: true }), 40));
	await runLoop("/repo", run, deps(slow, { heartbeatMs: 8, log: (ev) => { if (ev === "heartbeat") beats++; } }));
	assert.ok(beats >= 1, `esperava >=1 heartbeat, teve ${beats}`);
	assert.equal(run.status, "completed");
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
	assert.equal(run.steps.filter((s) => s.kind === "ship-gate").length, 3);
});

test("nextPending: ordem do array (impl step → ship gate)", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	assert.equal(nextPending(run)?.id, IMPL_STEP_ID, "o impl step roda primeiro");
	run.steps[0].status = "completed";
	injectShipGate(run);
	assert.equal(nextPending(run)?.id, "ship-gate-code-review", "depois do impl, o 1º passo do ship gate");
});

test("injectShipGate: honra o skip set (skipScrutiny/skipUserTesting)", () => {
	const r1 = planFeatureRun("f", [{ id: "T1", skillName: "w" }]);
	injectShipGate(r1, new Set(["harness-code-review"]));
	assert.deepEqual(
		r1.steps.filter((s) => s.kind === "ship-gate").map((s) => s.skillName),
		["harness-qa-validator", "harness-deliver"],
	);
	const r2 = planFeatureRun("f", [{ id: "T1", skillName: "w" }]);
	injectShipGate(r2, new Set(["harness-code-review", "harness-qa-validator", "harness-deliver"]));
	assert.equal(r2.steps.filter((s) => s.kind === "ship-gate").length, 0);
});
