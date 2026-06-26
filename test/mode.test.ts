import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeText, featureIdFromRequest, idleMode, statusText } from "../src/mode.ts";

test("featureIdFromRequest: slug ascii sem acento, ≤40, fallback", () => {
	assert.equal(featureIdFromRequest("Adicionar reset de senha"), "adicionar-reset-de-senha");
	assert.equal(featureIdFromRequest("Configuração de e-mail!!!"), "configuracao-de-e-mail");
	assert.equal(featureIdFromRequest("   "), "feature");
	assert.equal(featureIdFromRequest("...///"), "feature");
	const long = featureIdFromRequest("x".repeat(100));
	assert.ok(long.length <= 40, "trunca em 40");
	assert.ok(!long.endsWith("-"), "sem hífen sobrando após o slice");
});

test("badgeText: idle vs ativo", () => {
	assert.equal(badgeText(idleMode()), "⬢ pi-harness");
	assert.equal(
		badgeText({ active: true, featureId: "reset-senha", phase: "converge" }),
		"⬢ pi-harness · reset-senha · converge",
	);
});

test("statusText: inativo vs fase+readiness", () => {
	assert.equal(statusText(idleMode()), "pi-harness: inativo");
	assert.equal(statusText({ active: true, featureId: "x", phase: "run" }), "run");
	assert.equal(statusText({ active: true, featureId: "x", phase: "ship", readinessLevel: 4 }), "ship · readiness L4");
});
