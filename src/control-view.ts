/**
 * Feature Control — overlay FULL-SCREEN hand-drawn (recreate fiel do cap. 08 do Droid Mission
 * Control, rebrandeado). Ao contrário da versão anterior (frame `round` inline = "chat
 * extension"), agora é um overlay que cobre a TELA INTEIRA, desenhado glifo-a-glifo via as
 * primitivas de control-draw.ts (cantos quadrados `┌┐└┘`, banda de header, barra de progresso,
 * corpo de DUAS colunas com divisor `┬…┴`, faixa Active Worker, footer bar). Cores mapeadas ao
 * tema ativo do Pi (accent = laranja-análogo; moldura = `muted`, cinza neutro visível).
 *
 * Estrutura: ctx.ui.custom(factory, { overlay:true, overlayOptions: tela cheia }). O render lê
 * `tui.terminal.rows`/`columns` e emite EXATAMENTE `rows` linhas opacas. Sub-views (Tasks/
 * Workers/Coverage) embrulham uma SelectList dentro da moldura; drilldowns (Task detail/Handoff)
 * renderizam texto. Watcher live re-renderiza ao mudar os ficheiros do run. Conteúdo/strings
 * vêm dos módulos puros (control-model/control-rows/control-screen/control-draw).
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type SelectItem, SelectList, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { selectListTheme } from "./control-frame.ts";
import { drawMain, drawSub, mainBodyRows, subBodyRows } from "./control-draw.ts";
import { type ControlView, type FooterItem, controlMidPos, footerItems } from "./control-screen.ts";
import { type ControlModel, type RunState, formatDuration, readControlModel, stateLabel, stripParts, taskIcon } from "./control-model.ts";
import { type Watcher, watchRun } from "./control-watch.ts";
import { splitLineRender, tabRowText, truncate } from "./control-render.ts";
import {
	type Row,
	type TaskFilter,
	type WorkerFilter,
	TASK_FILTERS,
	WORKER_FILTERS,
	coverageDisplayRows,
	coverageSummary,
	cycleFilter,
	filterLabel,
	handoffLines,
	liveActiveWorkerText,
	liveAgentRows,
	progressLogLines,
	taskDetailLines,
	taskDisplayRows,
	workerDisplayRows,
} from "./control-rows.ts";
import { listLiveAgents } from "./live-agents.ts";
import { type Paint, deliveryPanelLines } from "./delivery.ts";

/** O caller (extensão) lida com `models` reabrindo o overlay depois do config. */
export type ControlResult = { kind: "models" } | { kind: "close" };

const TAB_VIEWS: ControlView[] = ["main", "tasks", "workers", "coverage", "delivery"];

function shortId(id: string): string {
	return id === "—" ? id : id.slice(0, 8);
}

/** Cor do estado (accent/orange = ativo; warning = pausa/retorno; success = done). */
function tone(state: RunState): "success" | "warning" | "accent" {
	if (state === "completed") return "success";
	if (state === "paused" || state === "orchestrator_turn") return "warning";
	return "accent";
}

function iconColor(status: string): "success" | "accent" | "error" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "in_progress") return "accent";
	if (status === "returned") return "warning";
	if (status === "cancelled" || status === "failed") return "error";
	return "muted";
}

function rowsToItems(rows: Row[]): SelectItem[] {
	return rows.map((r) => ({ value: r.value, label: r.label, description: r.description }));
}

/**
 * Abre o overlay full-screen; resolve com `models` (reabrir após config) ou `close`. Lê o model
 * do disco e observa o run pra re-render ao vivo. Sem UI o caller deve pular.
 */
export function showFeatureControl(ctx: ExtensionContext, featureId: string, opts: { now?: number } = {}): Promise<ControlResult> {
	return ctx.ui.custom<ControlResult>(
		(tui, theme, _kb, done) => {
			let model = readControlModel(ctx.cwd, featureId, opts.now);
			let view: ControlView = "main";
			let taskFilter: TaskFilter = "all";
			let workerFilter: WorkerFilter = "all";
			let detailTaskId: string | undefined;
			let detailExpanded = false;
			let handoffWsid: string | undefined;
			let handoffBack: ControlView = "workers";
			const sel = new Map<ControlView, number>();
			let list: SelectList | undefined;

			const listTheme = selectListTheme(theme);

			// Paleta mapeada ao tema (cap. 08 §9: accent = laranja; moldura = cinza neutro VISÍVEL).
			// NB: `borderMuted` (= darkGray na maioria dos temas) some no fundo escuro — a moldura
			// full-screen usa `muted` (= gray), análogo do `#4e4e4e` do Droid: sutil mas visível.
			const accent = (s: string): string => theme.fg("accent", s);
			const accentB = (s: string): string => theme.bold(theme.fg("accent", s));
			const dim = (s: string): string => theme.fg("dim", s);
			const borderC = (s: string): string => theme.fg("muted", s);
			const deps = { border: borderC, widthOf: visibleWidth, clip: (s: string, w: number): string => sliceByColumn(s, 0, w, true) };

			const footerLine = (v: ControlView): string => {
				const items: FooterItem[] = footerItems(v);
				return ` ${items.map((i) => `${accent(i.key)} ${dim(i.label)}`).join("   ")}`;
			};

			// ── MAIN view: header band + barra + 2 colunas + Active Worker ────────────────
			const headerLine = (cols: number, m: ControlModel): string => {
				const live = m.state !== "completed";
				const dirPlain = ctx.cwd.length > 40 ? `…${ctx.cwd.slice(-39)}` : ctx.cwd;
				const left = `${accent("⛬")} ${accentB("Feature Control")}   ${dim(dirPlain)}`;
				// "Time <elapsed>" (doc 11 §5): tempo ATIVO (pausas excluídas), não wall-clock.
				const elapsed = m.activeMs !== null ? formatDuration(m.activeMs) : "";
				const timePart = elapsed ? `${dim("Time")} ${theme.fg("muted", elapsed)}   ${dim("·")}   ` : "";
				const right = `${timePart}${live ? theme.fg("success", "● Live") : dim(stateLabel(m.state))}`;
				return splitLineRender(left, right, cols - 2, 1, visibleWidth);
			};
			const barLine = (cols: number, m: ControlModel): string => {
				const barWidth = Math.max(10, Math.min(48, cols - 34));
				const p = stripParts(m, barWidth);
				const barColor = m.state === "paused" ? "warning" : "success";
				// 3 segmentos 1:1 com o Droid: █ completed (state color) · ▒ pending · ░ estimate (dim).
				const bar = `${theme.fg(barColor, p.bar.filled)}${theme.fg("muted", p.bar.pending)}${theme.fg("dim", p.bar.estimate)}`;
				const t = tone(m.state);
				const extra = p.estimate > 0 ? ` ${theme.fg("dim", `[+${p.estimate}]`)}` : "";
				return ` ${theme.fg(t, p.icon)}  ${theme.fg(t, stateLabel(m.state))}   ${bar}  ${theme.bold(p.ratio)}${extra}`;
			};
			// Edge text do painel Active Task — state-aware (era o genérico "Waiting" que destoava
			// do estado Orch. Turn na screenshot).
			const activeEdge = (m: ControlModel): string => {
				const returned = m.tasks.filter((t) => t.status === "returned").length;
				switch (m.state) {
					case "completed":
						return "All tasks completed.";
					case "orchestrator_turn":
						return returned > 0 ? `Awaiting orchestrator — ${returned} task(s) returned for rework.` : "Awaiting orchestrator decision…";
					case "paused":
						return `Paused.${m.pauseReason ? ` (${m.pauseReason})` : ""}`;
					case "ready":
						return "Ready — run /harness run to execute.";
					case "unknown":
						return "Waiting to start…";
					default:
						return "Waiting for a task to start…";
				}
			};
			const leftColumn = (m: ControlModel, w: number, cap: number, activeId?: string): string[] => {
				const out: string[] = [];
				out.push(` ${accentB("Active Task")}`);
				const liveTask = !m.active && activeId ? m.tasks.find((t) => t.id === activeId) : undefined;
				if (m.active) {
					const head = m.active.kind === "ship-gate" ? `ship gate: ${m.active.skillName.replace("harness-", "")}` : `[${m.active.id}] ${m.active.label}`;
					out.push(`   ${truncate(head, w - 3)}`);
					const meta = `skill ${m.active.skillName.replace("harness-", "")}${m.active.fulfills.length ? ` · fulfills ${m.active.fulfills.join(", ")}` : ""}`;
					out.push(dim(`   ${truncate(meta, w - 3)}`));
				} else if (liveTask) {
					out.push(`   ${truncate(`[${liveTask.id}] ${liveTask.description}`, w - 3)}`);
					out.push(dim(`   ${truncate(`skill ${liveTask.skillName}${liveTask.fulfills.length ? ` · fulfills ${liveTask.fulfills.join(", ")}` : ""}`, w - 3)}`));
				} else {
					out.push(dim(`   ${truncate(activeEdge(m), w - 3)}`));
				}
				out.push("");
				out.push(` ${accentB(`Tasks (${m.tasksDone}/${m.tasksTotal})`)}`);
				const room = Math.max(0, cap - out.length);
				const shown = m.tasks.slice(0, room);
				for (const t of shown) {
					const plain = `  ${taskIcon(t.status)} ${t.id}  ${t.description}`;
					if (t.active || t.id === activeId) {
						out.push(theme.inverse(truncate(plain, w).padEnd(w)));
					} else {
						const rest = truncate(` ${t.id}  ${t.description}`, w - 4);
						out.push(`  ${theme.fg(iconColor(t.status), taskIcon(t.status))}${rest}`);
					}
				}
				const more = m.tasks.length - shown.length;
				if (more > 0) out.push(dim(`  +${more} more`));
				return out;
			};
			const rightColumn = (m: ControlModel, w: number, cap: number): string[] => {
				const log = progressLogLines(m, Math.max(1, cap - 1), w - 1);
				const out: string[] = [` ${accentB(`Progress Log${log.range ? `   (${log.range})` : ""}`)}`];
				for (const l of log.lines) out.push(dim(` ${truncate(l, w - 1)}`));
				return out;
			};
			const workerLine = (m: ControlModel): string => {
				// Workers ao vivo (subagents rodando agora) primeiro — ainda não existem em disco.
				const live = liveActiveWorkerText(listLiveAgents());
				if (live) return ` ${accentB("Active Worker")}  ${dim("·")}  ${live}  ${theme.fg("success", "● live")}`;
				const running = m.workers.find((x) => x.status === "running");
				if (running) return ` ${accentB("Active Worker")}  ·  #${running.taskId}  ·  ${shortId(running.workerSessionId)}  ·  running  ${dim("(live logs in the native subagent stream)")}`;
				// Caminho NATIVO sem live registry (ex.: pós-/reload): a task ativa do disco (task_started)
				// ainda diz QUAL worker corre, mesmo sem o wsid (que só chega no handoff).
				if (m.active) return ` ${accentB("Active Worker")}  ·  #${m.active.id}  ·  running  ${dim("(live logs in the native subagent stream)")}`;
				return ` ${accentB("Active Worker")}  ${dim("—  (no worker running)")}`;
			};

			// Paint theme-backed pro painel de Delivery (lógica pura de layout vive em delivery.ts).
			const deliveryPaint: Paint = {
				fg: (tone, s) => theme.fg(tone, s),
				bold: (s) => theme.bold(s),
				dim,
				accent,
				accentB,
				width: visibleWidth,
				truncate,
				split: (l, r, w, px) => splitLineRender(l, r, w, px, visibleWidth),
				rule: (n) => ` ${borderC("─".repeat(Math.max(0, n - 2)))}`,
			};

			// ── Sub-views (lista embrulhada na moldura) ────────────────────────────────
			const buildList = (v: ControlView, rows: Row[], maxVisible: number): SelectList => {
				const sl = new SelectList(rowsToItems(rows), Math.max(1, maxVisible), listTheme);
				const idx = Math.min(sel.get(v) ?? 0, Math.max(0, rows.length - 1));
				sl.setSelectedIndex(idx);
				sl.onSelectionChange = () => {
					const it = sl.getSelectedItem();
					if (it) sel.set(v, rows.findIndex((r) => r.value === it.value));
				};
				return sl;
			};
			const filterRow = (filters: readonly string[], active: string): string => `${tabRowText(theme, filters.map(filterLabel), filters.indexOf(active))}   ${dim("(T cycles)")}`;
			const colorBlock = (lines: string[]): string[] =>
				lines.map((l) => {
					if (l === "") return "";
					if (/^\S/.test(l)) return accentB(l);
					if (l.includes("⚠")) return theme.fg("warning", l);
					return l;
				});

			// Constrói as linhas da tela inteira pro estado atual (cols/rows do terminal).
			const renderScreen = (cols: number, rows: number): string[] => {
				if (!model) {
					return drawSub(cols, rows, { headerRows: [` ${accentB("Feature Control")}`], body: [dim(` No run found for "${featureId}".`), dim(" Converge a feature first (/harness \"<feature>\").")], footer: footerLine("main") }, deps);
				}
				const m = model;

				if (view === "main") {
					const midPos = controlMidPos(cols);
					const leftW = midPos - 1;
					const rightW = Math.max(8, cols - midPos - 2);
					const body = mainBodyRows(rows);
					// Active task efetiva: o disco (m.active) ou, no nativo antes do task_started chegar, o
					// subagent vivo — mantém o painel Active Task e a row realçada coerentes com o worker.
					const liveId = listLiveAgents()[0]?.taskId;
					const activeId = m.active?.id ?? (liveId && liveId !== "—" ? liveId : undefined);
					const left = leftColumn(m, leftW, body, activeId);
					const right = rightColumn(m, rightW, body);
					return drawMain(cols, rows, { header: headerLine(cols, m), bar: barLine(cols, m), left, right, worker: workerLine(m), footer: footerLine("main"), midPos }, deps);
				}

				if (view === "task_detail" && detailTaskId) {
					const body = colorBlock(taskDetailLines(m, detailTaskId, detailExpanded)).map((l) => ` ${l}`);
					return drawSub(cols, rows, { headerRows: [` ${accentB(`Task ${detailTaskId}`)}`], body, footer: footerLine("task_detail") }, deps);
				}
				if (view === "handoff" && handoffWsid) {
					const body = colorBlock(handoffLines(m, handoffWsid)).map((l) => ` ${l}`);
					return drawSub(cols, rows, { headerRows: [` ${accentB("Worker Handoff")}`], body, footer: footerLine("handoff") }, deps);
				}
				if (view === "delivery") {
					// Render rico read-only: badge de estado, issue, branch, CI em chips coloridos, barra de fix-loop, merge.
					return drawSub(cols, rows, { headerRows: [` ${accent("⛬")} ${accentB("Delivery")}`], body: deliveryPanelLines(m.delivery, deliveryPaint, cols - 2), footer: footerLine("delivery") }, deps);
				}

				// list views: tasks / workers / coverage
				let headerRows: string[];
				let rows0: Row[];
				if (view === "tasks") {
					headerRows = [` ${accentB(`Tasks (${m.tasks.length})`)}`, ` ${filterRow(TASK_FILTERS, taskFilter)}`];
					rows0 = taskDisplayRows(m, taskFilter);
				} else if (view === "workers") {
					// Prepend os workers AO VIVO (subagents rodando, sem handoff ainda) — só nos filtros
					// que mostram ativos (All/Active). Era a causa do "agent não aparece no control".
					const live = listLiveAgents();
					const liveRows = workerFilter === "all" || workerFilter === "active" ? liveAgentRows(live) : [];
					headerRows = [` ${accentB(`Workers (${m.workers.length + liveRows.length})`)}`, ` ${filterRow(WORKER_FILTERS, workerFilter)}`];
					rows0 = [...liveRows, ...workerDisplayRows(m, workerFilter)];
				} else {
					headerRows = [` ${accentB(`Coverage (${coverageSummary(m)})`)}`, ` ${dim("assertion → task → status")}`];
					rows0 = coverageDisplayRows(m);
				}
				const bodyRows = subBodyRows(rows, headerRows.length);
				list = buildList(view, rows0, bodyRows);
				wireSelect(view, rows0);
				const lines = list.render(Math.max(4, cols - 4)).map((l) => ` ${l}`);
				return drawSub(cols, rows, { headerRows, body: lines, footer: footerLine(view) }, deps);
			};

			// onSelect (Enter numa lista): SÓ muta estado; o re-render acontece FORA do handleInput.
			const wireSelect = (v: ControlView, rows0: Row[]): void => {
				if (!list) return;
				if (v === "tasks") {
					list.onSelect = (it) => {
						detailTaskId = it.value;
						detailExpanded = false;
						view = "task_detail";
					};
				} else if (v === "workers") {
					list.onSelect = (it) => {
						if (it.value.startsWith("live__")) return; // worker ao vivo: ainda sem handoff em disco
						handoffWsid = it.value.split("__")[0];
						handoffBack = "workers";
						view = "handoff";
					};
				} else if (v === "coverage") {
					list.onSelect = (it) => {
						const cov = model?.coverage.find((c) => c.assertion === it.value);
						if (cov?.taskId) {
							detailTaskId = cov.taskId;
							detailExpanded = false;
							view = "task_detail";
						}
					};
				}
				void rows0;
			};

			const refresh = (): void => {
				model = readControlModel(ctx.cwd, featureId, opts.now);
				tui.requestRender();
			};
			const watcher: Watcher = watchRun(ctx.cwd, featureId, refresh);
			// Tick de re-render enquanto há workers AO VIVO (subagents) — os stats (tools/tokens)
			// mudam em memória, não em disco, então o watcher de fs não os pega.
			const ticker = setInterval(() => {
				if (listLiveAgents().length > 0) tui.requestRender();
			}, 700);
			const finish = (r: ControlResult): void => {
				watcher.close();
				clearInterval(ticker);
				done(r);
			};

			const isNavKey = (d: string): boolean =>
				matchesKey(d, "up") || matchesKey(d, "down") || matchesKey(d, "enter") || matchesKey(d, "return") || matchesKey(d, "pageUp") || matchesKey(d, "pageDown") || matchesKey(d, "home") || matchesKey(d, "end");

			const component: Component & { handleInput(data: string): void } = {
				render: (width: number): string[] => {
					try {
						const cols = Math.max(20, width);
						const rows = Math.max(12, tui.terminal.rows);
						return renderScreen(cols, rows);
					} catch (e) {
						return [` ⚠ Feature Control render error: ${(e as Error).message}`, " Esc / Ctrl+C to close"];
					}
				},
				invalidate: (): void => {
					list?.invalidate();
				},
				handleInput: (data: string): void => {
					try {
						if (matchesKey(data, "ctrl+t") || matchesKey(data, "ctrl+c")) return finish({ kind: "close" });
						const esc = matchesKey(data, "escape") || matchesKey(data, "q");
						const tab = matchesKey(data, "tab");
						const nextView = (): ControlView => TAB_VIEWS[(TAB_VIEWS.indexOf(view as ControlView) + 1) % TAB_VIEWS.length] ?? "main";

						if (view === "main") {
							if (esc) return finish({ kind: "close" });
							if (tab) view = nextView();
							else if (matchesKey(data, "m")) return finish({ kind: "models" });
							else if (matchesKey(data, "f")) view = "tasks";
							else if (matchesKey(data, "w")) view = "workers";
							else if (matchesKey(data, "c")) view = "coverage";
							else if (matchesKey(data, "d")) view = "delivery";
							else return;
							return tui.requestRender();
						}
						if (view === "delivery") {
							if (esc) view = "main";
							else if (tab) view = nextView();
							else if (matchesKey(data, "m")) return finish({ kind: "models" });
							else if (matchesKey(data, "f")) view = "tasks";
							else if (matchesKey(data, "w")) view = "workers";
							else if (matchesKey(data, "c")) view = "coverage";
							else return;
							return tui.requestRender();
						}
						if (view === "task_detail") {
							if (esc) view = "tasks";
							else if (matchesKey(data, "space")) detailExpanded = !detailExpanded;
							else if (matchesKey(data, "h")) {
								const wk = model?.workers.find((x) => x.taskId === detailTaskId && x.status !== "running");
								if (wk) {
									handoffWsid = wk.workerSessionId;
									handoffBack = "task_detail";
									view = "handoff";
								} else return;
							} else return;
							return tui.requestRender();
						}
						if (view === "handoff") {
							if (esc) view = handoffBack;
							else return;
							return tui.requestRender();
						}

						// list views: tasks / workers / coverage
						if (esc) view = "main";
						else if (tab) view = nextView();
						else if (matchesKey(data, "m")) return finish({ kind: "models" });
						else if (matchesKey(data, "f")) view = "tasks";
						else if (matchesKey(data, "w")) view = "workers";
						else if (matchesKey(data, "c")) view = "coverage";
						else if (matchesKey(data, "d")) view = "delivery";
						else if (matchesKey(data, "t") && view === "tasks") taskFilter = cycleFilter(TASK_FILTERS, taskFilter);
						else if (matchesKey(data, "t") && view === "workers") workerFilter = cycleFilter(WORKER_FILTERS, workerFilter);
						else if (matchesKey(data, "h") && view === "workers") {
							const it = list?.getSelectedItem();
							if (it && !it.value.startsWith("live__")) {
								handoffWsid = it.value.split("__")[0];
								handoffBack = "workers";
								view = "handoff";
							} else return;
						} else if (isNavKey(data)) {
							list?.handleInput(data);
							return tui.requestRender();
						} else return;
						return tui.requestRender();
					} catch {
						tui.requestRender();
					}
				},
			};
			return component;
		},
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } },
	);
}
