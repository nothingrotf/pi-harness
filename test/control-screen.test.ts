import { test } from "node:test";
import assert from "node:assert/strict";
import type { ControlModel, WorkerRow } from "../src/control-model.ts";
import { activeWorkerText, controlMidPos, footerItems } from "../src/control-screen.ts";

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
		...over,
	};
}

test("controlMidPos: ~50%, clampado pra caber as duas colunas", () => {
	assert.equal(controlMidPos(80), 40);
	assert.ok(controlMidPos(30) >= 12 && controlMidPos(30) <= 30 - 2);
	assert.ok(controlMidPos(200) <= 200 - 18);
});

test("footerItems(main): F/W/C/D/Models/Tab/Ctrl+T, formato KEY LABEL", () => {
	const f = footerItems("main");
	assert.deepEqual(
		f.map((i) => i.key),
		["F", "W", "C", "D", "M", "Tab", "Ctrl+T"],
	);
	assert.equal(f[0].label, "Tasks");
	assert.equal(f.find((i) => i.key === "D")?.label, "Delivery");
	assert.equal(f.at(-1)?.label, "Close");
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
