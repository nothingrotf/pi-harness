/**
 * Re-costura por CONTEXTO — fecha o batch numa fronteira de task quando a sessão do worker já
 * carrega tokens demais, e deixa o resto pra um worker fresco.
 *
 * Por que medir em vez de contar tasks: o budget de batch (doc 05) é denominado em TASKS, mas o
 * que custa é CONTEXTO. Medido no mesmo plano de 10 tasks, o contexto por fronteira cresceu ~24k
 * por task com um modelo e ~51k com outro — 2,1x de diferença na mesma feature. Nenhuma constante
 * em tasks serve os dois: 7 é folgado pra um e apertado pro outro. O `weight` do plano é a
 * estimativa do autor; isto é a medição em execução.
 *
 * Por que compensa (simulado sobre o custo real por turno das duas runs, erro do modelo 0,4%):
 * cortar a 200k levaria a sessão de implementação de $31,47→$15,20 (−52%) num braço e de
 * $26,49→$21,87 (−18%) no outro. `cacheRead` é 87% do custo da sessão e cresce a cada turno; o
 * bootstrap re-escrito num worker novo custa ~28k de cacheWrite, ~$0,07. A troca é barata.
 *
 * As duas travas que impedem virar "um worker por task" (regime que a prática já reprovou):
 *   - **piso de tasks** — uma sessão precisa ter entregue RESEAM_MIN_TASKS antes de poder ser
 *     cortada, senão uma única task pesada (uma delas sozinha somou +182k) fragmentaria o resto;
 *   - **coesão** — o corte só cai onde o batcher estático já podia cortar (`cutForbidden`), então
 *     um cluster coeso nunca é rachado.
 * A emenda é sempre um commit com árvore verde: o worker seguinte herda repo + `git log` + a spec
 * via `next_task`.
 */
import { cutForbidden } from "./batch.ts";
import type { PlanTaskRef } from "./feature-runner.ts";

/** Teto default de contexto por turno (tokens). */
export const DEFAULT_RESEAM_THRESHOLD = 200_000;

/** Tasks que a sessão precisa ter entregue antes de poder ser cortada. */
export const RESEAM_MIN_TASKS = 3;

/**
 * Teto efetivo: env `HARNESS_CONTEXT_RESEAM`. Ausente → default. `0`/inválido → 0 = corte
 * DESLIGADO (a medição de sombra continua; é o interruptor de reversão).
 */
export function reseamThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.HARNESS_CONTEXT_RESEAM;
	if (raw === undefined || raw === "") return DEFAULT_RESEAM_THRESHOLD;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.floor(n);
}

export interface ReseamInput {
	/** contexto do último turno da sessão (tokens); null = sem medida. */
	contextTokens: number | null;
	threshold: number;
	/** tasks DESTE batch já concluídas (o que a sessão entregou). */
	completedInBatch: number;
	/** a task recém-concluída (origem do corte) — undefined numa fronteira sem anterior. */
	prev?: PlanTaskRef;
	/** a próxima task a entregar (destino) — undefined quando o batch acabou. */
	next?: PlanTaskRef;
	minTasks?: number;
}

export interface ReseamDecision {
	/** true = fecha o batch aqui; o resto vai pra um worker fresco. */
	cut: boolean;
	contextTokens: number;
	threshold: number;
	/** por que NÃO cortou (telemetria/depuração) — ausente quando cortou. */
	reason?: "below_threshold" | "min_tasks" | "cohesion" | "no_next" | "disabled" | "no_measure";
}

/** Decisão PURA do corte. Tudo que a impede é explícito e nomeado. */
export function decideReseam(i: ReseamInput): ReseamDecision {
	const ctx = i.contextTokens ?? 0;
	const base = { cut: false as const, contextTokens: ctx, threshold: i.threshold };
	if (i.threshold <= 0) return { ...base, reason: "disabled" };
	if (i.contextTokens === null || ctx <= 0) return { ...base, reason: "no_measure" };
	if (!i.next) return { ...base, reason: "no_next" };
	if (ctx < i.threshold) return { ...base, reason: "below_threshold" };
	if (i.completedInBatch < (i.minTasks ?? RESEAM_MIN_TASKS)) return { ...base, reason: "min_tasks" };
	if (i.prev && cutForbidden(i.prev, i.next)) return { ...base, reason: "cohesion" };
	return { cut: true, contextTokens: ctx, threshold: i.threshold };
}
