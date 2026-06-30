import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readNativeSessionFile, readNativeWorkerEntries, readNativeWorkerTree, sessionApiReady } from "../src/session-read.ts";

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
