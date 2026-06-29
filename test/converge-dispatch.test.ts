import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConvergeDispatch, CONVERGE_PHASES } from "../src/converge-dispatch.ts";

test("CONVERGE_PHASES: 5 fases (size+entender → store_plan)", () => {
	assert.equal(CONVERGE_PHASES.length, 5);
	assert.match(CONVERGE_PHASES[0], /understand the feature/i);
	assert.match(CONVERGE_PHASES[0], /[Ss]ize/, "a fase 1 inclui o sizing (auto-sizing)");
	assert.match(CONVERGE_PHASES[CONVERGE_PHASES.length - 1], /store_plan/);
});

test("buildConvergeDispatch: com todo → Plan + harness-feature-converge + artefatos + store_plan + clear", () => {
	const m = buildConvergeDispatch("add user login", "add-user-login", { todo: true });
	assert.match(m, /`todo` tool/);
	for (const p of CONVERGE_PHASES) assert.ok(m.includes(p), `falta fase: ${p}`);
	assert.match(m, /harness-feature-converge/);
	assert.match(m, /add user login/); // a request aparece
	assert.match(m, /\.harness\/runs\/add-user-login\//);
	assert.match(m, /feature\.md/);
	assert.match(m, /contract\.md/);
	assert.match(m, /decompose into ordered tasks/);
	assert.match(m, /plan\.json/);
	assert.match(m, /store_plan/);
	assert.match(m, /coverage invariant/);
	// auto-sizing: escala o esforço, não a estrutura (invariante)
	assert.match(m, /Size the feature first/);
	assert.match(m, /ALWAYS run regardless of size/);
	assert.match(m, /clear the plan with the `todo` tool/);
	assert.match(m, /do NOT hand-write plan\.json/i);
	assert.match(m, /\/harness run/); // sugere o próximo passo (execução)
});

test("buildConvergeDispatch: sem todo → sem Plan/clear, ainda roda a skill + store_plan", () => {
	const m = buildConvergeDispatch("x", "x", { todo: false });
	assert.doesNotMatch(m, /`todo` tool/);
	assert.doesNotMatch(m, /clear the plan/);
	assert.match(m, /harness-feature-converge/);
	assert.match(m, /store_plan/);
});

test("buildConvergeDispatch: lembra de ler o profile cacheado, não re-derivar", () => {
	const m = buildConvergeDispatch("x", "x", { todo: true });
	assert.match(m, /\.harness\/profile\//);
	assert.match(m, /do NOT re-derive/);
});
