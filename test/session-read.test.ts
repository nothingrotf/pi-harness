import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readAsyncStatusLite, readLiveAgentEntries, readNativeSessionFile, readNativeWorkerEntries, readNativeWorkerTree, resolveSubagentSessionFile, sessionApiReady, subagentSessionRoot } from "../src/session-read.ts";

// O reader nativo (pi 0.80.3 get_entries/get_tree) é SEGURO de usar em qualquer contexto:
// ficheiro ausente/path inválido → null SEM lançar (o caller cai pro fallback tolerante).
// Com o pi como devDependency, o caminho NATIVO agora é exercitado nos testes: um transcript
// válido devolve entries parseadas. (Sem o pacote — ambiente degradado — tudo devolve null.)
test("session-read: null gracioso em ficheiro ausente; transcript válido parseia via API nativa", async () => {
	const apiAvailable = await sessionApiReady;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sr-"));
	const dir = path.join(cwd, ".harness", "runs", "feat-x", "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ts_ws_1.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }));

	assert.equal(readNativeSessionFile("/nope/does-not-exist.jsonl"), null, "path inexistente → null, nunca lança");
	assert.equal(readNativeWorkerEntries(cwd, "feat-x", "absent-wsid"), null, "sem ficheiro → null");
	const entries = readNativeWorkerEntries(cwd, "feat-x", "ws_1");
	if (apiAvailable) {
		assert.ok(entries && entries.length > 0, "pi disponível (devDependency) → transcript parseado");
	} else {
		assert.equal(entries, null, "pi ausente → null (fallback)");
		assert.equal(readNativeWorkerTree(cwd, "feat-x", "ws_1"), null);
	}
});

test("subagentSessionRoot: deriva <sessionsDir>/<basename-sem-.jsonl> do session file do parent (layout pi-subagents)", () => {
	assert.equal(subagentSessionRoot("/sessions/cwd-enc/2026-01-01T00-00-00_abc.jsonl"), path.join("/sessions/cwd-enc", "2026-01-01T00-00-00_abc"));
	assert.equal(subagentSessionRoot(null), null, "sem session file do parent → null (fallback do painel)");
	assert.equal(subagentSessionRoot(undefined), null);
});

test("resolveSubagentSessionFile: pega o session.jsonl mais recente (<root>/<runId>/run-N/session.jsonl); runId restringe", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-subsess-"));
	const older = path.join(root, "run-aaa", "run-0", "session.jsonl");
	const newer = path.join(root, "run-bbb", "run-0", "session.jsonl");
	fs.mkdirSync(path.dirname(older), { recursive: true });
	fs.mkdirSync(path.dirname(newer), { recursive: true });
	const line = (t: string) => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: t }] } })}\n`;
	fs.writeFileSync(older, line("old child"));
	fs.writeFileSync(newer, line("new child"));
	const now = Date.now();
	fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
	fs.utimesSync(newer, new Date(now), new Date(now));
	// sem runId (foreground: o provider não expõe o runId nos partials) → scan por mtime
	assert.equal(resolveSubagentSessionFile(root), newer, "pega o session.jsonl mais fresco");
	// com runId (async) → restringe ao run dir
	assert.equal(resolveSubagentSessionFile(root, "run-aaa"), older, "runId exato → só aquele run");
	assert.equal(resolveSubagentSessionFile(path.join(root, "absent")), null, "root inexistente → null");
});

test("readAsyncStatusLite: lê o status.json do asyncDir (state/currentTool/toolCount/totalTokens/steps)", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-async-"));
	assert.equal(readAsyncStatusLite(asyncDir), null, "sem status.json → null (run recém-aceito)");
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId: "r1",
			mode: "single",
			state: "running",
			currentTool: "bash",
			toolCount: 9,
			totalTokens: { input: 5000, output: 2000, total: 7000 },
			steps: [{ agent: "harness-qa-flow-validator", status: "running", recentTools: [{ tool: "bash", args: "curl", endMs: 1 }], sessionFile: "/tmp/child-session.jsonl" }],
		}),
	);
	const st = readAsyncStatusLite(asyncDir);
	assert.ok(st);
	assert.deepEqual([st?.state, st?.currentTool, st?.toolCount, st?.tokens], ["running", "bash", 9, 7000]);
	assert.equal(st?.steps?.length, 1);
	// corrompido → null (tenta de novo no próximo mtime)
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "harness-async2-"));
	fs.writeFileSync(path.join(dir2, "status.json"), "{partial");
	assert.equal(readAsyncStatusLite(dir2), null);
});

test("readLiveAgentEntries: async → sessionFile do status.json; foreground → session-root do parent; null → fallback", async () => {
	const apiAvailable = await sessionApiReady;
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "harness-live-"));
	// layout do parent: <sessions>/<enc>/<ts_sid>.jsonl → root <sessions>/<enc>/<ts_sid>/
	const parentFile = path.join(base, "sessions", "enc", "2026-01-01T00-00-00_parent.jsonl");
	fs.mkdirSync(path.dirname(parentFile), { recursive: true });
	fs.writeFileSync(parentFile, "");
	const childFile = path.join(base, "sessions", "enc", "2026-01-01T00-00-00_parent", "run-xyz", "run-0", "session.jsonl");
	fs.mkdirSync(path.dirname(childFile), { recursive: true });
	fs.writeFileSync(childFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "child says hi" }] } })}\n`);

	// foreground (sem runId/asyncDir): resolve sob a session-root do parent
	const fg = readLiveAgentEntries(parentFile, {});
	if (apiAvailable) {
		assert.ok(fg && fg.length > 0, "parseia a sessão do child via API nativa");
	} else {
		assert.equal(fg, null);
	}

	// async: o sessionFile do status.json tem precedência
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-live-async-"));
	const asyncChild = path.join(asyncDir, "child-session.jsonl");
	fs.writeFileSync(asyncChild, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "async child" }] } })}\n`);
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "running", steps: [{ agent: "a", status: "running", sessionFile: asyncChild }] }));
	const as = readLiveAgentEntries(parentFile, { runId: "run-does-not-exist", asyncDir });
	if (apiAvailable) {
		assert.ok(as && as.length > 0, "usa o sessionFile do step do status.json");
	}

	// nada resolvível → null (o caller cai pro recentActivity)
	assert.equal(readLiveAgentEntries(null, {}), null);
});
