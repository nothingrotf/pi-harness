import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changedParts, combinedFingerprint, computeFingerprint, computeFingerprintParts } from "../src/fingerprint.ts";
import { ensureProfile, readProfile, storeProfile } from "../src/profile.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-profile-"));
}
function write(dir: string, rel: string, content: string): void {
	const abs = path.join(dir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

test("computeFingerprint: determinístico (mesmo conteúdo → mesmo hash)", () => {
	const a = tmp();
	const b = tmp();
	for (const d of [a, b]) {
		write(d, "package-lock.json", '{"x":1}');
		write(d, "AGENTS.md", "# rules\n");
		write(d, ".agents/rules/style.md", "no emojis");
		write(d, "tsconfig.json", '{"strict":true}');
	}
	assert.equal(computeFingerprint(a), computeFingerprint(b), "repos idênticos → fingerprint igual");
	// re-rodar no mesmo repo é estável
	assert.equal(computeFingerprint(a), computeFingerprint(a));
});

test("computeFingerprintParts: muda só a parte afetada", () => {
	const d = tmp();
	write(d, "package-lock.json", "v1");
	write(d, "AGENTS.md", "rules-v1");
	write(d, "tsconfig.json", "cfg-v1");
	const p0 = computeFingerprintParts(d);

	write(d, "package-lock.json", "v2"); // muda lockfiles
	const p1 = computeFingerprintParts(d);
	assert.deepEqual(changedParts(p0, p1), ["lockfiles"]);

	write(d, "AGENTS.md", "rules-v2"); // muda rules também
	const p2 = computeFingerprintParts(d);
	assert.deepEqual(changedParts(p1, p2), ["rules"]);
	assert.notEqual(combinedFingerprint(p0), combinedFingerprint(p2));
});

test("computeFingerprint: repo vazio é estável (sem inputs)", () => {
	assert.equal(computeFingerprint(tmp()), computeFingerprint(tmp()));
});

/** Autora o conteúdo mínimo do profile (o que a setup skill produziria). */
function authorProfile(dir: string): void {
	for (const f of ["architecture.md", "services.yaml", "init.sh", "harness.md"]) write(dir, `.harness/profile/${f}`, "x");
	write(dir, ".harness/profile/skills/w/SKILL.md", "x");
	write(dir, ".harness/profile/library/repo-facts.md", "x");
	write(dir, ".harness/profile/library/conventions-map.md", "x");
}

test("ensureProfile: absent sem profile.json (gate read-only não escreve)", () => {
	const d = tmp();
	write(d, "package-lock.json", "v1");
	const r = ensureProfile(d);
	assert.equal(r.status, "absent");
	assert.equal(r.profile, null);
	assert.equal(readProfile(d), null, "o gate NÃO estampa profile.json");
});

test("storeProfile: recusa sem conteúdo; estampa com conteúdo; ok → drift → re-store", () => {
	const d = tmp();
	write(d, "package-lock.json", "v1");
	write(d, "AGENTS.md", "rules");

	// sem conteúdo autorado → recusa e NÃO escreve (corrige o baseline prematuro)
	const bad = storeProfile(d);
	assert.equal(bad.ok, false);
	assert.ok(!bad.ok && bad.missing.length > 0, "reporta artefatos ausentes");
	assert.equal(readProfile(d), null, "recusa não estampa profile.json");

	// autora o conteúdo → estampa
	authorProfile(d);
	const good = storeProfile(d);
	assert.ok(good.ok && good.profile.version === 1, "estampou");
	assert.ok(readProfile(d), "gravou profile.json só depois do conteúdo existir");
	assert.equal(ensureProfile(d).status, "ok");

	// muda lockfile → drift (advisory, não reescreve)
	const before = readProfile(d)?.fingerprint.lockfiles;
	write(d, "package-lock.json", "v2");
	const drift = ensureProfile(d);
	assert.equal(drift.status, "drift");
	assert.deepEqual(drift.changed, ["lockfiles"]);
	assert.equal(readProfile(d)?.fingerprint.lockfiles, before, "drift não reescreve");

	// re-store reconcilia
	assert.ok(storeProfile(d).ok);
	assert.notEqual(readProfile(d)?.fingerprint.lockfiles, before);
	assert.equal(ensureProfile(d).status, "ok");
});

test("storeProfile: now injetável (generatedAt determinístico em teste)", () => {
	const d = tmp();
	authorProfile(d);
	const r = storeProfile(d, { now: () => "2026-06-29T00:00:00Z" });
	assert.ok(r.ok && r.profile.generatedAt === "2026-06-29T00:00:00Z");
});
