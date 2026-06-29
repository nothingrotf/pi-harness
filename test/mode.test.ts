import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeText, featureIdFromRequest, idleMode, phaseGlyph, statusDetail, statusText } from "../src/mode.ts";

test("featureIdFromRequest: slug ascii sem acento, ≤40, fallback", () => {
	assert.equal(featureIdFromRequest("Adicionar reset de senha"), "adicionar-reset-de-senha");
	assert.equal(featureIdFromRequest("Configuração de e-mail!!!"), "configuracao-de-e-mail");
	assert.equal(featureIdFromRequest("   "), "feature");
	assert.equal(featureIdFromRequest("...///"), "feature");
	const long = featureIdFromRequest("x".repeat(100));
	assert.ok(long.length <= 40, "trunca em 40");
	assert.ok(!long.endsWith("-"), "sem hífen sobrando após o slice");
});

test("phaseGlyph: um glyph text-presentation por fase", () => {
	assert.equal(phaseGlyph("converge"), "◆");
	assert.equal(phaseGlyph("run"), "▸");
	assert.equal(phaseGlyph("ship"), "✦");
	assert.equal(phaseGlyph("setup"), "⊙");
	assert.equal(phaseGlyph("readiness"), "▢");
	assert.equal(phaseGlyph("idle"), "○");
});

test("badgeText: idle vs ativo (com glyph da fase)", () => {
	assert.equal(badgeText(idleMode()), "⬢ pi-harness");
	assert.equal(
		badgeText({ active: true, featureId: "reset-senha", phase: "converge" }),
		"⬢ pi-harness · reset-senha · ◆ converge",
	);
});

test("statusText: inativo vs glyph+fase+readiness", () => {
	assert.equal(statusText(idleMode()), "pi-harness: inativo");
	assert.equal(statusText({ active: true, featureId: "x", phase: "run" }), "▸ run");
	assert.equal(statusText({ active: true, featureId: "x", phase: "ship", readinessLevel: 4 }), "✦ ship · readiness L4");
});

test("statusDetail: rico com progresso; omite partes ausentes/zero", () => {
	assert.equal(statusDetail(idleMode()), "pi-harness: inativo");
	// sem progresso
	assert.equal(statusDetail({ active: true, featureId: "reset", phase: "converge" }), "⬢ pi-harness · reset · ◆ converge");
	// com progresso + readiness + falhas
	const full = statusDetail(
		{ active: true, featureId: "reset", phase: "run", readinessLevel: 4 },
		{ tasksTotal: 3, tasksDone: 2, assertionsTotal: 8, assertionsPassed: 5, assertionsFailed: 1 },
	);
	assert.equal(full, "⬢ pi-harness · reset · ▸ run · readiness L4 · tasks 2/3 · assertions 5/8 (1 failed)");
	// progresso zerado → omite tasks/assertions
	assert.equal(
		statusDetail({ active: true, featureId: "x", phase: "converge" }, { tasksTotal: 0, tasksDone: 0, assertionsTotal: 0, assertionsPassed: 0, assertionsFailed: 0 }),
		"⬢ pi-harness · x · ◆ converge",
	);
});
