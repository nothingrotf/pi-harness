import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SESSION_DENSITY_DEFAULT, cycleDensity, entriesFromActivity, entriesFromSessionEntries, foldTranscript, parseSessionJsonl, pickActiveWorker, readWorkerSession, scrollOffset, sessionWindow, summarizeToolParams, transcriptSource, workerEntries } from "../src/control-worker.ts";
import type { ControlModel } from "../src/control-model.ts";
import type { LiveAgent } from "../src/live-agents.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-cw-"));
}

test("summarizeToolParams: pega o arg saliente (command/path/…)", () => {
	assert.equal(summarizeToolParams("bash", { command: "go test ./..." }), "go test ./...");
	assert.equal(summarizeToolParams("read", { path: "src/x.ts" }), "src/x.ts");
	assert.equal(summarizeToolParams("x", {}), "");
	assert.equal(summarizeToolParams("x", "literal"), "literal");
});

test("foldTranscript: colapsa toolCall + toolResult numa única entry de tool (o g2H)", () => {
	const e = foldTranscript([
		{ role: "user", content: [{ type: "text", text: "do it" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "hi\n" }] },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	]);
	assert.equal(e.length, 3);
	assert.deepEqual([e[0].kind, e[0].role], ["message", "user"]);
	assert.equal(e[1].kind, "tool");
	assert.equal(e[1].toolName, "bash");
	assert.equal(e[1].params, "echo hi");
	assert.equal(e[1].result, "hi", "result colapsado do toolResult seguinte");
	assert.equal(e[2].text, "done");
});

test("foldTranscript: toolResult com is_error marca isError", () => {
	const e = foldTranscript([
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "false" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "boom", is_error: true }] },
	]);
	assert.equal(e[0].isError, true);
});

test("parseSessionJsonl: extrai só type:message em ordem; tolera lixo", () => {
	const text = [
		JSON.stringify({ type: "session", version: 1 }),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
		"garbage-line",
		JSON.stringify({ type: "model_change" }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
	].join("\n");
	const m = parseSessionJsonl(text);
	assert.equal(m.length, 2);
	assert.equal(m[0].role, "user");
	assert.equal(m[1].role, "assistant");
});

test("readWorkerSession: lê o jsonl da sessão do worker por wsid e folda; [] se ausente", () => {
	const cwd = tmp();
	const dir = path.join(cwd, ".harness", "runs", "feat-x", "sessions");
	fs.mkdirSync(dir, { recursive: true });
	const line = (m: unknown): string => JSON.stringify({ type: "message", message: m });
	fs.writeFileSync(
		path.join(dir, "2026-06-30T00-00-00Z_ws_abc123.jsonl"),
		[line({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] }), line({ role: "toolResult", content: [{ type: "text", text: "contents" }] })].join("\n"),
	);
	const e = readWorkerSession(cwd, "feat-x", "ws_abc123");
	assert.equal(e.length, 1);
	assert.equal(e[0].toolName, "read");
	assert.equal(e[0].params, "a.ts");
	assert.equal(e[0].result, "contents");
	assert.deepEqual(readWorkerSession(cwd, "feat-x", "nope"), []);
	assert.deepEqual(readWorkerSession(cwd, "feat-x", "—"), []);
});

test("entriesFromActivity: 'bash: echo' → tool; texto solto → message", () => {
	const e = entriesFromActivity(["bash: echo hi", "thinking about the plan"]);
	assert.equal(e[0].kind, "tool");
	assert.equal(e[0].toolName, "bash");
	assert.equal(e[0].params, "echo hi");
	assert.equal(e[1].kind, "message");
	assert.equal(e[1].role, "system");
});

function model(over: Partial<ControlModel> = {}): ControlModel {
	return {
		featureId: "f",
		exists: true,
		state: "running",
		activeMs: 0,
		counts: { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 },
		gateInjected: false,
		assertions: { passed: 0, failed: 0, pending: 0, total: 0 },
		tasks: [],
		tasksDone: 0,
		tasksTotal: 0,
		active: null,
		workers: [],
		handoffsRaw: [],
		progress: [],
		coverage: [],
		delivery: null,
		...over,
	} as ControlModel;
}
const liveAgent = (over: Partial<LiveAgent> = {}): LiveAgent => ({ index: 0, taskId: "T1", agent: "harness-worker", label: "do T1", status: "running", toolCount: 3, tokens: 12000, recentActivity: ["bash: go test"], ...over });

test("pickActiveWorker: prefere o subagent vivo (KG0); senão a row running; senão null", () => {
	assert.equal(pickActiveWorker(model(), []), null);

	const live = pickActiveWorker(model(), [liveAgent()]);
	assert.equal(live?.source, "live");
	assert.equal(live?.id, "T1");
	assert.equal(live?.number, 1);
	assert.equal(live?.skill, "worker", "tira o prefixo harness-");
	assert.equal(live?.toolCount, 3);

	const wrModel = model({ workers: [{ workerSessionId: "ws_z", taskId: "T2", status: "running", workerNumber: 2, durationMs: 5000 }] });
	const sess = pickActiveWorker(wrModel, []);
	assert.equal(sess?.source, "session");
	assert.equal(sess?.id, "T2");
	assert.equal(sess?.wsid, "ws_z");
	assert.equal(sess?.durationMs, 5000);
});

test("pickActiveWorker: run pausado marca status paused na row running", () => {
	const m = model({ state: "paused", workers: [{ workerSessionId: "ws_p", taskId: "T1", status: "running" }] });
	assert.equal(pickActiveWorker(m, [])?.status, "paused");
});

test("entriesFromSessionEntries: folda só type:message do schema oficial; ignora compaction/branch/label", () => {
	const entries = [
		{ type: "session", version: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{ type: "model_change", provider: "anthropic", modelId: "x" },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } },
		{ type: "compaction", summary: "…" },
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "a\nb" }] } },
		{ type: "label", label: "x" },
	];
	const e = entriesFromSessionEntries(entries);
	assert.equal(e.length, 2, "user msg + tool (call+result colapsado); não-message ignoradas");
	assert.equal(e[0].text, "go");
	assert.equal(e[1].kind, "tool");
	assert.equal(e[1].toolName, "bash");
	assert.equal(e[1].result, "a\nb", "result preserva \\n cru (a view colapsa no render)");
	assert.deepEqual(entriesFromSessionEntries([]), []);
});

test("transcriptSource: mapa de casos session / activity / none", () => {
	assert.equal(transcriptSource(null), "none");
	assert.equal(transcriptSource({ number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "session", wsid: "ws_1" }), "session");
	assert.equal(transcriptSource({ number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "session" }), "none", "session sem wsid → none");
	assert.equal(transcriptSource({ number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "live", recentActivity: ["bash: x"] }), "activity");
	assert.equal(transcriptSource({ number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "live", recentActivity: [] }), "none");
});

test("workerEntries: session com ficheiro → entries; session sem ficheiro → cai p/ activity; activity → activity", () => {
	const cwd = tmp();
	const dir = path.join(cwd, ".harness", "runs", "feat-x", "sessions");
	fs.mkdirSync(dir, { recursive: true });
	const line = (m: unknown): string => JSON.stringify({ type: "message", message: m });
	fs.writeFileSync(path.join(dir, "ts_ws_disk.jsonl"), line({ role: "assistant", content: [{ type: "text", text: "from disk" }] }));

	const fromDisk = workerEntries(cwd, "feat-x", { number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "session", wsid: "ws_disk" });
	assert.equal(fromDisk[0]?.text, "from disk");

	const noFile = workerEntries(cwd, "feat-x", { number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "session", wsid: "ws_absent", recentActivity: ["bash: echo"] });
	assert.equal(noFile[0]?.kind, "tool", "sem ficheiro → fallback ao recentActivity");

	const live = workerEntries(cwd, "feat-x", { number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "live", recentActivity: ["read: a.ts"] });
	assert.equal(live[0]?.toolName, "read");

	assert.deepEqual(workerEntries(cwd, "feat-x", { number: 1, id: "T1", label: "x", skill: "w", status: "running", source: "session" }), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Session viewer (droid §7b): densidade + janela de scroll com follow-tail

test("cycleDensity: clampa 1..5", () => {
	assert.equal(cycleDensity(4, 1), 5);
	assert.equal(cycleDensity(5, 1), 5);
	assert.equal(cycleDensity(2, -1), 1);
	assert.equal(cycleDensity(1, -1), 1);
	assert.equal(SESSION_DENSITY_DEFAULT, 4, "default 4 (o do Droid)");
});

test("sessionWindow: tudo cabe → janela completa em follow, sem range", () => {
	assert.deepEqual(sessionWindow(5, null, 10), { start: 0, count: 5, follow: true, range: "" });
});

test("sessionWindow: follow-tail (offset null) cola no fim; offset ancora; offset no fim re-engaja follow", () => {
	const tail = sessionWindow(50, null, 10);
	assert.deepEqual([tail.start, tail.count, tail.follow], [40, 10, true]);
	assert.equal(tail.range, "41-50 of 50");
	const anchored = sessionWindow(50, 12, 10);
	assert.deepEqual([anchored.start, anchored.follow], [12, false]);
	assert.equal(anchored.range, "13-22 of 50");
	assert.equal(sessionWindow(50, 45, 10).follow, true, "offset ≥ maxStart → follow");
});

test("scrollOffset: sobe ancorando a partir do fim; desce até re-engajar follow (null)", () => {
	// em follow (null), subir 1 → ancora em maxStart-1
	assert.equal(scrollOffset(50, null, 10, -1), 39);
	assert.equal(scrollOffset(50, 39, 10, -10), 29);
	assert.equal(scrollOffset(50, 5, 10, -10), 0, "clampa no topo");
	assert.equal(scrollOffset(50, 30, 10, 10), null, "alcançou o fim → follow");
	assert.equal(scrollOffset(5, null, 10, -1), null, "tudo cabe → sempre follow");
});
