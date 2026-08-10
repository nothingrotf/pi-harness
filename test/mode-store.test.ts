import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearMode, liveLockedFeature, loadMode, readRunLockPid, renameModePointer, resolveSessionMode, saveMode } from "../src/mode-store.ts";
import { idleMode } from "../src/mode.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-modestore-"));
}

/** Escreve um run.lock com o pid dado em .harness/runs/<id>/run.lock. */
function writeLock(cwd: string, featureId: string, pid: number): void {
	const dir = path.join(cwd, ".harness", "runs", featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "run.lock"), `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`);
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

test("renameModePointer: ponteiro segue o rename do run; outro id fica intacto", () => {
	const d = tmp();
	saveMode(d, { active: true, featureId: "feat-old", phase: "run" });
	renameModePointer(d, "feat-old", "feat-new");
	assert.equal(loadMode(d)?.featureId, "feat-new");
	renameModePointer(d, "feat-zzz", "feat-x"); // id que não é o do ponteiro → no-op
	assert.equal(loadMode(d)?.featureId, "feat-new");
});

test("readRunLockPid: lê o pid do run.lock; ausente/ilegível → null", () => {
	const d = tmp();
	assert.equal(readRunLockPid(d, "nope"), null, "sem run.lock → null");
	writeLock(d, "f1", 4321);
	assert.equal(readRunLockPid(d, "f1"), 4321);
	fs.writeFileSync(path.join(d, ".harness", "runs", "f1", "run.lock"), "not json");
	assert.equal(readRunLockPid(d, "f1"), null, "corrompido → null");
});

test("liveLockedFeature: prefere um run.lock com pid VIVO ao ponteiro stale", () => {
	const d = tmp();
	writeLock(d, "f-dead", 111);
	writeLock(d, "f-live", 222);
	const alive = (pid: number): boolean => pid === 222; // só f-live está vivo
	// o ponteiro (`prefer`) aponta pra f-dead — a feature viva ganha (auto-heal).
	assert.equal(liveLockedFeature(d, ["f-dead", "f-live"], { prefer: "f-dead", pidAlive: alive }), "f-live");
});

test("liveLockedFeature: nenhum lock vivo → null (caller mantém o ponteiro)", () => {
	const d = tmp();
	writeLock(d, "f1", 111);
	assert.equal(liveLockedFeature(d, ["f1", "f2"], { pidAlive: () => false }), null);
	assert.equal(liveLockedFeature(d, [], { pidAlive: () => true }), null, "sem features → null");
});

test("liveLockedFeature: não troca à toa — se `prefer` está vivo, mantém-no", () => {
	const d = tmp();
	writeLock(d, "a", 10);
	writeLock(d, "b", 20);
	// ambos vivos; prefer=b deve ganhar mesmo não sendo o primeiro da lista.
	assert.equal(liveLockedFeature(d, ["a", "b"], { prefer: "b", pidAlive: () => true }), "b");
	// sem prefer (ou prefer morto) → primeiro vivo da lista.
	assert.equal(liveLockedFeature(d, ["a", "b"], { pidAlive: () => true }), "a");
	assert.equal(liveLockedFeature(d, ["a", "b"], { prefer: "zzz", pidAlive: () => true }), "a");
});


test("resolveSessionMode: startup não restaura um ponteiro sem run vivo", () => {
	const restored = { active: true as const, featureId: "stale", phase: "run" as const };
	assert.equal(resolveSessionMode("startup", restored, null), null);
});

test("resolveSessionMode: reload preserva o modo e um run vivo ganha do ponteiro", () => {
	const restored = { active: true as const, featureId: "stale", phase: "ship" as const };
	assert.deepEqual(resolveSessionMode("reload", restored, null), restored);
	assert.deepEqual(resolveSessionMode("startup", restored, "live"), { active: true, featureId: "live", phase: "run" });
});
