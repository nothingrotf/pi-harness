import { test } from "node:test";
import assert from "node:assert/strict";
import { firstUncompleted, planNextTask } from "../src/next-task.ts";

const IDS = ["T1", "T2", "T3"];

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
