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

/** Glyph por fase — leitura rápida do estágio no badge/status (text-presentation, single-width). */
export function phaseGlyph(phase: Phase): string {
	switch (phase) {
		case "setup":
			return "⊙";
		case "readiness":
			return "▢";
		case "converge":
			return "◆";
		case "run":
			return "▸";
		case "ship":
			return "✦";
		default:
			return "○";
	}
}

/** O badge colado no input (widget aboveEditor). */
export function badgeText(m: HarnessMode): string {
	if (!m.active) return "⬢ pi-harness";
	const parts = ["⬢ pi-harness"];
	if (m.featureId) parts.push(m.featureId);
	parts.push(`${phaseGlyph(m.phase)} ${m.phase}`);
	return parts.join(" · ");
}

/** O texto compacto do rodapé (setStatus). */
export function statusText(m: HarnessMode): string {
	if (!m.active) return "pi-harness: inativo";
	const lvl = m.readinessLevel ? ` · readiness L${m.readinessLevel}` : "";
	return `${phaseGlyph(m.phase)} ${m.phase}${lvl}`;
}

/** Progresso do feature run (computado pelo caller a partir de plan.json/status.json/feature-run.json). */
export interface ProgressSummary {
	tasksTotal: number;
	tasksDone: number;
	assertionsTotal: number;
	assertionsPassed: number;
	assertionsFailed: number;
}

/**
 * Status RICO (uma linha) pro comando `/harness status`: badge + feature + fase + readiness +
 * progresso (tasks done/total, assertions passed/total, falhas). Omite partes ausentes/zero.
 */
export function statusDetail(m: HarnessMode, progress?: ProgressSummary | null): string {
	if (!m.active) return "pi-harness: inativo";
	const parts = ["⬢ pi-harness"];
	if (m.featureId) parts.push(m.featureId);
	parts.push(`${phaseGlyph(m.phase)} ${m.phase}`);
	if (m.readinessLevel) parts.push(`readiness L${m.readinessLevel}`);
	if (progress) {
		if (progress.tasksTotal > 0) parts.push(`tasks ${progress.tasksDone}/${progress.tasksTotal}`);
		if (progress.assertionsTotal > 0) {
			const fail = progress.assertionsFailed > 0 ? ` (${progress.assertionsFailed} failed)` : "";
			parts.push(`assertions ${progress.assertionsPassed}/${progress.assertionsTotal}${fail}`);
		}
	}
	return parts.join(" · ");
}
