import { test } from "node:test";
import assert from "node:assert/strict";
import type { ControlModel, WorkerRow } from "../src/control-model.ts";
import { activeWorkerText, controlMidPos, footerItems, openDirCommand } from "../src/control-screen.ts";

function model(over: Partial<ControlModel> = {}): ControlModel {
	return {
		featureId: "f",
		exists: true,
		state: "running",
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
		activeMs: null,
		counts: { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 },
		delivery: null,
		...over,
	};
}

test("controlMidPos: ~50%, clampado pra caber as duas colunas", () => {
	assert.equal(controlMidPos(80), 40);
	assert.ok(controlMidPos(30) >= 12 && controlMidPos(30) <= 30 - 2);
	assert.ok(controlMidPos(200) <= 200 - 18);
});

test("footerItems(main): F/W/C/D/O/Models/Tab/Alt+T, formato KEY LABEL", () => {
	const f = footerItems("main");
	assert.deepEqual(
		f.map((i) => i.key),
		["F", "W", "C", "D", "O", "M", "Tab", "Alt+T"],
	);
	assert.equal(f[0].label, "Tasks");
	assert.equal(f.find((i) => i.key === "D")?.label, "Delivery");
	assert.equal(f.find((i) => i.key === "O")?.label, "Run Dir", "O = abrir o dir do run (o Mission Dir do Droid)");
	assert.equal(f.at(-1)?.label, "Close");
});

test("footerItems(main) state-aware: P quando run ativo; R/Shift+R quando retomável; S quando steerable", () => {
	// run ativo → P (Pause), sem R.
	const active = footerItems("main", { runActive: true, steerable: true }).map((i) => i.key);
	assert.ok(active.includes("P") && active.includes("S"));
	assert.ok(!active.includes("R"));
	// pausado/orchestrator_turn/ready sem run ativo → R + Shift+R (Resume/Restart), sem P.
	for (const state of ["paused", "orchestrator_turn", "ready"] as const) {
		const keys = footerItems("main", { state }).map((i) => i.key);
		assert.ok(keys.includes("R") && keys.includes("Shift+R"), state);
		assert.ok(!keys.includes("P"), state);
	}
	// running sem registry (ex.: run de outro processo) → nem P nem R.
	const running = footerItems("main", { state: "running" }).map((i) => i.key);
	assert.ok(!running.includes("P") && !running.includes("R") && !running.includes("S"));
});

test("footerItems(workers): tem `r` = Resume this (resumeWorkerSessionId)", () => {
	const f = footerItems("workers");
	assert.ok(f.some((i) => i.key === "r" && i.label === "Resume this"));
});

test("footerItems(delivery): navega de volta com Esc + tabs F/W/C", () => {
	const keys = footerItems("delivery").map((i) => i.key);
	assert.deepEqual(keys, ["F", "W", "C", "Tab", "Esc"]);
});

test("footerItems(main, hasModels:false): some o item Models", () => {
	const keys = footerItems("main", { hasModels: false }).map((i) => i.key);
	assert.ok(!keys.includes("M"));
});

test("footerItems: sub-views têm ↑↓/Enter/Esc; handoff só Esc", () => {
	assert.ok(footerItems("tasks").some((i) => i.key === "T" && i.label === "Filter"));
	assert.ok(footerItems("workers").some((i) => i.label === "Handoff"));
	assert.deepEqual(footerItems("handoff"), [{ key: "Esc", label: "Back" }]);
});

test("activeWorkerText: sem worker → '—'; com worker → #task + sid curto", () => {
	assert.match(activeWorkerText(model()), /—/);
	const w: WorkerRow = { workerSessionId: "9f3a4b2c1d", taskId: "T2", status: "running" };
	assert.match(activeWorkerText(model({ workers: [w] })), /#T2 .*9f3a4b2c .*running/);
});

test("footerItems(session): scroll + density + handoff; Steer só quando steerable", () => {
	const base = footerItems("session").map((i) => i.key);
	assert.deepEqual(base, ["↑↓", "g", "G", "[ ]", "h", "Esc"]);
	const steer = footerItems("session", { steerable: true }).map((i) => i.key);
	assert.ok(steer.includes("s"), "steerable → s Steer");
});

test("footerItems(workers): Enter abre o Session viewer; h = handoff direto", () => {
	const f = footerItems("workers");
	assert.equal(f.find((i) => i.key === "Enter")?.label, "Session");
	assert.equal(f.find((i) => i.key === "h")?.label, "Handoff");
});

test("openDirCommand: open/explorer/xdg-open por plataforma", () => {
	assert.equal(openDirCommand("darwin").cmd, "open");
	assert.equal(openDirCommand("win32").cmd, "explorer");
	assert.equal(openDirCommand("linux").cmd, "xdg-open");
	assert.deepEqual(openDirCommand("darwin").argsFor("/x/y"), ["/x/y"]);
});
