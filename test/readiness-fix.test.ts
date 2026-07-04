import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixPlan, failingSignals } from "../src/readiness-fix-prompt.ts";
import type { CriterionEval, ReadinessSnapshot } from "../src/readiness.ts";

function snap(evals: Record<string, CriterionEval>): ReadinessSnapshot {
	return { version: 1, generatedAt: "2026-06-28T00:00:00Z", fingerprint: "f", apps: 1, evals, level: 2, passRate: 0.3 };
}

test("failingSignals: num<den (non-null) é falha; passou ou null não", () => {
	const s = snap({
		gitignore_comprehensive: { num: 0, den: 1, rationale: "sem .gitignore" }, // falha
		readme: { num: 1, den: 1, rationale: "ok" }, // passou
		dast_scanning: { num: null, den: 1, rationale: "cloud" }, // null → fora
	});
	const f = failingSignals(s);
	assert.equal(f.length, 1);
	assert.equal(f[0].id, "gitignore_comprehensive");
	assert.equal(f[0].name, "Gitignore Comprehensive");
});

test("buildFixPlan: sem snapshot → audit (roda avaliação primeiro)", () => {
	assert.deepEqual(buildFixPlan(null, ""), { kind: "audit" });
	assert.deepEqual(buildFixPlan(null, "lint"), { kind: "audit" });
});

test("buildFixPlan: nada falhando → none com a frase verbatim", () => {
	const plan = buildFixPlan(snap({ readme: { num: 1, den: 1, rationale: "ok" } }), "");
	assert.equal(plan.kind, "none");
	if (plan.kind === "none") {
		assert.match(plan.text, /All readiness signals are passing for this repository\. No fixes needed\./);
	}
});

test("buildFixPlan: report + args → variante de match semântico (verbatim)", () => {
	const plan = buildFixPlan(snap({ gitignore_comprehensive: { num: 0, den: 1, rationale: "x" } }), "secrets");
	assert.equal(plan.kind, "prompt");
	if (plan.kind === "prompt") {
		assert.match(plan.text, /## Failing Signals \(1 total\)/);
		assert.match(plan.text, /The user asked to fix: "secrets"/);
		assert.match(plan.text, /Semantically match the user's requested signals/);
		assert.match(plan.text, /CRITICAL: Quality Standards/);
		assert.match(plan.text, /Evaluation instructions:/); // veio do criteria.json
		// camada de orquestração: sessão isolada por critério (@tintinweb/pi-subagents) + todo (rpiv-todo)
		assert.match(plan.text, /@tintinweb\/pi-subagents \+ rpiv-todo/);
		assert.match(plan.text, /subagent_type: "harness-readiness-remediator"/);
		assert.match(plan.text, /todo\(\{ action: "create"/);
	}
});

test("buildFixPlan: report + sem args → variante AskUser por categoria (verbatim)", () => {
	const plan = buildFixPlan(snap({ gitignore_comprehensive: { num: 0, den: 1, rationale: "x" } }), "");
	assert.equal(plan.kind, "prompt");
	if (plan.kind === "prompt") {
		assert.match(plan.text, /Group the failing signals above by their category/);
		assert.match(plan.text, /Ask the user which category they want to fix using the ask_user_question tool/);
		assert.doesNotMatch(plan.text, /The user asked to fix/);
	}
});
