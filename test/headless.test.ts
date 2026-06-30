import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildConvergeDispatch } from "../src/converge-dispatch.ts";
import type { SpawnFn } from "../src/feature-runner.ts";
import { convergePiArgs } from "../src/feature-spawn.ts";
import { type ConvergeFn, runHeadlessFeature } from "../src/headless.ts";
import { buildFeatureRun, storePlan, writeFeatureRun } from "../src/plan.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-headless-"));
}
const okSpawn: SpawnFn = async () => ({ code: 0, success: true });
type T = { id: string; description: string; skillName: string; fulfills: string[] };
function fakeConverge(tasks: T[], assertions: string[]): ConvergeFn {
	return async (cwd, _request, featureId) => {
		storePlan(cwd, { featureId, tasks, assertions, createdAt: "t" });
	};
}
const oneTask: T[] = [{ id: "T1", description: "a", skillName: "w", fulfills: ["A1"] }];

test("buildConvergeDispatch: headless → [assumido], sem ask_user_question, chama store_plan", () => {
	const h = buildConvergeDispatch("add login", "feat-login", {}, { headless: true });
	assert.match(h, /Headless mode/);
	assert.match(h, /Do NOT call `ask_user_question`/);
	assert.match(h, /\[assumido\]/);
	assert.match(h, /store_plan/);
	assert.doesNotMatch(buildConvergeDispatch("add login", "feat-login", {}), /Headless mode/);
});

test("convergePiArgs: --print headless + tools store_plan + prompt com request/featureId", () => {
	const a = convergePiArgs("/tmp/sys.md", "add login", "feat-login", { model: "anthropic/claude", thinking: "xhigh" });
	assert.ok(a.includes("--print") && a.includes("--no-session"));
	const ti = a.indexOf("--tools");
	assert.ok(a[ti + 1].includes("store_plan"), "tools inclui store_plan");
	assert.ok(a.includes("--model") && a.includes("anthropic/claude"));
	assert.ok(a.includes("--thinking") && a.includes("xhigh"), "effort do orchestrator → --thinking");
	const prompt = a[a.length - 1];
	assert.match(prompt, /Headless mode/);
	assert.match(prompt, /feat-login/);
	assert.match(prompt, /add login/);
});

test("runHeadlessFeature: converge escreve plan → runner completa (ok)", async () => {
	const d = tmp();
	const res = await runHeadlessFeature(d, {
		request: "x",
		featureId: "feat-x",
		converge: fakeConverge(oneTask, ["A1"]),
		spawn: okSpawn,
		log: () => {},
	});
	assert.equal(res.ok, true);
	assert.equal(res.stage, "run");
	assert.equal(res.status, "completed");
	assert.ok(fs.existsSync(path.join(d, ".harness/runs/feat-x/plan.json")), "plan.json escrito");
});

test("runHeadlessFeature: converge não produz plan → falha no estágio converge", async () => {
	const d = tmp();
	const res = await runHeadlessFeature(d, {
		request: "x",
		featureId: "feat-x",
		converge: async () => {}, // não escreve plan
		spawn: okSpawn,
		log: () => {},
	});
	assert.equal(res.ok, false);
	assert.equal(res.stage, "converge");
	assert.match(res.reason ?? "", /no plan\.json/);
});

test("runHeadlessFeature: idempotente — plan.json existente pula o converge (resume)", async () => {
	const d = tmp();
	storePlan(d, { featureId: "feat-x", tasks: oneTask, assertions: ["A1"], createdAt: "t" });
	let called = false;
	const res = await runHeadlessFeature(d, {
		request: "x",
		featureId: "feat-x",
		converge: async () => {
			called = true;
		},
		spawn: okSpawn,
		log: () => {},
	});
	assert.equal(called, false, "não re-converge se já há plan.json");
	assert.equal(res.ok, true);
});

test("runHeadlessFeature: graceful pause então resume re-attacha e completa", async () => {
	const d = tmp();
	storePlan(d, { featureId: "feat-x", tasks: oneTask, assertions: ["A1"], createdAt: "t" });
	let calls = 0;
	const seen: boolean[] = [];
	const spawn: SpawnFn = async (_s, ctx) => {
		calls++;
		seen.push(!!ctx.resume);
		return calls === 1 ? { code: 0, aborted: true } : { code: 0, success: true };
	};
	const r1 = await runHeadlessFeature(d, { request: "x", featureId: "feat-x", converge: async () => {}, spawn, log: () => {} });
	assert.equal(r1.ok, false);
	assert.equal(r1.status, "paused");
	assert.equal(r1.run?.steps[0].status, "in_progress", "graceful → in_progress persistido");
	const r2 = await runHeadlessFeature(d, { request: "x", featureId: "feat-x", converge: async () => {}, spawn, log: () => {} });
	assert.equal(r2.ok, true);
	assert.equal(r2.status, "completed");
	assert.equal(seen[1], true, "a 2ª chamada re-attacha (resume:true)");
});

test("runHeadlessFeature: hard-kill (status running congelado) → requeue do zero (resume:false)", async () => {
	const d = tmp();
	storePlan(d, { featureId: "feat-x", tasks: oneTask, assertions: ["A1"], createdAt: "t" });
	const run = buildFeatureRun(d, "feat-x", () => "t");
	if (!run) return;
	run.status = "running"; // congelado por um kill sem hook
	run.steps[0].status = "in_progress";
	run.steps[0].attempts = 1;
	run.steps[0].workerSessionIds = ["ws_dead"];
	writeFeatureRun(d, run);
	const seen: boolean[] = [];
	const spawn: SpawnFn = async (_s, ctx) => {
		seen.push(!!ctx.resume);
		return { code: 0, success: true };
	};
	const res = await runHeadlessFeature(d, { request: "x", featureId: "feat-x", converge: async () => {}, spawn, log: () => {} });
	assert.equal(res.ok, true);
	assert.equal(seen[0], false, "hard-kill → re-roda do zero (resume:false), não re-attacha o worker morto");
});

test("runHeadlessFeature: worker falha → para com reason (ok:false)", async () => {
	const d = tmp();
	const res = await runHeadlessFeature(d, {
		request: "x",
		featureId: "feat-x",
		converge: fakeConverge(oneTask, ["A1"]),
		spawn: async () => ({ code: 1, success: false }),
		log: () => {},
	});
	assert.equal(res.ok, false);
	assert.equal(res.stage, "run");
	assert.equal(res.status, "orchestrator_turn");
});
