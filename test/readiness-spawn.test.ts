import { test } from "node:test";
import assert from "node:assert/strict";
import { auditSystemPrompt, piArgs, resolvePiBin } from "../src/readiness-spawn.ts";

test("resolvePiBin: default 'pi', honra PI_BIN", () => {
	const saved = process.env.PI_BIN;
	delete process.env.PI_BIN;
	assert.equal(resolvePiBin(), "pi");
	process.env.PI_BIN = "/custom/pi";
	assert.equal(resolvePiBin(), "/custom/pi");
	if (saved === undefined) delete process.env.PI_BIN;
	else process.env.PI_BIN = saved;
});

test("piArgs(audit): --print, tools read-only + store tool, append-system-prompt", () => {
	const args = piArgs("audit", "/tmp/p.md");
	assert.ok(args.includes("--print"));
	const t = args[args.indexOf("--tools") + 1];
	assert.match(t, /store_agent_readiness_report/);
	assert.doesNotMatch(t, /\bedit\b|\bwrite\b/, "auditor não edita");
	assert.equal(args[args.indexOf("--append-system-prompt") + 1], "/tmp/p.md");
	assert.match(args[args.length - 1], /store_agent_readiness_report/);
});

test("piArgs(fix): tools com edit/write", () => {
	const t = piArgs("fix", "/tmp/p.md")[piArgs("fix", "/tmp/p.md").indexOf("--tools") + 1];
	assert.match(t, /\bedit\b/);
	assert.match(t, /\bwrite\b/);
});

test("piArgs: model opcional vira --model; --no-session sempre", () => {
	const withModel = piArgs("audit", "/tmp/p.md", "anthropic/claude-haiku-4-5");
	assert.equal(withModel[withModel.indexOf("--model") + 1], "anthropic/claude-haiku-4-5");
	assert.ok(withModel.includes("--no-session"));
	assert.ok(!piArgs("audit", "/tmp/p.md").includes("--model"), "sem model → sem --model");
});

test("auditSystemPrompt: corpo do SKILL + caminho do criteria.json + manda chamar a tool", () => {
	const p = auditSystemPrompt();
	assert.match(p, /Agent[- ]?Readiness/i);
	assert.match(p, /criteria\.json/);
	assert.match(p, /store_agent_readiness_report/);
});
