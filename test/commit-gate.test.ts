import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_COMMIT_GATE_TIMEOUT_SEC, normalizeCommitGateConfig, readCommitGateConfig, runCommitGate, tail } from "../src/commit-gate.ts";

test("normalizeCommitGateConfig: sem objeto ou sem command → undefined (sem gate)", () => {
	assert.equal(normalizeCommitGateConfig(undefined), undefined);
	assert.equal(normalizeCommitGateConfig(null), undefined);
	assert.equal(normalizeCommitGateConfig("bun run check"), undefined);
	assert.equal(normalizeCommitGateConfig({}), undefined);
	assert.equal(normalizeCommitGateConfig({ command: "   " }), undefined);
	assert.equal(normalizeCommitGateConfig({ enabled: true }), undefined);
});

test("normalizeCommitGateConfig: defaults + coação tolerante", () => {
	assert.deepEqual(normalizeCommitGateConfig({ command: "bun run typecheck" }), { enabled: true, command: "bun run typecheck", timeoutSec: DEFAULT_COMMIT_GATE_TIMEOUT_SEC });
	const n = normalizeCommitGateConfig({ command: " tsc --noEmit ", enabled: false, timeoutSec: 42.9 });
	assert.deepEqual(n, { enabled: false, command: "tsc --noEmit", timeoutSec: 42 });
	assert.equal(normalizeCommitGateConfig({ command: "x", timeoutSec: -1 })?.timeoutSec, DEFAULT_COMMIT_GATE_TIMEOUT_SEC, "timeout inválido → default");
});

test("readCommitGateConfig: lê delivery.json; disabled/ausente/inválido → undefined", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-"));
	const profile = path.join(dir, ".harness", "profile");
	fs.mkdirSync(profile, { recursive: true });
	// sem delivery.json
	assert.equal(readCommitGateConfig(dir), undefined);
	// com gate
	fs.writeFileSync(path.join(profile, "delivery.json"), JSON.stringify({ branch: { base: "main" }, commitGate: { command: "true", timeoutSec: 5 } }));
	assert.deepEqual(readCommitGateConfig(dir), { enabled: true, command: "true", timeoutSec: 5 });
	// disabled → undefined (o caller não roda nada)
	fs.writeFileSync(path.join(profile, "delivery.json"), JSON.stringify({ commitGate: { command: "true", enabled: false } }));
	assert.equal(readCommitGateConfig(dir), undefined);
	// JSON inválido → undefined, sem lançar
	fs.writeFileSync(path.join(profile, "delivery.json"), "{nope");
	assert.equal(readCommitGateConfig(dir), undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("tail: curto intacto; longo corta pelo FIM (onde o erro mora)", () => {
	assert.equal(tail("ok\n"), "ok");
	const long = `${"x".repeat(3000)}THE-ERROR`;
	const t = tail(long, 100);
	assert.ok(t.endsWith("THE-ERROR"));
	assert.ok(t.startsWith("…(truncated)…"));
});

test("runCommitGate: verde (exit 0) → ok com output", () => {
	const r = runCommitGate(process.cwd(), { enabled: true, command: "echo all-green", timeoutSec: 10 });
	assert.equal(r.ok, true);
	assert.equal(r.timedOut, false);
	assert.equal(r.output, "all-green");
});

test("runCommitGate: vermelho (exit != 0) → fail com stdout+stderr capturados, sem lançar", () => {
	const r = runCommitGate(process.cwd(), { enabled: true, command: "echo build-broke; echo err-detail >&2; exit 1", timeoutSec: 10 });
	assert.equal(r.ok, false);
	assert.equal(r.timedOut, false);
	assert.ok(r.output.includes("build-broke"));
	assert.ok(r.output.includes("err-detail"));
});

test("runCommitGate: timeout → fail com timedOut (nunca pendura o worker)", () => {
	const r = runCommitGate(process.cwd(), { enabled: true, command: "sleep 5", timeoutSec: 1 });
	assert.equal(r.ok, false);
	assert.equal(r.timedOut, true);
});
