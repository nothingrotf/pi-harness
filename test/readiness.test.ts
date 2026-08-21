import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	buildGateModel,
	buildSnapshot,
	categorySummaries,
	computePassRate,
	criteriaIds,
	deriveStance,
	levelBar,
	levelFromPassRate,
	ratioBar,
	READINESS_CRITERIA,
	CLOUD_ONLY_IDS,
	criterionStatus,
	renderReadinessReport,
	renderReadinessReportText,
	summarizeSnapshot,
	validateReport,
	type CriterionEval,
	type ReadinessReport,
	type ReadinessSnapshot,
} from "../src/readiness.ts";

function snapshot(level: number, passRate: number, evals: Record<string, CriterionEval> = {}): ReadinessSnapshot {
	return { version: 1, generatedAt: "2026-06-28T00:00:00Z", fingerprint: "f", apps: 1, evals, level, passRate };
}

/** Report válido (todos passam): den por scope; cloudOnly → null. */
function fullReport(apps = 1): ReadinessReport {
	const evals: Record<string, CriterionEval> = {};
	for (const crit of READINESS_CRITERIA) {
		const den = crit.scope === "repository" ? 1 : apps;
		evals[crit.id] = { num: crit.cloudOnly ? null : den, den, rationale: "ok" };
	}
	return { evals, apps };
}

test("criterionStatus: pass/fail/partial/skip (app-scope parcial)", () => {
	assert.equal(criterionStatus({ num: 1, den: 1 }), "pass");
	assert.equal(criterionStatus({ num: 2, den: 2 }), "pass");
	assert.equal(criterionStatus({ num: 0, den: 1 }), "fail");
	assert.equal(criterionStatus({ num: 1, den: 3 }), "partial");
	assert.equal(criterionStatus({ num: null, den: 1 }), "skip");
});

test("renderReadinessReport: medidor + contagem + seções por categoria, mais fraca primeiro", () => {
	const evals: Record<string, CriterionEval> = {
		readme: { num: 1, den: 1, rationale: "present" }, // pass, docs
		env_template: { num: 0, den: 1, rationale: "no .env.example" }, // fail, dev_env
		gitignore_comprehensive: { num: 1, den: 1 }, // pass, security
		unit_tests_exist: { num: 0, den: 2 }, // fail, testing (app-scope)
		formatter: { num: 1, den: 2 }, // partial, style (app-scope)
		[CLOUD_ONLY_IDS[0]]: { num: null, den: 1 }, // skip (cloud-only)
	};
	const report = renderReadinessReportText(snapshot(2, 0.45, evals), { targetLevel: 4 });

	// header + contagem
	assert.match(report, /L2 \/ L5/);
	assert.match(report, /45%/);
	assert.match(report, /target ≥ L4/);
	assert.match(report, /6 criteria · 5 evaluated · 2 passed · 1 skipped/);

	// símbolos por status
	assert.match(report, /✓ readme/);
	assert.match(report, /✗ env_template/);
	assert.match(report, /◐ formatter\s+Code Formatter\s+\[L1\] 1\/2/);
	assert.match(report, /⊘ .+\(skipped: cloud-only\)/);

	// weakest-first: uma categoria 0/1 (testing) vem antes de uma 1/1 (security)
	assert.ok(report.indexOf("testing") < report.indexOf("security"), "categoria fraca antes da forte");
	// rationale truncada/anexada
	assert.match(report, /✗ env_template\s+Environment Template\s+\[L1\]  — no \.env\.example/);
});

test("renderReadinessReport: snapshot só com skipped — categoria aparece, 0 evaluated", () => {
	const lines = renderReadinessReport(snapshot(1, 0, { [CLOUD_ONLY_IDS[0]]: { num: null, den: 1 } }));
	assert.ok(lines[1].includes("1 criteria · 0 evaluated · 0 passed · 1 skipped"));
	assert.ok(lines.some((l) => l.includes("⊘")), "mostra o critério skipped");
});

test("READINESS_CRITERIA: catálogo 1:1 de 82 com ids únicos e 20 cloudOnly", () => {
	assert.equal(READINESS_CRITERIA.length, 82);
	assert.equal(new Set(READINESS_CRITERIA.map((c) => c.id)).size, 82, "sem ids duplicados");
	assert.equal(READINESS_CRITERIA.filter((c) => c.cloudOnly).length, 20, "20 cloudOnly");
	assert.equal(criteriaIds().length, 82);
});

test("computePassRate: média ponderada igual, ignora skipped (num null)", () => {
	const rate = computePassRate({
		a: { num: 1, den: 1 },
		b: { num: 0, den: 1 },
		c: { num: 3, den: 6 },
		d: { num: null, den: 1 },
	});
	assert.ok(Math.abs(rate - 0.5) < 1e-9, `esperava 0.5, veio ${rate}`);
	assert.equal(computePassRate({}), 0);
	assert.equal(computePassRate({ a: { num: null, den: 1 } }), 0);
});

test("levelFromPassRate: bandas e fronteiras", () => {
	assert.equal(levelFromPassRate(0), 1);
	assert.equal(levelFromPassRate(0.19), 1);
	assert.equal(levelFromPassRate(0.2), 2);
	assert.equal(levelFromPassRate(0.4), 3);
	assert.equal(levelFromPassRate(0.6), 4);
	assert.equal(levelFromPassRate(0.8), 5);
	assert.equal(levelFromPassRate(1), 5);
});

test("levelBar / ratioBar", () => {
	assert.equal(levelBar(2), "▰▰▱▱▱");
	assert.equal(levelBar(9), "▰▰▰▰▰");
	assert.equal(ratioBar(1, 12, 6), "▰▱▱▱▱▱");
	assert.equal(ratioBar(0, 0, 6), "▱▱▱▱▱▱");
});

test("validateReport: report cheio é válido; cloudOnly como null é aceito", () => {
	const r = validateReport(fullReport(1));
	assert.ok(r.ok, `esperava válido, issues: ${r.issues.join(" | ")}`);
});

test("validateReport: feature flags são opcionais", () => {
	const report = fullReport(1);
	report.evals.feature_flag_infrastructure = { num: null, den: 1, rationale: "not used by this repository" };
	const result = validateReport(report);
	assert.ok(result.ok, `esperava válido, issues: ${result.issues.join(" | ")}`);
	const criteria = JSON.parse(readFileSync(new URL("../skills/harness-readiness-audit/criteria.json", import.meta.url), "utf8"));
	assert.equal(criteria.find((criterion: { id: string }) => criterion.id === "feature_flag_infrastructure")?.isSkippable, true);
});

test("validateReport: app-scope com den=N", () => {
	assert.ok(validateReport(fullReport(3)).ok, "den=N nas app-scope deve validar");
});

test("validateReport: pega critério ausente, id extra, den errado, null inválido", () => {
	// ausente
	const missing = fullReport(1);
	delete missing.evals.readme;
	assert.match(validateReport(missing).issues.join(" "), /missing criterion: readme/);

	// id extra
	const extra = fullReport(1);
	extra.evals.bogus_id = { num: 1, den: 1, rationale: "x" };
	assert.match(validateReport(extra).issues.join(" "), /unknown criterion.*bogus_id/);

	// den errado (readme é repository → den deve ser 1)
	const badDen = fullReport(1);
	badDen.evals.readme = { num: 1, den: 5, rationale: "x" };
	assert.match(validateReport(badDen).issues.join(" "), /readme: den 5/);

	// num=null num não-skippable (readme não é skippable nem cloudOnly)
	const badNull = fullReport(1);
	badNull.evals.readme = { num: null, den: 1, rationale: "x" };
	assert.match(validateReport(badNull).issues.join(" "), /readme: num=null/);
});

test("buildSnapshot: computa level e passRate a partir do report", () => {
	const snap = buildSnapshot(fullReport(1), { fingerprint: "abc" });
	assert.equal(snap.fingerprint, "abc");
	assert.equal(snap.passRate, 1, "todos passam → 1.0");
	assert.equal(snap.level, 5);
	assert.equal(snap.version, 1);
});

test("deriveStance: unknown/stale/weak/ready", () => {
	assert.equal(deriveStance(null), "unknown");
	assert.equal(deriveStance(snapshot(4, 0.7), { targetLevel: 4, drift: true }), "stale");
	assert.equal(deriveStance(snapshot(2, 0.34), { targetLevel: 4 }), "weak");
	assert.equal(deriveStance(snapshot(4, 0.7), { targetLevel: 4 }), "ready");
});

test("categorySummaries: ordena do mais fraco pro mais forte, ignora null", () => {
	const snap = snapshot(2, 0.5, {
		gitignore_comprehensive: { num: 0, den: 1 }, // security: fail
		unit_tests_exist: { num: 1, den: 1 }, // testing: pass
		readme: { num: null, den: 1 }, // docs: skipped → fora
	});
	const sums = categorySummaries(snap);
	assert.equal(sums[0].category, "security");
	assert.ok(!sums.some((s) => s.category === "docs"));
});

test("summarizeSnapshot: linha com nível, %, e fracas", () => {
	const snap = snapshot(2, 0.34, { gitignore_comprehensive: { num: 0, den: 1 } });
	const s = summarizeSnapshot(snap);
	assert.match(s, /L2\/5/);
	assert.match(s, /34%/);
	assert.match(s, /security 0\/1/);
});

test("buildGateModel: unknown → audit primário, sem meter", () => {
	const m = buildGateModel(null, { targetLevel: 4 });
	assert.equal(m.stance, "unknown");
	assert.equal(m.meter, "");
	assert.deepEqual(m.actions.map((a) => a.value), ["reaudit", "proceed", "cancel"]);
});

test("buildGateModel: weak → fix primário + meter; level 1 → error", () => {
	const m = buildGateModel(snapshot(2, 0.34, { gitignore_comprehensive: { num: 0, den: 1 } }), { targetLevel: 4 });
	assert.equal(m.stance, "weak");
	assert.deepEqual(m.actions.map((a) => a.value), ["fix", "report", "proceed", "cancel"]);
	assert.match(m.meter, /L2 \/ L5/);
	assert.equal(buildGateModel(snapshot(1, 0.1), { targetLevel: 4 }).tone, "error");
});

test("buildGateModel: ready → proceed primário; stale → reaudit + nota stale", () => {
	const ready = buildGateModel(snapshot(4, 0.72), { targetLevel: 4 });
	assert.equal(ready.actions[0].value, "proceed");
	assert.equal(ready.weakest.length, 0);
	const stale = buildGateModel(snapshot(4, 0.72), { targetLevel: 4, drift: true });
	assert.equal(stale.actions[0].value, "reaudit");
	assert.match(stale.meter, /stale/);
});
