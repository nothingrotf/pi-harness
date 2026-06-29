/**
 * Painel do readiness gate — overlay bordado no estilo do rpiv-advisor
 * (Container + DynamicBorder + Text + SelectList). Renderiza o GateModel
 * (lógica pura em readiness.ts) e devolve a ação escolhida.
 *
 * Layout escolhido: "stance banner + actions" (coluna única compacta):
 *   ⬢ pi-harness · readiness gate
 *   ▲ ABAIXO DA BARRA   L2/5 ▰▰▱▱▱ 34%  target ≥L4
 *   <weakest>
 *   → <ações>
 *   <nav hint>
 *
 * ponytail: precisa de smoke test ao vivo (não dá pra rodar o TUI do Pi aqui);
 * a lógica do modelo é coberta por test/readiness.test.ts.
 */
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import type { GateActionValue, GateModel, Tone } from "./readiness.ts";

const TITLE = "⬢ pi-harness · readiness gate";
const NAV_HINT = "enter select · ↑↓ move · r re-audit · esc cancel";

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
		selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function tonedChip(theme: Theme, tone: Tone, chip: string): string {
	// tone ∈ success|warning|error|muted — todos ThemeColor válidos.
	return theme.bold(theme.fg(tone, chip));
}

function buildPanel(theme: Theme, model: GateModel, selectList: SelectList): Container {
	const container = new Container();
	const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));

	container.addChild(border());
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold(TITLE)), 1, 0));
	container.addChild(new Spacer(1));

	// banner de stance: chip + medidor na mesma linha (medidor vazio no unknown)
	const banner = model.meter ? `${tonedChip(theme, model.tone, model.chip)}   ${theme.fg("muted", model.meter)}` : tonedChip(theme, model.tone, model.chip);
	container.addChild(new Text(banner, 1, 0));
	container.addChild(new Spacer(1));

	// áreas mais fracas (weak/stale)
	if (model.weakest.length > 0) {
		container.addChild(new Text(theme.fg("dim", "Weakest areas"), 1, 0));
		for (const w of model.weakest) {
			const label = w.label.padEnd(10);
			container.addChild(new Text(`  ${theme.fg("muted", label)} ${theme.fg(model.tone, w.bar)} ${theme.fg("muted", w.ratio)}`, 1, 0));
		}
		container.addChild(new Spacer(1));
	}

	container.addChild(selectList);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", NAV_HINT), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(border());
	return container;
}

/**
 * Mostra o gate e resolve com a ação escolhida. `esc` → "cancel"; tecla `r` →
 * "reaudit" (atalho). Sem UI (print/json), o caller deve pular e prosseguir.
 */
export function showReadinessGate(ctx: ExtensionContext, model: GateModel): Promise<GateActionValue> {
	return ctx.ui.custom<GateActionValue>((tui, theme, _kb, done) => {
		const items: SelectItem[] = model.actions.map((a) => ({ value: a.value, label: a.label, description: a.description }));
		const selectList = new SelectList(items, Math.min(items.length, 10), selectListTheme(theme));
		selectList.onSelect = (item) => done(item.value as GateActionValue);
		selectList.onCancel = () => done("cancel");
		const container = buildPanel(theme, model, selectList);

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// atalho global: re-auditar
				if (data === "r" || data === "R") {
					done("reaudit");
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
