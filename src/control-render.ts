/**
 * Helpers de render PUROS da frame compartilhada — SEM value-import de pi (só `type`),
 * pra serem testáveis isolados (test/control-frame.test.ts). control-frame.ts (que usa
 * os componentes pi de verdade) consome estes.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Linha de tabs inline (` │ `), ativo em bold/accent, demais muted — sem `[ ]` (traced). */
export function tabRowText(theme: Theme, labels: string[], active: number): string {
	const sep = theme.fg("dim", " │ ");
	return labels.map((l, i) => (i === active ? theme.bold(theme.fg("accent", l)) : theme.fg("muted", l))).join(sep);
}

/** Range "1-N of T" pra help-line; "" quando vazio (espelha missions.rangeEmpty). */
export function rangeLabel(start: number, end: number, total: number): string {
	if (total <= 0) return "";
	return `${start}-${end} of ${total}`;
}

/**
 * Justifica left/right na largura dada (space-between), medindo com `widthOf` (injetado
 * = visibleWidth no runtime, = .length nos testes) pra ignorar ANSI. Gap mínimo 1.
 * NUNCA excede `width` (o pi-tui aborta em linha larga): se não cabe, trunca o right
 * (depois o left) via `clip` (injetado = sliceByColumn ANSI-safe no runtime, `.slice` nos testes).
 */
export function splitLineRender(
	left: string,
	right: string,
	width: number,
	padX: number,
	widthOf: (s: string) => number,
	clip: (s: string, w: number) => string = (s, w) => s.slice(0, Math.max(0, w)),
): string {
	const pad = " ".repeat(padX);
	const inner = Math.max(0, width - padX * 2);
	const l = widthOf(left) > inner ? clip(left, inner) : left;
	let r = right;
	const roomRight = inner - widthOf(l) - 1;
	if (r && widthOf(r) > roomRight) r = roomRight > 0 ? clip(r, roomRight) : "";
	if (!r) return `${pad}${l}${pad}`;
	const gap = Math.max(1, inner - widthOf(l) - widthOf(r));
	return `${pad}${l}${" ".repeat(gap)}${r}${pad}`;
}

/**
 * Quebra `s` em até `maxLines` linhas de ≤`width` colunas (word-slice; o `xG0` do cap. 08a).
 * Colapsa whitespace; a última linha trunca com reticência se ainda sobra texto.
 * LIMITAÇÃO: mede com `.length` (colunas ≠ chars p/ emoji/CJK e ANSI) — só alimentar com texto
 * plano e SEMPRE clipar o output final com clipToWidth/cell antes de devolver ao pi-tui.
 */
export function wrapText(s: string, width: number, maxLines: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const max = Math.max(1, Math.floor(maxLines));
	const words = String(s ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [];
	const lines: string[] = [];
	let cur = "";
	for (const word of words) {
		const next = cur ? `${cur} ${word}` : word;
		if (next.length <= w) {
			cur = next;
		} else {
			if (cur) lines.push(cur);
			cur = word;
			if (lines.length >= max) break;
		}
	}
	if (lines.length < max && cur) lines.push(cur);
	if (lines.length > max) lines.length = max;
	return lines.map((l) => (l.length > w ? truncate(l, w) : l));
}

/** Trunca pra `n` colunas com reticência (texto plano; sem ANSI). */
export function truncate(s: string, n: number): string {
	if (n <= 0) return "";
	if (s.length <= n) return s;
	if (n <= 1) return s.slice(0, n);
	return `${s.slice(0, n - 1)}…`;
}

/**
 * Funde duas colunas de texto PLANO lado a lado com divisor ` │ ` (espelha o `┬…┴` do
 * Mission Control). Alinha pela maior coluna; left é truncada/padded a `leftWidth`.
 */
export function twoColumn(left: string[], right: string[], leftWidth: number): string[] {
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		const l = truncate(left[i] ?? "", leftWidth).padEnd(leftWidth);
		const r = right[i] ?? "";
		out.push(`${l} │ ${r}`.trimEnd());
	}
	return out;
}
