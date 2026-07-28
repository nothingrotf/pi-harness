/**
 * reseam — o corte por CONTEXTO na fronteira de task. O caso que motiva: no mesmo plano de 10
 * tasks, um modelo cresceu ~24k por fronteira e outro ~51k, chegando a 570k tok/turno. Cortar a
 * 200k levaria a sessão de $31,47 → $15,20 (simulado sobre o custo real por turno).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { PlanTaskRef } from "../src/feature-runner.ts";
import { DEFAULT_RESEAM_THRESHOLD, decideReseam, RESEAM_MIN_TASKS, reseamThreshold } from "../src/reseam.ts";
import { lastTurnContext } from "../src/usage.ts";

const T = (id: string, cohesion?: string): PlanTaskRef => ({ id, skillName: "backend", ...(cohesion ? { cohesion } : {}) });
const ok = { contextTokens: 250_000, threshold: 200_000, completedInBatch: 4, prev: T("T4"), next: T("T5") };

test("reseamThreshold: default 200k; env positivo substitui; 0/inválido DESLIGA o corte", () => {
	assert.equal(reseamThreshold({}), DEFAULT_RESEAM_THRESHOLD);
	assert.equal(DEFAULT_RESEAM_THRESHOLD, 200_000);
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "250000" }), 250_000);
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "0" }), 0, "interruptor de reversão");
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "abc" }), 0);
});

test("decideReseam: corta acima do teto numa fronteira legal", () => {
	const d = decideReseam(ok);
	assert.equal(d.cut, true);
	assert.equal(d.contextTokens, 250_000);
	assert.equal(d.reason, undefined);
});

test("decideReseam: abaixo do teto não corta", () => {
	assert.deepEqual(decideReseam({ ...ok, contextTokens: 150_000 }).cut, false);
	assert.equal(decideReseam({ ...ok, contextTokens: 150_000 }).reason, "below_threshold");
	assert.equal(decideReseam({ ...ok, contextTokens: 200_000 }).cut, true, "igual ao teto corta");
});

test("decideReseam: PISO de tasks impede fragmentar (uma task pesada sozinha não corta o resto)", () => {
	assert.equal(RESEAM_MIN_TASKS, 3);
	for (let n = 0; n < RESEAM_MIN_TASKS; n++) {
		const d = decideReseam({ ...ok, contextTokens: 600_000, completedInBatch: n });
		assert.equal(d.cut, false, `${n} tasks entregues não pode cortar`);
		assert.equal(d.reason, "min_tasks");
	}
	assert.equal(decideReseam({ ...ok, completedInBatch: RESEAM_MIN_TASKS }).cut, true);
});

test("decideReseam: cluster de COESÃO nunca é rachado, por mais alto que esteja o contexto", () => {
	const d = decideReseam({ ...ok, contextTokens: 900_000, prev: T("T4", "asr-orchestration"), next: T("T5", "asr-orchestration") });
	assert.equal(d.cut, false);
	assert.equal(d.reason, "cohesion");
	// tags diferentes = fronteira legal
	assert.equal(decideReseam({ ...ok, prev: T("T4", "a"), next: T("T5", "b") }).cut, true);
});

test("decideReseam: sem próxima task, sem medida, ou desligado → nunca corta", () => {
	assert.equal(decideReseam({ ...ok, next: undefined }).reason, "no_next");
	assert.equal(decideReseam({ ...ok, contextTokens: null }).reason, "no_measure");
	assert.equal(decideReseam({ ...ok, threshold: 0 }).reason, "disabled");
});

test("decideReseam contra a série REAL medida (10 tasks, dois modelos)", () => {
	// Fronteiras observadas em sotaq. Ambas as séries são de UMA sessão (o bug do fold do batcher).
	const series = {
		opus: [60, 87, 113, 116, 161, 168, 181, 263, 276, 293, 301],
		sonnet: [61, 108, 140, 152, 225, 245, 270, 452, 466, 555, 570],
	};
	const cuts = (s: number[]) =>
		s.filter((k, i) => decideReseam({ contextTokens: k * 1000, threshold: 200_000, completedInBatch: i + 1, prev: T(`T${i + 1}`), next: T(`T${i + 2}`) }).cut).length;
	assert.ok(cuts(series.opus) > 0, "o braço de 301k seria cortado");
	assert.ok(cuts(series.sonnet) > cuts(series.opus), "o braço mais verboso é cortado mais vezes — a razão de medir em vez de contar tasks");
});

test("lastTurnContext: pega o ÚLTIMO turno assistant (não soma), tolera linha parcial, null sem ficheiro", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reseam-"));
	const f = path.join(d, "s.jsonl");
	const turn = (input: number, cacheRead: number, cacheWrite: number) => JSON.stringify({ message: { role: "assistant", usage: { input, cacheRead, cacheWrite, output: 100 } } });
	fs.writeFileSync(f, [JSON.stringify({ type: "meta" }), turn(2, 0, 29_000), JSON.stringify({ message: { role: "user" } }), turn(5, 180_000, 1_000), '{"corta'].join("\n"));
	assert.equal(lastTurnContext(f), 5 + 180_000 + 1_000, "último turno = tamanho atual da conversa");
	assert.equal(lastTurnContext(path.join(d, "nope.jsonl")), null);
	assert.equal(lastTurnContext(undefined), null);
	fs.writeFileSync(f, JSON.stringify({ type: "meta" }));
	assert.equal(lastTurnContext(f), null, "sem turno com usage → null");
	fs.rmSync(d, { recursive: true, force: true });
});

test("lastTurnContext contra uma sessão REAL (a que chegou a 570k)", () => {
	const real = path.join(os.homedir(), "Workspaces/sotaq/.harness/runs/pr-d-typed-extraction/sessions");
	if (!fs.existsSync(real)) return;
	const files = fs.readdirSync(real).filter((x) => x.endsWith(".jsonl"));
	if (files.length === 0) return;
	const measured = files.map((x) => lastTurnContext(path.join(real, x))).filter((x): x is number => x !== null);
	assert.ok(measured.length > 0, "lê sessões reais do harness");
	assert.ok(Math.max(...measured) > 50_000, "mede contexto de verdade");
});
