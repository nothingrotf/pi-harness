/**
 * Re-costura por contexto — hoje em MODO SOMBRA (mede e loga, NUNCA corta).
 *
 * O batch de ~7 tasks (doc 05, o sweet spot validado do modelo tlc-spec-driven) mede a fatia em
 * CONTAGEM de tasks, mas o que custa é CONTEXTO: numa run real um batch de 6 tasks — dentro do
 * budget — subiu a 466k tokens/turno (sot-38: 385 turnos, $23,77 numa sessão; 97% da conta total é
 * cacheRead de re-leitura do próprio histórico). O próprio tlc-spec-driven prescreve a válvula:
 * "if a batch's task list would likely push the worker's context beyond the budget, close the
 * batch at an earlier phase boundary" — mas como ESTIMATIVA pré-dispatch. Aqui é a versão MEDIDA:
 * o next_task roda dentro da sessão do worker e lê o tamanho real dela a cada fronteira de task.
 *
 * Fases (decisão do usuário — eval antes de cortar de verdade):
 *   1. SOMBRA (isto): loga `task_context` em toda fronteira + `context_reseam_shadow` quando o
 *      teto é excedido. Zero mudança de execução; os números brutos permitem simular QUALQUER
 *      teto offline.
 *   2. (futuro, após eval) corte real: fecha o batch na fronteira e o runner recostura o resto
 *      num worker fresco — respeitando as MESMAS regras de seam do batcher estático (nunca
 *      dentro de um cluster `cohesion`; "never split a phase").
 */

/** Teto default (tokens de contexto/turno). Modelos atuais são 1M; 200k corta só o patológico —
 * no caso real de referência, 200k e 250k produzem o MESMO corte (só a task que cresceu 138k). */
export const DEFAULT_RESEAM_THRESHOLD = 200_000;

/** Teto efetivo: env `HARNESS_CONTEXT_RESEAM` (tokens; 0/negativo/inválido → desliga a medição do
 * marcador wouldCut, mantendo o default para simulação). */
export function reseamThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.HARNESS_CONTEXT_RESEAM;
	if (raw === undefined || raw === "") return DEFAULT_RESEAM_THRESHOLD;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESEAM_THRESHOLD;
	return Math.floor(n);
}

export interface ReseamMeasurement {
	/** contexto do último turno da sessão do worker (tokens). */
	contextTokens: number;
	threshold: number;
	/** true = acima do teto — no modo sombra é só o marcador do eval. */
	wouldCut: boolean;
}

/** Decisão pura da sombra. null quando não há medida (sem session file / sem turno com usage). */
export function measureReseam(contextTokens: number | null, threshold: number): ReseamMeasurement | null {
	if (contextTokens === null || contextTokens <= 0) return null;
	return { contextTokens, threshold, wouldCut: contextTokens >= threshold };
}
