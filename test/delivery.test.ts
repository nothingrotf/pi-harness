import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DeliveryRecord,
	type Paint,
	MERGE_OPTIONS,
	ciLine,
	deliveryDisplayLines,
	deliveryPanelLines,
	deliveryStateLabel,
	mergeDecisionMessage,
	mergeGateSummaryLines,
	normalizeDeliveryRecord,
	readDeliveryRecord,
	writeDeliveryRecord,
} from "../src/delivery.ts";

/** Paint identidade (sem ANSI) p/ testar a ESTRUTURA/geometria do painel rico. */
const plainPaint: Paint = {
	fg: (_t, s) => s,
	bold: (s) => s,
	dim: (s) => s,
	accent: (s) => s,
	accentB: (s) => s,
	width: (s) => s.length,
	truncate: (s, n) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`),
	split: (l, r, w, px) => {
		const gap = Math.max(1, w - px * 2 - l.length - r.length);
		return `${" ".repeat(px)}${l}${" ".repeat(gap)}${r}${" ".repeat(px)}`;
	},
	rule: (n) => ` ${"─".repeat(Math.max(0, n - 2))}`,
};

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-delivery-"));
}

const FULL: DeliveryRecord = {
	prNumber: 142,
	prUrl: "https://github.com/acme/app/pull/142",
	prTitle: "feat(auth): add login",
	baseBranch: "master",
	headBranch: "gabriel/eng-123-login",
	linkedIssues: { linearIssueIds: ["ENG-123"], jiraIssueKeys: [], candidateKeys: [] },
	ci: { state: "failed", iterations: 2, checks: [{ name: "build", state: "passed" }, { name: "lint", state: "failed" }], primaryFailure: "lint: eslint no-unused-vars" },
	state: "ci_blocked",
	commitShas: [],
	fixesApplied: ["eslint --fix"],
	salientSummary: "PR opened, lint failing.",
};

test("normalize: tolera JSON parcial e coage estados inválidos", () => {
	const n = normalizeDeliveryRecord({ prNumber: 1, ci: { state: "bogus", checks: [{ name: "x", state: "weird" }] }, state: "nope" });
	assert.equal(n.ci.state, "pending", "estado de CI inválido → pending");
	assert.equal(n.ci.checks[0].state, "pending", "check inválido → pending");
	assert.equal(n.state, "preparing", "estado de delivery inválido → preparing");
	assert.deepEqual(n.linkedIssues, { linearIssueIds: [], jiraIssueKeys: [], candidateKeys: [] });
	assert.deepEqual(n.fixesApplied, []);
});

test("read/write: round-trip num dir isolado; ausente → null", () => {
	const cwd = tmp();
	assert.equal(readDeliveryRecord(cwd, "feat-x"), null, "ausente → null");
	writeDeliveryRecord(cwd, "feat-x", FULL);
	const back = readDeliveryRecord(cwd, "feat-x");
	assert.deepEqual(back, normalizeDeliveryRecord(FULL), "lê de volta idêntico (normalizado)");
	assert.ok(fs.existsSync(path.join(cwd, ".harness", "runs", "feat-x", "validation", "delivery", "record.json")));
});

test("ciLine: ícones por check; sem checks → '—' quando pending", () => {
	assert.equal(ciLine(FULL), "✓ build   ✗ lint");
	const empty = normalizeDeliveryRecord({ state: "preparing" });
	assert.equal(ciLine(empty), "—");
});

test("deliveryDisplayLines: null → mensagem 'no PR yet'; full → PR/CI/fix-loop/merge", () => {
	assert.match(deliveryDisplayLines(null).join("\n"), /No PR yet/);
	const lines = deliveryDisplayLines(FULL).join("\n");
	assert.match(lines, /PR #142  feat\(auth\): add login/);
	assert.match(lines, /CI blocked/);
	assert.match(lines, /ENG-123 \(Linear\)/);
	assert.match(lines, /Fix-loop 2\/3   last: eslint --fix/);
	assert.match(lines, /lint: eslint no-unused-vars/);
});

test("deliveryDisplayLines: candidatos não-confirmados são marcados", () => {
	const rec = normalizeDeliveryRecord({ state: "open", linkedIssues: { candidateKeys: ["ENG-9"] } });
	assert.match(deliveryDisplayLines(rec).join("\n"), /ENG-9 \(candidate — unconfirmed\)/);
});

test("merge gate: opções, resumo e mensagens de decisão", () => {
	assert.deepEqual(MERGE_OPTIONS.map((o) => o.value), ["merge", "cancel", "leave_open"]);
	const green: DeliveryRecord = { ...FULL, ci: { ...FULL.ci, state: "passed" }, state: "awaiting_merge" };
	const summary = mergeGateSummaryLines(green).join("\n");
	assert.match(summary, /✓ CI all green/);
	assert.match(summary, /Closes ENG-123/);
	// com diff summary: o overlay mostra O QUE VAI (droid generate_semantic_diff) + stat + [draft]
	const withDiff: DeliveryRecord = { ...green, draft: true, diff: { summary: "Adds F2 funnel gating\nRefactors the auth guard", filesChanged: 12, insertions: 340, deletions: 120 } };
	const ds = mergeGateSummaryLines(withDiff).join("\n");
	assert.match(ds, /\[draft\]/);
	assert.match(ds, /12 files  \+340  −120/);
	assert.match(ds, /What this ships:/);
	assert.match(ds, /Adds F2 funnel gating/);
	assert.match(ds, /Refactors the auth guard/);
	assert.match(mergeDecisionMessage("feat-x", { kind: "merge" }), /gh pr merge --squash/);
	assert.match(mergeDecisionMessage("feat-x", { kind: "cancel" }), /gh pr close --delete-branch/);
	assert.match(mergeDecisionMessage("feat-x", { kind: "leave_open" }), /LEAVE OPEN/);
});

test("deliveryPanelLines: render rico — badge, issue, branch, chips de CI, fix-loop, merge", () => {
	const rec: DeliveryRecord = {
		prNumber: 259,
		prUrl: "https://github.com/acme/app/pull/259",
		prTitle: "feat: habilitar F2",
		baseBranch: "next",
		headBranch: "feat/adm-84-funil-f2",
		linkedIssues: { linearIssueIds: ["ADM-84"], jiraIssueKeys: [], candidateKeys: [] },
		ci: { state: "passed", iterations: 0, checks: [{ name: "Unit", state: "passed" }, { name: "E2E", state: "passed" }], primaryFailure: null },
		state: "awaiting_merge",
		commitShas: [],
		fixesApplied: [],
		salientSummary: "mergeable, CI verde.",
	};
	const lines = deliveryPanelLines(rec, plainPaint, 90);
	const text = lines.join("\n");
	// cada linha cabe na largura interna (geometria não estoura)
	for (const l of lines) assert.ok(l.length <= 90, `linha excede 90: ${JSON.stringify(l)}`);
	assert.match(text, /PR #259/);
	assert.match(text, /AWAITING MERGE GATE/);
	assert.match(text, /● /, "badge dot");
	assert.match(text, /ADM-84 \(Linear\)/);
	assert.match(text, /feat\/adm-84-funil-f2 → next/);
	assert.match(text, /✓ all green/);
	assert.match(text, /2\/2 checks/);
	assert.match(text, /✓ Unit/);
	assert.match(text, /▱▱▱  0\/3/);
	assert.match(text, /awaiting your decision/);
});

test("deliveryPanelLines: null → estado vazio acionável", () => {
	const text = deliveryPanelLines(null, plainPaint, 90).join("\n");
	assert.match(text, /No PR yet/);
	assert.match(text, /\/harness run/);
});

test("deliveryStateLabel cobre todos os estados", () => {
	for (const s of ["preparing", "open", "awaiting_merge", "merged", "cancelled", "ci_blocked"] as const) {
		assert.equal(typeof deliveryStateLabel(s), "string");
	}
});
