/**
 * Hand-drawn FULL-SCREEN frame primitives — o recreate fiel do cap. 08 (Mission Control)
 * dos docs de referência, rebrandeado pro nosso domínio. PURO, pi-free, testável isolado
 * (test/control-draw.test.ts).
 *
 * Ao contrário da frame compartilhada (control-frame.ts, caixa `round` inline = "chat
 * extension"), aqui o overlay NÃO usa borda do Ink/pi: a moldura é desenhada glifo-a-glifo
 * — cantos QUADRADOS (`┌ ┐ └ ┘`, a assinatura visual do cap. 08), réguas `├─┤`, divisor de
 * coluna `┬…┴`, e linhas de conteúdo `│ … │`. Ocupa a tela inteira: produz EXATAMENTE `rows`
 * linhas, cada uma com `cols` colunas visíveis (opaca, cobre o transcript por baixo).
 *
 * Primitivas (análogas a aAT/FST/ynu do cap. 08):
 *   rule    → régua/borda horizontal (com `┬`/`┴` opcional no midPos)   [aAT]
 *   fullRow → linha cheia `│ … │`                                        [FST]
 *   twoRow  → linha de duas colunas `│ L │ R │`                          [ynu]
 *
 * Cor e medida são INJETADAS: `border` colore só os glifos de moldura (o conteúdo das
 * células já vem colorido pelo caller); `widthOf`/`clip` medem/cortam ignorando ANSI
 * (visibleWidth/sliceByColumn no runtime, `.length`/`.slice` nos testes) — assim ANSI nunca
 * quebra a geometria.
 */

export type Color = (s: string) => string;
export type WidthOf = (s: string) => number;
export type Clip = (s: string, width: number) => string;

const ID: Color = (s) => s;
const LEN: WidthOf = (s) => s.length;
const SLICE: Clip = (s, w) => s.slice(0, Math.max(0, w));

export interface DrawDeps {
	/** colore os glifos de moldura (`┌ ┐ │ ─ …`). Default identidade (testes). */
	border?: Color;
	/** mede largura visível (ignora ANSI). Default `.length`. */
	widthOf?: WidthOf;
	/** corta pra `width` colunas preservando estilo. Default `.slice`. */
	clip?: Clip;
}

// Box-drawing — cantos QUADRADOS (assinatura do cap. 08, vs os `╭╮╰╯` do resto).
const H = "─";
const VBAR = "│";
const TL = "┌";
const TR = "┐";
const BL = "└";
const BR = "┘";
const ML = "├";
const MR = "┤";
const MT = "┬";
const MB = "┴";

/** Ajusta `content` pra exatamente `width` colunas visíveis: corta se excede, padeia com espaços. */
function cell(content: string, width: number, widthOf: WidthOf, clip: Clip): string {
	if (width <= 0) return "";
	const w = widthOf(content);
	if (w === width) return content;
	if (w > width) return clip(content, width);
	return content + " ".repeat(width - w);
}

/**
 * Régua/borda horizontal de largura `cols`. `left`/`right` default `├`/`┤` (tee nas laterais);
 * passe `┌`/`┐` (topo), `└`/`┘` (base). Com `mid`+`midPos` insere `┬`/`┴` na coluna `midPos`
 * (alinhado ao `│` do meio do twoRow). A string inteira é colorida por `border`.
 */
export function rule(cols: number, opts: { left?: string; right?: string; mid?: string; midPos?: number } = {}, deps: DrawDeps = {}): string {
	const border = deps.border ?? ID;
	const left = opts.left ?? ML;
	const right = opts.right ?? MR;
	if (cols <= 1) return border(left);
	if (cols === 2) return border(left + right);
	if (opts.mid && opts.midPos !== undefined) {
		const i = Math.max(1, Math.min(opts.midPos, cols - 2));
		const leftFill = Math.max(0, i - 1);
		const rightFill = Math.max(0, cols - i - 2);
		return border(left + H.repeat(leftFill) + opts.mid + H.repeat(rightFill) + right);
	}
	return border(left + H.repeat(cols - 2) + right);
}

/** Linha cheia `│<content>│` (FST). `content` é padeado/cortado pro miolo (`cols-2`). */
export function fullRow(cols: number, content: string, deps: DrawDeps = {}): string {
	const border = deps.border ?? ID;
	const widthOf = deps.widthOf ?? LEN;
	const clip = deps.clip ?? SLICE;
	const inner = Math.max(0, cols - 2);
	return border(VBAR) + cell(content, inner, widthOf, clip) + border(VBAR);
}

/**
 * Linha de duas colunas `│ L │ R │` (ynu). O `│` do meio fica na coluna `midPos` (= índice do
 * `┬`/`┴` das réguas de split). Largura da esquerda = `midPos-1`, da direita = `cols-midPos-2`.
 */
export function twoRow(cols: number, left: string, right: string, midPos: number, deps: DrawDeps = {}): string {
	const border = deps.border ?? ID;
	const widthOf = deps.widthOf ?? LEN;
	const clip = deps.clip ?? SLICE;
	const i = Math.max(1, Math.min(midPos, cols - 2));
	const leftW = Math.max(0, i - 1);
	const rightW = Math.max(0, cols - i - 2);
	return border(VBAR) + cell(left, leftW, widthOf, clip) + border(VBAR) + cell(right, rightW, widthOf, clip) + border(VBAR);
}

// ─────────────────────────────────────────────────────────────────────────────
// Montagem das telas (full-screen): produzem EXATAMENTE `rows` linhas.

export interface MainParts {
	/** banda de cabeçalho (1 linha): título · dir · `● Live`. */
	header: string;
	/** linha da barra de progresso: ícone · estado · `█▒` · ratio. */
	bar: string;
	/** coluna esquerda (Active Task + Tasks list) — colorida pelo caller. */
	left: string[];
	/** coluna direita (Progress Log). */
	right: string[];
	/** faixa Active Worker (1 linha). */
	worker: string;
	/** barra de footer (1 linha): `F Tasks   W Workers   …`. */
	footer: string;
	/** coluna do `│` divisor (alinha com `┬`/`┴`). */
	midPos: number;
}

/** Quantas linhas de corpo (duas colunas) o main view tem pra uma tela de `rows`. */
export function mainBodyRows(rows: number): number {
	return Math.max(1, rows - 10);
}

/**
 * Main view full-screen: topo · header · régua · barra · split(┬) · K linhas de 2 colunas ·
 * join(┴) · worker · régua · footer · base. Total = 10 + K = `rows`.
 */
export function drawMain(cols: number, rows: number, parts: MainParts, deps: DrawDeps = {}): string[] {
	const bodyRows = mainBodyRows(rows);
	const lines: string[] = [];
	lines.push(rule(cols, { left: TL, right: TR }, deps));
	lines.push(fullRow(cols, parts.header, deps));
	lines.push(rule(cols, {}, deps));
	lines.push(fullRow(cols, parts.bar, deps));
	lines.push(rule(cols, { mid: MT, midPos: parts.midPos }, deps));
	for (let k = 0; k < bodyRows; k++) lines.push(twoRow(cols, parts.left[k] ?? "", parts.right[k] ?? "", parts.midPos, deps));
	lines.push(rule(cols, { mid: MB, midPos: parts.midPos }, deps));
	lines.push(fullRow(cols, parts.worker, deps));
	lines.push(rule(cols, {}, deps));
	lines.push(fullRow(cols, parts.footer, deps));
	lines.push(rule(cols, { left: BL, right: BR }, deps));
	return lines;
}

export interface SubParts {
	/** 1-2 linhas de cabeçalho (título; e filtro/subtítulo opcional). */
	headerRows: string[];
	/** corpo (linhas da lista/detalhe), já cortadas pra largura do miolo. */
	body: string[];
	/** barra de footer (hints). */
	footer: string;
}

/** Quantas linhas de corpo um sub-view tem (dado o nº de linhas de cabeçalho). */
export function subBodyRows(rows: number, headerLines: number): number {
	return Math.max(1, rows - (5 + headerLines));
}

/**
 * Sub-view full-screen (Tasks/Workers/Coverage/detalhe): topo · headerRows · régua · K linhas
 * de corpo · régua · footer · base. As laterais `│ … │` dão o look "inset" do cap. 08 (§6).
 */
export function drawSub(cols: number, rows: number, parts: SubParts, deps: DrawDeps = {}): string[] {
	const h = parts.headerRows.length;
	const bodyRows = subBodyRows(rows, h);
	const lines: string[] = [];
	lines.push(rule(cols, { left: TL, right: TR }, deps));
	for (const hr of parts.headerRows) lines.push(fullRow(cols, hr, deps));
	lines.push(rule(cols, {}, deps));
	for (let k = 0; k < bodyRows; k++) lines.push(fullRow(cols, parts.body[k] ?? "", deps));
	lines.push(rule(cols, {}, deps));
	lines.push(fullRow(cols, parts.footer, deps));
	lines.push(rule(cols, { left: BL, right: BR }, deps));
	return lines;
}
