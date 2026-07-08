/**
 * Run card no transcript (cap. 09) — a view fina que registra o renderer da mensagem custom
 * `harness-run` e a envia ao iniciar um run. O cartão VIVE no transcript (como o tool-card
 * `start_mission_run` do Droid) e se AUTO-ATUALIZA: o render lê o snapshot vivo (run-store) a
 * cada ciclo do TUI; o watcher (control-strip) atualiza o snapshot + dispara o render. Alt+T
 * abre o Feature Control full-screen (opt-in). Conteúdo/strings vêm do módulo puro run-card.ts.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "./control-frame.ts";
import { type RunCard, buildRunCard } from "./run-card.ts";
import { getRunModel } from "./run-store.ts";
import { listLiveAgents } from "./live-agents.ts";

const RUN_CARD_TYPE = "harness-run";
export { RUN_CARD_TYPE };

/** Pinta o cartão com o tema ativo (accent = laranja-análogo; estado tonalizado; hint alt+t). */
function colorizeCard(theme: Theme, card: RunCard): string[] {
	const accent = (s: string): string => theme.fg("accent", s);
	const accentB = (s: string): string => theme.bold(theme.fg("accent", s));
	const dim = (s: string): string => theme.fg("dim", s);
	const stateColor = card.paused ? "warning" : card.phase === "completed" ? "success" : "accent";
	const lines: string[] = [`${accent("⛬")} ${accentB("harness run")} ${dim("·")} ${theme.fg(stateColor, card.summary)}`];
	for (const r of card.rows) {
		const value = r.label === "State" ? theme.fg(stateColor, r.value) : r.value;
		let line = `  ${dim(`${r.label}:`)} ${value}`;
		if (r.label === "Progress") {
			const bc = card.paused ? "warning" : "success";
			line += `  ${theme.fg(bc, card.bar.filled)}${theme.fg("muted", card.bar.pending)}${theme.fg("dim", card.bar.estimate)}`;
		}
		lines.push(line);
	}
	if (card.tasks) lines.push(`  ${dim("Tasks:")} ${card.tasks}`);
	if (card.activity.length) {
		lines.push(`  ${dim("Worker Activity:")}`);
		for (const a of card.activity) lines.push(`    ${dim(a)}`);
	}
	if (card.showHint) lines.push(`  ${accent("alt+t")} ${dim("to enter Feature Control")}`);
	return lines;
}

/** Registra o renderer da mensagem custom (chamar 1x no load da extensão). */
export function registerRunCardRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(RUN_CARD_TYPE, (message, _options, theme) => {
		const featureId = (message.details as { featureId?: string } | undefined)?.featureId;
		if (!featureId) return undefined;
		const component: Component = {
			// Lê o snapshot vivo + os subagents rodando agora (cap. 09): re-renderiza a cada ciclo
			// do TUI (@tintinweb/pi-subagents anima ~80ms), então o Worker tica ao vivo no transcript.
			// CLIP obrigatório: o pi-tui aborta a app inteira numa linha > width, e o card carrega
			// conteúdo dinâmico ilimitado (task ids, activity snippets) — re-renderiza a cada ciclo.
			render: (width: number): string[] => colorizeCard(theme, buildRunCard(getRunModel(featureId), { liveAgents: listLiveAgents() })).map((l) => clipToWidth(l, width)),
			invalidate: (): void => {},
		};
		return component;
	});
}

/** Insere o cartão no transcript pro run dado (display-only, não dispara turn do modelo). */
export function sendRunCard(pi: ExtensionAPI, featureId: string): void {
	pi.sendMessage({ customType: RUN_CARD_TYPE, content: `Feature run: ${featureId}`, display: true, details: { featureId } }, { triggerTurn: false });
}
