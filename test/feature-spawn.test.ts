import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureStep } from "../src/feature-runner.ts";
import { buildWorkerSystemPrompt, makeRealSpawn, piArgs } from "../src/feature-spawn.ts";
import { type EndFeatureRunPayload, recordHandoff } from "../src/handoff.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-fspawn-"));
}
const task: FeatureStep = { id: "T1", kind: "task", skillName: "backend-worker", fulfills: ["A-1"], status: "pending", attempts: 0 };
const gate: FeatureStep = { id: "ship-gate-code-review", kind: "ship-gate", skillName: "harness-code-review", status: "pending", attempts: 0 };

function payload(over: Partial<EndFeatureRunPayload> = {}): EndFeatureRunPayload {
	return {
		taskId: "T1",
		workerSessionId: "ws",
		successState: "success",
		returnToOrchestrator: false,
		validatorsPassed: true,
		handoff: { whatWasImplemented: "did the thing, with detail", whatWasLeftUndone: "", verification: { commandsRun: [] } },
		...over,
	};
}

test("piArgs: task vs ship-gate tools; --append-system-prompt; model opcional", () => {
	const a = piArgs(task, "/tmp/sys.md");
	assert.ok(a.includes("--print") && a.includes("--no-session"));
	const ti = a.indexOf("--tools");
	assert.match(a[ti + 1], /EndFeatureRun/);
	assert.doesNotMatch(a[ti + 1], /subagent/, "task não precisa de subagent");
	assert.ok(a.includes("--append-system-prompt") && a.includes("/tmp/sys.md"));
	assert.ok(!a.includes("--model"), "sem model → herda o do parent");

	const g = piArgs(gate, "/tmp/sys.md", "anthropic/claude");
	const gi = g.indexOf("--tools");
	assert.match(g[gi + 1], /subagent/, "ship-gate spawna reviewers → precisa de subagent");
	assert.ok(g.includes("--model") && g.includes("anthropic/claude"));
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

/** child fake (EventEmitter) que fecha no próximo tick com o code dado. */
function fakeSpawn(code: number) {
	return () => {
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding: () => void }; kill: () => void };
		const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
		child.stdout = stdout;
		child.kill = () => {};
		setImmediate(() => child.emit("close", code));
		return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
	};
}

test("makeRealSpawn: success vem do handoff escrito pelo child (não do exit code só)", async () => {
	const cwd = tmp();
	recordHandoff(cwd, "feat-x", payload({ taskId: "T1", successState: "success" }));
	const spawn = makeRealSpawn({ featureId: "feat-x", spawnImpl: fakeSpawn(0), genSessionId: () => "ws" });
	const out = await spawn(task, { cwd });
	assert.equal(out.code, 0);
	assert.equal(out.success, true);
	assert.equal(out.returnToOrchestrator, false);
});

test("makeRealSpawn: handoff failure+returnToOrchestrator → reflete no outcome; sem handoff → success false", async () => {
	const cwd = tmp();
	recordHandoff(cwd, "feat-x", payload({ taskId: "T1", successState: "failure", returnToOrchestrator: true }));
	const spawn = makeRealSpawn({ featureId: "feat-x", spawnImpl: fakeSpawn(0), genSessionId: () => "ws" });
	const out = await spawn(task, { cwd });
	assert.equal(out.success, false);
	assert.equal(out.returnToOrchestrator, true);

	// step sem handoff (worker crashou sem reportar) → success false
	const out2 = await spawn({ ...task, id: "T-missing" }, { cwd });
	assert.equal(out2.success, false);
});
