/**
 * Painel da config de modelo por role (orchestrator / worker / validator) — overlay
 * no estilo do readiness-gate (Container + DynamicBorder + Text + SelectList).
 *
 * UX SEQUENCIAL: uma linha por role mostrando o valor combinado "Model (Effort)"
 * (ex.: "Claude Opus 4.8 (XHigh)"). Enter num role abre o picker de MODEL e, ao
 * escolher, encadeia automaticamente o picker de EFFORT. "Save" persiste; esc cancela.
 * A lógica/persistência/display é pura (model-config.ts) — aqui é só a camada de UI.
 *
 * ponytail: precisa de smoke test ao vivo (não dá pra rodar o TUI do Pi aqui); a lógica
 * pura é coberta por test/model-config.test.ts.
 */
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import {
	defaultModelRef,
	type Effort,
	EFFORTS,
	effortLabel,
	HARNESS_ROLES,
	type HarnessModelConfig,
	type HarnessRole,
	INHERIT,
	isEffort,
	modelLabel,
	type PiSettingsView,
	roleSummary,
} from "./model-config.ts";

const TITLE = "⬢ pi-harness · models per role";
const NAV_HINT = "enter edit (model → effort) · ↑↓ move · esc cancel";
const SUBTITLE = "Governs harness-spawned children (headless runner · converge). The live in-session orchestrator uses your Pi session model.";

function selectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
		selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function panelFrame(theme: Theme, title: string, body: SelectList, hint: string, subtitle?: string): Container {
	const container = new Container();
	const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
	container.addChild(border());
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	if (subtitle) container.addChild(new Text(theme.fg("dim", subtitle), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(body);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", hint), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(border());
	return container;
}

type GateKey = "skipScrutiny" | "skipUserTesting" | "skipDelivery";
type PanelAction = { kind: "save" } | { kind: "cancel" } | { kind: "edit"; role: HarnessRole } | { kind: "toggle"; gate: GateKey };

function rolesPanel(ctx: ExtensionContext, cfg: HarnessModelConfig, opts: { labels?: Record<string, string>; fallback?: string }): Promise<PanelAction> {
	return ctx.ui.custom<PanelAction>((tui, theme, _kb, done) => {
		const items: SelectItem[] = [
			{ value: "save", label: "✓ Save & apply", description: "persist to ~/.pi/agent/pi-harness/models.json" },
			...HARNESS_ROLES.map((role) => ({ value: `role:${role}`, label: role, description: roleSummary(cfg, role, opts) })),
			{ value: "gate:skipScrutiny", label: `Skip scrutiny  [${cfg.gates.skipScrutiny ? "ON" : "OFF"}]`, description: cfg.gates.skipScrutiny ? "ship gate SKIPS harness-code-review (3-axis review)" : "harness-code-review runs at the ship gate" },
			{ value: "gate:skipUserTesting", label: `Skip user testing  [${cfg.gates.skipUserTesting ? "ON" : "OFF"}]`, description: cfg.gates.skipUserTesting ? "ship gate SKIPS harness-qa-validator (contract on real surface)" : "harness-qa-validator runs at the ship gate" },
			{ value: "gate:skipDelivery", label: `Skip delivery  [${cfg.gates.skipDelivery ? "ON" : "OFF"}]`, description: cfg.gates.skipDelivery ? "ship gate SKIPS harness-deliver (PR + Linear + CI watch + fix loop + merge/cancel)" : "harness-deliver runs at the ship gate (opens PR, watches CI, fixes, human merge gate)" },
		];
		const selectList = new SelectList(items, Math.min(items.length, 10), selectListTheme(theme));
		selectList.onSelect = (item) => {
			if (item.value === "save") return done({ kind: "save" });
			if (item.value.startsWith("gate:")) return done({ kind: "toggle", gate: item.value.slice("gate:".length) as GateKey });
			done({ kind: "edit", role: item.value.slice("role:".length) as HarnessRole });
		};
		selectList.onCancel = () => done({ kind: "cancel" });
		const container = panelFrame(theme, TITLE, selectList, NAV_HINT, SUBTITLE);
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/** Sub-picker de uma opção (items já rotulados); resolve `undefined` no esc (sem mudança). */
function pickOne(ctx: ExtensionContext, title: string, items: SelectItem[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const selectList = new SelectList(items, Math.min(items.length, 12), selectListTheme(theme));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		const container = panelFrame(theme, `⬢ ${title}`, selectList, "enter select · esc keep current");
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export interface ShowModelConfigInput {
	config: HarnessModelConfig;
	/** "provider/id" selecionáveis, já ordenados (registry + enabledModels do settings). */
	models: string[];
	/** ref → nome amigável (display names do registry) pro picker e o display combinado. */
	labels?: Record<string, string>;
	/** settings.json do usuário — pra exibir o default herdado. */
	settings: PiSettingsView;
}

/**
 * Abre o painel; editar um role é SEQUENCIAL (model → effort). Resolve com o config
 * atualizado (em memória — o caller persiste via saveModelConfig) ou `undefined` no cancel.
 */
export async function showModelConfig(ctx: ExtensionContext, input: ShowModelConfigInput): Promise<HarnessModelConfig | undefined> {
	const cfg: HarnessModelConfig = JSON.parse(JSON.stringify(input.config));
	const fallback = defaultModelRef(input.settings);
	const display = { labels: input.labels, fallback };
	const modelItems: SelectItem[] = [{ value: INHERIT, label: INHERIT, description: "use the parent/session model" }, ...input.models.map((ref) => ({ value: ref, label: modelLabel(ref, display) }))];
	const effortItems: SelectItem[] = [{ value: INHERIT, label: INHERIT, description: "use the model's default thinking level" }, ...EFFORTS.map((e) => ({ value: e, label: effortLabel(e) }))];

	for (;;) {
		const action = await rolesPanel(ctx, cfg, display);
		if (action.kind === "cancel") return undefined;
		if (action.kind === "save") return cfg;
		if (action.kind === "toggle") {
			cfg.gates[action.gate] = !cfg.gates[action.gate];
			continue;
		}

		// SEQUENCIAL: model primeiro; esc no model aborta a edição (não abre o effort).
		const role = action.role;
		const pm = await pickOne(ctx, `${role} · model`, modelItems);
		if (pm === undefined) continue;
		cfg.roles[role].model = pm === INHERIT ? undefined : pm;
		// Encadeia o effort. esc mantém o atual.
		const pe = await pickOne(ctx, `${role} · effort — ${modelLabel(cfg.roles[role].model, display)}`, effortItems);
		if (pe !== undefined) cfg.roles[role].thinking = isEffort(pe) ? (pe as Effort) : undefined;
	}
}
