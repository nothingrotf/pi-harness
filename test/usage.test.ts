import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureRun } from "../src/feature-runner.ts";
import { featureUsage, featureUsageFromRun, leadUsageLine, parseSessionUsage, sessionUsageFromFile, usageReportLines } from "../src/usage.ts";
import { writeFeatureRun } from "../src/plan.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-usage-"));
}

/** Uma linha de sessão pi com mensagem assistant + usage (formato real dos session jsonl). */
function assistantLine(over: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; model?: string } = {}): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			model: over.model ?? "claude-opus-4-8",
			usage: {
				input: over.input ?? 2,
				output: over.output ?? 100,
				cacheRead: over.cacheRead ?? 1000,
				cacheWrite: over.cacheWrite ?? 50,
				totalTokens: 1152,
				cost: { input: 0.00001, output: 0.0025, cacheRead: 0.0005, cacheWrite: 0.00003, total: over.cost ?? 0.003 },
			},
		},
	});
}

test("parseSessionUsage folds assistant usage and skips non-assistant/partial lines", () => {
	const content = [
		JSON.stringify({ type: "message", message: { role: "user", content: "go" } }),
		assistantLine({ output: 100, cost: 0.01 }),
		'{"broken json', // linha parcial (ficheiro em escrita)
		JSON.stringify({ type: "message", message: { role: "toolResult" } }),
		assistantLine({ output: 200, cost: 0.02, model: "gpt-6-mini" }),
		"",
	].join("\n");
	const u = parseSessionUsage(content);
	assert.equal(u.turns, 2);
	assert.equal(u.output, 300);
	assert.equal(u.input, 4);
	assert.equal(u.cacheRead, 2000);
	assert.ok(Math.abs(u.cost - 0.03) < 1e-9);
	assert.deepEqual(u.models.sort(), ["claude-opus-4-8", "gpt-6-mini"]);
});

test("parseSessionUsage on empty/garbage content returns zeros", () => {
	const u = parseSessionUsage("not json\n\n{}\n");
	assert.equal(u.turns, 0);
	assert.equal(u.cost, 0);
});

function run(): FeatureRun {
	return {
		featureId: "feat-u",
		status: "completed",
		steps: [
			{ id: "implement-1", kind: "task", skillName: "impl", status: "completed", attempts: 1, workerSessionIds: ["ws_a", "ws_b"] },
			{ id: "ship-gate-code-review", kind: "ship-gate", skillName: "harness-code-review", status: "completed", attempts: 1, workerSessionIds: ["ws_c"] },
			{ id: "never-ran", kind: "task", skillName: "impl", status: "pending", attempts: 0, workerSessionIds: [] },
		],
	} as unknown as FeatureRun;
}

test("featureUsageFromRun aggregates per step and per role via injected reader", () => {
	const sessions: Record<string, string> = {
		ws_a: [assistantLine({ output: 100, cost: 0.1 }), assistantLine({ output: 100, cost: 0.1 })].join("\n"),
		ws_b: assistantLine({ output: 50, cost: 0.05 }),
		ws_c: assistantLine({ output: 30, cost: 0.3, model: "gpt-6-mini" }),
	};
	const u = featureUsageFromRun("/nowhere", run(), (wsid) => sessions[wsid] ?? null);
	assert.equal(u.steps.length, 3);
	const impl = u.steps[0];
	assert.equal(impl.role, "worker");
	assert.equal(impl.sessionsRead, 2);
	assert.equal(impl.usage.turns, 3);
	assert.equal(impl.usage.output, 250);
	const gate = u.steps[1];
	assert.equal(gate.role, "validator");
	assert.deepEqual(gate.models, ["gpt-6-mini"]);
	assert.ok(Math.abs((u.byRole.worker?.cost ?? 0) - 0.25) < 1e-9);
	assert.ok(Math.abs((u.byRole.validator?.cost ?? 0) - 0.3) < 1e-9);
	assert.ok(Math.abs(u.total.cost - 0.55) < 1e-9);
	assert.equal(u.missingSessions, 0);
});

test("featureUsageFromRun counts unreadable sessions as missing (undercount is visible)", () => {
	const u = featureUsageFromRun("/nowhere", run(), (wsid) => (wsid === "ws_a" ? assistantLine({ cost: 0.1 }) : null));
	assert.equal(u.missingSessions, 2);
	assert.ok(Math.abs(u.total.cost - 0.1) < 1e-9);
	const report = usageReportLines(u);
	assert.ok(report.at(-1)?.includes("unreadable"));
});

test("featureUsage reads run + sessions from disk (end-to-end join)", () => {
	const cwd = tmp();
	writeFeatureRun(cwd, run());
	const dir = path.join(cwd, ".harness", "runs", "feat-u", "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "2026-07-13T10-00-00-000Z_ws_a.jsonl"), assistantLine({ output: 10, cost: 0.5 }));
	const u = featureUsage(cwd, "feat-u");
	assert.ok(u);
	assert.ok(Math.abs(u.total.cost - 0.5) < 1e-9);
	assert.equal(u.steps[0].sessionsRead, 1);
	assert.equal(u.missingSessions, 2); // ws_b/ws_c sem ficheiro
});

test("featureUsage returns null without a feature-run.json", () => {
	assert.equal(featureUsage(tmp(), "nope"), null);
});

test("usageReportLines renders steps with data, role totals and grand total", () => {
	const sessions: Record<string, string> = { ws_a: assistantLine({ output: 1500, cacheRead: 2_000_000, cost: 1.23 }), ws_c: assistantLine({ output: 10, cost: 0.5 }) };
	const u = featureUsageFromRun("/nowhere", run(), (wsid) => sessions[wsid] ?? null);
	const lines = usageReportLines(u);
	assert.ok(lines[0].startsWith("Usage"));
	const implLine = lines.find((l) => l.includes("implement-1"));
	assert.ok(implLine?.includes("[worker]"));
	assert.ok(implLine?.includes("out=2k"));
	assert.ok(implLine?.includes("cacheRead=2.0M"));
	assert.ok(implLine?.includes("$1.23"));
	assert.ok(lines.some((l) => l.includes("worker total")));
	assert.ok(lines.at(-1)?.includes("TOTAL (children): $1.73"));
	// step sem sessão lida não aparece
	assert.ok(!lines.some((l) => l.includes("never-ran")));
});

test("usageReportLines is empty when no session had data", () => {
	const u = featureUsageFromRun("/nowhere", run(), () => null);
	assert.deepEqual(usageReportLines(u), []);
});

test("usageReportLines includes the live-lead line when leadUsage is provided", () => {
	const u = featureUsageFromRun("/nowhere", run(), (wsid) => (wsid === "ws_a" ? assistantLine({ cost: 0.1 }) : null));
	const lead = parseSessionUsage(assistantLine({ output: 500, cost: 2.5, model: "claude-opus-4-8" }));
	const lines = usageReportLines(u, lead);
	const leadLine = lines.find((l) => l.includes("live chat"));
	assert.ok(leadLine?.includes("orchestrator"));
	assert.ok(leadLine?.includes("$2.50"));
	assert.ok(leadLine?.includes("session-cumulative"));
	// o custo do líder NÃO soma no TOTAL dos children
	assert.ok(lines.at(-1)?.includes("TOTAL (children): $0.10"));
});

test("usageReportLines shows lead even when no child session had data", () => {
	const u = featureUsageFromRun("/nowhere", run(), () => null);
	const lead = parseSessionUsage(assistantLine({ cost: 1.0 }));
	const lines = usageReportLines(u, lead);
	assert.equal(lines.length, 2); // header + lead
	assert.ok(lines[1].includes("orchestrator"));
});

test("sessionUsageFromFile reads a session file; null when absent/undefined", () => {
	const dir = tmp();
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, assistantLine({ output: 42, cost: 0.42 }));
	const u = sessionUsageFromFile(file);
	assert.equal(u?.turns, 1);
	assert.equal(u?.output, 42);
	assert.equal(sessionUsageFromFile(path.join(dir, "nope.jsonl")), null);
	assert.equal(sessionUsageFromFile(undefined), null);
});

test("leadUsageLine renders turns/tokens/cost/model", () => {
	const lead = parseSessionUsage([assistantLine({ output: 1000, cost: 1.5 }), assistantLine({ output: 500, cost: 0.5 })].join("\n"));
	const line = leadUsageLine(lead);
	assert.ok(line.includes("turns=2"));
	assert.ok(line.includes("out=2k"));
	assert.ok(line.includes("$2.00"));
	assert.ok(line.includes("claude-opus-4-8"));
});
