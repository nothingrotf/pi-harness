/**
 * Testes do empacotador de batches por budget (src/batch.ts, doc 05 §4).
 * Puros — sem IO, sem runner. Cobrem: legado K=1, split por budget, coesão nunca rachada,
 * emenda de skill como bônus de localização, batchBreakBefore forçado, cauda curta, env budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchBudget, batchTasks, DEFAULT_BATCH_BUDGET } from "../src/batch.ts";
import type { PlanTaskRef } from "../src/feature-runner.ts";

/** Helper: N tasks sequenciais com skill/coesão opcionais. */
function mk(n: number, opts: { skill?: (i: number) => string; cohesion?: (i: number) => string | undefined; brk?: (i: number) => boolean } = {}): PlanTaskRef[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `T${i + 1}`,
		skillName: opts.skill ? opts.skill(i) : "backend",
		...(opts.cohesion?.(i) ? { cohesion: opts.cohesion(i) } : {}),
		...(opts.brk?.(i) ? { batchBreakBefore: true } : {}),
	}));
}
const ids = (b: PlanTaskRef[][]): string[][] => b.map((batch) => batch.map((t) => t.id));

test("vazio → []", () => {
	assert.deepEqual(batchTasks([], 7), []);
});

test("legado: T ≤ budget → UM batch (K=1 byte-idêntico)", () => {
	assert.deepEqual(ids(batchTasks(mk(7), 7)), [["T1", "T2", "T3", "T4", "T5", "T6", "T7"]]);
	assert.deepEqual(ids(batchTasks(mk(1), 7)), [["T1"]]);
	assert.deepEqual(ids(batchTasks(mk(3), 7)), [["T1", "T2", "T3"]]);
});

test("budget ≤ 0 desliga o batching → um batch só", () => {
	assert.equal(batchTasks(mk(20), 0).length, 1);
	assert.equal(batchTasks(mk(20), -5).length, 1);
});

test("split por budget: 20 tasks homogêneas / budget 7 → [7,7,6]", () => {
	// sem coesão/skill-seam: corta exatamente no budget; cauda 6 não funde (>2).
	assert.deepEqual(
		ids(batchTasks(mk(20), 7)).map((b) => b.length),
		[7, 7, 6],
	);
});

test("cauda curta (1–2) funde no batch anterior", () => {
	// 15 tasks / budget 7 → [7,7,1] → funde a cauda 1 → [7,8].
	assert.deepEqual(
		ids(batchTasks(mk(15), 7)).map((b) => b.length),
		[7, 8],
	);
	// 16 / 7 → [7,7,2] → funde → [7,9].
	assert.deepEqual(
		ids(batchTasks(mk(16), 7)).map((b) => b.length),
		[7, 9],
	);
	// 17 / 7 → [7,7,3] → cauda 3 NÃO funde.
	assert.deepEqual(
		ids(batchTasks(mk(17), 7)).map((b) => b.length),
		[7, 7, 3],
	);
});

test("coesão nunca é rachada (overflow permitido além do budget)", () => {
	// 10 tasks / budget 4; T3..T8 são um cluster 'core' → não pode cortar dentro dele.
	const tasks = mk(10, { cohesion: (i) => (i >= 2 && i <= 7 ? "core" : undefined) });
	const b = batchTasks(tasks, 4);
	// Nenhum batch corta o cluster: T3..T8 devem estar todos no MESMO batch.
	const clusterBatch = b.find((batch) => batch.some((t) => t.id === "T3"));
	assert.ok(clusterBatch, "achou o batch do cluster");
	for (const id of ["T3", "T4", "T5", "T6", "T7", "T8"]) {
		assert.ok(
			clusterBatch?.some((t) => t.id === id),
			`${id} está no mesmo batch do cluster`,
		);
	}
});

test("batchBreakBefore força uma emenda dura antes da task", () => {
	// 10 tasks / budget grande (nunca cortaria por budget); break antes de T6 → 2 batches.
	const tasks = mk(10, { brk: (i) => i === 5 });
	const b = batchTasks(tasks, 20);
	assert.deepEqual(ids(b), [
		["T1", "T2", "T3", "T4", "T5"],
		["T6", "T7", "T8", "T9", "T10"],
	]);
});

test("batchBreakBefore: cauda forçada NÃO funde (respeita a fronteira dura)", () => {
	// break antes de T9 cria uma cauda [T9,T10] (len 2) — normalmente fundiria, mas é forçada.
	const tasks = mk(10, { brk: (i) => i === 8 });
	const b = batchTasks(tasks, 20);
	assert.deepEqual(ids(b), [
		["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"],
		["T9", "T10"],
	]);
});

test("emenda de skill fecha um batch já ≥60% do budget (bônus de localização)", () => {
	// budget 7 → softFloor = ceil(7*0.6)=5. 5 backend + 5 frontend.
	// Ao chegar em T5 (len 5 ≥ softFloor) com T6 de skill diferente → corta cedo em 5.
	const tasks = mk(10, { skill: (i) => (i < 5 ? "backend" : "frontend") });
	const b = batchTasks(tasks, 7);
	assert.deepEqual(ids(b), [
		["T1", "T2", "T3", "T4", "T5"],
		["T6", "T7", "T8", "T9", "T10"],
	]);
});

test("emenda de skill NÃO corta se o batch ainda está abaixo do softFloor", () => {
	// budget 7 (softFloor 5). skills alternam a cada 2 tasks — nenhum batch abaixo de 5 corta na
	// troca; só corta quando budget/softFloor permite. 8 tasks → um único batch (≤ budget).
	const tasks = mk(8, { skill: (i) => (Math.floor(i / 2) % 2 === 0 ? "a" : "b") });
	// 8 > 7 → deve cortar. softFloor 5: primeira emenda de skill em index≥4 com len≥5...
	// T1a T2a T3b T4b T5a T6a T7b T8b: em T5(len5, next T6 mesma skill 'a') não corta;
	// T6(len6, next T7 skill 'b' ≠ 'a', len6≥5) → corta em 6 → [6,2] → cauda 2 funde → [8].
	assert.deepEqual(
		ids(batchTasks(tasks, 7)).map((b) => b.length),
		[8],
	);
});

test("batchBudget: env HARNESS_TASK_BUDGET", () => {
	assert.equal(batchBudget({} as NodeJS.ProcessEnv), DEFAULT_BATCH_BUDGET);
	assert.equal(batchBudget({ HARNESS_TASK_BUDGET: "10" } as unknown as NodeJS.ProcessEnv), 10);
	assert.equal(batchBudget({ HARNESS_TASK_BUDGET: "0" } as unknown as NodeJS.ProcessEnv), 0, "0 desliga");
	assert.equal(batchBudget({ HARNESS_TASK_BUDGET: "-3" } as unknown as NodeJS.ProcessEnv), 0, "negativo desliga");
	assert.equal(batchBudget({ HARNESS_TASK_BUDGET: "abc" } as unknown as NodeJS.ProcessEnv), 0, "inválido desliga");
});

test("não muta as tasks de entrada", () => {
	const tasks = mk(20);
	const snapshot = JSON.stringify(tasks);
	batchTasks(tasks, 7);
	assert.equal(JSON.stringify(tasks), snapshot);
});
