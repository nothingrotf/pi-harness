import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureStep } from "../src/feature-runner.ts";
import { buildWorkerSystemPrompt, isUsageLimitEvent, rpcWorkerArgs, rpcWorkerPrompt } from "../src/feature-spawn.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-fspawn-"));
}
const task: FeatureStep = { id: "T1", kind: "task", skillName: "backend-worker", fulfills: ["A-1"], status: "pending", attempts: 0 };
const gate: FeatureStep = { id: "ship-gate-code-review", kind: "ship-gate", skillName: "harness-code-review", status: "pending", attempts: 0 };

test("rpcWorkerArgs: launch flags p/ `pi --mode rpc` (sem --mode/--print/prompt posicional)", () => {
	const a = rpcWorkerArgs(task, "/tmp/sys.md");
	assert.ok(!a.includes("--mode") && !a.includes("--print"), "o RpcClient adiciona --mode rpc; nada de --print");
	const ti = a.indexOf("--tools");
	assert.match(a[ti + 1], /EndFeatureRun/);
	assert.doesNotMatch(a[ti + 1], /subagent/, "task não precisa de subagent");
	assert.ok(a.includes("--append-system-prompt") && a.includes("/tmp/sys.md"));
	assert.equal(a.at(-1), "/tmp/sys.md", "sem prompt posicional — o último arg é o caminho do system prompt");
	assert.ok(!a.includes("--model"), "sem model → herda o do parent");

	const g = rpcWorkerArgs(gate, "/tmp/sys.md", { model: "anthropic/claude", thinking: "high" });
	const gi = g.indexOf("--tools");
	assert.match(g[gi + 1], /subagent/, "ship-gate spawna reviewers → precisa de subagent");
	assert.ok(g.includes("--model") && g.includes("anthropic/claude"));
	const thi = g.indexOf("--thinking");
	assert.ok(thi !== -1 && g[thi + 1] === "high", "effort do role → --thinking high");
});

test("rpcWorkerArgs: session-backed (--session-id + --session-dir); sem wsid → nenhum flag de sessão", () => {
	const a = rpcWorkerArgs(task, "/tmp/sys.md", {}, { workerSessionId: "ws_1", sessionDir: "/run/sessions" });
	const si = a.indexOf("--session-id");
	assert.ok(si !== -1 && a[si + 1] === "ws_1", "--session-id <wsid> (transcript persistente → resume + Active Worker)");
	assert.ok(a.includes("--session-dir") && a.includes("/run/sessions"));
	assert.ok(!a.includes("--no-session"), "RPC worker é session-backed, nunca --no-session");

	const b = rpcWorkerArgs(task, "/tmp/sys.md");
	assert.ok(!b.includes("--session-id") && !b.includes("--no-session"), "sem wsid → sem flags de sessão");
});

test("rpcWorkerPrompt: task normal vs resume (continue where you left off)", () => {
	assert.match(rpcWorkerPrompt(task), /Execute your assigned task/);
	assert.match(rpcWorkerPrompt(gate), /Run the ship-gate validator/);
	assert.match(rpcWorkerPrompt(task, true), /Continue EXACTLY where you left off/);
	assert.doesNotMatch(rpcWorkerPrompt(task, true), /Execute your assigned task/);
});

test("isUsageLimitEvent: detecta 402/usage em evento de erro; ignora output normal", () => {
	assert.equal(isUsageLimitEvent({ type: "error", message: "Request failed: 402 Payment Required" }), true);
	assert.equal(isUsageLimitEvent({ type: "error", error: "no active subscription" }), true);
	assert.equal(isUsageLimitEvent({ type: "assistant", text: "we hit the rate limit yesterday" }), false, "menção em texto normal não dispara");
	assert.equal(isUsageLimitEvent({ type: "tool_result", output: "quota: 50%" }), false, "quota em tool output (não-erro) não dispara");
	assert.equal(isUsageLimitEvent(null), false);
});

test("buildWorkerSystemPrompt: task inclui harness-worker-base + skill do profile + bootstrap", () => {
	const cwd = tmp();
	const skillDir = path.join(cwd, ".harness", "profile", "skills", "backend-worker");
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), "PROFILE-BACKEND-SKILL-BODY");
	const sys = buildWorkerSystemPrompt(task, cwd, { featureId: "feat-x", workerSessionId: "ws" });
	assert.match(sys, /# harness-worker-base/);
	assert.match(sys, /Worker Base Procedures/, "corpo real do harness-worker-base inlined");
	assert.match(sys, /PROFILE-BACKEND-SKILL-BODY/, "skill do profile inlined");
	assert.match(sys, /EndFeatureRun with featureId="feat-x", taskId="T1"/);
});

test("buildWorkerSystemPrompt: ship-gate inclui a skill do validator, não o harness-worker-base", () => {
	const cwd = tmp();
	const sys = buildWorkerSystemPrompt(gate, cwd, { featureId: "feat-x", workerSessionId: "ws" });
	assert.match(sys, /# harness-code-review/);
	assert.doesNotMatch(sys, /# harness-worker-base/);
});
