/**
 * Layout PURO do overlay full-screen (cap. 08 §6 router + §7 footer) — sem value-import de pi,
 * testável (test/control-screen.test.ts). Decide: coluna do divisor (`midPos`), itens do footer
 * por view+estado, e o texto do Active Worker. A coloração e o desenho ficam na view fina
 * (control-view.ts) + nas primitivas (control-draw.ts).
 */
import type { ControlModel, RunState } from "./control-model.ts";

export type ControlView = "main" | "tasks" | "workers" | "coverage" | "delivery" | "task_detail" | "handoff" | "session";

export interface FooterItem {
	key: string;
	label: string;
}

/** Coluna do `│` divisor (≈ 50%, clamp pra caber as duas colunas). Alinha `┬`/`┴` ↔ `│`. */
export function controlMidPos(cols: number): number {
	const half = Math.floor(cols * 0.5);
	return Math.max(20, Math.min(half, cols - 18));
}

/** Opções state-aware do footer (Pause/Resume/Steer — paridade com o Mission Control do Droid: P/R + interrupt-and-chat). */
export interface FooterOpts {
	hasModels?: boolean;
	/** estado do run — decide P (Pause) vs R (Resume) no main. */
	state?: RunState;
	/** há um run ATIVO no processo (registry) — habilita P. */
	runActive?: boolean;
	/** há um worker VIVO steerable (client RPC registrado) — habilita S. */
	steerable?: boolean;
}

function runControlItems(opts: FooterOpts): FooterItem[] {
	const out: FooterItem[] = [];
	if (opts.runActive) out.push({ key: "P", label: "Pause" });
	else if (opts.state === "paused" || opts.state === "orchestrator_turn" || opts.state === "ready") out.push({ key: "R", label: "Resume" }, { key: "Shift+R", label: "Restart" });
	if (opts.steerable) out.push({ key: "S", label: "Steer" });
	return out;
}

/**
 * Itens do footer por view (cap. 08 §7: formato `KEY LABEL`, sem `:`). Rebrand: Features→Tasks,
 * +Coverage. Main ganha P/R/S state-aware (Pause · Resume/Restart · Steer — o interrupt-and-chat
 * do Droid §7b.4); Workers ganha `r` = resume DAQUELA sessão (resumeWorkerSessionId). `Alt+T`
 * fecha (= "Back To Orchestrator") — Ctrl+T é reservado pelo Pi (thinking-toggle).
 */
export function footerItems(view: ControlView, opts: FooterOpts = {}): FooterItem[] {
	const models: FooterItem[] = opts.hasModels === false ? [] : [{ key: "M", label: "Models" }];
	switch (view) {
		case "main":
			// `O` = abrir o dir do run no gestor de ficheiros (o `D Mission Dir` do Droid — D aqui é Delivery).
			// `B Runs` = abrir o picker de runs SEM sair do cockpit (trocar de feature ativa).
			return [{ key: "F", label: "Tasks" }, { key: "W", label: "Workers" }, { key: "C", label: "Coverage" }, { key: "D", label: "Delivery" }, { key: "O", label: "Run Dir" }, { key: "B", label: "Runs" }, ...runControlItems(opts), ...models, { key: "Tab", label: "Next" }, { key: "Alt+T", label: "Close" }];
		case "tasks":
			// 1:1 com o `features` do Droid (§9): ↑↓ · g Top · G Bottom · Enter · T Filter · jumps W/M · Esc (+Tab nosso).
			return [{ key: "↑↓", label: "Select" }, { key: "g", label: "Top" }, { key: "G", label: "Bottom" }, { key: "Enter", label: "Details" }, { key: "T", label: "Filter" }, { key: "W", label: "Workers" }, ...models, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "workers":
			// Enter agora abre o SESSION VIEWER (o "Worker Session" do Droid §7b); `h` = handoff direto.
			return [{ key: "↑↓", label: "Select" }, { key: "g", label: "Top" }, { key: "G", label: "Bottom" }, { key: "Enter", label: "Session" }, { key: "h", label: "Handoff" }, { key: "r", label: "Resume this" }, { key: "T", label: "Filter" }, { key: "F", label: "Tasks" }, ...models, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "coverage":
			return [{ key: "↑↓", label: "Select" }, { key: "g", label: "Top" }, { key: "G", label: "Bottom" }, { key: "Enter", label: "Task" }, { key: "D", label: "Delivery" }, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "delivery":
			return [{ key: "F", label: "Tasks" }, { key: "W", label: "Workers" }, { key: "C", label: "Coverage" }, { key: "Tab", label: "Next" }, { key: "Esc", label: "Back" }];
		case "task_detail":
			return [{ key: "Space", label: "Expand" }, { key: "h", label: "Handoff" }, { key: "Esc", label: "Back" }];
		case "handoff":
			return [{ key: "Esc", label: "Back" }];
		case "session": {
			// Worker Session viewer (droid §7b): scroll + follow-tail, densidade `[`/`]` (1–5), steer, handoff.
			const out: FooterItem[] = [
				{ key: "↑↓", label: "Scroll" },
				{ key: "g", label: "Top" },
				{ key: "G", label: "Tail" },
				{ key: "[ ]", label: "Density" },
			];
			if (opts.steerable) out.push({ key: "s", label: "Steer" });
			out.push({ key: "h", label: "Handoff" }, { key: "Esc", label: "Back" });
			return out;
		}
	}
}

/**
 * Comando do SO pra abrir um caminho no gestor de ficheiros (o "Open Mission Dir" do Droid).
 * PURO (decisão por plataforma); o caller spawna detached. win32 usa `explorer` (start é builtin).
 */
export function openDirCommand(platform: NodeJS.Platform): { cmd: string; argsFor: (p: string) => string[] } {
	if (platform === "darwin") return { cmd: "open", argsFor: (p) => [p] };
	if (platform === "win32") return { cmd: "explorer", argsFor: (p) => [p] };
	return { cmd: "xdg-open", argsFor: (p) => [p] };
}

/** Linha do Active Worker (faixa sob as colunas, cap. 08 §8). Aponta pro stream nativo p/ logs. */
export function activeWorkerText(model: ControlModel): string {
	const running = model.workers.find((w) => w.status === "running");
	if (!running) return "Active Worker  —  (no worker running)";
	const sid = running.workerSessionId === "—" ? "—" : running.workerSessionId.slice(0, 8);
	return `Active Worker  ·  #${running.taskId}  ·  ${sid}  ·  running  (live logs in the native subagent session)`;
}
