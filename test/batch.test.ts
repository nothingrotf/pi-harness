/**
 * Testes do empacotador de batches por budget (src/batch.ts, doc 05 §4).
 * Puros — sem IO, sem runner. Cobrem: legado K=1, split por budget, coesão nunca rachada,
 * emenda de skill como bônus de localização, batchBreakBefore forçado, cauda curta, env budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchBudget, batchTasks, DEFAULT_BATCH_BUDGET, foldCeiling } from "../src/batch.ts";
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

test("cauda curta funde SÓ até o teto de transbordo (25% do budget)", () => {
	// 15 tasks / budget 7 → [7,7,1] → 7+1=8 ≤ teto(8) → funde → [7,8].
	assert.deepEqual(
		ids(batchTasks(mk(15), 7)).map((b) => b.length),
		[7, 8],
	);
	// 16 / 7 → [7,7,2] → 7+2=9 > teto(8) → NÃO funde. Um worker de 2 tasks paga ~45k de cold start;
	// um batch de 9 paga contexto crescente em CADA turno — medido em 301k/570k tok/turno.
	assert.deepEqual(
		ids(batchTasks(mk(16), 7)).map((b) => b.length),
		[7, 7, 2],
	);
	// 17 / 7 → [7,7,3] → cauda 3 NÃO funde (regra de tamanho, independente do teto).
	assert.deepEqual(
		ids(batchTasks(mk(17), 7)).map((b) => b.length),
		[7, 7, 3],
	);
});

test("foldCeiling: 25% de transbordo, arredondado pra baixo", () => {
	assert.equal(foldCeiling(7), 8);
	assert.equal(foldCeiling(4), 5);
	assert.equal(foldCeiling(10), 12);
});

test("REGRESSÃO (caso real medido): fold não pode empilhar cauda num batch já estourado", () => {
	// Plano exato da feature do A/B em sotaq: 10 tasks, budget 7, T7 weight 2 + cluster de coesão
	// T7–T8. O corte cai em T8 (peso 9, já acima do budget porque cutForbidden protege o cluster) e
	// a cauda T9+T10 era fundida de volta → UM batch de 10 tasks / peso 11 (157% do budget).
	// Consequência medida nas duas runs: contexto monotônico até 301k (opus) e 570k (sonnet)
	// tok/turno, contra ~90k de mediana no resto da feature.
	const plan = [
		...mk(6),
		{ id: "T7", skillName: "backend", cohesion: "asr-orchestration", weight: 2 },
		{ id: "T8", skillName: "backend", cohesion: "asr-orchestration" },
		{ id: "T9", skillName: "backend" },
		{ id: "T10", skillName: "backend" },
	];
	const got = ids(batchTasks(plan, 7));
	assert.deepEqual(got, [["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"], ["T9", "T10"]], "a feature roda em 2 sessões, não numa só");
	assert.ok(
		got.every((b) => b.length <= 8),
		"nenhum batch acima do teto de transbordo",
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

test("weight: task pesada consome mais budget (token-aware, doc 05 §10)", () => {
	// budget 7. 3 tasks leves (w1) + 1 pesada (w4) + 3 leves = peso total 10 > 7 → racha.
	const tasks: PlanTaskRef[] = [
		{ id: "T1", skillName: "w" },
		{ id: "T2", skillName: "w" },
		{ id: "T3", skillName: "w" },
		{ id: "T4", skillName: "w", weight: 4 }, // pesada
		{ id: "T5", skillName: "w" },
		{ id: "T6", skillName: "w" },
		{ id: "T7", skillName: "w" },
	];
	// T1(1)T2(2)T3(3)T4(+4=7) → atBudget em T4 → corta [T1..T4]; T5T6T7 = [T5..T7].
	assert.deepEqual(ids(batchTasks(tasks, 7)), [
		["T1", "T2", "T3", "T4"],
		["T5", "T6", "T7"],
	]);
});

test("weight: default 1 — pesos ausentes = contagem pura (K=1 byte-idêntico preservado)", () => {
	// 7 tasks sem weight, budget 7 → peso total 7 ≤ budget → um batch (legado).
	assert.deepEqual(ids(batchTasks(mk(7), 7)), [["T1", "T2", "T3", "T4", "T5", "T6", "T7"]]);
	// weight inválido/≤0 cai pra 1.
	const tasks: PlanTaskRef[] = [{ id: "T1", skillName: "w", weight: 0 }, { id: "T2", skillName: "w", weight: -3 }];
	assert.deepEqual(ids(batchTasks(tasks, 7)), [["T1", "T2"]]);
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
