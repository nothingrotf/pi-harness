import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { READINESS_CRITERIA, type ReadinessReport } from "../src/readiness.ts";
import {
	auditLogPath,
	ensureReadinessInputs,
	readRun,
	readSnapshot,
	repoFingerprint,
	snapshotPath,
	storeReport,
	writeRun,
} from "../src/readiness-pipeline.ts";

function tmpRepo(withGit = true): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-readiness-"));
	if (withGit) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

function fullReport(apps = 1): ReadinessReport {
	const evals: ReadinessReport["evals"] = {};
	for (const crit of READINESS_CRITERIA) {
		const den = crit.scope === "repository" ? 1 : apps;
		evals[crit.id] = { num: crit.cloudOnly ? null : den, den, rationale: "ok" };
	}
	return { evals, apps };
}

test("ensureReadinessInputs: cria profile dir; sem .git → not ok", () => {
	const noGit = tmpRepo(false);
	const r1 = ensureReadinessInputs(noGit);
	assert.equal(r1.ok, false);
	assert.match(r1.issues.join(" "), /git/);
	assert.ok(fs.existsSync(path.join(noGit, ".harness", "profile")), "criou o dir mesmo assim");

	const withGit = tmpRepo(true);
	assert.equal(ensureReadinessInputs(withGit).ok, true);
});

test("storeReport: valida, grava readiness.json + trilha, e readSnapshot faz round-trip", () => {
	const dir = tmpRepo(true);
	const res = storeReport(dir, fullReport(1), "fp123");
	assert.ok(res.ok, `esperava ok, issues: ${res.issues.join(" | ")}`);
	assert.ok(fs.existsSync(snapshotPath(dir)));
	assert.equal(res.snapshot?.level, 5);
	assert.equal(res.snapshot?.fingerprint, "fp123");

	const round = readSnapshot(dir);
	assert.ok(round);
	assert.equal(round?.level, 5);
	assert.equal(round?.passRate, 1);

	// trilha tem o evento snapshot_stored
	const log = fs.readFileSync(auditLogPath(dir), "utf8");
	assert.match(log, /snapshot_stored/);
});

test("storeReport: report inválido é rejeitado e NÃO grava snapshot", () => {
	const dir = tmpRepo(true);
	const bad = fullReport(1);
	delete bad.evals.readme; // critério ausente → contrato quebrado
	const res = storeReport(dir, bad, "fp");
	assert.equal(res.ok, false);
	assert.match(res.issues.join(" "), /missing criterion: readme/);
	assert.equal(fs.existsSync(snapshotPath(dir)), false, "não deve gravar snapshot inválido");
	assert.match(fs.readFileSync(auditLogPath(dir), "utf8"), /report_rejected/);
});

test("readSnapshot: ausente → null; repoFingerprint nunca lança", () => {
	const dir = tmpRepo(false);
	assert.equal(readSnapshot(dir), null);
	assert.equal(typeof repoFingerprint(dir), "string"); // sem refs → "uncomputed"
});

test("readRun/writeRun: round-trip do estado do runner (state.json analog)", () => {
	const dir = tmpRepo(true);
	assert.equal(readRun(dir), null);
	const run = { runId: "rdy_1", status: "paused", steps: [], createdAt: "t", updatedAt: "t" };
	writeRun(dir, run);
	const back = readRun<typeof run>(dir);
	assert.equal(back?.runId, "rdy_1");
	assert.equal(back?.status, "paused");
});
