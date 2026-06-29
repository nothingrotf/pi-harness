import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupDispatch, SETUP_PHASES } from "../src/setup-dispatch.ts";

test("SETUP_PHASES: 8 fases do profile (brownfield → store)", () => {
	assert.equal(SETUP_PHASES.length, 8);
	assert.match(SETUP_PHASES[0], /brownfield/i);
	assert.match(SETUP_PHASES[SETUP_PHASES.length - 1], /store_profile/);
	assert.ok(
		SETUP_PHASES.some((p) => /verify-by-execution/.test(p)),
		"inclui o profile readiness check",
	);
});

test("buildSetupDispatch: com todo → Plan + harness-setup + artefatos + clear", () => {
	const m = buildSetupDispatch({ todo: true });
	assert.match(m, /`todo` tool/);
	for (const p of SETUP_PHASES) assert.ok(m.includes(p), `falta fase: ${p}`);
	assert.match(m, /harness-setup/);
	assert.match(m, /\.harness\/profile\//);
	assert.match(m, /architecture\.md/);
	assert.match(m, /services\.yaml/);
	assert.match(m, /harness\.md/);
	assert.match(m, /clear the plan with the `todo` tool/);
	assert.match(m, /store_profile/); // estampa via tool, depois do conteúdo existir
	assert.match(m, /do NOT hand-write profile\.json/i);
});

test("buildSetupDispatch: sem todo → sem Plan/clear, ainda roda a skill", () => {
	const m = buildSetupDispatch({ todo: false });
	assert.doesNotMatch(m, /`todo` tool/);
	assert.doesNotMatch(m, /clear the plan/);
	assert.match(m, /harness-setup/);
	assert.match(m, /architecture\.md/);
});

test("buildSetupDispatch: não rewrita AGENTS.md do repo (brownfield)", () => {
	assert.match(buildSetupDispatch({ todo: true }), /do NOT rewrite the repo's own AGENTS\.md/);
});
