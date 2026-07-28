import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendFixTasksToPlan, buildFeatureRun, completionGate, ensureAssertions, featureProgress, loadOrBuildFeatureRun, type Plan, readFeatureRun, readPlan, readStatus, storePlan, validatePlan, writeFeatureRun } from "../src/plan.ts";
import { IMPL_STEP_ID } from "../src/feature-runner.ts";
import { appendProgress } from "../src/handoff.ts";

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

test("buildFeatureRun: thread de cohesion → batching respeita o cluster (doc 05 phase 6)", () => {
	const dir = tmp();
	const p = plan({
		assertions: Array.from({ length: 10 }, (_, i) => `A${i + 1}`),
		tasks: Array.from({ length: 10 }, (_, i) => ({
			id: `T${i + 1}`,
			description: `d${i + 1}`,
			skillName: "backend-worker",
			fulfills: [`A${i + 1}`],
			...(i >= 2 && i <= 6 ? { cohesion: "core" } : {}), // T3..T7 = cluster coeso
		})),
	});
	const res = storePlan(dir, p);
	assert.ok(res.ok, "plan válido");
	assert.equal(readPlan(dir, "feat-x")?.tasks[2].cohesion, "core", "cohesion persistiu no plan.json");

	const prev = process.env.HARNESS_TASK_BUDGET;
	process.env.HARNESS_TASK_BUDGET = "4"; // budget pequeno p/ forçar batches determinísticos
	try {
		const run = buildFeatureRun(dir, "feat-x");
		const clusterStep = run?.steps.find((s) => s.tasks?.some((t) => t.id === "T3"));
		assert.ok(clusterStep, "achou o batch do cluster");
		for (const id of ["T3", "T4", "T5", "T6", "T7"]) {
			assert.ok(clusterStep?.tasks?.some((t) => t.id === id), `${id} no MESMO batch (cohesion não rachada)`);
		}
		assert.equal(clusterStep?.tasks?.find((t) => t.id === "T3")?.cohesion, "core", "cohesion carregou pro step.tasks");
		assert.ok((run?.steps.filter((s) => s.kind === "task").length ?? 0) >= 2, "feature grande rachou em ≥2 batches");
	} finally {
		if (prev === undefined) delete process.env.HARNESS_TASK_BUDGET;
		else process.env.HARNESS_TASK_BUDGET = prev;
	}
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

test("ensureAssertions: adiciona ids novos como pending SEM tocar nos existentes (fix tasks com bug assertions)", () => {
	const d = tmp();
	storePlan(d, plan());
	const before = readStatus(d, "feat-x");
	assert.ok(before && "A1" in before.assertions);
	// simula um verdict já dado
	before.assertions.A1 = "passed";
	fs.writeFileSync(path.join(d, ".harness", "runs", "feat-x", "status.json"), JSON.stringify(before));
	ensureAssertions(d, "feat-x", ["A-BUG-1", "A1"]);
	const after = readStatus(d, "feat-x");
	assert.equal(after?.assertions["A-BUG-1"], "pending", "assertion nova entra como pending");
	assert.equal(after?.assertions.A1, "passed", "verdict existente preservado");
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

test("buildFeatureRun: ponte converge→runner — plan.json vira UM impl step (1 worker por feature)", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "2026-06-29T00:00:00.000Z");
	assert.ok(run);
	assert.equal(run?.featureId, "feat-x");
	assert.equal(run?.steps.length, 1, "um único impl step carrega as 3 tasks (sem ship gate ainda)");
	assert.equal(run?.steps[0].id, IMPL_STEP_ID);
	assert.ok(run?.steps[0].kind === "task" && run?.steps[0].status === "pending");
	assert.deepEqual(
		run?.steps[0].tasks?.map((t) => t.id),
		["T1", "T2", "T3"],
		"a fila de tasks vira o TODO interno do worker",
	);
	assert.equal(run?.steps[0].tasks?.[2].skillName, "frontend-worker", "campos ricos preservados (skill heterogênea)");
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

test("loadOrBuildFeatureRun: sem run persistido → fresh do plano (resume:false)", () => {
	const d = tmp();
	storePlan(d, plan());
	const rp = loadOrBuildFeatureRun(d, "feat-x", () => "t");
	assert.ok(rp);
	assert.equal(rp?.resume, false);
	assert.equal(rp?.run.steps.length, 1, "um impl step (1 worker por feature)");
	assert.equal(loadOrBuildFeatureRun(d, "nao-existe"), null, "sem plan → null");
});

test("loadOrBuildFeatureRun: status 'paused' (graceful) → resume:true (re-attach)", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "t");
	if (!run) return;
	run.status = "paused";
	run.pauseReason = "aborted";
	run.steps[0].status = "in_progress";
	writeFeatureRun(d, run);
	const rp = loadOrBuildFeatureRun(d, "feat-x");
	assert.equal(rp?.resume, true);
	assert.equal(rp?.run.steps[0].status, "in_progress", "preserva o in_progress p/ re-attach");
});

test("loadOrBuildFeatureRun: status 'running' congelado (HARD kill) → resume:false", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "t");
	if (!run) return;
	run.status = "running"; // congelado por um kill sem hook
	run.steps[0].status = "in_progress";
	writeFeatureRun(d, run);
	const rp = loadOrBuildFeatureRun(d, "feat-x");
	assert.equal(rp?.resume, false, "hard kill → o runLoop reclama o órfão (re-roda do zero)");
});

test("loadOrBuildFeatureRun: pausa por esgotamento → concede budget bônus", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "t");
	if (!run) return;
	run.status = "paused";
	run.pauseReason = "step_retry_limit_exceeded";
	run.steps[0].attempts = 5;
	writeFeatureRun(d, run);
	const rp = loadOrBuildFeatureRun(d, "feat-x");
	assert.equal(rp?.resume, true);
	assert.equal(rp?.run.retryBudgetBonus?.[IMPL_STEP_ID], 5, "impl step esgotado ganha budget fresco no resume");
});

test("loadOrBuildFeatureRun: re-grant compara com o budget EFETIVO e tem teto (regressão: +5 a cada resume = loop infinito)", () => {
	const d = tmp();
	storePlan(d, plan());
	const run = buildFeatureRun(d, "feat-x", () => "t");
	if (!run) return;
	run.status = "paused";
	run.pauseReason = "step_retry_limit_exceeded";
	run.steps[0].attempts = 5;
	run.retryBudgetBonus = { [IMPL_STEP_ID]: 5 };
	writeFeatureRun(d, run);
	// attempts(5) < efetivo(10) → NÃO re-concede (antes: comparava com a constante e dava +5 sempre)
	const rp = loadOrBuildFeatureRun(d, "feat-x");
	assert.equal(rp?.run.retryBudgetBonus?.[IMPL_STEP_ID], 5, "sem re-grant enquanto o budget efetivo não esgotou");
	// esgotado de novo (10) mas bônus já no teto (2×base) → também não re-concede
	const run2 = readFeatureRun(d, "feat-x");
	if (!run2) return;
	run2.status = "paused";
	run2.pauseReason = "step_retry_limit_exceeded";
	run2.steps[0].attempts = 15;
	run2.retryBudgetBonus = { [IMPL_STEP_ID]: 10 };
	writeFeatureRun(d, run2);
	const rp2 = loadOrBuildFeatureRun(d, "feat-x");
	assert.equal(rp2?.run.retryBudgetBonus?.[IMPL_STEP_ID], 10, "teto de bônus: esgotamento crônico pede fix tasks, não mais budget");
});

test("storePlan: re-store preserva verdicts existentes (regressão: revisão mid-run apagava passed)", () => {
	const d = tmp();
	storePlan(d, plan());
	const st = readStatus(d, "feat-x");
	if (!st) return;
	st.assertions.A1 = "passed";
	fs.writeFileSync(path.join(d, ".harness", "runs", "feat-x", "status.json"), JSON.stringify(st));
	storePlan(d, plan());
	const after = readStatus(d, "feat-x");
	assert.equal(after?.assertions.A1, "passed", "verdict sobrevive ao re-store");
	assert.equal(after?.assertions.A2, "pending", "assertions sem verdict continuam pending");
});

test("loadOrBuildFeatureRun: feature-run.json corrupto → quarentena .corrupt-* (regressão: rebuild silencioso re-corria a feature)", () => {
	const d = tmp();
	storePlan(d, plan());
	const file = path.join(d, ".harness", "runs", "feat-x", "feature-run.json");
	fs.writeFileSync(file, "{ truncated-by-hard-kill");
	const rp = loadOrBuildFeatureRun(d, "feat-x");
	assert.ok(rp, "reconstrói do plan.json");
	assert.equal(fs.existsSync(file), false, "o corrupto foi MOVIDO (não fica a assombrar o próximo load)");
	const quarantined = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("feature-run.json.corrupt-"));
	assert.equal(quarantined.length, 1, "evidência preservada em .corrupt-<ts>");
});

test("featureProgress: tasks done/total (de eventos task_completed) + assertions passed/failed (do status)", () => {
	const d = tmp();
	assert.equal(featureProgress(d, "feat-x"), null, "sem plan → null");
	storePlan(d, plan()); // 3 tasks, 3 assertions pending
	// sem progresso ainda: 0 tasks done; assertions todas pending
	let p = featureProgress(d, "feat-x");
	assert.deepEqual(p, { tasksTotal: 3, tasksDone: 0, assertionsTotal: 3, assertionsPassed: 0, assertionsFailed: 0 });
	// o worker (ou o runner ao completar o impl step) emite task_completed por task concluída
	appendProgress(d, "feat-x", "task_completed", { taskId: "T1" });
	appendProgress(d, "feat-x", "task_completed", { taskId: "T2" });
	const st = readStatus(d, "feat-x");
	if (st) {
		st.assertions.A1 = "passed";
		st.assertions.A2 = "failed";
		fs.writeFileSync(path.join(d, ".harness", "runs", "feat-x", "status.json"), JSON.stringify(st));
	}
	p = featureProgress(d, "feat-x");
	assert.deepEqual(p, { tasksTotal: 3, tasksDone: 2, assertionsTotal: 3, assertionsPassed: 1, assertionsFailed: 1 });
});

// ─────────────────────────────────────────────────────────────────────────────
// completionGate (droid: mission completa ⇔ toda assertion do contrato passed)

test("completionGate: sem status.json / sem assertions → falha (contrato não verificado)", () => {
	const d = tmp();
	assert.equal(completionGate(d, "feat-x").ok, false);
	fs.mkdirSync(path.join(d, ".harness/runs/feat-x"), { recursive: true });
	fs.writeFileSync(path.join(d, ".harness/runs/feat-x/status.json"), JSON.stringify({ featureId: "feat-x", assertions: {} }));
	const r = completionGate(d, "feat-x");
	assert.equal(r.ok, false);
	assert.match(r.failing[0], /no assertions/);
});

test("completionGate: pending/failed listadas em failing; todas passed → ok", () => {
	const d = tmp();
	storePlan(d, plan());
	const r1 = completionGate(d, "feat-x");
	assert.equal(r1.ok, false);
	assert.deepEqual(r1.failing, ["A1", "A2", "A3"], "todas pending após o store");
	const sp = path.join(d, ".harness/runs/feat-x/status.json");
	const st = JSON.parse(fs.readFileSync(sp, "utf8"));
	st.assertions.A1 = "passed";
	st.assertions.A2 = "failed";
	st.assertions.A3 = "passed";
	fs.writeFileSync(sp, JSON.stringify(st));
	const r2 = completionGate(d, "feat-x");
	assert.equal(r2.ok, false);
	assert.deepEqual(r2.failing, ["A2"]);
	st.assertions.A2 = "passed";
	fs.writeFileSync(sp, JSON.stringify(st));
	assert.deepEqual(completionGate(d, "feat-x"), { ok: true, failing: [] });
});

test("appendFixTasksToPlan: fix vira task do plano (regressão: next_task só lê plan.json → 44% dos commits sem commitGate)", () => {
	const d = tmp();
	storePlan(d, plan());
	const r = appendFixTasksToPlan(d, "feat-x", [{ id: "FIX1", description: "close the blocking finding", skillName: "backend-worker", fulfills: ["A-NEW"] }]);
	assert.deepEqual(r, { appended: ["FIX1"], issues: [] });

	const stored = readPlan(d, "feat-x");
	const fix = stored?.tasks.find((t) => t.id === "FIX1");
	assert.ok(fix, "next_task encontra a fix no plano");
	assert.deepEqual(fix?.fulfills, ["A-NEW"]);
	assert.ok(stored?.assertions.includes("A-NEW"), "assertion nova do bug report entra no plano");
	assert.equal(readStatus(d, "feat-x")?.assertions["A-NEW"], "pending", "e no status, pendente");
});

test("appendFixTasksToPlan: preserva a invariante de cobertura (não re-reivindica assertion já reivindicada) e é idempotente", () => {
	const d = tmp();
	storePlan(d, plan());
	// A1 já é da T2: a fix a re-testa, mas o plano não pode ter duas donas.
	const r = appendFixTasksToPlan(d, "feat-x", [{ id: "FIX1", description: "re-fix A1", skillName: "backend-worker", fulfills: ["A1", "A-NEW"] }]);
	assert.deepEqual(r.appended, ["FIX1"]);
	const stored = readPlan(d, "feat-x");
	assert.deepEqual(stored?.tasks.find((t) => t.id === "FIX1")?.fulfills, ["A-NEW"], "só a assertion não reivindicada");
	assert.deepEqual(validatePlan(stored as Plan), { ok: true, issues: [] }, "invariante intacta");

	const again = appendFixTasksToPlan(d, "feat-x", [{ id: "FIX1", description: "re-fix A1", skillName: "backend-worker", fulfills: ["A-NEW"] }]);
	assert.deepEqual(again.appended, [], "id já presente não duplica");
	assert.equal(readPlan(d, "feat-x")?.tasks.filter((t) => t.id === "FIX1").length, 1);
});

test("appendFixTasksToPlan: preserva verdicts já conquistados (não regride passed → pending)", () => {
	const d = tmp();
	storePlan(d, plan());
	const st = readStatus(d, "feat-x");
	if (st) {
		st.assertions.A1 = "passed";
		fs.writeFileSync(path.join(d, ".harness", "runs", "feat-x", "status.json"), JSON.stringify(st));
	}
	appendFixTasksToPlan(d, "feat-x", [{ id: "FIX1", description: "x", skillName: "backend-worker", fulfills: ["A-NEW"] }]);
	assert.equal(readStatus(d, "feat-x")?.assertions.A1, "passed", "storePlan mergeia, não clobbera");
});
