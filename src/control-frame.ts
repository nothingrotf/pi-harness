/**
 * Frame compartilhada da TUI (docs/03-tui.md §4) — o análogo rebrandeado do `In`/`KcT`
 * do Droid: UMA frame que todo overlay/lista usa, pra consistência (a lei de DX nº1).
 * Estrutura: borda (top) · título-dentro (bold) · tab-row inline opcional · subtítulo
 * opcional · corpo · help-line com range à direita · borda (bottom).
 *
 * Segue a convenção do Pi (readiness-report-view / model-config-view): a "caixa" é
 * desenhada por DynamicBorder (réguas top/bottom), não rails laterais. Render só; a
 * lógica de dados/strings é pura (control-model.ts / runs.ts).
 */
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type SelectListTheme, sliceByColumn, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { rangeLabel, splitLineRender, tabRowText } from "./control-render.ts";

export { rangeLabel, tabRowText } from "./control-render.ts";

/** Clip ANSI-safe p/ truncar linhas à largura do terminal (o pi-tui aborta em linha larga). */
export const clipToWidth = (s: string, w: number): string => sliceByColumn(s, 0, Math.max(0, w), true);

/** Tema padrão das SelectList do harness (mesmo visual do readiness/model-config). */
export function selectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
		selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

/**
 * Linha com left + right justificados (space-between), medindo com visibleWidth (ignora
 * ANSI) — é a help-line "range à direita" da frame compartilhada.
 */
export class SplitLine implements Component {
	private left: string;
	private right: string;
	private padX: number;
	constructor(left: string, right: string, padX = 1) {
		this.left = left;
		this.right = right;
		this.padX = padX;
	}
	setContent(left: string, right: string): void {
		this.left = left;
		this.right = right;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [splitLineRender(this.left, this.right, width, this.padX, visibleWidth, clipToWidth)];
	}
}

export interface FrameOpts {
	title: string;
	/** título em bold (default true). O picker genérico do Droid usa não-bold; a maioria bold. */
	titleBold?: boolean;
	tabs?: { labels: string[]; active: number };
	/** linha muted sob o título (description/coluna-header). */
	subtitle?: string;
	body: Component;
	/** help à esquerda (abaixo do corpo). */
	help?: string;
	/** range/paginação à direita da help (ex.: "1-4 of 4"). */
	helpRight?: string;
}

/** Monta a frame compartilhada como um Container (o caller liga input ao `body`). */
export function frame(theme: Theme, opts: FrameOpts): Container {
	const c = new Container();
	const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
	const title = opts.titleBold === false ? theme.fg("accent", opts.title) : theme.bold(theme.fg("accent", opts.title));
	c.addChild(border());
	c.addChild(new Text(title, 1, 0));
	if (opts.tabs) c.addChild(new Text(tabRowText(theme, opts.tabs.labels, opts.tabs.active), 1, 0));
	if (opts.subtitle) c.addChild(new Text(theme.fg("muted", opts.subtitle), 1, 0));
	c.addChild(new Spacer(1));
	c.addChild(opts.body);
	c.addChild(new Spacer(1));
	if (opts.help !== undefined) {
		if (opts.helpRight) c.addChild(new SplitLine(theme.fg("dim", opts.help), theme.fg("dim", opts.helpRight)));
		else c.addChild(new Text(theme.fg("dim", opts.help), 1, 0));
	}
	c.addChild(border());
	return c;
}
