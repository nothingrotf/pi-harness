/**
 * branch-ops — o lado git (execução) do branch-per-feature. Testa a detecção da base efetiva
 * (main×master) e a decisão conservadora contra um repo git REAL temporário.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureFeatureBranch, resolveBase } from "../src/branch-ops.ts";
import type { BranchConfig } from "../src/branch.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

/** Cria um repo git com uma branch inicial nomeada + 1 commit. */
function makeRepo(initialBranch: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-branchops-"));
	git(dir, "init", "-b", initialBranch);
	git(dir, "config", "user.email", "t@t.t");
	git(dir, "config", "user.name", "t");
	fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "init");
	return dir;
}

const cfg = (over: Partial<BranchConfig> = {}): BranchConfig => ({ enabled: true, template: "{type}/{key}-{slug}", defaultType: "feat", base: "main", maxSlugLen: 40, ...over });

test("resolveBase: base configurada existe → usa-a", () => {
	const dir = makeRepo("develop");
	try {
		assert.equal(resolveBase(dir, "develop"), "develop");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveBase: base configurada ('main') ausente, repo é 'master' → detecta 'master'", () => {
	const dir = makeRepo("master");
	try {
		// sem branch 'main' — a detecção deve cair na default real do repo.
		assert.equal(resolveBase(dir, "main"), "master");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureFeatureBranch: em 'master' limpo com base default 'main' → CRIA a branch (via detecção)", () => {
	const dir = makeRepo("master");
	try {
		const r = ensureFeatureBranch(dir, "add login", cfg());
		assert.equal(r.kind, "create");
		assert.equal(r.base, "master");
		assert.equal(r.mutated, true);
		// realmente trocou pra branch nova
		const now = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
		assert.equal(now, r.branch);
		assert.notEqual(now, "master");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureFeatureBranch: árvore suja → skip (conservador, não move trabalho)", () => {
	const dir = makeRepo("master");
	try {
		fs.writeFileSync(path.join(dir, "dirty.txt"), "wip");
		const r = ensureFeatureBranch(dir, "add login", cfg());
		assert.equal(r.kind, "skip");
		assert.match(r.reason, /dirty/);
		// continua em master
		const now = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
		assert.equal(now, "master");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureFeatureBranch: já na branch da feature → noop", () => {
	const dir = makeRepo("master");
	try {
		const first = ensureFeatureBranch(dir, "add login", cfg());
		assert.equal(first.kind, "create");
		const again = ensureFeatureBranch(dir, "add login", cfg());
		assert.equal(again.kind, "noop");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("ensureFeatureBranch: desabilitado (delivery.json) → skip", () => {
	const dir = makeRepo("master");
	try {
		const r = ensureFeatureBranch(dir, "add login", cfg({ enabled: false }));
		assert.equal(r.kind, "skip");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
