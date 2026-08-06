import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConventionsMapDispatch, buildSetupDispatch, SETUP_PHASES } from "../src/setup-dispatch.ts";

test("SETUP_PHASES: fases 0-9 do skill + store (numeração 1:1 com harness-setup SKILL.md)", () => {
	assert.equal(SETUP_PHASES.length, 11);
	assert.match(SETUP_PHASES[0], /brownfield/i);
	// numeração alinhada ao skill: architecture é a Phase 2, conventions-map a Phase 9
	assert.match(SETUP_PHASES[2], /^Phase 2: architecture/);
	assert.match(SETUP_PHASES[9], /^Phase 9: conventions-map/);
	assert.match(SETUP_PHASES[SETUP_PHASES.length - 1], /store_profile/);
	assert.ok(
		SETUP_PHASES.some((p) => /verify-by-execution/.test(p)),
		"inclui o profile readiness check",
	);
});

test("buildSetupDispatch: fases como roteiro + harness-setup + artefatos; sem rpiv-todo", () => {
	const m = buildSetupDispatch({});
	assert.doesNotMatch(m, /`todo` tool/, "sem rpiv-todo — o harness não instrui Plan");
	for (const p of SETUP_PHASES) assert.ok(m.includes(p), `falta fase: ${p}`);
	assert.match(m, /harness-setup/);
	assert.match(m, /\.harness\/profile\//);
	assert.match(m, /architecture\.md/);
	assert.match(m, /services\.yaml/);
	assert.match(m, /harness\.md/);
	assert.doesNotMatch(m, /clear the plan/);
	assert.match(m, /store_profile/); // estampa via tool, depois do conteúdo existir
	assert.match(m, /do NOT hand-write profile\.json/i);
});

test("buildSetupDispatch: não rewrita AGENTS.md do repo (brownfield)", () => {
	assert.match(buildSetupDispatch({}), /do NOT rewrite the repo's own AGENTS\.md/);
});

test("buildConventionsMapDispatch: indexa ADRs/rules/patterns + split gate-vs-review → conventions-map.md", () => {
	const m = buildConventionsMapDispatch({ subagent: true });
	assert.match(m, /conventions-map\.md/);
	assert.match(m, /ADRs?/);
	assert.match(m, /Rule files/i);
	assert.match(m, /House patterns/i);
	assert.match(m, /Gate-enforced vs review-enforced/i);
	assert.match(m, /read and index them, never edit/i);
	assert.match(m, /subagent/i); // delega a varredura profunda
});

test("buildConventionsMapDispatch: sem subagent → sem passo de delegação, ainda gera o índice", () => {
	const m = buildConventionsMapDispatch();
	assert.match(m, /conventions-map\.md/);
	assert.doesNotMatch(m, /Delegate the broad search/);
});
