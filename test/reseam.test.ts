/**
 * reseam — a re-costura por contexto em MODO SOMBRA. Mede o contexto real da sessão do worker a
 * cada fronteira de task; nunca corta (fase de eval — decisão do usuário). O caso que motiva: um
 * batch de 6 tasks, dentro do budget de 7, subiu a 466k tok/turno sem nenhum sinal visível.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_RESEAM_THRESHOLD, measureReseam, reseamThreshold } from "../src/reseam.ts";
import { lastTurnContext } from "../src/usage.ts";

test("reseamThreshold: default 200k; env válido substitui; inválido/0 volta ao default", () => {
	assert.equal(reseamThreshold({}), DEFAULT_RESEAM_THRESHOLD);
	assert.equal(DEFAULT_RESEAM_THRESHOLD, 200_000);
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "250000" }), 250_000);
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "0" }), DEFAULT_RESEAM_THRESHOLD);
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "abc" }), DEFAULT_RESEAM_THRESHOLD);
	assert.equal(reseamThreshold({ HARNESS_CONTEXT_RESEAM: "" }), DEFAULT_RESEAM_THRESHOLD);
});

test("measureReseam: acima do teto marca wouldCut; abaixo não; sem medida → null", () => {
	assert.deepEqual(measureReseam(466_000, 200_000), { contextTokens: 466_000, threshold: 200_000, wouldCut: true });
	assert.deepEqual(measureReseam(145_000, 200_000), { contextTokens: 145_000, threshold: 200_000, wouldCut: false });
	assert.deepEqual(measureReseam(200_000, 200_000)?.wouldCut, true, "igual ao teto conta");
	assert.equal(measureReseam(null, 200_000), null);
	assert.equal(measureReseam(0, 200_000), null);
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

test("lastTurnContext contra uma sessão REAL do sot-38 (o batch que subiu a 466k)", () => {
	const real = path.join(os.homedir(), "Workspaces/sotaq/.harness/runs/linear-sot-38/sessions/2026-07-11T14-27-17-808Z_ws_1m72dw9d.jsonl");
	if (!fs.existsSync(real)) return;
	const ctx = lastTurnContext(real);
	assert.ok(ctx !== null && ctx > 400_000, `a sessão patológica mede >400k (deu ${ctx})`);
	assert.equal(measureReseam(ctx, 200_000)?.wouldCut, true, "a sombra teria acusado");
});
