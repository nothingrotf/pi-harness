import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanupOrphan,
	nextPending,
	planAuditRun,
	planFixRun,
	type ReadinessRun,
	type RunLoopDeps,
	runLoop,
	type SpawnFn,
	STEP_ATTEMPT_BUDGET,
} from "../src/readiness-runner.ts";

/** Spawn injetado: roteia outcomes por chamada e registra a ordem dos passos. */
function fakeSpawn(outcomes: Array<{ code: number | null; aborted?: boolean }>, calls: string[] = []): SpawnFn {
	let i = 0;
	return async (step) => {
		calls.push(step.id);
		return outcomes[Math.min(i++, outcomes.length - 1)];
	};
}

function deps(spawn: SpawnFn, auditOk = true, extra: Partial<RunLoopDeps> = {}): RunLoopDeps {
	return { spawn, auditSucceeded: () => auditOk, ...extra };
}

test("planAuditRun: um passo audit pendente; planFixRun: N passos de fix", () => {
	const a = planAuditRun("AUDIT PROMPT");
	assert.equal(a.steps.length, 1);
	assert.equal(a.steps[0].kind, "audit");
	assert.equal(a.steps[0].status, "pending");

	const f = planFixRun([
		{ criterionId: "lint_config", prompt: "p1" },
		{ criterionId: "readme", prompt: "p2" },
	]);
	assert.equal(f.steps.length, 2);
	assert.deepEqual(f.steps.map((s) => s.criterionId), ["lint_config", "readme"]);
	assert.equal(f.steps[0].kind, "fix");
});

test("runLoop: emite eventos de progresso (progress_log analog)", async () => {
	const evs: string[] = [];
	const run = planAuditRun("p");
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }]), true, { log: (ev) => evs.push(ev) }));
	assert.ok(evs.includes("step_started"), "logou step_started");
	assert.ok(evs.includes("step_completed"), "logou step_completed");
});

test("nextPending / cleanupOrphan", () => {
	const run = planFixRun([{ criterionId: "a", prompt: "p" }]);
	run.steps[0].status = "in_progress"; // órfão de crash
	cleanupOrphan(run);
	assert.equal(run.steps[0].status, "pending");
	assert.equal(nextPending(run)?.id, "fix-a");
});

test("runLoop: audit sucesso (code 0 + snapshot válido) → completed", async () => {
	const calls: string[] = [];
	const persisted: string[] = [];
	const run = planAuditRun("p");
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }], calls), true, { persist: (r) => persisted.push(r.status) }));
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].status, "completed");
	assert.equal(run.steps[0].attempts, 1);
	assert.deepEqual(calls, ["audit"]);
	assert.ok(persisted.length > 0, "persistiu o estado");
});

test("runLoop: audit code 0 mas snapshot inválido → re-tenta até o budget → paused", async () => {
	const calls: string[] = [];
	const run = planAuditRun("p");
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }], calls), false, { budget: 3 }));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "step_retry_limit_exceeded");
	assert.equal(run.steps[0].attempts, 3, "esgotou o budget");
	assert.equal(calls.length, 3, "3 spawns");
});

test("runLoop: fix sequencial — 3 passos, ordem preservada, todos completam", async () => {
	const calls: string[] = [];
	const run = planFixRun([
		{ criterionId: "a", prompt: "pa" },
		{ criterionId: "b", prompt: "pb" },
		{ criterionId: "c", prompt: "pc" },
	]);
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }], calls)));
	assert.equal(run.status, "completed");
	assert.deepEqual(calls, ["fix-a", "fix-b", "fix-c"]);
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("runLoop: falha persistente (code 1) esgota budget e pausa", async () => {
	const run = planFixRun([{ criterionId: "a", prompt: "p" }]);
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 1 }])));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "step_retry_limit_exceeded");
	assert.equal(run.steps[0].attempts, STEP_ATTEMPT_BUDGET);
});

test("runLoop: abort via spawn → step volta a pending, run paused 'aborted'", async () => {
	const run = planFixRun([{ criterionId: "a", prompt: "p" }]);
	await runLoop("/repo", run, deps(fakeSpawn([{ code: null, aborted: true }])));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "aborted");
	assert.equal(run.steps[0].status, "pending");
});

test("runLoop: signal já abortado → pausa sem spawnar", async () => {
	const calls: string[] = [];
	const ac = new AbortController();
	ac.abort();
	const run = planAuditRun("p");
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }], calls)), ac.signal);
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "aborted");
	assert.equal(calls.length, 0, "não spawnou nada");
});

test("runLoop: resume — run pausado com passos completos+pendentes continua os pendentes", async () => {
	const calls: string[] = [];
	const run = planFixRun([
		{ criterionId: "a", prompt: "pa" },
		{ criterionId: "b", prompt: "pb" },
	]);
	run.status = "paused";
	run.pauseReason = "aborted";
	run.steps[0].status = "completed"; // já feito antes da pausa
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }], calls)));
	assert.equal(run.status, "completed");
	assert.deepEqual(calls, ["fix-b"], "só re-roda o pendente");
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("runLoop: recupera órfão in_progress no início e prossegue", async () => {
	const run: ReadinessRun = planFixRun([{ criterionId: "a", prompt: "p" }]);
	run.steps[0].status = "in_progress";
	run.steps[0].attempts = 1;
	await runLoop("/repo", run, deps(fakeSpawn([{ code: 0 }])));
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].status, "completed");
});
