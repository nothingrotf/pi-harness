import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendProgress, type EndFeatureRunPayload, handoffOutcome, latestHandoff, recordHandoff, runDir } from "../src/handoff.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-handoff-"));
}

function payload(over: Partial<EndFeatureRunPayload> = {}): EndFeatureRunPayload {
	return {
		taskId: "T1",
		workerSessionId: "ws-1",
		successState: "success",
		returnToOrchestrator: false,
		validatorsPassed: true,
		handoff: {
			whatWasImplemented: "Implemented the thing with enough detail to be meaningful.",
			whatWasLeftUndone: "",
			verification: { commandsRun: [{ command: "npm test", exitCode: 0, observation: "all green" }] },
		},
		...over,
	};
}

test("recordHandoff: grava handoffs/<task>__<wsid>.json + append no transcripts", () => {
	const d = tmp();
	const file = recordHandoff(d, "feat-x", payload(), () => "2026-06-29T00:00:00.000Z");
	assert.ok(fs.existsSync(file));
	assert.match(path.basename(file), /^T1__ws-1\.json$/);
	const rec = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.equal(rec.successState, "success");
	assert.equal(rec.recordedAt, "2026-06-29T00:00:00.000Z");
	const transcripts = fs.readFileSync(path.join(runDir(d, "feat-x"), "worker-transcripts.jsonl"), "utf8").trim();
	assert.match(transcripts, /"workerSessionId":"ws-1"/);
	assert.match(transcripts, /"taskId":"T1"/);
});

test("latestHandoff: pega o mais recente por tentativa (wsid distinto)", () => {
	const d = tmp();
	recordHandoff(d, "feat-x", payload({ workerSessionId: "ws-1", successState: "failure" }));
	// segunda tentativa, mais nova
	const f2 = recordHandoff(d, "feat-x", payload({ workerSessionId: "ws-2", successState: "success" }));
	// garante mtime maior no segundo
	const future = Date.now() / 1000 + 5;
	fs.utimesSync(f2, future, future);
	const latest = latestHandoff(d, "feat-x", "T1");
	assert.equal(latest?.workerSessionId, "ws-2");
	assert.equal(latest?.successState, "success");
});

test("handoffOutcome: success do successState; sem handoff → false", () => {
	const d = tmp();
	assert.deepEqual(handoffOutcome(d, "feat-x", "T1"), { success: false, returnToOrchestrator: false });

	recordHandoff(d, "feat-x", payload({ successState: "success", returnToOrchestrator: false }));
	assert.deepEqual(handoffOutcome(d, "feat-x", "T1"), { success: true, returnToOrchestrator: false });

	recordHandoff(d, "feat-x", payload({ taskId: "T2", successState: "failure", returnToOrchestrator: true }));
	assert.deepEqual(handoffOutcome(d, "feat-x", "T2"), { success: false, returnToOrchestrator: true });
});

test("handoffOutcome: partial não conta como success", () => {
	const d = tmp();
	recordHandoff(d, "feat-x", payload({ successState: "partial" }));
	assert.equal(handoffOutcome(d, "feat-x", "T1").success, false);
});

test("handoffOutcome com wsid: lê SÓ a tentativa exata (regressão: success stale de tentativa anterior completava um crash)", () => {
	const d = tmp();
	// tentativa 1 (ws-a) terminou com success
	recordHandoff(d, "feat-x", payload({ workerSessionId: "ws-a", successState: "success" }));
	// tentativa 2 (ws-b) crashou SEM EndFeatureRun — não pode herdar o success da ws-a
	assert.deepEqual(handoffOutcome(d, "feat-x", "T1", "ws-b"), { success: false, returnToOrchestrator: false }, "sem handoff da ws-b → failure");
	// a própria ws-a continua legível
	assert.equal(handoffOutcome(d, "feat-x", "T1", "ws-a").success, true);
	// sem wsid mantém o comportamento histórico (mais recente)
	assert.equal(handoffOutcome(d, "feat-x", "T1").success, true);
});

test("recordHandoff: emite evento determinístico no progress_log.jsonl (durabilidade nativa)", () => {
	const d = tmp();
	recordHandoff(d, "feat-x", payload({ successState: "success" }));
	recordHandoff(d, "feat-x", payload({ taskId: "T2", workerSessionId: "ws2", successState: "failure", returnToOrchestrator: true }));
	const log = fs.readFileSync(path.join(runDir(d, "feat-x"), "progress_log.jsonl"), "utf8").trim();
	assert.match(log, /"event":"task_completed"/);
	assert.match(log, /"event":"task_returned"/);
});

test("appendProgress: append-only com timestamp", () => {
	const d = tmp();
	appendProgress(d, "feat-x", "plan_stored", { tasks: 3 }, () => "2026-06-29T00:00:00.000Z");
	const log = fs.readFileSync(path.join(runDir(d, "feat-x"), "progress_log.jsonl"), "utf8").trim();
	assert.match(log, /"event":"plan_stored"/);
	assert.match(log, /"tasks":3/);
	assert.match(log, /"ts":"2026-06-29T00:00:00.000Z"/);
});
