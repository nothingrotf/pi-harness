import { test } from "node:test";
import assert from "node:assert/strict";
import { injectShipGate, planFeatureRun } from "../src/feature-runner.ts";
import type { PersistedHandoff } from "../src/handoff.ts";
import { applyResumeMode, buildRunReport, insertFixTasks } from "../src/run-control.ts";

const NOW = () => "2026-07-02T00:00:00.000Z";

function pausedRun() {
	const run = planFeatureRun("feat-x", [{ id: "T1", skillName: "w", fulfills: ["A1"] }], NOW);
	run.status = "paused";
	run.pauseReason = "aborted";
	run.steps[0].status = "in_progress";
	run.steps[0].attempts = 2;
	run.steps[0].workerSessionIds = ["ws_a", "ws_b"];
	return run;
}

test("applyResumeMode: default preserva o baseResume (graceful×hard do disco)", () => {
	const run = pausedRun();
	assert.deepEqual(applyResumeMode(run, true), { resume: true });
	assert.equal(run.steps[0].status, "in_progress", "não mexe no run");
	assert.deepEqual(applyResumeMode(run, false), { resume: false });
});

test("applyResumeMode: restartFeature → requeue (in_progress→pending) e resume:false (droid TDT)", () => {
	const run = pausedRun();
	const m = applyResumeMode(run, true, { restartFeature: true });
	assert.equal(m.resume, false);
	assert.equal(run.steps[0].status, "pending", "step requeued — worker novo do zero");
	assert.match(m.note ?? "", /requeued/);
});

test("applyResumeMode: resumeWorkerSessionId re-attacha a sessão ESCOLHIDA (vira a última)", () => {
	const run = pausedRun();
	const m = applyResumeMode(run, false, { resumeWorkerSessionId: "ws_a" });
	assert.equal(m.resume, true, "seleção explícita força re-attach");
	assert.equal(run.steps[0].status, "in_progress");
	assert.deepEqual(run.steps[0].workerSessionIds, ["ws_b", "ws_a"], "a escolhida vira .at(-1) — o runLoop a re-attacha");
});

test("applyResumeMode: resumeWorkerSessionId de step COMPLETED → recusa regredir (regressão: re-executava trabalho commitado)", () => {
	const run = pausedRun();
	run.steps[0].status = "completed";
	const m = applyResumeMode(run, false, { resumeWorkerSessionId: "ws_a" });
	assert.equal(m.resume, false, "não re-attacha");
	assert.equal(run.steps[0].status, "completed", "step concluído fica concluído");
	assert.match(m.note ?? "", /refusing to regress/);
});

test("applyResumeMode: resumeWorkerSessionId desconhecido → degrada pro default com nota", () => {
	const run = pausedRun();
	const m = applyResumeMode(run, false, { resumeWorkerSessionId: "ws_ghost" });
	assert.equal(m.resume, false);
	assert.match(m.note ?? "", /not found/);
});

test("insertFixTasks: insere acima do ship gate, dedup por id existente", () => {
	const run = planFeatureRun("feat-x", [{ id: "T1", skillName: "w", fulfills: ["A1"] }], NOW);
	run.steps[0].status = "completed";
	injectShipGate(run);
	const inserted = insertFixTasks(run, [
		{ id: "FIX1", skillName: "w" },
		{ id: "FIX1", skillName: "w" }, // duplicada na mesma chamada
		{ id: "implement", skillName: "w" }, // id de step já existente
		{ id: "", skillName: "w" }, // inválida
	]);
	assert.deepEqual(inserted, ["FIX1"]);
	const idxFix = run.steps.findIndex((s) => s.id === "FIX1");
	const idxGate = run.steps.findIndex((s) => s.kind === "ship-gate");
	assert.ok(idxFix >= 0 && idxFix < idxGate, "fix entra antes do gate");
});

test("buildRunReport: status + steps + handoff de step não-completo + next action por status", () => {
	const run = pausedRun();
	run.status = "orchestrator_turn";
	run.pauseReason = undefined;
	run.steps[0].status = "pending";
	const h: PersistedHandoff = {
		taskId: "implement",
		workerSessionId: "ws_b",
		successState: "failure",
		returnToOrchestrator: true,
		validatorsPassed: false,
		handoff: {
			salientSummary: "migration blocked on schema drift",
			whatWasImplemented: "partial migration",
			whatWasLeftUndone: "rollback path",
			verification: { commandsRun: [] },
			discoveredIssues: [{ severity: "blocking", description: "schema drift" }],
		},
		recordedAt: NOW(),
	};
	const report = buildRunReport(run, new Map([["implement", h]]), { note: "n", insertedFixTasks: ["FIX1"] });
	assert.match(report, /status=orchestrator_turn/);
	assert.match(report, /Fix tasks inserted above the gate: FIX1/);
	assert.match(report, /implement \[task\] attempts=2 lastWorkerSession=ws_b/);
	assert.match(report, /successState=failure returnToOrchestrator=true/);
	assert.match(report, /migration blocked on schema drift/);
	assert.match(report, /leftUndone: rollback path/);
	assert.match(report, /issue \[blocking\]: schema drift/);
	assert.match(report, /call run_feature again/);

	run.status = "completed";
	assert.match(buildRunReport(run, new Map()), /verify status\.json/);
	run.status = "paused";
	run.pauseReason = "usage_limit";
	assert.match(buildRunReport(run, new Map()), /usage\/billing limit/);
	run.pauseReason = "step_retry_limit_exceeded";
	assert.match(buildRunReport(run, new Map()), /budget exhausted/);
	run.pauseReason = "aborted";
	assert.match(buildRunReport(run, new Map()), /resumeWorkerSessionId/);
});
