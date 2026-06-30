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
 */
export function splitLineRender(left: string, right: string, width: number, padX: number, widthOf: (s: string) => number): string {
	const pad = " ".repeat(padX);
	const inner = Math.max(0, width - padX * 2);
	const gap = Math.max(1, inner - widthOf(left) - widthOf(right));
	return `${pad}${left}${" ".repeat(gap)}${right}${pad}`;
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
