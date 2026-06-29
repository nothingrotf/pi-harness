import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFeatureRun, featureProgress, type Plan, readFeatureRun, readPlan, readStatus, storePlan, validatePlan, writeFeatureRun } from "../src/plan.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-plan-"));
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

test("validatePlan: cobertura ok (cada assertion em exatamente uma task)", () => {
	assert.deepEqual(validatePlan(plan()), { ok: true, issues: [] });
});

test("validatePlan: pega órfã, duplicata e assertion desconhecida", () => {
	const orphan = validatePlan(plan({ tasks: [{ id: "T1", description: "x", skillName: "w", fulfills: ["A1"] }] }));
	assert.equal(orphan.ok, false);
	assert.ok(orphan.issues.some((i) => /A2 is orphaned/.test(i)) && orphan.issues.some((i) => /A3 is orphaned/.test(i)));

	const dup = validatePlan(
		plan({
			tasks: [
				{ id: "T1", description: "x", skillName: "w", fulfills: ["A1", "A2"] },
				{ id: "T2", description: "y", skillName: "w", fulfills: ["A2", "A3"] },
			],
		}),
	);
	assert.ok(!dup.ok && dup.issues.some((i) => /A2 claimed by multiple tasks/.test(i)));

	const unknown = validatePlan(plan({ tasks: [{ id: "T1", description: "x", skillName: "w", fulfills: ["A1", "A2", "A3", "A9"] }] }));
	assert.ok(!unknown.ok && unknown.issues.some((i) => /unknown assertion: A9/.test(i)));
});

test("validatePlan: pega task sem id/skillName/description e id duplicado", () => {
	const r = validatePlan(plan({ tasks: [{ id: "", description: "", skillName: "", fulfills: [] }], assertions: [] }));
	assert.ok(r.issues.some((i) => /missing id/.test(i)));
	assert.ok(r.issues.some((i) => /missing skillName/.test(i)));
	assert.ok(r.issues.some((i) => /missing description/.test(i)));
});

test("storePlan: grava plan.json + status.json (assertions pending); recusa inválido sem gravar", () => {
	const d = tmp();
	const bad = storePlan(d, plan({ tasks: [{ id: "T1", description: "x", skillName: "w", fulfills: ["A1"] }] }));
	assert.equal(bad.ok, false);
	assert.equal(readPlan(d, "feat-x"), null, "recusa não grava");

	const good = storePlan(d, plan());
	assert.ok(good.ok);
	const rp = readPlan(d, "feat-x");
	assert.equal(rp?.tasks.length, 3);
	const st = readStatus(d, "feat-x");
	assert.deepEqual(st?.assertions, { A1: "pending", A2: "pending", A3: "pending" });
});

test("storePlan: emite plan_stored no progress_log.jsonl", () => {
	const d = tmp();
	storePlan(d, plan());
	const log = fs.readFileSync(path.join(d, ".harness", "runs", "feat-x", "progress_log.jsonl"), "utf8").trim();
	assert.match(log, /"event":"plan_stored"/);
	assert.match(log, /"tasks":3/);
	assert.match(log, /"assertions":3/);
});

test("buildFeatureRun: ponte converge→runner — plan.json vira FeatureRun (steps de task)", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "2026-06-29T00:00:00.000Z");
	assert.ok(run);
	assert.equal(run?.featureId, "feat-x");
	assert.equal(run?.steps.length, 3, "3 task steps (sem ship gate ainda)");
	assert.ok(run?.steps.every((s) => s.kind === "task" && s.status === "pending"));
	assert.deepEqual(
		run?.steps.map((s) => s.id),
		["T1", "T2", "T3"],
	);
	assert.equal(buildFeatureRun(d, "nao-existe"), null);
});

test("writeFeatureRun/readFeatureRun: round-trip (state.json do runner headless, pro resume)", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "2026-06-29T00:00:00.000Z");
	assert.ok(run);
	if (!run) return;
	run.steps[0].status = "completed";
	writeFeatureRun(d, run);
	const back = readFeatureRun(d, "feat-x");
	assert.equal(back?.steps[0].status, "completed");
	assert.equal(back?.featureId, "feat-x");
	assert.equal(readFeatureRun(d, "nao-existe"), null);
});

test("featureProgress: tasks done/total (do feature-run) + assertions passed/failed (do status)", () => {
	const d = tmp();
	assert.equal(featureProgress(d, "feat-x"), null, "sem plan → null");
	storePlan(d, plan()); // 3 tasks, 3 assertions pending
	// sem feature-run ainda: 0 tasks done; assertions todas pending
	let p = featureProgress(d, "feat-x");
	assert.deepEqual(p, { tasksTotal: 3, tasksDone: 0, assertionsTotal: 3, assertionsPassed: 0, assertionsFailed: 0 });
	// roda o runner parcial + marca status
	const run = buildFeatureRun(d, "feat-x", () => "2026-06-29T00:00:00.000Z");
	if (!run) return;
	run.steps[0].status = "completed";
	run.steps[1].status = "completed";
	writeFeatureRun(d, run);
	const st = readStatus(d, "feat-x");
	if (st) {
		st.assertions.A1 = "passed";
		st.assertions.A2 = "failed";
		fs.writeFileSync(path.join(d, ".harness", "runs", "feat-x", "status.json"), JSON.stringify(st));
	}
	p = featureProgress(d, "feat-x");
	assert.deepEqual(p, { tasksTotal: 3, tasksDone: 2, assertionsTotal: 3, assertionsPassed: 1, assertionsFailed: 1 });
});
