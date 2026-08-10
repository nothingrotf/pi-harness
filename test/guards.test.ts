import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { evaluateGuard, type GuardScope } from "../src/guards.ts";

const cwd = "/repo";
const worker: GuardScope = { cwd, featureId: "feat-a", role: "worker", kind: "task", planExists: true };
const gate: GuardScope = { ...worker, kind: "ship-gate" };
const orch: GuardScope = { cwd, featureId: "feat-a", role: "orchestrator", planExists: true };

test("worker: contract.md é FROZEN depois do store_plan (write/edit + evasão via bash)", () => {
	const p = path.join(cwd, ".harness", "runs", "feat-a", "contract.md");
	assert.match(evaluateGuard({ toolName: "write", path: p }, worker)?.reason ?? "", /FROZEN/);
	assert.match(evaluateGuard({ toolName: "edit", path: p }, worker)?.reason ?? "", /FROZEN/);
	// path relativo resolve contra o cwd
	assert.ok(evaluateGuard({ toolName: "edit", path: ".harness/runs/feat-a/contract.md" }, worker));
	// antes do store_plan (planExists false) o converge ainda autora o contract → permitido
	assert.equal(evaluateGuard({ toolName: "write", path: p }, { ...worker, planExists: false }), null);
	// evasão via bash: redirection/tee/sed -i no contract → block; leitura (cat) → livre
	assert.ok(evaluateGuard({ toolName: "bash", command: `echo x > ${p}` }, worker));
	assert.ok(evaluateGuard({ toolName: "bash", command: `sed -i '' 's/a/b/' ${p}` }, worker));
	assert.equal(evaluateGuard({ toolName: "bash", command: `cat ${p}` }, worker), null);
});

test("worker: plan.json/status.json são tool-owned; ship-gate PODE escrever status.json", () => {
	const plan = ".harness/runs/feat-a/plan.json";
	const status = ".harness/runs/feat-a/status.json";
	assert.match(evaluateGuard({ toolName: "write", path: plan }, worker)?.reason ?? "", /store_plan/);
	assert.match(evaluateGuard({ toolName: "edit", path: status }, worker)?.reason ?? "", /qa-validator/);
	assert.equal(evaluateGuard({ toolName: "edit", path: status }, gate), null, "qa-validator (ship-gate) escreve os statuses");
	assert.ok(evaluateGuard({ toolName: "edit", path: plan }, gate), "plan.json continua frozen até pro gate");
});

test("worker: AGENTS.md/CLAUDE.md do repo são do repo; merge é humano", () => {
	assert.match(evaluateGuard({ toolName: "edit", path: "AGENTS.md" }, worker)?.reason ?? "", /harness\.md/);
	assert.ok(evaluateGuard({ toolName: "write", path: "CLAUDE.md" }, worker));
	assert.equal(evaluateGuard({ toolName: "edit", path: "docs/AGENTS.md" }, worker), null, "só o AGENTS.md top-level do repo");
	assert.match(evaluateGuard({ toolName: "bash", command: "git merge feature-x" }, worker)?.reason ?? "", /HUMAN/);
	assert.ok(evaluateGuard({ toolName: "bash", command: "gh pr merge 42 --squash" }, worker));
	assert.equal(evaluateGuard({ toolName: "bash", command: "git status && git log" }, worker), null);
});

test("worker: trabalho normal passa livre", () => {
	assert.equal(evaluateGuard({ toolName: "edit", path: "src/app.ts" }, worker), null);
	assert.equal(evaluateGuard({ toolName: "write", path: ".harness/runs/feat-a/handoffs/h1.json" }, worker), null);
	assert.equal(evaluateGuard({ toolName: "bash", command: "npm test" }, worker), null);
	assert.equal(evaluateGuard({ toolName: "read", path: ".harness/runs/feat-a/contract.md" }, worker), null);
});

test("orchestrator (run/ship): nunca implementa — escrita fora de .harness/ → redirect pra fixTasks", () => {
	const v = evaluateGuard({ toolName: "edit", path: "src/app.ts" }, orch);
	assert.match(v?.reason ?? "", /fixTasks/);
	assert.ok(evaluateGuard({ toolName: "write", path: "README.md" }, orch));
	assert.equal(evaluateGuard({ toolName: "write", path: ".harness/runs/feat-a/feature.md" }, orch), null, "shared state do harness continua livre");
	assert.equal(evaluateGuard({ toolName: "write", path: "/tmp/report.txt" }, orch), null, "artefato fora do repo continua livre");
	assert.equal(evaluateGuard({ toolName: "edit", path: "../other-repo/src/app.ts" }, orch), null, "outro repo continua livre");
	assert.equal(evaluateGuard({ toolName: "bash", command: "git log" }, orch), null, "análise via bash livre");
});
