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
import { spawn as spawnProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type SelectItem, SelectList, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth, selectListTheme } from "./control-frame.ts";
import { drawMain, drawSub, mainLayout, subBodyRows } from "./control-draw.ts";
import { type ControlView, type FooterItem, controlMidPos, footerItems, openDirCommand } from "./control-screen.ts";
import { type ControlModel, type ProgressEntry, type RunState, formatDuration, readControlModel, stateLabel, stripParts, taskIcon } from "./control-model.ts";
import { type Watcher, watchRun } from "./control-watch.ts";
import { splitLineRender, tabRowText, truncate, wrapText } from "./control-render.ts";
import {
	type ActiveWorker,
	SESSION_DENSITY_DEFAULT,
	activeWorkerModelLabel,
	cycleDensity,
	entriesFromActivity,
	liveDurationMs,
	pickActiveWorker,
	readWorkerSession,
	toolLabel,
	scrollOffset,
	sessionWindow,
	type WorkerEntry,
	workerEntries,
} from "./control-worker.ts";
import { readLiveAgentEntries, readNativeWorkerEntries } from "./session-read.ts";
import {
	type Row,
	type TaskFilter,
	type WorkerFilter,
	TASK_FILTERS,
	WORKER_FILTERS,
	coverageDisplayRows,
	coverageSummary,
	cycleFilter,
	handoffLines,
	liveAgentRows,
	parseNumbered,
	progressLogLines,
	taskDetailLines,
	taskDisplayRows,
	taskTabLabels,
	taskWindow,
	workerDisplayRows,
	workerTabLabels,
} from "./control-rows.ts";
import { listLiveAgents } from "./live-agents.ts";
import { hasWorkerClient, isRunActive, pauseRun, steerWorker } from "./run-registry.ts";
import { runDir } from "./handoff.ts";
import { type Paint, deliveryPanelLines } from "./delivery.ts";

/** O caller (extensão) lida com `models` (reabre depois do config) e `resume` (dispara o runner
 * via orchestrator — os 3 modos do start_mission_run: continue · restart · sessão específica). */
export type ControlResult = { kind: "models" } | { kind: "close" } | { kind: "switch" } | { kind: "resume"; restartFeature?: boolean; resumeWorkerSessionId?: string };

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
			// Session viewer (droid §7b "Worker Session"): worker gravado (wsid) OU live agent (idx);
			// densidade `[`/`]` 1..5 (default 4) + scroll com follow-tail (offset null = colado ao fim).
			let sessionWsid: string | undefined;
			let sessionTaskId: string | undefined;
			let sessionLiveIdx: number | undefined;
			let density = SESSION_DENSITY_DEFAULT;
			let sessOffset: number | null = null; // null = follow tail
			let lastSessTotal = 0; // linhas totais da última render (p/ o scroll)
			let lastSessCap = 1;
			const sel = new Map<ControlView, number>();
			let list: SelectList | undefined;
			let lastRowCount = 0; // nº de rows da última list-view renderizada (p/ `G` = Bottom)

			const listTheme = selectListTheme(theme);

			// Steer mode (interrupt-and-chat do Droid §7b.4): input inline no footer → addUserMessage
			// analog (steerWorker → client.prompt no worker VIVO). Notice = feedback transiente de ações.
			let steerMode = false;
			let steerBuffer = "";
			let notice: string | undefined;

			// Paleta mapeada ao tema (cap. 08 §9: accent = laranja; moldura = cinza neutro VISÍVEL).
			// NB: `borderMuted` (= darkGray na maioria dos temas) some no fundo escuro — a moldura
			// full-screen usa `muted` (= gray), análogo do `#4e4e4e` do Droid: sutil mas visível.
			const accent = (s: string): string => theme.fg("accent", s);
			const accentB = (s: string): string => theme.bold(theme.fg("accent", s));
			const dim = (s: string): string => theme.fg("dim", s);
			const borderC = (s: string): string => theme.fg("muted", s);
			const deps = { border: borderC, widthOf: visibleWidth, clip: (s: string, w: number): string => sliceByColumn(s, 0, w, true) };

			const footerLine = (v: ControlView): string => {
				if (steerMode) return ` ${accentB("steer>")} ${theme.fg("text", steerBuffer)}${accent("▏")}  ${dim("Enter send · Esc cancel")}`;
				const items: FooterItem[] = footerItems(v, { state: model?.state, runActive: isRunActive(featureId), steerable: hasWorkerClient(featureId) });
				const base = ` ${items.map((i) => `${accent(i.key)} ${dim(i.label)}`).join("   ")}`;
				return notice ? `${base}   ${theme.fg("warning", notice)}` : base;
			};
			/** O run pode ser (re)disparado? (sem run ativo no processo E estado retomável.) */
			const canResume = (): boolean => !isRunActive(featureId) && (model?.state === "paused" || model?.state === "orchestrator_turn" || model?.state === "ready");
			/** `O` = abre o dir do run no gestor de ficheiros (o "Open Mission Dir" do Droid). */
			const openRunDir = (): void => {
				const dir = runDir(ctx.cwd, featureId);
				try {
					const { cmd, argsFor } = openDirCommand(process.platform);
					const child = spawnProcess(cmd, argsFor(dir), { detached: true, stdio: "ignore" });
					child.unref();
					child.on("error", () => {});
					notice = `opened ${dir}`;
				} catch (e) {
					notice = `open failed: ${(e as Error).message}`;
				}
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
				return splitLineRender(left, right, cols - 2, 1, visibleWidth, clipToWidth);
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
			// ── LEFT column: o cartão Active Task COMPLETO (Droid §1a) — skill, milestone?, Preconditions,
			// Expected Behavior e Description (parser K2H). A lista de Tasks foi pra coluna DIREITA.
			const leftCard = (m: ControlModel, w: number, cap: number, activeId?: string): string[] => {
				const out: string[] = [];
				const a = m.active;
				const t = activeId ? m.tasks.find((x) => x.id === activeId) : undefined;
				const idText = a?.id ?? t?.id ?? "—";
				out.push(` ${accentB("Active Task")}  ${dim(truncate(idText, Math.max(0, w - 15)))}`);
				if (!a && !t) {
					out.push("");
					out.push(dim(`   ${truncate(activeEdge(m), w - 3)}`));
					return out.slice(0, cap);
				}
				out.push("");
				if (a?.kind === "ship-gate") out.push(`   ${truncate(`ship gate: ${a.skillName.replace("harness-", "")}`, w - 3)}`);
				const skill = (a?.skillName ?? t?.skillName)?.replace("harness-", "");
				if (skill) out.push(`${dim("   skill")} ${theme.fg("text", truncate(skill, Math.max(0, w - 11)))}`);
				// milestone: condicional (tasks do pi normalmente não têm — mantém a estrutura 1:1 do Droid).
				const milestone = (t as unknown as { milestone?: string } | undefined)?.milestone;
				if (milestone) out.push(`${dim("   milestone")} ${theme.fg("text", truncate(milestone, Math.max(0, w - 15)))}`);
				const fulfills = a?.fulfills ?? t?.fulfills ?? [];
				if (fulfills.length) out.push(dim(`   fulfills ${truncate(fulfills.join(", "), Math.max(0, w - 13))}`));
				const section = (title: string, items?: string[]): void => {
					if (!items || items.length === 0) return;
					out.push("");
					out.push(` ${accentB(title)}`);
					for (const it of items.slice(0, 3)) out.push(dim(`   · ${truncate(it, w - 5)}`));
					if (items.length > 3) out.push(theme.fg("muted", `   +${items.length - 3} more`));
				};
				section("Preconditions", t?.preconditions);
				section("Expected Behavior", t?.expectedBehavior);
				if (t?.description) {
					out.push("");
					out.push(` ${accentB("Description")}`);
					for (const d of parseNumbered(t.description).slice(0, 4)) {
						if (d.number) out.push(`   ${theme.fg("muted", `(${d.number})`)} ${theme.fg("text", truncate(d.text, Math.max(0, w - 8)))}`);
						else for (const wl of wrapText(d.text, Math.max(1, w - 4), 1)) out.push(`   ${theme.fg("text", wl)}`);
					}
				}
				return out.slice(0, cap);
			};
			// Uma row da lista de Tasks (col. direita) — vídeo-invertida na ativa (Droid §1b).
			const taskRowLine = (t: ControlModel["tasks"][number], w: number, activeId?: string): string => {
				const plain = `  ${taskIcon(t.status)} ${t.id}  ${t.description}`;
				if (t.active || t.id === activeId) return theme.inverse(truncate(plain, w).padEnd(w));
				const rest = truncate(` ${t.id}  ${t.description}`, w - 4);
				return `  ${theme.fg(iconColor(t.status), taskIcon(t.status))}${rest}`;
			};
			// Uma entry do Progress Log com segmentos coloridos (o Enu): rel dim + segmentos, corta a `w`.
			const logLineColored = (e: ProgressEntry, w: number): string => {
				const relS = (e.rel || "·").padStart(8);
				let used = relS.length + 2;
				let out = `${dim(relS)}  `;
				const segs = e.segments && e.segments.length ? e.segments : [{ text: e.text, tone: "dim" as const }];
				for (const s of segs) {
					if (used >= w) break;
					const room = w - used;
					const txt = s.text.length > room ? truncate(s.text, room) : s.text;
					out += theme.fg(s.tone, txt);
					used += txt.length;
				}
				return out;
			};
			// ── RIGHT column: Tasks list + divisor `cnu` + Progress Log (Droid §1b). Devolve o array e o
			// índice do divisor (`dividerAt`) pra drawMain virar a metade direita em régua `├──┤` ali.
			const rightSplit = (m: ControlModel, w: number, bodyRows: number, activeId?: string): { right: string[]; dividerAt?: number } => {
				const tasksHeader = splitLineRender(accentB("Tasks"), dim(`${m.tasksDone}/${m.tasksTotal}`), w, 1, visibleWidth, clipToWidth);
				// Scroll AUTOMÁTICO: janela em torno da task ATIVA (segue o worker) em vez do head-slice fixo
				// — era o que sumia a task 9 ("+4 more" sem mostrar a corrente). header+blank consomem 2 linhas.
				const ftBudget = Math.max(3, Math.floor(bodyRows * 0.5));
				const activeIdx = activeId ? m.tasks.findIndex((t) => t.id === activeId) : -1;
				const win = taskWindow(m.tasks.length, activeIdx >= 0 ? activeIdx : 0, Math.max(1, ftBudget - 2));
				const taskLines: string[] = [];
				if (win.above > 0) taskLines.push(dim(`  ↑ ${win.above} more`));
				for (let i = win.start; i < win.start + win.count; i++) taskLines.push(taskRowLine(m.tasks[i], w, activeId));
				if (win.below > 0) taskLines.push(dim(`  +${win.below} more`));
				const tasksBlock = [tasksHeader, "", ...taskLines];
				if (bodyRows < 5) return { right: tasksBlock.slice(0, bodyRows) }; // tela curta: só tasks, sem divisor
				let ftRows = tasksBlock.length;
				if (ftRows > bodyRows - 2) ftRows = Math.max(1, bodyRows - 2);
				const logRows = Math.max(1, bodyRows - ftRows - 1);
				const logView = progressLogLines(m, Math.max(1, logRows - 1), w - 1);
				const logHeader = splitLineRender(accentB("Progress Log"), logView.range ? dim(logView.range) : "", w, 1, visibleWidth, clipToWidth);
				const logLines = logView.entries.length ? logView.entries.map((e) => logLineColored(e, w - 1)) : [dim(" (no progress entries yet)")];
				const logBlock = [logHeader, ...logLines];
				const right: string[] = [];
				for (let k = 0; k < bodyRows; k++) {
					if (k < ftRows) right.push(tasksBlock[k] ?? "");
					else if (k === ftRows) right.push(""); // placeholder do divisor (ignorado pelo drawMain)
					else right.push(logBlock[k - ftRows - 1] ?? "");
				}
				return { right, dividerAt: ftRows };
			};
			// Banda Active Worker (cap. 08a) — mini-transcript AO VIVO do único worker running/paused:
			// título (#N · featureId · Duration ao vivo) + linha em branco + entries (mensagem/tool, 2 linhas cada).
			// Entry com DENSIDADE (session viewer, droid §7b.3): d = linhas máx por entry (1..5).
			// d=1 → só a headline; mensagens embrulham até d linhas; tools = headline + result até d−1.
			const renderEntryDense = (e: WorkerEntry, w: number, d: number): string[] => {
				if (e.kind === "message") {
					const glyph = e.role === "user" ? ">" : e.role === "assistant" ? "⛬" : "●";
					const gtone = e.role === "system" ? "muted" : "accent";
					const body = wrapText(e.text ?? "", Math.max(1, w - 4), d);
					const out = [` ${theme.bold(theme.fg(gtone, glyph))} ${theme.fg("text", body[0] ?? "")}`];
					for (const b of body.slice(1, d)) out.push(`   ${theme.fg("text", b)}`);
					return out;
				}
				const label = toolLabel(e.toolName ?? "tool");
				const params = truncate(e.params ?? "", Math.max(0, w - label.length - 4));
				const out = [` ${theme.bold(theme.fg("accent", label))}  ${dim(params)}`];
				if (d > 1 && e.result && e.result.trim()) {
					const marker = e.isError ? "✗" : "→";
					const tone = e.isError ? "error" : "toolOutput";
					const wrapped = wrapText(e.result.replace(/\s+/g, " ").trim(), Math.max(1, w - 4), d - 1);
					out.push(`  ${theme.fg(tone, marker)} ${theme.fg(tone, wrapped[0] ?? "")}`);
					for (const b of wrapped.slice(1, d - 1)) out.push(`    ${theme.fg(tone, b)}`);
				}
				return out;
			};
			// Banda Active Worker: cada entry ocupa EXATAMENTE 2 linhas (altura fixa) — é o renderEntryDense
			// com d=2, padded a 2 linhas (antes era uma cópia quase idêntica — colapsado p/ uma fonte só).
			const renderEntry = (e: WorkerEntry, w: number): string[] => {
				const out = renderEntryDense(e, w, 2);
				return [out[0] ?? "", out[1] ?? ""];
			};
			/** Entries do worker escolhido no session viewer (gravado → sessão em disco; live → .output). */
			const sessionEntries = (): WorkerEntry[] => {
				if (sessionLiveIdx !== undefined) {
					const la = listLiveAgents()[sessionLiveIdx];
					const native = la ? readLiveAgentEntries(ctx.sessionManager?.getSessionFile?.(), la) : null;
					if (native && native.length > 0) return native;
					return la?.recentActivity?.length ? entriesFromActivity(la.recentActivity) : [];
				}
				if (!sessionWsid || sessionWsid === "—") return [];
				const native = readNativeWorkerEntries(ctx.cwd, featureId, sessionWsid);
				if (native && native.length > 0) return native;
				return readWorkerSession(ctx.cwd, featureId, sessionWsid);
			};
			const buildWorkerBand = (aw: ActiveWorker, workerRows: number, w: number): string[] => {
				const sA = Math.max(0, workerRows - 2);
				// Título 1:1 com o droid ($H, 08a §4a): `Active Worker  #N  <featureId>  …  Duration <d|->`.
				// SEM tag `● live`/spinner (dead code no droid); Duration TICA ao vivo (anchor + ticker).
				const durMs = liveDurationMs(aw);
				const durText = durMs !== undefined ? formatDuration(durMs) || "0s" : "-";
				const right = `${dim("Duration")} ${theme.fg("muted", durText)}`;
				const idText = truncate(featureId, Math.max(8, w - 20 - (9 + durText.length) - 4));
				const left = `${accentB("Active Worker")}  ${theme.fg("muted", `#${aw.number}`)}  ${dim(idText)}`;
				// 2ª linha da banda: o modelo EFETIVO do worker ("opus-4.8 (XHigh)", gravado no step_started).
				// Herda a sessão (subagent live / run antigo sem o campo) → label vazio → linha em branco.
				const mdlLabel = activeWorkerModelLabel(aw);
				const head: string[] = [splitLineRender(left, right, w, 1, visibleWidth, clipToWidth), mdlLabel ? clipToWidth(`  ${theme.fg("muted", mdlLabel)}`, w) : ""];
				if (sA <= 0) return head.slice(0, workerRows);
				// Caminho NATIVO — a transcript REAL, o análogo do tcT/dG0 do 08a: headless → o jsonl da sessão
				// do worker (runs/<id>/sessions via pi 0.80.3 parseSessionEntries); in-session subagent
				// (pi-subagents) → o session.jsonl do child (sob a session-root do parent, ou o sessionFile
				// do status.json em async). Fallback ao activity feed quando indisponível (1º frame).
				let native: WorkerEntry[] | null = null;
				if (aw.source === "session" && aw.wsid) native = readNativeWorkerEntries(ctx.cwd, featureId, aw.wsid);
				else if (aw.source === "live") native = readLiveAgentEntries(ctx.sessionManager?.getSessionFile?.(), { runId: aw.runId, asyncDir: aw.asyncDir });
				const entries = native && native.length > 0 ? native : workerEntries(ctx.cwd, featureId, aw);
				const maxItems = Math.max(1, Math.floor(sA / 2));
				// Largura interna do preview — o `B = max(40, H − 3)` do dG0 (fullRow clipa o excesso).
				const cw = Math.max(40, w - 3);
				const content: string[] = [];
				for (const e of entries.slice(-maxItems)) content.push(...renderEntry(e, cw));
				if (entries.length === 0) {
					// Sem transcript ao vivo (o `.output` do @tintinweb ainda não existe — 1º frame — e sem
					// buffer de activity): mostra um sinal HONESTO de que o worker está trabalhando
					// (tool atual + counts) em vez do beco "(no worker activity yet)".
					const parts: string[] = [];
					if (aw.currentTool) parts.push(aw.currentTool);
					if (aw.toolCount) parts.push(`${aw.toolCount} tool${aw.toolCount === 1 ? "" : "s"}`);
					if (aw.tokens) parts.push(`${aw.tokens >= 1000 ? `${Math.round(aw.tokens / 1000)}k` : aw.tokens} tokens`);
					const hint = parts.length ? `working — ${parts.join(" · ")}` : aw.status === "paused" ? "paused" : "working… (logs stream in the native subagent view)";
					content.push(` ${theme.bold(theme.fg("accent", "⛬"))} ${theme.fg("muted", truncate(hint, Math.max(0, w - 4)))}`);
				}
				while (content.length < sA) content.push("");
				if (content.length > sA) content.length = sA;
				return [...head, ...content];
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
				split: (l, r, w, px) => splitLineRender(l, r, w, px, visibleWidth, clipToWidth),
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
			// Tab-row com contagem por filtro (o `All (8) │ Pending (3)` do Droid §3). labels já vêm contados.
			const countedFilterRow = (labels: string[], activeIdx: number): string => `${tabRowText(theme, labels, activeIdx)}   ${dim("(T cycles)")}`;
			const colorBlock = (lines: string[]): string[] =>
				lines.map((l) => {
					if (l === "") return "";
					if (/^\S/.test(l)) return accentB(l);
					// Handoff: severidade `[blocking]` em VERMELHO (o tnu do Droid §8); demais avisos em warning.
					if (l.includes("[blocking]")) return theme.fg("error", l);
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
					const liveAgents = listLiveAgents();
					// O único worker ativo (running/paused) — o `KG0`. Define se a banda (~35%) aparece.
					const aw = pickActiveWorker(m, liveAgents);
					const { bodyRows, workerRows } = mainLayout(rows, !!aw);
					// Active task efetiva: o disco (m.active) ou, no nativo antes do task_started chegar, o
					// subagent vivo — mantém o painel Active Task e a row realçada coerentes com o worker.
					const liveId = liveAgents[0]?.taskId;
					const activeId = m.active?.id ?? (liveId && liveId !== "—" ? liveId : undefined);
					const left = leftCard(m, leftW, bodyRows, activeId);
					const { right, dividerAt } = rightSplit(m, rightW, bodyRows, activeId);
					const band = aw && workerRows > 0 ? buildWorkerBand(aw, workerRows, cols - 2) : [];
					return drawMain(cols, rows, { header: headerLine(cols, m), bar: barLine(cols, m), left, right, worker: band, footer: footerLine("main"), midPos, rightDivider: dividerAt }, deps);
				}

				// Chrome PERSISTENTE (look inset 1:1, Droid §2): título + barra do Feature Control por cima
				// de cada sub-view — ele renderiza DENTRO da moldura, não como caixa separada.
				const chrome = { header: headerLine(cols, m), bar: barLine(cols, m) };
				if (view === "task_detail" && detailTaskId) {
					const body = colorBlock(taskDetailLines(m, detailTaskId, detailExpanded)).map((l) => ` ${l}`);
					return drawSub(cols, rows, { chrome, headerRows: [` ${accentB(`Task ${detailTaskId}`)}`], body, footer: footerLine("task_detail") }, deps);
				}
				if (view === "handoff" && handoffWsid) {
					const body = colorBlock(handoffLines(m, handoffWsid)).map((l) => ` ${l}`);
					return drawSub(cols, rows, { chrome, headerRows: [` ${accentB("Worker Handoff")}`], body, footer: footerLine("handoff") }, deps);
				}
				if (view === "session") {
					// Worker Session viewer (droid §7b): header rico + transcript com densidade + follow-tail.
					const w = cols - 4;
					const live = sessionLiveIdx !== undefined ? listLiveAgents()[sessionLiveIdx] : undefined;
					const wk = m.workers.find((x) => x.workerSessionId === (sessionWsid ?? "") && (!sessionTaskId || x.taskId === sessionTaskId)) ?? m.workers.find((x) => x.taskId === sessionTaskId);
					const sid = live ? (live.runId ?? "live") : (sessionWsid ?? "—");
					const status = live ? "running" : (wk?.status ?? "—");
					const durMs = live ? undefined : wk?.durationMs;
					const info: string[] = [`${dim("Session")} ${theme.fg("text", shortId(sid))}`, `${dim("Task")} ${theme.fg("text", sessionTaskId ?? wk?.taskId ?? "—")}`, `${dim("Status")} ${theme.fg(status === "running" ? "success" : "muted", String(status))}`];
					if (durMs !== undefined) info.push(`${dim("Duration")} ${theme.fg("muted", formatDuration(durMs) || "0s")}`);
					// Modelo EFETIVO da sessão (do step_started via WorkerRow) — omitido quando herda/desconhecido.
					const sessMdl = activeWorkerModelLabel(wk ?? null);
					if (sessMdl) info.push(`${dim("Model")} ${theme.fg("muted", sessMdl)}`);
					const entries = sessionEntries();
					const flat: string[] = [];
					for (const e of entries) flat.push(...renderEntryDense(e, w, density));
					const headerRows = [` ${accentB("Worker Session")}`, ` ${info.join("   ")}`];
					const cap = subBodyRows(rows, headerRows.length, true);
					lastSessTotal = flat.length;
					lastSessCap = cap;
					const win = sessionWindow(flat.length, sessOffset, cap);
					const tail = win.follow ? theme.fg("success", "● tail") : theme.fg("warning", "↑ scrolled");
					headerRows[1] += `   ${dim(`density ${density}`)}   ${tail}${win.range ? `   ${dim(win.range)}` : ""}`;
					let body: string[];
					if (flat.length === 0) {
						// empty-state ladder (droid §7b.6): sem sessão → sem transcript → a caminho.
						const why = live ? "transcript not written yet — the live stream lands on turn end" : !sessionWsid || sessionWsid === "—" ? "no session recorded for this worker" : "transcript not available (session file missing)";
						body = ["", dim(`  (${why})`)];
					} else {
						body = flat.slice(win.start, win.start + win.count);
					}
					return drawSub(cols, rows, { chrome, headerRows, body, footer: footerLine("session") }, deps);
				}
				if (view === "delivery") {
					// Render rico read-only: badge de estado, issue, branch, CI em chips coloridos, barra de fix-loop, merge.
					return drawSub(cols, rows, { chrome, headerRows: [` ${accent("⛬")} ${accentB("Delivery")}`], body: deliveryPanelLines(m.delivery, deliveryPaint, cols - 2), footer: footerLine("delivery") }, deps);
				}

				// list views: tasks / workers / coverage — tabs com contagem (Droid §3).
				let headerRows: string[];
				let rows0: Row[];
				if (view === "tasks") {
					headerRows = [` ${accentB(`Tasks (${m.tasks.length})`)}`, ` ${countedFilterRow(taskTabLabels(m), TASK_FILTERS.indexOf(taskFilter))}`];
					rows0 = taskDisplayRows(m, taskFilter);
				} else if (view === "workers") {
					// Prepend os workers AO VIVO (subagents rodando, sem handoff ainda) — só nos filtros
					// que mostram ativos (All/Active). Era a causa do "agent não aparece no control".
					const live = listLiveAgents();
					const liveRows = workerFilter === "all" || workerFilter === "active" ? liveAgentRows(live) : [];
					headerRows = [` ${accentB(`Workers (${m.workers.length + liveRows.length})`)}`, ` ${countedFilterRow(workerTabLabels(m, live.length), WORKER_FILTERS.indexOf(workerFilter))}`];
					rows0 = [...liveRows, ...workerDisplayRows(m, workerFilter)];
				} else {
					headerRows = [` ${accentB(`Coverage (${coverageSummary(m)})`)}`, ` ${dim("assertion → task → status")}`];
					rows0 = coverageDisplayRows(m);
				}
				lastRowCount = rows0.length;
				const bodyRows = subBodyRows(rows, headerRows.length, true);
				list = buildList(view, rows0, bodyRows);
				wireSelect(view, rows0);
				const lines = list.render(Math.max(4, cols - 4)).map((l) => ` ${l}`);
				return drawSub(cols, rows, { chrome, headerRows, body: lines, footer: footerLine(view) }, deps);
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
					// Enter = SESSION VIEWER (droid §7b) — tanto pro worker gravado (sessão em disco) quanto
					// pro live agent (.output do @tintinweb). `h` continua a abrir o handoff direto.
					list.onSelect = (it) => {
						if (it.value.startsWith("live__")) {
							sessionLiveIdx = Number(it.value.slice("live__".length)) || 0;
							sessionWsid = undefined;
							sessionTaskId = listLiveAgents()[sessionLiveIdx]?.taskId;
						} else {
							const [wsid, taskId] = it.value.split("__");
							sessionWsid = wsid;
							sessionTaskId = taskId;
							sessionLiveIdx = undefined;
						}
						sessOffset = null; // abre colado ao fim (follow-tail)
						view = "session";
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
			// Tick de re-render enquanto há worker ativo: subagents AO VIVO (stats em memória) E a
			// Duration do título (recomputada de Date.now() − anchor a cada frame — o interval de 1s do droid).
			const ticker = setInterval(() => {
				if (listLiveAgents().length > 0 || model?.workers.some((x) => x.status === "running")) tui.requestRender();
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
						// cols tem piso 20 p/ layout estável, mas o retorno é SEMPRE clipado a `width`
						// (o pi-tui aborta em linha > width; terminal < 20 col crashava deterministicamente).
						const cols = Math.max(20, width);
						const rows = Math.max(12, tui.terminal.rows);
						return renderScreen(cols, rows).map((l) => clipToWidth(l, width));
					} catch (e) {
						return [clipToWidth(` ⚠ Feature Control render error: ${(e as Error).message}`, width), " Esc / Ctrl+C to close"];
					}
				},
				invalidate: (): void => {
					list?.invalidate();
				},
				handleInput: (data: string): void => {
					try {
						// Steer mode captura TUDO (input de texto) até Enter/Esc.
						if (steerMode) {
							if (matchesKey(data, "escape")) {
								steerMode = false;
								steerBuffer = "";
							} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
								const text = steerBuffer.trim();
								steerMode = false;
								steerBuffer = "";
								if (text) {
									notice = "steering…";
									void steerWorker(featureId, text).then((r) => {
										notice = r === "sent" ? "✓ sent to the live worker" : r === "no_worker" ? "no live worker" : "worker wire refused (try between turns)";
										tui.requestRender();
									});
								}
							} else if (matchesKey(data, "backspace")) {
								steerBuffer = steerBuffer.slice(0, -1);
							} else if (data >= " " && !data.startsWith("\x1b")) {
								steerBuffer += data;
							}
							return tui.requestRender();
						}
						if (matchesKey(data, "alt+t") || matchesKey(data, "ctrl+c")) return finish({ kind: "close" });
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
							else if (matchesKey(data, "o")) openRunDir();
							else if (matchesKey(data, "p")) {
								// Pause graceful (tecla P do Droid): aborta o run ativo — o runner persiste paused e o
								// worker é interrompido RETENDO o transcript; o watcher re-renderiza do disco.
								notice = pauseRun(featureId) ? "pausing… (worker interrupted, transcript retained)" : "no active run to pause";
							} else if (matchesKey(data, "shift+r")) {
								if (canResume()) return finish({ kind: "resume", restartFeature: true });
								notice = isRunActive(featureId) ? "run already active" : "nothing to restart";
							} else if (matchesKey(data, "r")) {
								if (canResume()) return finish({ kind: "resume" });
								notice = isRunActive(featureId) ? "run already active" : "nothing to resume";
							} else if (matchesKey(data, "s")) {
								if (hasWorkerClient(featureId)) {
									steerMode = true;
									steerBuffer = "";
								} else notice = "no live worker to steer";
							} else if (matchesKey(data, "b")) return finish({ kind: "switch" });
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
						if (view === "session") {
							// Worker Session viewer (droid §7b): scroll+follow-tail, densidade, steer, handoff.
							if (esc) view = "workers";
							else if (matchesKey(data, "up") || matchesKey(data, "k")) sessOffset = scrollOffset(lastSessTotal, sessOffset, lastSessCap, -1);
							else if (matchesKey(data, "down") || matchesKey(data, "j")) sessOffset = scrollOffset(lastSessTotal, sessOffset, lastSessCap, 1);
							else if (matchesKey(data, "pageUp")) sessOffset = scrollOffset(lastSessTotal, sessOffset, lastSessCap, -lastSessCap);
							else if (matchesKey(data, "pageDown")) sessOffset = scrollOffset(lastSessTotal, sessOffset, lastSessCap, lastSessCap);
							else if (matchesKey(data, "g") && !matchesKey(data, "shift+g")) sessOffset = lastSessTotal > lastSessCap ? 0 : null;
							else if (matchesKey(data, "shift+g") || matchesKey(data, "end")) sessOffset = null;
							else if (data === "[") density = cycleDensity(density, -1);
							else if (data === "]") density = cycleDensity(density, 1);
							else if (matchesKey(data, "s")) {
								if (hasWorkerClient(featureId)) {
									steerMode = true;
									steerBuffer = "";
								} else notice = "no live worker to steer";
							} else if (matchesKey(data, "h")) {
								const wsid = sessionWsid && sessionWsid !== "—" ? sessionWsid : undefined;
								if (wsid && model?.handoffsRaw.some((x) => x.workerSessionId === wsid)) {
									handoffWsid = wsid;
									handoffBack = "session";
									view = "handoff";
								} else notice = "no handoff recorded for this session yet";
							} else return;
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
						} else if (matchesKey(data, "r") && view === "workers") {
							// `r` = resume DAQUELA sessão (o resumeWorkerSessionId do start_mission_run) —
							// "selecionar o worker e fazer ele voltar".
							const it = list?.getSelectedItem();
							const wsid = it && !it.value.startsWith("live__") ? it.value.split("__")[0] : undefined;
							if (wsid && !isRunActive(featureId)) return finish({ kind: "resume", resumeWorkerSessionId: wsid });
							notice = isRunActive(featureId) ? "run already active" : "select a recorded worker session";
						} else if (matchesKey(data, "g")) {
							// g = Top (Droid §9); G = Bottom. SelectList não tem home/end nativo — setSelectedIndex.
							list?.setSelectedIndex(0);
							sel.set(view, 0);
						} else if (matchesKey(data, "shift+g")) {
							const last = Math.max(0, lastRowCount - 1);
							list?.setSelectedIndex(last);
							sel.set(view, last);
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
