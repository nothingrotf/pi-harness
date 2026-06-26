/**
 * Estado e formatação do "modo harness" — lógica pura, sem dependência do Pi.
 * Testável isoladamente (test/mode.test.ts). O index.ts liga isto ao TUI.
 */

export type Phase = "idle" | "setup" | "readiness" | "converge" | "run" | "ship";

export interface HarnessMode {
	active: boolean;
	phase: Phase;
	featureId?: string;
	readinessLevel?: number; // 1..5, quando o setup já computou
}

export function idleMode(): HarnessMode {
	return { active: false, phase: "idle" };
}

/**
 * Deriva um id de feature estável a partir do pedido do usuário.
 * slug ascii, sem acento, ≤40 chars. Vazio → "feature".
 */
export function featureIdFromRequest(req: string): string {
	const base = req
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // tira diacríticos (configuração → configuracao)
		.replace(/[^a-z0-9]+/g, "-") // não-alfanumérico → hífen
		.replace(/^-+/, "")
		.slice(0, 40)
		.replace(/-+$/g, ""); // limpa hífen sobrando (inclusive após o slice)
	return base || "feature";
}

/** O badge colado no input (widget aboveEditor). */
export function badgeText(m: HarnessMode): string {
	if (!m.active) return "⬢ pi-harness";
	const parts = ["⬢ pi-harness"];
	if (m.featureId) parts.push(m.featureId);
	parts.push(m.phase);
	return parts.join(" · ");
}

/** O texto compacto do rodapé (setStatus). */
export function statusText(m: HarnessMode): string {
	if (!m.active) return "pi-harness: inativo";
	const lvl = m.readinessLevel ? ` · readiness L${m.readinessLevel}` : "";
	return `${m.phase}${lvl}`;
}
