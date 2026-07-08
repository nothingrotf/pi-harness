import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRefreshDispatch, buildRefreshPlan, detectClobber, listProfileContent, refreshPlanFor } from "../src/reconcile.ts";
import { storeProfile } from "../src/profile.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-reconcile-"));
}
function write(dir: string, rel: string, content: string): void {
	const abs = path.join(dir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}
function authorProfile(dir: string): void {
	for (const f of ["architecture.md", "services.yaml", "init.sh", "harness.md"]) write(dir, `.harness/profile/${f}`, "x");
	write(dir, ".harness/profile/delivery.json", '{"branch":{"enabled":true}}');
	write(dir, ".harness/profile/skills/w/SKILL.md", "x");
	write(dir, ".harness/profile/library/repo-facts.md", "x");
	write(dir, ".harness/profile/library/conventions-map.md", "x");
	write(dir, ".harness/profile/library/coding-principles.md", "x");
}

test("buildRefreshPlan: cada parte → seus artefatos + estratégia", () => {
	const tool = buildRefreshPlan(["toolcfg"]);
	assert.deepEqual(tool.parts, ["toolcfg"]);
	const svc = tool.artifacts.find((a) => a.file === "services.yaml");
	assert.ok(svc && svc.strategy === "additive-merge", "toolcfg → services.yaml additive-merge");

	const rules = buildRefreshPlan(["rules"]);
	assert.ok(rules.artifacts.find((a) => a.file === "library/conventions-map.md" && a.strategy === "regenerate"), "rules → conventions-map regenerate");
	assert.ok(rules.artifacts.find((a) => a.file === "skills/" && a.strategy === "review"));

	const locks = buildRefreshPlan(["lockfiles"]);
	assert.ok(locks.artifacts.find((a) => a.file === "library/" && a.strategy === "append-merge"), "lockfiles → library append-merge");
});

test("buildRefreshPlan: dedupe de artefato em 2+ partes (architecture.md aparece 1x)", () => {
	const both = buildRefreshPlan(["lockfiles", "toolcfg"]);
	const arch = both.artifacts.filter((a) => a.file === "architecture.md");
	assert.equal(arch.length, 1, "architecture.md (em lockfiles E toolcfg) deduplicado");
});

test("buildRefreshPlan: changed vazio = refresh forçado → todas as partes", () => {
	const all = buildRefreshPlan([]);
	assert.deepEqual(all.parts, ["lockfiles", "rules", "toolcfg"]);
	assert.ok(all.artifacts.find((a) => a.file === "services.yaml"));
	assert.ok(all.artifacts.find((a) => a.file === "library/conventions-map.md"));
});

test("buildRefreshPlan: ignora partes desconhecidas", () => {
	const r = buildRefreshPlan(["bogus"]);
	assert.deepEqual(r.parts, ["lockfiles", "rules", "toolcfg"], "só lixo → trata como refresh forçado");
});

test("detectClobber: pega artefato que sumiu/zerou; vazio quando nada foi perdido", () => {
	const before = ["architecture.md", "library/repo-facts.md", "services.yaml"];
	assert.deepEqual(detectClobber(before, ["architecture.md", "services.yaml"]), ["library/repo-facts.md"], "sumido = clobber");
	assert.deepEqual(detectClobber(before, [...before, "library/new.md"]), [], "superconjunto não clobbera");
	assert.deepEqual(detectClobber(before, before), []);
});

test("listProfileContent: lista conteúdo não-vazio, exclui profile.json", () => {
	const d = tmp();
	authorProfile(d);
	write(d, ".harness/profile/profile.json", '{"version":1}');
	write(d, ".harness/profile/empty.md", ""); // vazio → ignorado
	const content = listProfileContent(d);
	assert.ok(content.includes("architecture.md"));
	assert.ok(content.includes("library/conventions-map.md"));
	assert.ok(content.includes("skills/w/SKILL.md"), "anda recursivo em subdirs");
	assert.ok(!content.includes("profile.json"), "metadata não conta como conteúdo");
	assert.ok(!content.includes("empty.md"), "arquivo vazio não conta");
});

test("refreshPlanFor: null sem profile; plano após store + drift", () => {
	const d = tmp();
	write(d, "package-lock.json", "v1");
	assert.equal(refreshPlanFor(d), null, "sem profile.json → null");
	authorProfile(d);
	assert.ok(storeProfile(d).ok);
	write(d, "package-lock.json", "v2"); // drift de lockfiles
	const plan = refreshPlanFor(d);
	assert.ok(plan, "com profile → plano");
	assert.deepEqual(plan?.parts, ["lockfiles"]);
	assert.ok(plan?.artifacts.find((a) => a.file === "library/"));
});

test("buildRefreshDispatch: instrui MERGE não-clobber + artefatos alvo + store_profile", () => {
	const msg = buildRefreshDispatch(["toolcfg"], { todo: true });
	assert.match(msg, /MERGE, do NOT clobber/);
	assert.match(msg, /services\.yaml → additive-merge/);
	assert.match(msg, /store_profile/);
	assert.match(msg, /todo/, "com todo ativo, menciona o plano via todo");
	// sem todo: ainda roda a skill + store, sem o passo de Plan
	const bare = buildRefreshDispatch(["rules"]);
	assert.match(bare, /harness-setup/);
	assert.match(bare, /library\/conventions-map\.md → regenerate/);
	assert.doesNotMatch(bare, /`todo` tool/);
});
