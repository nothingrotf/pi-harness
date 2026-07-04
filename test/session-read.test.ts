import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentOutputFilePath, readAgentOutputEntries, readNativeSessionFile, readNativeWorkerEntries, readNativeWorkerTree, resolveAgentOutputFile, sessionApiReady } from "../src/session-read.ts";

// Garante que o reader nativo (pi 0.80.3 get_entries/get_tree) é SEGURO de importar/usar em
// qualquer contexto: sem o pacote pi (testes/CI ou pi antigo), o dynamic import guarded resolve
// para "indisponível" e os readers devolvem null SEM lançar — o caller (control-view) cai pro
// fallback tolerante (control-worker). Isto é o "garante que nada se quebre".
test("session-read: sem o pacote pi → null gracioso, nunca lança", async () => {
	await sessionApiReady; // espera a tentativa de import resolver (→ indisponível no teste)
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sr-"));
	const dir = path.join(cwd, ".harness", "runs", "feat-x", "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ts_ws_1.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }));

	assert.equal(readNativeWorkerEntries(cwd, "feat-x", "ws_1"), null, "pi ausente → null (fallback)");
	assert.equal(readNativeWorkerTree(cwd, "feat-x", "ws_1"), null);
	assert.equal(readNativeSessionFile("/nope/does-not-exist.jsonl"), null);
	assert.equal(readNativeWorkerEntries(cwd, "feat-x", "absent-wsid"), null, "sem ficheiro → null");
});

test("agentOutputFilePath: layout Claude-Code do @tintinweb (pi-subagents-uid/encodeCwd/sessionId/tasks/agentId.output)", () => {
	const p = agentOutputFilePath("/home/u/proj", "sess123", "ag_abc");
	assert.ok(p.endsWith(path.join("tasks", "ag_abc.output")), "termina em tasks/<agentId>.output");
	assert.ok(p.includes("sess123"), "inclui o sessionId (pai)");
	assert.ok(p.includes("pi-subagents-"), "root pi-subagents-<uid>");
});

test("readAgentOutputEntries: lê o .output JSONL do @tintinweb e folda (colapsa toolCall+toolResult); guards + linha parcial", () => {
	// guards
	assert.equal(readAgentOutputEntries("/cwd", null, "ag"), null, "sem sessionId → null");
	assert.equal(readAgentOutputEntries("/cwd", "s", null), null, "sem agentId → null");
	assert.equal(readAgentOutputEntries("/cwd", "s-absent", "ag-absent"), null, "sem ficheiro → null (fallback)");

	// escreve um .output realista no caminho reconstruído e lê (SELF-CONTIDO — não depende do pacote pi)
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-out-"));
	const sessionId = `sess_${Date.now()}`;
	const agentId = "ag_test";
	const file = agentOutputFilePath(cwd, sessionId, agentId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines = [
		{ isSidechain: true, agentId, type: "user", message: { role: "user", content: "Run T1" }, timestamp: "t", cwd },
		{ isSidechain: true, agentId, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it — running tests" }] }, timestamp: "t", cwd },
		{ isSidechain: true, agentId, type: "assistant", message: { role: "assistant", content: [{ type: "toolCall", name: "Execute", arguments: { command: "go test ./..." } }] }, timestamp: "t", cwd },
		{ isSidechain: true, agentId, type: "toolResult", message: { role: "toolResult", content: [{ type: "text", text: "ok 0.184s" }] }, timestamp: "t", cwd },
	];
	fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

	const entries = readAgentOutputEntries(cwd, sessionId, agentId);
	assert.ok(entries && entries.length >= 3, "parseou as mensagens/tools do .output");
	const tool = entries?.find((e) => e.kind === "tool");
	assert.equal(tool?.toolName, "Execute");
	assert.equal(tool?.result, "ok 0.184s", "colapsou o toolResult no toolCall (o g2H)");
	// linha parcial no fim (ficheiro a ser escrito ao vivo) não quebra
	fs.appendFileSync(file, '{"partial');
	assert.doesNotThrow(() => readAgentOutputEntries(cwd, sessionId, agentId));
});

test("resolveAgentOutputFile: sem agentId (foreground @tintinweb não streama) → pega o .output mais recente da sessão", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-scan-"));
	const sessionId = `sess_${Date.now()}`;
	const older = agentOutputFilePath(cwd, sessionId, "ag_old");
	const newer = agentOutputFilePath(cwd, sessionId, "ag_new");
	fs.mkdirSync(path.dirname(older), { recursive: true });
	const line = (t: string) => `${JSON.stringify({ agentId: "x", type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } })}\n`;
	fs.writeFileSync(older, line("old worker"));
	fs.writeFileSync(newer, line("new worker"));
	const now = Date.now();
	fs.utimesSync(older, new Date(now - 10000), new Date(now - 10000));
	fs.utimesSync(newer, new Date(now), new Date(now));
	// sem agentId → scan por mtime → o mais recente (o worker vivo; a banda é singular = KG0)
	assert.equal(resolveAgentOutputFile(cwd, sessionId, null), newer, "pega o .output mais fresco");
	// com agentId exato → caminho exato tem precedência
	assert.equal(resolveAgentOutputFile(cwd, sessionId, "ag_old"), older, "agentId exato → caminho exato");
	// lê o conteúdo do mais recente
	assert.equal(readAgentOutputEntries(cwd, sessionId, null)?.at(-1)?.text, "new worker");
});
