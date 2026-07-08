/**
 * `batchTasks` — o empacotador de tasks em BATCHES por BUDGET de contexto (doc 05).
 *
 * O problema (doc 05 §1): 1 worker por FEATURE dá contexto rico mas ESTOURA a janela em features
 * Large → auto-compact → qualidade cai. 1 worker por TASK perde contexto + paga o startup N×. O
 * batch é o meio: uma sessão fresca por ~7 tasks (sem compaction), startup amortizado sobre o
 * batch, continuidade entre batches via artefatos duráveis + handoff compacto.
 *
 * **Batch = unidade de EXECUÇÃO dirigida por BUDGET, não por milestone/phase.** O budget dirige o
 * TAMANHO; a coesão só restringe ONDE o corte cai (doc 05 §2/§4):
 *   - HARD forbid: duas tasks consecutivas com a MESMA `cohesion` não-vazia nunca são rachadas.
 *   - HARD force:  `batchBreakBefore` força uma emenda antes da task.
 *   - SOFT prefer: uma troca de `skillName` (worker type) é uma emenda barata → permite fechar um
 *     batch já razoavelmente cheio ANTES do budget, pra alinhar batches a tipos de worker (§5.3).
 *   - Cauda curta (regra tlc): um último batch de 1–2 tasks funde no anterior (a não ser que o
 *     split tenha sido forçado por `batchBreakBefore`).
 *
 * `T ≤ budget` (ou budget ≤ 0) ⇒ UM batch = comportamento LEGADO idêntico (doc 05 spine: K=1 é
 * byte-idêntico). Função PURA e testável isolada (test/batch.test.ts) — não toca o runner.
 */
import type { PlanTaskRef } from "./feature-runner.ts";

/** Budget default de tasks por batch (doc 05: ~7, o sweet spot benchmarkado do tlc). */
export const DEFAULT_BATCH_BUDGET = 7;

/**
 * Budget efetivo: env `HARNESS_TASK_BUDGET` (inteiro > 0) ou o default 7. `0`/inválido/≤0 →
 * DESLIGA o batching (retorna 0 → `batchTasks` devolve um único batch = legado). Assim o operador
 * pode voltar ao 1-worker-por-feature sem tocar código.
 */
export function batchBudget(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.HARNESS_TASK_BUDGET;
	if (raw === undefined) return DEFAULT_BATCH_BUDGET;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0; // explicitamente desligado
	return Math.floor(n);
}

/** Corte PROIBIDO entre a→b: mesma tag de coesão não-vazia (não racha um cluster coeso). */
function cutForbidden(a: PlanTaskRef, b: PlanTaskRef): boolean {
	return !!a.cohesion && a.cohesion === b.cohesion;
}

/**
 * Peso da task no budget (doc 05 §10: budget token-aware). Default 1 = contagem pura (sem
 * regressão). O author (converge) marca `weight` > 1 numa task PESADA (muito código/contexto) pra
 * ela consumir mais budget → batches menores ao redor dela, sem inventar um estimador de tokens.
 */
function weightOf(t: PlanTaskRef): number {
	const w = t.weight;
	return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1;
}
function sumWeight(ts: PlanTaskRef[]): number {
	return ts.reduce((s, t) => s + weightOf(t), 0);
}

/**
 * Empacota `tasks` (na ordem do plano) em batches por budget + coesão. Retorna `PlanTaskRef[][]`
 * (sempre ≥1 batch quando há tasks; `[]` quando não há). NÃO muta as tasks.
 *
 * @param budget teto de tasks por batch. `≤0` ou `tasks.length ≤ budget` ⇒ um único batch (legado).
 */
export function batchTasks(tasks: PlanTaskRef[], budget: number = batchBudget()): PlanTaskRef[][] {
	if (tasks.length === 0) return [];
	// Desligado explicitamente (env 0/inválido): um batch só.
	if (budget <= 0) return [tasks.slice()];
	// Legado K=1 (byte-idêntico ao planFeatureRun de antes do batching): peso total ≤ budget E sem
	// emenda dura. Com pesos default (1) ⇒ sumWeight == count ⇒ mesma condição de antes. Uma
	// `batchBreakBefore` presente FORÇA o split mesmo abaixo do budget (é opt-in do author).
	const hasForcedBreak = tasks.some((t, i) => i > 0 && t.batchBreakBefore);
	if (sumWeight(tasks) <= budget && !hasForcedBreak) return [tasks.slice()];

	// Piso suave pra cortar cedo numa emenda de skill (alinha batches a worker types sem fragmentar):
	// só permite o corte antecipado quando o batch já está com ≥60% do budget.
	const softFloor = Math.max(1, Math.ceil(budget * 0.6));

	const batches: PlanTaskRef[][] = [];
	let current: PlanTaskRef[] = [];

	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i];
		// Emenda dura ANTES desta task: fecha o batch corrente (se não vazio) antes de adicionar.
		if (current.length > 0 && t.batchBreakBefore) {
			batches.push(current);
			current = [];
		}
		current.push(t);

		const next = tasks[i + 1];
		if (!next) continue; // última task: o batch corrente vai no flush final
		if (cutForbidden(t, next)) continue; // nunca racha um cluster de coesão (overflow permitido)

		const w = sumWeight(current); // budget token-aware: soma de pesos, não contagem (default 1 = count)
		const atBudget = w >= budget;
		const skillSeam = t.skillName !== next.skillName;
		// Fecha: (a) ao atingir o budget, em qualquer emenda permitida; ou (b) numa emenda de skill
		// com o batch já ≥ softFloor (bônus de localização — budget ainda manda, isto só antecipa).
		if (atBudget || (skillSeam && w >= softFloor)) {
			batches.push(current);
			current = [];
		}
	}
	if (current.length > 0) batches.push(current);

	return foldShortTail(batches, budget);
}

/**
 * Funde uma cauda curta (último batch de 1–2 tasks) no batch anterior — regra tlc, evita um worker
 * quase-vazio. NÃO funde se o split da cauda foi FORÇADO por `batchBreakBefore` (respeita a
 * fronteira dura) nem se não há batch anterior.
 */
function foldShortTail(batches: PlanTaskRef[][], _budget: number): PlanTaskRef[][] {
	if (batches.length < 2) return batches;
	const last = batches[batches.length - 1];
	if (last.length > 2) return batches;
	if (last[0]?.batchBreakBefore) return batches; // fronteira dura: não funde
	const prev = batches[batches.length - 2];
	// Não funde através de um cluster de coesão partido (a cauda pertence a outro cluster): seguro
	// porque cutForbidden já impede rachar o MESMO cluster; aqui a cauda tem cohesion distinta/ausente.
	prev.push(...last);
	return batches.slice(0, -1);
}
