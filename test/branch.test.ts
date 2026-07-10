import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBranchName, hasNonHarnessDirt, inferType, normalizeBranchConfig, planBranchAction, sanitizeRef, slugify } from "../src/branch.ts";

test("hasNonHarnessDirt: sujeira .harness/-only N\u00c3O bloqueia; sujeira real bloqueia", () => {
	assert.equal(hasNonHarnessDirt(""), false);
	assert.equal(hasNonHarnessDirt(" M .harness/profile/architecture.md\n?? .harness/runs/f1/plan.json"), false, "harness-owned \u2192 n\u00e3o \u00e9 dirty");
	assert.equal(hasNonHarnessDirt(" M src/app.ts"), true);
	assert.equal(hasNonHarnessDirt(" M .harness/profile/harness.md\n M src/app.ts"), true, "mistura \u2192 dirty (o lado real conta)");
	assert.equal(hasNonHarnessDirt("?? novo-arquivo.txt"), true, "untracked fora de .harness \u2192 dirty");
	assert.equal(hasNonHarnessDirt('?? ".harness/runs/f\u00e9 1/x.json"'), false, "path com aspas (chars especiais) \u2192 desembrulhado");
	assert.equal(hasNonHarnessDirt("R  .harness/profile/a.md -> src/roubado.md"), true, "rename: os DOIS lados contam");
	assert.equal(hasNonHarnessDirt("R  .harness/a.md -> .harness/b.md"), false);
	assert.equal(hasNonHarnessDirt(" M .harnessX/file.ts"), true, "prefixo parecido n\u00e3o passa (exige .harness/)");
});

test("slugify: minúsculo, sem acento, kebab, corta no limite de palavra", () => {
	assert.equal(slugify("Habilitação F1→F2: status, convocação"), "habilitacao-f1-f2-status-convocacao");
	assert.equal(slugify("  Already-Kebab_Case  "), "already-kebab-case");
	assert.equal(slugify("um titulo bem longo que passa do limite imposto", 20), "um-titulo-bem-longo");
});

test("sanitizeRef: remove chars proibidos e segmentos vazios", () => {
	assert.equal(sanitizeRef("feat//-adm-84-"), "feat/adm-84");
	assert.equal(sanitizeRef("feat/ad m:84"), "feat/ad-m-84");
	assert.equal(sanitizeRef("feat/{key}-slug".replace("{key}", "")), "feat/slug");
});

test("deriveBranchName: preenche placeholders e sanitiza", () => {
	assert.equal(deriveBranchName({ template: "{type}/{key}-{slug}", type: "feat", key: "ADM-84", slug: "habilitacao-f1-f2" }), "feat/adm-84-habilitacao-f1-f2");
});

test("deriveBranchName: key vazia → segmento {key} some limpo (sem `feat/-slug`)", () => {
	assert.equal(deriveBranchName({ template: "{type}/{key}-{slug}", type: "feat", key: "", slug: "add-login" }), "feat/add-login");
	assert.equal(deriveBranchName({ template: "{type}/{slug}", type: "fix", slug: "auth-bug" }), "fix/auth-bug");
});

test("deriveBranchName: aliases {linear-key} também funcionam", () => {
	assert.equal(deriveBranchName({ template: "{type}/{linear-key}-{slug}", type: "feat", key: "eng-1", slug: "x" }), "feat/eng-1-x");
});

test("normalizeBranchConfig: defaults + coação tolerante", () => {
	assert.deepEqual(normalizeBranchConfig(undefined), { enabled: true, template: "{type}/{key}-{slug}", defaultType: "feat", base: "main", maxSlugLen: 40 });
	const n = normalizeBranchConfig({ enabled: false, template: "no-placeholder", base: "develop", maxSlugLen: 2 });
	assert.equal(n.enabled, false);
	assert.equal(n.template, "{type}/{key}-{slug}", "template sem {slug} é rejeitado → default");
	assert.equal(n.base, "develop");
	assert.equal(n.maxSlugLen, 40, "maxSlugLen inválido → default");
});

test("planBranchAction: conservador — cria só na base+limpo; senão respeita a atual", () => {
	const base = { name: "feat/adm-84-x", base: "develop", enabled: true };
	// na base, limpo, branch não existe → create
	assert.equal(planBranchAction({ ...base, current: "develop", dirty: false, branchExists: false }).kind, "create");
	// na base, limpo, branch existe → switch (resume)
	assert.equal(planBranchAction({ ...base, current: "develop", dirty: false, branchExists: true }).kind, "switch");
	// já na branch da feature → noop
	assert.equal(planBranchAction({ ...base, current: "feat/adm-84-x", dirty: false, branchExists: true }).kind, "noop");
	// noutra branch (não-base) → skip (respeita)
	const onOther = planBranchAction({ ...base, current: "next", dirty: false, branchExists: false });
	assert.equal(onOther.kind, "skip");
	assert.match(onOther.reason, /respecting the current branch/);
	// na base porém suja → skip
	assert.equal(planBranchAction({ ...base, current: "develop", dirty: true, branchExists: false }).kind, "skip");
	// desligado → skip
	assert.equal(planBranchAction({ ...base, current: "develop", dirty: false, branchExists: false, enabled: false }).kind, "skip");
});

test("inferType: fix/chore/docs por prefixo; senão fallback", () => {
	assert.equal(inferType("Fix: login bug", "feat"), "fix");
	assert.equal(inferType("chore(infra): bump", "feat"), "chore");
	assert.equal(inferType("Habilitação F1→F2", "feat"), "feat");
});
