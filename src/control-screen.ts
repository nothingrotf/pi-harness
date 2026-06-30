/**
 * Layout PURO do overlay full-screen (cap. 08 §6 router + §7 footer) — sem value-import de pi,
 * testável (test/control-screen.test.ts). Decide: coluna do divisor (`midPos`), itens do footer
 * por view+estado, e o texto do Active Worker. A coloração e o desenho ficam na view fina
 * (control-view.ts) + nas primitivas (control-draw.ts).
 */
import type { ControlModel } from "./control-model.ts";

export type ControlView = "main" | "tasks" | "workers" | "coverage" | "delivery" | "task_detail" | "handoff";

export interface FooterItem {
	key: string;
	label: string;
}

/** Coluna do `│` divisor (≈ 50%, clamp pra caber as duas colunas). Alinha `┬`/`┴` ↔ `│`. */
export function controlMidPos(cols: number): number {
	const half = Math.floor(cols * 0.5);
	return Math.max(20, Math.min(half, cols - 18));
}

/**
 * Itens do footer por view (cap. 08 §7: formato `KEY LABEL`, sem `:`). Rebrand: Features→Tasks,
 * +Coverage; Pause/Resume adiados (docs/03-tui §Pontos abertos → overlay read-only). `Ctrl+T`
 * fecha (= "Back To Orchestrator").
 */
export function footerItems(view: ControlView, opts: { hasModels?: boolean } = {}): FooterItem[] {
	const models: FooterItem[] = opts.hasModels === false ? [] : [{ key: "M", label: "Models" }];
	switch (view) {
		case "main":
			return [{ key: "F", label: "Tasks" }, { key: "W", label: "Workers" }, { key: "C", label: "Coverage" }, { key: "D", label: "Delivery" }, ...models, { key: "Tab", label: "Next" }, { key: "Ctrl+T", label: "Close" }];
		case "tasks":
			return [{ key: "↑↓", label: "Select" }, { key: "Enter", label: "Details" }, { key: "T", label: "Filter" }, { key: "W", label: "Workers" }, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "workers":
			return [{ key: "↑↓", label: "Select" }, { key: "Enter", label: "Handoff" }, { key: "T", label: "Filter" }, { key: "F", label: "Tasks" }, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "coverage":
			return [{ key: "↑↓", label: "Select" }, { key: "Enter", label: "Task" }, { key: "D", label: "Delivery" }, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "delivery":
			return [{ key: "F", label: "Tasks" }, { key: "W", label: "Workers" }, { key: "C", label: "Coverage" }, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "task_detail":
			return [{ key: "Space", label: "Expand" }, { key: "h", label: "Handoff" }, { key: "Esc", label: "Back" }];
		case "handoff":
			return [{ key: "Esc", label: "Back" }];
	}
}

/** Linha do Active Worker (faixa sob as colunas, cap. 08 §8). Aponta pro stream nativo p/ logs. */
export function activeWorkerText(model: ControlModel): string {
	const running = model.workers.find((w) => w.status === "running");
	if (!running) return "Active Worker  —  (no worker running)";
	const sid = running.workerSessionId === "—" ? "—" : running.workerSessionId.slice(0, 8);
	return `Active Worker  ·  #${running.taskId}  ·  ${sid}  ·  running  (live logs in the native subagent stream)`;
}
