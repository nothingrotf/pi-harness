import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activeRunIds, clearWorkerClient, hasWorkerClient, isRunActive, pauseAllRuns, pauseRun, registerRun, registerWorkerClient, steerWorker, unregisterRun } from "../src/run-registry.ts";

test("registerRun com cwd: lock on-disk — pid vivo noutro processo bloqueia; pid morto é roubado; release limpa", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lock-"));
	const lock = path.join(d, ".harness", "runs", "feat-lock", "run.lock");
	// lock de um processo VIVO (pid 1 do launchd/init responde a kill 0? usa o próprio pid de um child... usa process.pid de OUTRO "processo" simulando com um pid vivo que não é o nosso: ppid)
	fs.mkdirSync(path.dirname(lock), { recursive: true });
	fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, at: "t" }));
	assert.throws(() => registerRun("feat-lock", d), /locked by a live run in another process/);
	// pid morto → lock stale é roubado
	fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, at: "t" }));
	const c = registerRun("feat-lock", d);
	assert.ok(c);
	const held = JSON.parse(fs.readFileSync(lock, "utf8"));
	assert.equal(held.pid, process.pid, "lock agora é nosso");
	unregisterRun("feat-lock", d);
	assert.equal(fs.existsSync(lock), false, "release remove o lock");
});

test("registerRun: 1 run por feature; pauseRun aborta; unregister limpa", () => {
	const c = registerRun("feat-a");
	assert.equal(isRunActive("feat-a"), true);
	assert.throws(() => registerRun("feat-a"), /already has an active run/);
	assert.equal(pauseRun("feat-a"), true);
	assert.equal(c.signal.aborted, true, "pause = abort graceful (o runLoop persiste paused)");
	unregisterRun("feat-a");
	assert.equal(isRunActive("feat-a"), false);
	assert.equal(pauseRun("feat-a"), false, "nada ativo → false");
});

test("pauseAllRuns: aborta todos (gracefulMissionExit analog)", () => {
	const a = registerRun("feat-a");
	const b = registerRun("feat-b");
	const ids = pauseAllRuns();
	assert.deepEqual(ids.sort(), ["feat-a", "feat-b"]);
	assert.ok(a.signal.aborted && b.signal.aborted);
	unregisterRun("feat-a");
	unregisterRun("feat-b");
	assert.deepEqual(activeRunIds(), []);
});

test("steerWorker: envia pro client vivo; no_worker sem client; error se o wire recusa", async () => {
	assert.equal(await steerWorker("feat-s", "hi"), "no_worker");
	const seen: string[] = [];
	registerWorkerClient("feat-s", { prompt: async (m) => void seen.push(m) });
	assert.equal(hasWorkerClient("feat-s"), true);
	assert.equal(await steerWorker("feat-s", "focus on the API layer"), "sent");
	assert.deepEqual(seen, ["focus on the API layer"]);
	registerWorkerClient("feat-s", {
		prompt: async () => {
			throw new Error("busy");
		},
	});
	assert.equal(await steerWorker("feat-s", "x"), "error");
	clearWorkerClient("feat-s");
	assert.equal(await steerWorker("feat-s", "x"), "no_worker");
});
