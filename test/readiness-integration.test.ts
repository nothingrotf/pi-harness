/**
 * Integração real do runner: spawna um subprocesso de verdade (um `pi` FAKE,
 * sem LLM/custo) e exercita o pipeline inteiro — planAuditRun → runLoop →
 * makeRealSpawn (child_process real) → child grava readiness.json → auditSucceeded
 * lê o arquivo → completed. Valida a fiação que os unit tests (spawn injetado)
 * não tocam: child_process, cwd, temp-prompt lifecycle, close/abort, fs real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSnapshot, snapshotPath } from "../src/readiness-pipeline.ts";
import { planAuditRun, planFixRun, runLoop } from "../src/readiness-runner.ts";
import { makeRealSpawn } from "../src/readiness-spawn.ts";

const skipOnWindows = process.platform === "win32";

function tmpRepo(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-rt-"));
}

/** Cria um `pi` fake executável com o comportamento dado. */
function fakePi(body: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-"));
	const file = path.join(dir, "pi");
	fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
	return file;
}

const VALID_SNAPSHOT = JSON.stringify({ version: 1, generatedAt: "t", fingerprint: "f", apps: 1, evals: {}, level: 1, passRate: 0 });

test("e2e: audit spawna child real que grava o snapshot → run completed", { skip: skipOnWindows }, async () => {
	const repo = tmpRepo();
	// fake pi: grava .harness/profile/readiness.json no cwd e sai 0
	const bin = fakePi(`mkdir -p "$PWD/.harness/profile"\ncat > "$PWD/.harness/profile/readiness.json" <<'JSON'\n${VALID_SNAPSHOT}\nJSON\nexit 0`);

	const run = planAuditRun("audit prompt");
	await runLoop(repo, run, {
		spawn: makeRealSpawn({ bin }),
		auditSucceeded: (cwd) => readSnapshot(cwd) !== null,
	});

	assert.equal(run.status, "completed", "run completou");
	assert.equal(run.steps[0].status, "completed");
	assert.ok(fs.existsSync(snapshotPath(repo)), "child gravou readiness.json");
	assert.equal(readSnapshot(repo)?.version, 1);
});

test("e2e: child que NÃO grava snapshot → audit re-tenta e pausa (budget)", { skip: skipOnWindows }, async () => {
	const repo = tmpRepo();
	const bin = fakePi("exit 0"); // sai 0 mas não grava nada → auditSucceeded false

	const run = planAuditRun("p");
	await runLoop(repo, run, { spawn: makeRealSpawn({ bin }), auditSucceeded: (cwd) => readSnapshot(cwd) !== null, budget: 2 });

	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "step_retry_limit_exceeded");
	assert.equal(fs.existsSync(snapshotPath(repo)), false);
});

test("e2e: fix sequencial spawna um child real por critério → completed", { skip: skipOnWindows }, async () => {
	const repo = tmpRepo();
	const bin = fakePi("exit 0"); // fix: sucesso = exit 0 (não depende de snapshot)
	const run = planFixRun([
		{ criterionId: "lint_config", prompt: "p1" },
		{ criterionId: "readme", prompt: "p2" },
	]);
	await runLoop(repo, run, { spawn: makeRealSpawn({ bin }), auditSucceeded: () => true });
	assert.equal(run.status, "completed");
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("e2e: abort mata o child em andamento → paused 'aborted'", { skip: skipOnWindows }, async () => {
	const repo = tmpRepo();
	const bin = fakePi('sleep 5\nexit 0'); // child lento
	const run = planAuditRun("p");
	const ac = new AbortController();
	const p = runLoop(repo, run, { spawn: makeRealSpawn({ bin }), auditSucceeded: () => true }, ac.signal);
	setTimeout(() => ac.abort(), 100);
	await p;
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "aborted");
});
