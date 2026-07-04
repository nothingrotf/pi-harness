import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureStep } from "../src/feature-runner.ts";
import { makeRpcSpawn, type RpcClientFactory, type RpcWorkerClient } from "../src/rpc-worker.ts";
import { type EndFeatureRunPayload, recordHandoff } from "../src/handoff.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-rpc-"));
}
const task: FeatureStep = { id: "T1", kind: "task", skillName: "backend-worker", fulfills: ["A-1"], status: "pending", attempts: 0, workerSessionIds: [] };

function handoff(cwd: string, over: Partial<EndFeatureRunPayload> = {}): void {
	recordHandoff(cwd, "feat-x", {
		taskId: "T1",
		workerSessionId: "ws",
		successState: "success",
		returnToOrchestrator: false,
		validatorsPassed: true,
		handoff: { whatWasImplemented: "did the thing, with detail", whatWasLeftUndone: "", verification: { commandsRun: [] } },
		...over,
	});
}

interface Spy {
	started?: boolean;
	aborted?: boolean;
	stopped?: boolean;
	args?: string[];
}

/** Fake RpcClient: ao chamar prompt() roda o `script`, que emite os eventos pro listener registrado. */
function fakeFactory(script: (emit: (e: unknown) => void) => void, spy: Spy = {}): RpcClientFactory {
	return async (cfg) => {
		spy.args = cfg.args;
		let listener: ((e: unknown) => void) | null = null;
		const client: RpcWorkerClient = {
			start: async () => {
				spy.started = true;
			},
			onEvent: (l) => {
				listener = l;
				return () => {
					listener = null;
				};
			},
			prompt: async () => {
				script((e) => listener?.(e));
			},
			abort: async () => {
				spy.aborted = true;
			},
			stop: async () => {
				spy.stopped = true;
			},
		};
		return client;
	};
}

test("makeRpcSpawn: turno normal → agent_end → lê o handoff (success do EndFeatureRun, não do agent_end)", async () => {
	const cwd = tmp();
	handoff(cwd, { successState: "success" });
	const spy: Spy = {};
	const spawn = makeRpcSpawn({ featureId: "feat-x", genSessionId: () => "ws", clientFactory: fakeFactory((emit) => emit({ type: "agent_end" }), spy) });
	const out = await spawn(task, { cwd, workerSessionId: "ws" });
	assert.equal(out.success, true);
	assert.equal(out.returnToOrchestrator, false);
	assert.equal(out.code, 0);
	assert.equal(spy.started, true);
	assert.equal(spy.stopped, true, "para o processo RPC ao fim do turno");
	assert.ok((spy.args ?? []).includes("--session-id") && (spy.args ?? []).includes("ws"), "launch session-backed (RpcClient adiciona --mode rpc)");
});

test("makeRpcSpawn: handoff failure+returnToOrchestrator reflete; sem handoff → success false", async () => {
	const cwd = tmp();
	handoff(cwd, { successState: "failure", returnToOrchestrator: true });
	const spawn = makeRpcSpawn({ featureId: "feat-x", genSessionId: () => "ws", clientFactory: fakeFactory((emit) => emit({ type: "agent_end" })) });
	const out = await spawn(task, { cwd, workerSessionId: "ws" });
	assert.equal(out.success, false);
	assert.equal(out.returnToOrchestrator, true);

	const out2 = await spawn({ ...task, id: "T-missing" }, { cwd, workerSessionId: "ws2" });
	assert.equal(out2.success, false, "worker que não reportou handoff → success false");
});

test("makeRpcSpawn: evento 402 no stream → usageLimit + abort (auto-pausa resumível)", async () => {
	const cwd = tmp();
	const spy: Spy = {};
	const spawn = makeRpcSpawn({ featureId: "feat-x", genSessionId: () => "ws", clientFactory: fakeFactory((emit) => emit({ type: "error", message: "402 Payment Required" }), spy) });
	const out = await spawn(task, { cwd, workerSessionId: "ws" });
	assert.equal(out.usageLimit, true);
	assert.equal(spy.aborted, true, "graceful: abort interrompe (transcript --session-id fica p/ resume)");
});

test("makeRpcSpawn: sem eventos além do inactivityMs → inactivity (requeue)", async () => {
	const cwd = tmp();
	const spawn = makeRpcSpawn({ featureId: "feat-x", genSessionId: () => "ws", inactivityMs: 10, clientFactory: fakeFactory(() => {}) });
	const out = await spawn(task, { cwd, workerSessionId: "ws" });
	assert.equal(out.inactivity, true);
});

test("makeRpcSpawn: abort signal → aborted (graceful pause)", async () => {
	const cwd = tmp();
	const ac = new AbortController();
	const spawn = makeRpcSpawn({ featureId: "feat-x", genSessionId: () => "ws", clientFactory: fakeFactory(() => ac.abort()) });
	const out = await spawn(task, { cwd, workerSessionId: "ws", signal: ac.signal });
	assert.equal(out.aborted, true);
});

test("makeRpcSpawn: onClient recebe o client vivo após start e null ao terminar (steer hook)", async () => {
	const cwd = tmp();
	handoff(cwd, { successState: "success" });
	const seen: ("client" | "null")[] = [];
	const spawn = makeRpcSpawn({
		featureId: "feat-x",
		genSessionId: () => "ws",
		clientFactory: fakeFactory((emit) => emit({ type: "agent_end" })),
		onClient: (c) => void seen.push(c ? "client" : "null"),
	});
	await spawn(task, { cwd, workerSessionId: "ws" });
	assert.deepEqual(seen, ["client", "null"], "registra o client vivo e limpa no fim");
});

test("makeRpcSpawn: RpcClient indisponível (factory lança) → failure code 1", async () => {
	const cwd = tmp();
	const spawn = makeRpcSpawn({
		featureId: "feat-x",
		genSessionId: () => "ws",
		clientFactory: async () => {
			throw new Error("pi RpcClient unavailable");
		},
	});
	const out = await spawn(task, { cwd, workerSessionId: "ws" });
	assert.equal(out.code, 1);
	assert.equal(out.success, undefined);
});
