import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	activeItem,
	assertionCounts,
	buildControlModel,
	buildTaskRows,
	buildWorkerRows,
	type ControlModel,
	coverageRows,
	deriveRunState,
	deriveTaskStatuses,
	activeElapsedMs,
	apportion,
	formatDuration,
	formatProgressEntry,
	progressSegments,
	type ProgressRaw,
	gateDoneCount,
	progressBar,
	progressCounts,
	readControlModel,
	relTime,
	runState,
	stripParts,
	stateIcon,
	stateLabel,
	taskIcon,
} from "../src/control-model.ts";
import type { Plan, PlanStatus } from "../src/plan.ts";
import { buildFeatureRun, storePlan, writeFeatureRun } from "../src/plan.ts";
import type { FeatureRun } from "../src/feature-runner.ts";
import { type PersistedHandoff, appendProgress, recordHandoff } from "../src/handoff.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-control-"));
}

function plan(over: Partial<Plan> = {}): Plan {
	return {
		featureId: "feat-x",
		assertions: ["A1", "A2", "A3"],
		tasks: [
			{ id: "T1", description: "foundation", skillName: "backend-worker", fulfills: [] },
			{ id: "T2", description: "endpoint", skillName: "backend-worker", fulfills: ["A1", "A2"] },
			{ id: "T3", description: "ui", skillName: "frontend-worker", fulfills: ["A3"] },
		],
		createdAt: "2026-06-29T00:00:00.000Z",
		...over,
	};
}

function run(steps: FeatureRun["steps"], over: Partial<FeatureRun> = {}): FeatureRun {
	return {
		runId: "ftr_1",
		featureId: "feat-x",
		status: "running",
		steps,
		gateInjected: false,
		createdAt: "2026-06-29T00:00:00.000Z",
		updatedAt: "2026-06-29T00:00:00.000Z",
		...over,
	};
}

function cmodel(over: Partial<ControlModel> = {}): ControlModel {
	return { featureId: "f", exists: true, state: "running", activeMs: null, counts: { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 }, gateInjected: false, assertions: { passed: 0, failed: 0, pending: 0, total: 0 }, tasks: [], tasksDone: 0, tasksTotal: 0, active: null, workers: [], handoffsRaw: [], progress: [], coverage: [], ...over };
}

function okHandoff(taskId: string, recordedAt: string, over: Partial<PersistedHandoff> = {}): PersistedHandoff {
	return { taskId, workerSessionId: `w-${taskId}`, successState: "success", returnToOrchestrator: false, validatorsPassed: true, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } }, recordedAt, ...over };
}

test("stripParts: barra dos counts (work items) — ratio completed/total + [+N]; soma=width", () => {
	const p = stripParts(cmodel({ counts: { completed: 4, pending: 2, estimate: 2, cancelled: 0, total: 8 } }), 20);
	assert.equal(p.ratio, "4/8");
	assert.equal(p.estimate, 2);
	assert.equal(p.bar.filled.length + p.bar.pending.length + p.bar.estimate.length, 20, "3 segmentos somam barWidth");
	assert.ok(p.bar.filled.length > 0);
});

test("apportion: Hamilton — soma=width, min-1 sliver, tudo ░ quando vazio (Droid §4/§8)", () => {
	// Droid §8 worked example: {3,3,4} em 20 → [6,6,8]
	const ex = apportion({ completed: 3, pending: 3, estimate: 4 }, 20);
	assert.deepEqual([ex.completed, ex.pending, ex.estimate], [6, 6, 8]);
	// min-1 sliver: 1 de 50 ainda pinta ≥1 char
	const sliver = apportion({ completed: 1, pending: 49, estimate: 0 }, 20);
	assert.ok(sliver.completed >= 1, "completed não-zero → ≥1 char (sem sliver invisível)");
	assert.equal(sliver.completed + sliver.pending + sliver.estimate, 20);
	// nada começou → barra toda ░ estimate
	assert.deepEqual(apportion({ completed: 0, pending: 0, estimate: 0 }, 12), { completed: 0, pending: 0, estimate: 12 });
});

test("progressCounts: denominador CONSTANTE (tasks+gate−cancelled) → monotônico; gate ░→▒→█", () => {
	const tasks = (done: number, total = 6) => Array.from({ length: total }, (_, i) => ({ id: `T${i}`, skillName: "w", fulfills: [], description: "", preconditions: [], expectedBehavior: [], status: i < done ? "completed" : "pending", active: false }) as ControlModel["tasks"][number]);
	// converge: 0 tasks done, gate ainda estimate (░)
	const c0 = progressCounts({ tasks: tasks(0), gateSteps: 2, gateMaterialized: false, gateDone: 0 });
	assert.deepEqual([c0.completed, c0.pending, c0.estimate, c0.total], [0, 6, 2, 8]);
	// 4 tasks done
	const c4 = progressCounts({ tasks: tasks(4), gateSteps: 2, gateMaterialized: false, gateDone: 0 });
	assert.deepEqual([c4.completed, c4.pending, c4.estimate, c4.total], [4, 2, 2, 8]);
	// todas as tasks → gate materializa (░→▒), denominador IGUAL (8), sem salto
	const c6 = progressCounts({ tasks: tasks(6), gateSteps: 2, gateMaterialized: true, gateDone: 0 });
	assert.deepEqual([c6.completed, c6.pending, c6.estimate, c6.total], [6, 2, 0, 8]);
	// gate completo → 8/8
	const c8 = progressCounts({ tasks: tasks(6), gateSteps: 2, gateMaterialized: true, gateDone: 2 });
	assert.deepEqual([c8.completed, c8.pending, c8.estimate, c8.total], [8, 0, 0, 8]);
});

test("progressCounts: gate concluído implica materializado (sem double-count) e `complete`→barra cheia", () => {
	const mk = (status: ControlModel["tasks"][number]["status"], id: string) => ({ id, skillName: "w", fulfills: [], description: "", preconditions: [], expectedBehavior: [], status, active: false }) as ControlModel["tasks"][number];
	// Regressão do "7/9": T1 returned (não-terminal) + T2..T6 done, assertions todas passed → gateDone 2,
	// mas gateMaterialized=false. gateDone>0 deve materializar o gate → denominador 8 (não 9).
	const stuck = [mk("returned", "T1"), ...Array.from({ length: 5 }, (_, i) => mk("completed", `T${i + 2}`))];
	const noFlag = progressCounts({ tasks: stuck, gateSteps: 2, gateMaterialized: false, gateDone: 2 });
	assert.deepEqual([noFlag.completed, noFlag.pending, noFlag.estimate, noFlag.total], [7, 1, 0, 8], "gateDone>0 ⇒ materializado: total 8, sem ░ residual");
	// Com o run em `completed` (contrato satisfeito) a barra fica CHEIA — a task returned superada não trava < 100%.
	const done = progressCounts({ tasks: stuck, gateSteps: 2, gateMaterialized: false, gateDone: 2, complete: true });
	assert.deepEqual([done.completed, done.pending, done.estimate, done.total], [8, 0, 0, 8], "complete → 8/8 cheio");
	assert.equal(stripParts(cmodel({ state: "completed", counts: done }), 20).ratio, "8/8", "faixa: completed mostra 8/8, nunca 7/9");
});

test("gateDoneCount: handoffs ship-gate-* success, ou assertions todas passed", () => {
	const h = (taskId: string, ss: "success" | "failure"): PersistedHandoff => ({ taskId, workerSessionId: "w", successState: ss, returnToOrchestrator: false, validatorsPassed: ss === "success", handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } }, recordedAt: "t" });
	assert.equal(gateDoneCount([h("ship-gate-code-review", "success")], null, 2), 1);
	assert.equal(gateDoneCount([], { featureId: "f", assertions: { A1: "passed", A2: "passed" } }, 2), 2, "todas passed → gate completo");
	assert.equal(gateDoneCount([], { featureId: "f", assertions: { A1: "passed", A2: "pending" } }, 2), 0);
});

test("activeElapsedMs: Σ intervalos run→pause, pausas EXCLUÍDAS (doc 11 §5)", () => {
	const log = [
		{ event: "run_started", ts: "2026-06-30T00:00:00.000Z" },
		{ event: "step_paused", ts: "2026-06-30T00:10:00.000Z" }, // 10min ativos
		{ event: "run_resumed", ts: "2026-06-30T00:30:00.000Z" }, // 20min pausado (excluído)
	];
	// estado ativo → intervalo aberto corre até now (+5min) = 15min ativos
	const ms = activeElapsedMs("running", log, Date.parse("2026-06-30T00:35:00.000Z"));
	assert.equal(ms, 15 * 60_000, "10min + 5min ativos; 20min pausado não conta");
	assert.equal(activeElapsedMs("ready", [], 0), null, "sem run_started → null");
});

test("formatDuration: s / m / h", () => {
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(134_000), "2m 14s");
	assert.equal(formatDuration(3_780_000), "1h 03m");
	assert.equal(formatDuration(undefined), "");
	assert.equal(formatDuration(-5), "");
});

test("buildWorkerRows: #n por ordem de início + duração (start=task_started → end=handoff)", () => {
	const progress = [
		{ event: "task_started", taskId: "T1", ts: "2026-06-29T00:00:00.000Z" },
		{ event: "task_started", taskId: "T2", ts: "2026-06-29T00:06:00.000Z" },
	];
	const rows = buildWorkerRows(null, [okHandoff("T1", "2026-06-29T00:05:00.000Z"), okHandoff("T2", "2026-06-29T00:12:00.000Z")], progress, Date.parse("2026-06-29T00:20:00.000Z"));
	const byTask = Object.fromEntries(rows.map((r) => [r.taskId, r]));
	assert.equal(byTask.T1.workerNumber, 1, "T1 começou primeiro → #1");
	assert.equal(byTask.T2.workerNumber, 2);
	assert.equal(byTask.T1.durationMs, 5 * 60_000, "T1: 00:00→00:05 = 5min");
	assert.equal(byTask.T2.durationMs, 6 * 60_000, "T2: 00:06→00:12 = 6min");
});

test("buildControlModel: a screenshot EXATA (T1 returned + T2-T5 done, sem task_started) fica coerente", () => {
	const handoffs: PersistedHandoff[] = [
		okHandoff("T1", "2026-06-30T06:00:00.000Z", { successState: "partial", returnToOrchestrator: true, validatorsPassed: false }),
		okHandoff("T2", "2026-06-30T06:10:00.000Z"),
		okHandoff("T3", "2026-06-30T06:20:00.000Z"),
		okHandoff("T4", "2026-06-30T06:35:00.000Z"),
		okHandoff("T5", "2026-06-30T07:50:00.000Z"),
	];
	const p: Plan = { featureId: "feat-x", createdAt: "2026-06-30T05:00:00.000Z", assertions: ["A1", "A2", "A3"], tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `T${n}`, description: `t${n}`, skillName: "w", fulfills: [] })) };
	const m = buildControlModel({ featureId: "feat-x", plan: p, status: { featureId: "feat-x", assertions: { A1: "pending", A2: "pending", A3: "pending" } }, run: null, handoffs, progressRaw: [{ event: "run_started", ts: "2026-06-30T05:55:00.000Z" }, { event: "task_returned", taskId: "T1" }], now: Date.parse("2026-06-30T08:00:00.000Z") });
	assert.equal(m.state, "orchestrator_turn");
	assert.equal(m.tasks.find((t) => t.id === "T1")?.status, "returned", "T1 → ↩ (não o falso ●)");
	assert.equal(m.tasksDone, 4, "T2-T5 completas = 4/6");
	assert.equal(m.active, null, "sem worker vivo → edge state-aware (não 'Waiting to start')");
	assert.equal(stripParts(m, 20).ratio, "4/8", "work items = 6 tasks + 2 ship gate; 4 done → 4/8 (não 0/3 assertions)");
	assert.equal(stripParts(m, 20).estimate, 2, "ship gate ainda não materializado (T6 pending) → ░ [+2]");
	assert.equal(m.startedAt, "2026-06-30T05:55:00.000Z", "startedAt = primeiro run_started");
});

// ─── barra de progresso ──────────────────────────────────────────────────────

test("progressBar: 3 segmentos somam width; largura mín 10; vazio → tudo ░", () => {
	const b = progressBar({ completed: 4, pending: 2, estimate: 2 }, 24);
	assert.equal(b.filled.length + b.pending.length + b.estimate.length, 24);
	assert.equal(b.completed, 4);
	assert.equal(b.total, 8);

	const full = progressBar({ completed: 8, pending: 0, estimate: 0 }, 20);
	assert.equal(full.pending.length + full.estimate.length, 0, "tudo █ quando só completed");

	const empty = progressBar({ completed: 0, pending: 0, estimate: 0 }, 24);
	assert.equal(empty.filled.length + empty.pending.length, 0);
	assert.equal(empty.estimate.length, 24, "nada → barra toda ░ (sem divisão por zero)");

	assert.equal(progressBar({ completed: 3, pending: 1, estimate: 0 }, 4).width, 10, "largura forçada ao mínimo 10");
});

// ─── estado ──────────────────────────────────────────────────────────────────

test("runState/stateIcon/stateLabel: null → unknown; mapeia o status do run", () => {
	assert.equal(runState(null), "unknown");
	assert.equal(runState(run([], { status: "paused" })), "paused");
	assert.equal(stateIcon("running"), "●");
	assert.equal(stateIcon("paused"), "⏸");
	assert.equal(stateIcon("completed"), "✓");
	assert.equal(stateIcon("orchestrator_turn"), "◑");
	assert.equal(stateLabel("orchestrator_turn"), "Orch. Turn");
	assert.equal(stateIcon("ready"), "◆");
	assert.equal(stateLabel("ready"), "Ready");
});

test("deriveRunState: caminho NATIVO (sem feature-run.json) deriva dos sinais em disco", () => {
	const pending: PlanStatus = { featureId: "feat-x", assertions: { A1: "pending", A2: "pending" } };
	const passed: PlanStatus = { featureId: "feat-x", assertions: { A1: "passed", A2: "passed" } };
	const ok: PersistedHandoff = { taskId: "T1", workerSessionId: "w1", successState: "success", returnToOrchestrator: false, validatorsPassed: true, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } }, recordedAt: "t" };
	// plan FROZEN, nada começou → ready (NÃO "unknown" — era o bug)
	assert.equal(deriveRunState({ run: null, status: pending }), "ready");
	assert.equal(deriveRunState({ run: null, status: pending, progressRaw: [{ event: "plan_stored" }] }), "ready");
	// run_started no log → running (caminho nativo, antes de qualquer handoff)
	assert.equal(deriveRunState({ run: null, status: pending, progressRaw: [{ event: "plan_stored" }, { event: "run_started" }] }), "running");
	// task_started (worker dispatched no nativo) sozinho já conta como running
	assert.equal(deriveRunState({ run: null, status: pending, progressRaw: [{ event: "plan_stored" }, { event: "task_started", taskId: "T2" }] }), "running");
	// handoff de sucesso presente, ainda não tudo passed → running
	assert.equal(deriveRunState({ run: null, status: pending, handoffs: [ok] }), "running");
	// handoff returnToOrchestrator → orchestrator_turn
	assert.equal(deriveRunState({ run: null, status: pending, handoffs: [{ ...ok, successState: "partial", returnToOrchestrator: true }] }), "orchestrator_turn");
	// todas as assertions passed → completed
	assert.equal(deriveRunState({ run: null, status: passed, handoffs: [ok] }), "completed");
	// feature-run.json (headless) é autoritativo, ignora os outros sinais
	assert.equal(deriveRunState({ run: run([], { status: "paused" }), status: passed }), "paused");
});

test("buildControlModel: plan stored mas run não começou → state ready (não unknown)", () => {
	const m = buildControlModel({ featureId: "feat-x", plan: plan(), status: { featureId: "feat-x", assertions: { A1: "pending", A2: "pending", A3: "pending" } }, run: null, handoffs: [], progressRaw: [{ event: "plan_stored" }], now: Date.now() });
	assert.equal(m.state, "ready");
});

// ─── tasks ───────────────────────────────────────────────────────────────────

test("buildTaskRows: junta descrição (plan) com status (run) e marca o ativo", () => {
	const r = run([
		{ id: "T1", kind: "task", skillName: "backend-worker", status: "completed", attempts: 1 },
		{ id: "T2", kind: "task", skillName: "backend-worker", status: "in_progress", attempts: 1, fulfills: ["A1", "A2"] },
		{ id: "T3", kind: "task", skillName: "frontend-worker", status: "pending", attempts: 0 },
	]);
	const rows = buildTaskRows(plan(), r);
	assert.equal(rows.length, 3);
	assert.deepEqual(
		rows.map((x) => [x.id, x.status, x.active]),
		[
			["T1", "completed", false],
			["T2", "in_progress", true],
			["T3", "pending", false],
		],
	);
	assert.equal(rows[1].description, "endpoint");
	assert.deepEqual(rows[1].fulfills, ["A1", "A2"]);
	assert.equal(taskIcon("completed"), "✓");
	assert.equal(taskIcon("cancelled"), "✗");
});

test("buildTaskRows: sem run → todas pending; sem plan → []", () => {
	assert.deepEqual(buildTaskRows(null, null), []);
	const rows = buildTaskRows(plan(), null);
	assert.ok(rows.every((r) => r.status === "pending" && !r.active));
});

test("deriveTaskStatuses: handoffs + progress_log → status por task (handoff vence)", () => {
	const ok: PersistedHandoff = { taskId: "T1", workerSessionId: "w1", successState: "success", returnToOrchestrator: true, validatorsPassed: true, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } }, recordedAt: "2026-06-29T00:02:00.000Z" };
	const m = deriveTaskStatuses(
		[ok],
		[
			{ event: "task_started", taskId: "T1" }, // sobreposto pelo handoff success
			{ event: "task_returned", taskId: "T2" }, // returned → ↩ (bounce ao orquestrador)
			{ event: "task_started", taskId: "T3" }, // started sem terminal → in_progress
			{ event: "task_failed", taskId: "T4" }, // failed → cancelled
		],
	);
	assert.equal(m.get("T1"), "completed");
	assert.equal(m.get("T2"), "returned");
	assert.equal(m.get("T3"), "in_progress");
	assert.equal(m.get("T4"), "cancelled");
	assert.equal(m.get("T9"), undefined, "sem sinal → ausente (pending no caller)");
});

test("buildTaskRows: caminho NATIVO (run=null) deriva status dos handoffs + progress_log", () => {
	const h: PersistedHandoff = { taskId: "T1", workerSessionId: "w1", successState: "partial", returnToOrchestrator: true, validatorsPassed: false, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "more", verification: { commandsRun: [] } }, recordedAt: "2026-06-29T00:02:00.000Z" };
	// reproduz a screenshot: T1 voltou pro orquestrador, T2 acabou de spawnar
	const rows = buildTaskRows(plan(), null, { handoffs: [h], progressRaw: [{ event: "task_returned", taskId: "T1" }, { event: "task_started", taskId: "T2" }] });
	assert.deepEqual(
		rows.map((r) => [r.id, r.status]),
		[
			["T1", "returned"],
			["T2", "in_progress"],
			["T3", "pending"],
		],
		"T1 returned vira ↩ (não o falso ● in_progress, era o bug); T3 sem sinal continua pending",
	);
});

// ─── item ativo ──────────────────────────────────────────────────────────────

test("buildTaskRows: handoff de SUCESSO do impl step marca TODAS as tasks completas (backstop 357, git-free)", () => {
	const implH: PersistedHandoff = { taskId: "implement", workerSessionId: "w", successState: "success", returnToOrchestrator: false, validatorsPassed: true, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } }, recordedAt: "z" };
	assert.ok(buildTaskRows(plan(), null, { handoffs: [implH] }).every((r) => r.status === "completed"), "impl-success → todas completed");
	// impl-success NÃO sobrepõe um cancelled explícito.
	const rows = buildTaskRows(plan(), null, { handoffs: [implH], progressRaw: [{ event: "task_failed", taskId: "T2" }] });
	assert.equal(rows.find((r) => r.id === "T2")?.status, "cancelled");
});

test("activeItem: prefere in_progress; senão o próximo pending se running; null sem run", () => {
	assert.equal(activeItem(plan(), null), null);
	const inProg = activeItem(
		plan(),
		run([
			{ id: "T1", kind: "task", skillName: "w", status: "completed", attempts: 1 },
			{ id: "T2", kind: "task", skillName: "w", status: "in_progress", attempts: 1 },
		]),
	);
	assert.equal(inProg?.id, "T2");
	assert.equal(inProg?.kind, "task");
	assert.equal(inProg?.label, "endpoint", "label = descrição da task");

	const nextPending = activeItem(
		plan(),
		run([
			{ id: "T1", kind: "task", skillName: "w", status: "completed", attempts: 1 },
			{ id: "T2", kind: "task", skillName: "w", status: "pending", attempts: 0 },
		]),
	);
	assert.equal(nextPending?.id, "T2");
});

test("activeItem: ship-gate em progresso vira item kind ship-gate (label = skillName)", () => {
	const a = activeItem(
		plan(),
		run([
			{ id: "T1", kind: "task", skillName: "w", status: "completed", attempts: 1 },
			{ id: "ship-gate-code-review", kind: "ship-gate", skillName: "harness-code-review", status: "in_progress", attempts: 1 },
		]),
	);
	assert.equal(a?.kind, "ship-gate");
	assert.equal(a?.label, "harness-code-review");
});

test("activeItem: caminho NATIVO → a task com task_started mais recente sem terminal posterior", () => {
	// só T2 started, sem terminal → ativo T2 (com label/skill do plano)
	const a = activeItem(plan(), null, { progressRaw: [{ event: "task_returned", taskId: "T1" }, { event: "task_started", taskId: "T2" }] });
	assert.equal(a?.id, "T2");
	assert.equal(a?.kind, "task");
	assert.equal(a?.label, "endpoint");
	// um terminal posterior pro mesmo id limpa o ativo
	assert.equal(activeItem(plan(), null, { progressRaw: [{ event: "task_started", taskId: "T2" }, { event: "task_completed", taskId: "T2" }] }), null);
	// ship-gate started → kind ship-gate derivado do id
	const g = activeItem(plan(), null, { progressRaw: [{ event: "task_started", taskId: "ship-gate-qa-validator" }] });
	assert.equal(g?.kind, "ship-gate");
	assert.equal(g?.skillName, "harness-qa-validator");
	// sem sinal nenhum → null
	assert.equal(activeItem(plan(), null, {}), null);
});

test("buildControlModel: NATIVO reproduz a screenshot (T1 returned + T2 a correr) → destaque único em T2", () => {
	const h: PersistedHandoff = { taskId: "T1", workerSessionId: "w1", successState: "partial", returnToOrchestrator: true, validatorsPassed: false, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "more", verification: { commandsRun: [] } }, recordedAt: "2026-06-29T00:02:00.000Z" };
	const m = buildControlModel({
		featureId: "feat-x",
		plan: plan(),
		status: { featureId: "feat-x", assertions: { A1: "pending", A2: "pending", A3: "pending" } },
		run: null,
		handoffs: [h],
		progressRaw: [{ event: "plan_stored" }, { event: "run_started" }, { event: "task_returned", taskId: "T1" }, { event: "task_started", taskId: "T2" }],
		now: Date.now(),
	});
	assert.equal(m.state, "orchestrator_turn", "T1 returned → ◑ Orch. Turn");
	assert.equal(m.active?.id, "T2", "Active Task = o worker vivo (T2), não 'Waiting'");
	// T1 returned vira ↩ (não o falso ● in_progress); destaque ÚNICO em T2 (o worker vivo).
	assert.deepEqual(m.tasks.map((t) => [t.id, t.status, t.active]), [
		["T1", "returned", false],
		["T2", "in_progress", true],
		["T3", "pending", false],
	]);
});

// ─── assertions + coverage ───────────────────────────────────────────────────

test("assertionCounts: passed/failed/pending/total", () => {
	const status: PlanStatus = { featureId: "feat-x", assertions: { A1: "passed", A2: "failed", A3: "pending" } };
	assert.deepEqual(assertionCounts(status), { passed: 1, failed: 1, pending: 1, total: 3 });
	assert.deepEqual(assertionCounts(null), { passed: 0, failed: 0, pending: 0, total: 0 });
});

test("coverageRows: cada assertion → a task que a fulfills + status", () => {
	const status: PlanStatus = { featureId: "feat-x", assertions: { A1: "passed", A2: "pending", A3: "failed" } };
	const rows = coverageRows(plan(), status);
	assert.deepEqual(rows, [
		{ assertion: "A1", taskId: "T2", status: "passed" },
		{ assertion: "A2", taskId: "T2", status: "pending" },
		{ assertion: "A3", taskId: "T3", status: "failed" },
	]);
	// assertion órfã (sem task) → taskId null, status default pending
	const rows2 = coverageRows(plan({ assertions: ["A1", "A9"], tasks: [{ id: "T1", description: "x", skillName: "w", fulfills: ["A1"] }] }), null);
	assert.deepEqual(rows2.find((r) => r.assertion === "A9"), { assertion: "A9", taskId: null, status: "pending" });
});

// ─── workers ─────────────────────────────────────────────────────────────────

test("buildWorkerRows: 1 por handoff (status mapeado) + step ativo running, mais recente primeiro", () => {
	const handoffs: PersistedHandoff[] = [
		{ taskId: "T1", workerSessionId: "ws1", successState: "success", returnToOrchestrator: false, validatorsPassed: true, handoff: { whatWasImplemented: "x", whatWasLeftUndone: "", verification: { commandsRun: [] } }, recordedAt: "2026-06-29T00:01:00.000Z" },
		{ taskId: "T2", workerSessionId: "ws2", successState: "failure", returnToOrchestrator: true, validatorsPassed: false, handoff: { whatWasImplemented: "y", whatWasLeftUndone: "z", verification: { commandsRun: [] } }, recordedAt: "2026-06-29T00:02:00.000Z" },
	];
	const r = run([{ id: "T3", kind: "task", skillName: "w", status: "in_progress", attempts: 1 }]);
	const rows = buildWorkerRows(r, handoffs);
	assert.equal(rows[0].status, "running", "step ativo (running) vem primeiro");
	assert.equal(rows[0].taskId, "T3");
	const ws1 = rows.find((x) => x.workerSessionId === "ws1");
	const ws2 = rows.find((x) => x.workerSessionId === "ws2");
	assert.equal(ws1?.status, "success");
	assert.equal(ws2?.status, "returned", "failure + returnToOrchestrator → returned");
});

// ─── progress log ────────────────────────────────────────────────────────────

test("relTime: just now / m / h / d", () => {
	const now = Date.parse("2026-06-29T12:00:00.000Z");
	assert.equal(relTime("2026-06-29T11:59:30.000Z", now), "just now");
	assert.equal(relTime("2026-06-29T11:55:00.000Z", now), "5m");
	assert.equal(relTime("2026-06-29T09:00:00.000Z", now), "3h");
	assert.equal(relTime("2026-06-26T12:00:00.000Z", now), "3d");
	assert.equal(relTime(undefined, now), "");
	assert.equal(relTime("lixo", now), "");
});

test("formatProgressEntry: mapeia os eventos do runner/handoff/store", () => {
	assert.equal(formatProgressEntry({ event: "plan_stored", tasks: 8, assertions: 12 }), "plan stored: 8 tasks / 12 assertions");
	assert.equal(formatProgressEntry({ event: "step_started", id: "T2", attempt: 2 }), "T2 started (attempt 2)");
	assert.equal(formatProgressEntry({ event: "step_completed", id: "T1" }), "T1 completed ✓");
	assert.equal(formatProgressEntry({ event: "step_returned", id: "T2", returnToOrchestrator: true }), "T2 returned → orchestrator");
	assert.equal(formatProgressEntry({ event: "ship_gate_injected" }), "ship gate injected (code-review → qa-validator)");
	assert.equal(formatProgressEntry({ event: "task_started", taskId: "T2" }), "task T2 started");
	assert.equal(formatProgressEntry({ event: "task_completed", taskId: "T1" }), "task T1 completed ✓");
	assert.equal(formatProgressEntry({ event: "task_failed", taskId: "T2" }), "task T2 failed");
	assert.equal(formatProgressEntry({ event: "mystery" }), "mystery");
});

test("progressSegments: join dos .text == formatProgressEntry; tons por estado (Enu analog)", () => {
	const evs: ProgressRaw[] = [
		{ event: "plan_stored", tasks: 8, assertions: 12 },
		{ event: "task_completed", taskId: "T1" },
		{ event: "task_returned", taskId: "T2" },
		{ event: "task_failed", taskId: "T3" },
		{ event: "task_started", taskId: "T4" },
		{ event: "mystery" },
	];
	for (const e of evs) assert.equal(progressSegments(e).map((s) => s.text).join(""), formatProgressEntry(e), `join == plain p/ ${e.event}`);
	// ícone ✓ de completed em success; id em accent; "returned" em warning; "failed" em error.
	const done = progressSegments({ event: "task_completed", taskId: "T1" });
	assert.ok(done.some((s) => s.text === "✓" && s.tone === "success"));
	assert.ok(done.some((s) => s.text === "T1" && s.tone === "accent"));
	assert.ok(progressSegments({ event: "task_returned", taskId: "T2" }).some((s) => s.tone === "warning"));
	assert.ok(progressSegments({ event: "task_failed", taskId: "T3" }).some((s) => s.tone === "error"));
});

// ─── modelo completo (puro) ──────────────────────────────────────────────────

test("buildControlModel: integra tudo a partir de inputs em memória", () => {
	const m = buildControlModel({
		featureId: "feat-x",
		plan: plan(),
		status: { featureId: "feat-x", assertions: { A1: "passed", A2: "pending", A3: "pending" } },
		run: run(
			[
				{ id: "T1", kind: "task", skillName: "w", status: "completed", attempts: 1 },
				{ id: "T2", kind: "task", skillName: "w", status: "in_progress", attempts: 1 },
				{ id: "T3", kind: "task", skillName: "w", status: "pending", attempts: 0 },
			],
			{ status: "running" },
		),
		handoffs: [],
		progressRaw: [{ ts: "2026-06-29T00:00:00.000Z", event: "plan_stored", tasks: 3, assertions: 3 }],
		now: Date.parse("2026-06-29T00:05:00.000Z"),
	});
	assert.equal(m.exists, true);
	assert.equal(m.state, "running");
	assert.deepEqual(m.assertions, { passed: 1, failed: 0, pending: 2, total: 3 });
	assert.equal(m.tasksDone, 1);
	assert.equal(m.tasksTotal, 3);
	assert.equal(m.active?.id, "T2");
	assert.equal(m.coverage.length, 3);
	assert.equal(m.progress[0].text, "plan stored: 3 tasks / 3 assertions");
	assert.equal(m.progress[0].rel, "5m");
});

// ─── faixa (stripParts) ──────────────────────────────────────────────────────

test("stripParts: barra dos counts; ativo = task/ship-gate/all done; live exceto completed", () => {
	const common = { featureId: "f", exists: true, activeMs: null, gateInjected: false, tasks: [], tasksDone: 1, tasksTotal: 4, assertions: { passed: 0, failed: 0, pending: 0, total: 0 }, workers: [], handoffsRaw: [], progress: [], coverage: [] } as const;

	const running = stripParts({ ...common, state: "running", counts: { completed: 3, pending: 3, estimate: 2, cancelled: 0, total: 8 }, active: { id: "T2", kind: "task", label: "x", skillName: "worker", fulfills: [] } }, 16);
	assert.equal(running.ratio, "3/8");
	assert.equal(running.estimate, 2);
	assert.equal(running.bar.filled.length + running.bar.pending.length + running.bar.estimate.length, 16);
	assert.equal(running.active, "task T2");
	assert.equal(running.live, true);

	const gate = stripParts({ ...common, state: "running", counts: { completed: 1, pending: 3, estimate: 0, cancelled: 0, total: 4 }, active: { id: "g", kind: "ship-gate", label: "l", skillName: "harness-qa-validator", fulfills: [] } }, 16);
	assert.equal(gate.ratio, "1/4");
	assert.equal(gate.active, "ship gate: qa-validator");

	const done = stripParts({ ...common, state: "completed", counts: { completed: 8, pending: 0, estimate: 0, cancelled: 0, total: 8 }, active: null }, 16);
	assert.equal(done.active, "all done");
	assert.equal(done.live, false);
	assert.equal(done.bar.pending.length + done.bar.estimate.length, 0);
});

// ─── IO: lê do disco ─────────────────────────────────────────────────────────

test("readControlModel: null sem plan; integra plan+run+handoff+progress do disco", () => {
	const d = tmp();
	assert.equal(readControlModel(d, "feat-x"), null, "sem plan → null");

	storePlan(d, plan()); // grava plan.json + status.json (pending) + plan_stored
	// 1 worker por feature: o impl step está in_progress; os sinais POR-TASK vêm do progress/handoffs
	// (o tool `next_task` grava as fronteiras), não de N steps. T1 concluída (handoff), T2 corrente (task_started).
	const r = buildFeatureRun(d, "feat-x", () => "2026-06-29T00:00:00.000Z");
	assert.ok(r);
	if (!r) return;
	r.steps[0].status = "in_progress";
	writeFeatureRun(d, r);
	recordHandoff(
		d,
		"feat-x",
		{ taskId: "T1", workerSessionId: "ws1", successState: "success", returnToOrchestrator: false, validatorsPassed: true, handoff: { whatWasImplemented: "did T1", whatWasLeftUndone: "", verification: { commandsRun: [] } } },
		() => "2026-06-29T00:03:00.000Z",
	);
	appendProgress(d, "feat-x", "task_completed", { taskId: "T1" });
	appendProgress(d, "feat-x", "task_started", { taskId: "T2" });

	const m = readControlModel(d, "feat-x", Date.parse("2026-06-29T00:10:00.000Z"));
	assert.ok(m);
	if (!m) return;
	assert.equal(m.exists, true);
	assert.equal(m.tasksDone, 1);
	assert.equal(m.active?.id, "T2");
	assert.ok(m.workers.some((w) => w.workerSessionId === "ws1" && w.status === "success"));
	assert.ok(m.workers.some((w) => w.status === "running" && w.taskId === "T2"));
	assert.ok(m.progress.some((p) => p.text.includes("T2 started")));
});
