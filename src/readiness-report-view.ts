/**
 * Painel do relatório completo de readiness — overlay bordado navegável (espelha
 * readiness-gate.ts). Renderiza `renderReadinessReport` (lógica pura, testada em
 * test/readiness.test.ts) numa SelectList das linhas, pra scroll por categoria/critério.
 * É o que a ação "View full report" do gate mostra.
 *
 * ponytail: o painel TUI precisa de smoke ao vivo (não dá pra rodar o TUI do Pi aqui);
 * o conteúdo (renderReadinessReport) é coberto por testes puros.
 */
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { type ReadinessSnapshot, renderReadinessReport } from "./readiness.ts";
import { clipToWidth } from "./control-frame.ts";

const TITLE = "⬢ pi-harness · readiness report";
const NAV_HINT = "↑↓ scroll · enter/esc close";

function reportListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.bg("selectedBg", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

/**
 * Mostra o relatório navegável e resolve quando o usuário fecha (enter/esc). Sem UI
 * (print/json), o caller deve pular (checar ctx.hasUI). Visível: 20 linhas por vez.
 */
export function showReadinessReport(ctx: ExtensionContext, snapshot: ReadinessSnapshot, opts: { targetLevel?: number } = {}): Promise<void> {
	const lines = renderReadinessReport(snapshot, opts);
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const items: SelectItem[] = lines.map((l, i) => ({ value: String(i), label: l.length > 0 ? l : " " }));
		const list = new SelectList(items, Math.min(items.length, 20), reportListTheme(theme));
		list.onSelect = () => done(undefined);
		list.onCancel = () => done(undefined);

		const container = new Container();
		const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border());
		container.addChild(new Text(theme.bold(theme.fg("accent", TITLE)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", NAV_HINT), 1, 0));
		container.addChild(border());

		return {
			render: (w) => {
				try {
					return container.render(w);
				} catch (e) {
					return [clipToWidth(` ⚠ render error: ${(e as Error).message}`, w), " Esc / Ctrl+C"];
				}
			},
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
