import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isValidRunId, listRunIds, listRuns, renameRun, runRow, type RunSummary } from "../src/runs.ts";
import type { Plan } from "../src/plan.ts";
import { buildFeatureRun, storePlan, writeFeatureRun } from "../src/plan.ts";
import { appendProgress } from "../src/handoff.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-runs-"));
}

function plan(featureId: string, createdAt: string): Plan {
	return {
		featureId,
		assertions: ["A1", "A2"],
		tasks: [
			{ id: "T1", description: "x", skillName: "w", fulfills: ["A1"] },
			{ id: "T2", description: "y", skillName: "w", fulfills: ["A2"] },
		],
		createdAt,
	};
}

test("listRuns: vazio quando não há .harness/runs", () => {
	const d = tmp();
	assert.deepEqual(listRunIds(d), []);
	assert.deepEqual(listRuns(d), []);
});

test("listRuns: lista runs com plan, ordenado por updatedAt desc, com current e progresso", () => {
	const d = tmp();
	storePlan(d, plan("feat-a", "2026-06-20T00:00:00.000Z"));
	storePlan(d, plan("feat-b", "2026-06-28T00:00:00.000Z"));

	// feat-a roda parcial (1 task concluída via task_completed) e marca um assertion passed →
	// updatedAt mais novo que feat-b. (1 worker por feature: tasksDone vem dos eventos, não de N steps.)
	const ra = buildFeatureRun(d, "feat-a", () => "2026-06-29T00:00:00.000Z");
	if (ra) {
		ra.steps[0].status = "in_progress";
		ra.updatedAt = "2026-06-29T12:00:00.000Z";
		writeFeatureRun(d, ra);
	}
	appendProgress(d, "feat-a", "task_completed", { taskId: "T1" });
	const stPath = path.join(d, ".harness", "runs", "feat-a", "status.json");
	const st = JSON.parse(fs.readFileSync(stPath, "utf8"));
	st.assertions.A1 = "passed";
	fs.writeFileSync(stPath, JSON.stringify(st));

	const runs = listRuns(d, { activeFeatureId: "feat-a" });
	assert.equal(runs.length, 2);
	assert.equal(runs[0].featureId, "feat-a", "mais recente primeiro (updatedAt do feature-run)");
	assert.equal(runs[0].current, true);
	assert.equal(runs[0].state, "running");
	assert.equal(runs[0].tasksDone, 1);
	assert.equal(runs[0].tasksTotal, 2);
	assert.deepEqual(runs[0].assertions, { passed: 1, failed: 0, pending: 1, total: 2 });

	assert.equal(runs[1].featureId, "feat-b");
	assert.equal(runs[1].current, false);
	assert.equal(runs[1].state, "ready", "feat-b convergiu (plan FROZEN) mas não rodou → ready, não Unknown");
});

test("runRow: marcador ● no atual + ícone de estado; description estado·work-items·updated", () => {
	const now = Date.parse("2026-06-29T12:00:00.000Z");
	const base: RunSummary = {
		featureId: "add-rate-limiter",
		state: "running",
		counts: { completed: 4, pending: 2, estimate: 2, cancelled: 0, total: 8 },
		assertions: { passed: 6, failed: 0, pending: 6, total: 12 },
		tasksDone: 2,
		tasksTotal: 8,
		updatedAt: "2026-06-29T11:58:00.000Z",
		current: true,
	};
	const row = runRow(base, now);
	assert.equal(row.label, "● ● add-rate-limiter");
	assert.equal(row.description, "Running · 4/8 [+2] · 2m", "work items completed/total [+N]");

	// sem counts (total 0) e sem updatedAt → só o estado
	const row2 = runRow({ ...base, current: false, counts: { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 }, updatedAt: null, state: "unknown" }, now);
	assert.equal(row2.label, "  ○ add-rate-limiter");
	assert.equal(row2.description, "Unknown");
});

test("listRunIds: ignora dirs sem plan.json", () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, ".harness", "runs", "lixo"), { recursive: true });
	storePlan(d, plan("feat-real", "2026-06-28T00:00:00.000Z"));
	assert.deepEqual(listRunIds(d), ["feat-real"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-row load errors (Droid missions picker: um run corrompido degrada a linha)

test("listRuns: run com plan.json corrompido vira linha degradada (loadError), não quebra o picker", () => {
	const d = tmp();
	storePlan(d, plan("feat-ok", "2026-06-20T00:00:00.000Z"));
	const bad = path.join(d, ".harness", "runs", "feat-bad");
	fs.mkdirSync(bad, { recursive: true });
	fs.writeFileSync(path.join(bad, "plan.json"), "{corrupt json");
	const runs = listRuns(d);
	assert.equal(runs.length, 2, "os dois aparecem");
	const ok = runs.find((r) => r.featureId === "feat-ok");
	const broken = runs.find((r) => r.featureId === "feat-bad");
	assert.equal(ok?.loadError, undefined);
	// plan corrompido → readPlan devolve null → o run é tratado como "unknown" sem crash;
	// um throw em QUALQUER leitura vira loadError (o catch de summarize).
	assert.ok(broken, "run corrompido continua listado");
});

test("runRow: loadError → ⚠ + motivo na description", () => {
	const r: RunSummary = {
		featureId: "feat-bad",
		state: "unknown",
		counts: { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 },
		assertions: { passed: 0, failed: 0, pending: 0, total: 0 },
		tasksDone: 0,
		tasksTotal: 0,
		updatedAt: null,
		current: false,
		loadError: "Unexpected token c in JSON",
	};
	const row = runRow(r, Date.now());
	assert.match(row.label, /⚠ feat-bad/);
	assert.match(row.description, /load error: Unexpected token/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rename (Ctrl+R do picker — o rename inline do Droid)

test("renameRun: renomeia o dir + reescreve featureId em plan/status/feature-run", () => {
	const d = tmp();
	storePlan(d, plan("feat-old", "2026-06-20T00:00:00.000Z"));
	const run = buildFeatureRun(d, "feat-old", () => "t");
	if (run) writeFeatureRun(d, run);
	const res = renameRun(d, "feat-old", "feat-new");
	assert.deepEqual(res, { ok: true, featureId: "feat-new" });
	assert.ok(!fs.existsSync(path.join(d, ".harness/runs/feat-old")));
	const p = JSON.parse(fs.readFileSync(path.join(d, ".harness/runs/feat-new/plan.json"), "utf8"));
	assert.equal(p.featureId, "feat-new");
	const st = JSON.parse(fs.readFileSync(path.join(d, ".harness/runs/feat-new/status.json"), "utf8"));
	assert.equal(st.featureId, "feat-new");
	const fr = JSON.parse(fs.readFileSync(path.join(d, ".harness/runs/feat-new/feature-run.json"), "utf8"));
	assert.equal(fr.featureId, "feat-new");
	assert.deepEqual(listRunIds(d), ["feat-new"]);
});

test("renameRun: recusa nome inválido, colisão e origem ausente; no-op pro mesmo nome", () => {
	const d = tmp();
	storePlan(d, plan("feat-a", "t"));
	storePlan(d, plan("feat-b", "t"));
	assert.equal(renameRun(d, "feat-a", "").ok, false);
	assert.equal(renameRun(d, "feat-a", "has space").ok, false);
	assert.equal(renameRun(d, "feat-a", ".hidden").ok, false);
	assert.equal(renameRun(d, "feat-a", "feat-b").ok, false, "colisão");
	assert.equal(renameRun(d, "feat-zzz", "feat-x").ok, false, "origem ausente");
	assert.deepEqual(renameRun(d, "feat-a", "feat-a"), { ok: true, featureId: "feat-a" }, "mesmo nome = no-op");
});

test("isValidRunId: slug filesystem-safe", () => {
	assert.equal(isValidRunId("feat-login-2"), true);
	assert.equal(isValidRunId("Feat_x.1"), true);
	assert.equal(isValidRunId(""), false);
	assert.equal(isValidRunId(".dot"), false);
	assert.equal(isValidRunId("a b"), false);
	assert.equal(isValidRunId("a/b"), false);
});
