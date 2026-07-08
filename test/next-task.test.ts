import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeatureRun, FeatureStep } from "../src/feature-runner.ts";
import { batchUniverse, completedTaskIds, firstUncompleted, planNextTask } from "../src/next-task.ts";

const IDS = ["T1", "T2", "T3"];

/** Constrói um FeatureRun mínimo com os steps dados (só os campos que batchUniverse lê). */
function runWith(steps: Partial<FeatureStep>[]): FeatureRun {
	return { steps: steps as FeatureStep[] } as unknown as FeatureRun;
}
const PLAN_IDS = ["T1", "T2", "T3", "T4", "T5", "T6"];

test("firstUncompleted: primeiro não-completo na ordem, excluindo `exclude`", () => {
	assert.equal(firstUncompleted(IDS, new Set(), undefined), "T1");
	assert.equal(firstUncompleted(IDS, new Set(["T1"]), undefined), "T2");
	assert.equal(firstUncompleted(IDS, new Set(["T1"]), "T2"), "T3");
	assert.equal(firstUncompleted(IDS, new Set(["T1", "T2", "T3"]), undefined), undefined);
});

test("planNextTask: primeira chamada (sem ativo) → start T1", () => {
	const d = planNextTask(IDS, new Set(), {}, "sha0");
	assert.deepEqual(d, { action: "start", taskId: "T1" });
});

test("planNextTask: git gate por ANCESTRALIDADE — amend/rebase (HEAD mudou sem commit novo) NÃO avança", () => {
	// amend: sha0 NÃO é ancestral do novo sha → resend (antes: qualquer movimento de HEAD avançava)
	const amend = planNextTask(IDS, new Set(), { activeTaskId: "T1", head: "sha0" }, "sha0-amended", () => false);
	assert.deepEqual(amend, { action: "resend", taskId: "T1" });
	// commit real em cima: sha0 é ancestral → avança
	const commit = planNextTask(IDS, new Set(), { activeTaskId: "T1", head: "sha0" }, "sha1", () => true);
	assert.equal(commit.action, "start");
	assert.equal(commit.completePrev, "T1");
});

test("planNextTask: ativo commitou (HEAD mudou) → completa o ativo + começa o próximo", () => {
	const d = planNextTask(IDS, new Set(), { activeTaskId: "T1", head: "sha0" }, "sha1");
	assert.deepEqual(d, { action: "start", completePrev: "T1", taskId: "T2" });
});

test("planNextTask: ativo SEM commit (mesmo HEAD) → resend (não avança, não confia no modelo)", () => {
	const d = planNextTask(IDS, new Set(), { activeTaskId: "T1", head: "sha0" }, "sha0");
	assert.deepEqual(d, { action: "resend", taskId: "T1" });
});

test("planNextTask: sem git (head undefined) → protocolo puro, avança na chamada", () => {
	const d = planNextTask(IDS, new Set(), { activeTaskId: "T1", head: "sha0" }, undefined);
	assert.deepEqual(d, { action: "start", completePrev: "T1", taskId: "T2" });
});

test("planNextTask: última task commitada → done (completa a última, sem próxima)", () => {
	const d = planNextTask(IDS, new Set(["T1", "T2"]), { activeTaskId: "T3", head: "sha2" }, "sha3");
	assert.deepEqual(d, { action: "done", completePrev: "T3" });
});

test("planNextTask: tudo já completo → done (sem completePrev)", () => {
	const d = planNextTask(IDS, new Set(["T1", "T2", "T3"]), {}, "shaX");
	assert.deepEqual(d, { action: "done" });
});

test("planNextTask: ativo já estava no conjunto completo → apenas segue pro próximo não-completo", () => {
	// (ex.: task_completed do ativo já gravado por uma chamada anterior) → não recompleta, só avança.
	const d = planNextTask(IDS, new Set(["T1"]), { activeTaskId: "T1", head: "sha0" }, "sha0");
	assert.deepEqual(d, { action: "start", taskId: "T2" });
});

test("batchUniverse: sem run (null/undefined) → plano inteiro + IMPL_STEP_ID (legado K=1)", () => {
	assert.deepEqual(batchUniverse(null, PLAN_IDS), { taskIds: PLAN_IDS, batchId: "implement" });
	assert.deepEqual(batchUniverse(undefined, PLAN_IDS), { taskIds: PLAN_IDS, batchId: "implement" });
});

test("batchUniverse: step único 'implement' in_progress (carrega o plano todo) → mesmo universo", () => {
	const run = runWith([{ id: "implement", kind: "task", status: "in_progress", tasks: PLAN_IDS.map((id) => ({ id, skillName: "w" })) }]);
	assert.deepEqual(batchUniverse(run, PLAN_IDS), { taskIds: PLAN_IDS, batchId: "implement" });
});

test("batchUniverse: K batches — implement-2 in_progress → SÓ a fatia do batch 2 + batchId implement-2", () => {
	const run = runWith([
		{ id: "implement-1", kind: "task", status: "completed", tasks: [{ id: "T1", skillName: "w" }, { id: "T2", skillName: "w" }, { id: "T3", skillName: "w" }] },
		{ id: "implement-2", kind: "task", status: "in_progress", tasks: [{ id: "T4", skillName: "w" }, { id: "T5", skillName: "w" }, { id: "T6", skillName: "w" }] },
	]);
	assert.deepEqual(batchUniverse(run, PLAN_IDS), { taskIds: ["T4", "T5", "T6"], batchId: "implement-2" });
});

test("batchUniverse: nenhum step in_progress (tudo pending) → fallback plano inteiro", () => {
	const run = runWith([{ id: "implement-1", kind: "task", status: "pending", tasks: [{ id: "T1", skillName: "w" }] }]);
	assert.deepEqual(batchUniverse(run, PLAN_IDS), { taskIds: PLAN_IDS, batchId: "implement" });
});

test("batchUniverse: ship-gate in_progress (kind != task) → fallback (só batch de implementação escopa)", () => {
	const run = runWith([{ id: "ship-gate-qa-validator", kind: "ship-gate", status: "in_progress" }]);
	assert.deepEqual(batchUniverse(run, PLAN_IDS), { taskIds: PLAN_IDS, batchId: "implement" });
});

test("completedTaskIds: ignora task_completed vindo de EndFeatureRun (successState presente) — bypass do git gate", () => {
	const done = completedTaskIds([
		{ event: "task_completed", taskId: "T1" }, // runner/next_task → conta
		{ event: "task_completed", taskId: "T2", successState: "success" }, // recordHandoff (worker-supplied) → NÃO conta
		{ event: "step_completed", id: "implement" },
	]);
	assert.ok(done.has("T1"));
	assert.ok(!done.has("T2"), "EndFeatureRun não marca tasks do plano como feitas");
	assert.ok(done.has("implement"));
});
