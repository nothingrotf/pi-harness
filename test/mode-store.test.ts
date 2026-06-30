import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearMode, loadMode, saveMode } from "../src/mode-store.ts";
import { idleMode } from "../src/mode.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-modestore-"));
}

test("saveMode/loadMode: round-trip do ponteiro ativo", () => {
	const d = tmp();
	assert.equal(loadMode(d), null, "sem ficheiro → null");
	saveMode(d, { active: true, featureId: "add-rate-limiter", phase: "converge" });
	assert.deepEqual(loadMode(d), { active: true, featureId: "add-rate-limiter", phase: "converge" });
});

test("saveMode: inativo (ou sem featureId) limpa o ponteiro", () => {
	const d = tmp();
	saveMode(d, { active: true, featureId: "x", phase: "run" });
	assert.ok(loadMode(d));
	saveMode(d, idleMode()); // active:false → clear
	assert.equal(loadMode(d), null);
});

test("clearMode: remove o ponteiro; idempotente", () => {
	const d = tmp();
	saveMode(d, { active: true, featureId: "x", phase: "run" });
	clearMode(d);
	assert.equal(loadMode(d), null);
	clearMode(d); // não lança quando já ausente
});

test("loadMode: ponteiro inválido (sem featureId) → null", () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, ".harness", "runs"), { recursive: true });
	fs.writeFileSync(path.join(d, ".harness", "runs", ".session.json"), JSON.stringify({ active: true }));
	assert.equal(loadMode(d), null);
});

test("loadMode: default phase 'run' quando ausente no ficheiro", () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, ".harness", "runs"), { recursive: true });
	fs.writeFileSync(path.join(d, ".harness", "runs", ".session.json"), JSON.stringify({ active: true, featureId: "x" }));
	assert.equal(loadMode(d)?.phase, "run");
});
