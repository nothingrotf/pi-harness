import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HINT_SUPPRESS_MS, detectLocalGaps, getReadinessHint, hintsPath, markReadinessHintShown } from "../src/readiness-hints.ts";

function tmp(prefix = "harness-hints-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("detectLocalGaps: repo vazio → gaps dos checks aplicáveis (type_check só nag com ecossistema conhecido)", () => {
	const d = tmp();
	const gaps = detectLocalGaps(d);
	assert.deepEqual(gaps, ["lint_config", "formatter", "unit_tests_exist", "readme", "env_template"]);
	// com package.json (node) e sem tsconfig → type_check vira gap
	fs.writeFileSync(path.join(d, "package.json"), "{}");
	assert.ok(detectLocalGaps(d).includes("type_check"));
});

test("detectLocalGaps: repo node bem equipado → sem gaps", () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, "package.json"), "{}");
	fs.writeFileSync(path.join(d, "eslint.config.js"), "");
	fs.writeFileSync(path.join(d, "tsconfig.json"), "{}");
	fs.writeFileSync(path.join(d, ".prettierrc"), "{}");
	fs.mkdirSync(path.join(d, "test"));
	fs.writeFileSync(path.join(d, "README.md"), "# x");
	fs.writeFileSync(path.join(d, ".env.example"), "");
	assert.deepEqual(detectLocalGaps(d), []);
});

test("detectLocalGaps: go/rust ganham lint/typecheck/fmt do toolchain", () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, "go.mod"), "module x");
	const gaps = detectLocalGaps(d);
	assert.ok(!gaps.includes("type_check"), "go: type check inerente");
	assert.ok(!gaps.includes("formatter"), "go: gofmt");
	const r = tmp();
	fs.writeFileSync(path.join(r, "Cargo.toml"), "");
	const rg = detectLocalGaps(r);
	assert.ok(!rg.includes("lint_config"), "rust: clippy");
	assert.ok(!rg.includes("type_check"), "rust: type check inerente");
});

test("getReadinessHint: sem report → no-report hint; suprimido por 24h após markShown", () => {
	const repo = tmp("harness-hints-repo-");
	const agentDir = tmp("harness-hints-agent-");
	const now = 1_000_000;
	const h1 = getReadinessHint(repo, { hasReport: false, now, agentDir });
	assert.equal(h1?.kind, "no_report");
	assert.match(h1?.text ?? "", /readiness-report/);
	markReadinessHintShown(repo, h1 as NonNullable<typeof h1>, { now, agentDir });
	// dentro da janela → suprimido
	assert.equal(getReadinessHint(repo, { hasReport: false, now: now + 1000, agentDir }), null);
	// depois da janela → volta
	const h2 = getReadinessHint(repo, { hasReport: false, now: now + HINT_SUPPRESS_MS + 1, agentDir });
	assert.equal(h2?.kind, "no_report");
});

test("getReadinessHint: com report → primeiro gap local; supressão POR GAP (avança pro próximo)", () => {
	const repo = tmp("harness-hints-repo-");
	const agentDir = tmp("harness-hints-agent-");
	const now = 1_000_000;
	const h1 = getReadinessHint(repo, { hasReport: true, now, agentDir });
	assert.equal(h1?.kind, "gap");
	assert.equal(h1?.gap, "lint_config");
	assert.match(h1?.text ?? "", /readiness-fix/);
	markReadinessHintShown(repo, h1 as NonNullable<typeof h1>, { now, agentDir });
	const h2 = getReadinessHint(repo, { hasReport: true, now: now + 1000, agentDir });
	assert.equal(h2?.gap, "formatter", "gap suprimido → o próximo da lista");
});

test("getReadinessHint: sem gaps e com report → null; estado persiste em cli-hints.json", () => {
	const repo = tmp("harness-hints-repo-");
	const agentDir = tmp("harness-hints-agent-");
	fs.writeFileSync(path.join(repo, "go.mod"), "module x"); // go: vet/gofmt/types vêm do toolchain
	fs.mkdirSync(path.join(repo, "test"));
	fs.writeFileSync(path.join(repo, "README.md"), "# x");
	fs.writeFileSync(path.join(repo, ".env.example"), "");
	assert.equal(getReadinessHint(repo, { hasReport: true, now: 5, agentDir }), null);
	const state = JSON.parse(fs.readFileSync(hintsPath({ agentDir }), "utf8"));
	assert.equal(state.perPath[repo].hasPreviousReport, true);
	assert.deepEqual(state.perPath[repo].lastSeenGaps, []);
});

test("getReadinessHint: cli-hints.json corrompido não quebra (tolerante)", () => {
	const repo = tmp("harness-hints-repo-");
	const agentDir = tmp("harness-hints-agent-");
	fs.mkdirSync(path.join(agentDir, "pi-harness"), { recursive: true });
	fs.writeFileSync(hintsPath({ agentDir }), "not json{");
	const h = getReadinessHint(repo, { hasReport: false, now: 1, agentDir });
	assert.equal(h?.kind, "no_report");
});
