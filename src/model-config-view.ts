/**
 * Painel da config de modelo por role (orchestrator / worker / validator) — overlay
 * no estilo do readiness-gate (Container + DynamicBorder + Text + SelectList). Edição
 * em loop: a lista mostra os 3 roles × {model, effort}; Enter num campo abre um
 * sub-picker (SelectList); "Save" persiste; esc cancela. A lógica/persistência é pura
 * (model-config.ts) — aqui é só a camada de UI.
 *
 * ponytail: precisa de smoke test ao vivo (não dá pra rodar o TUI do Pi aqui); a lógica
 * pura é coberta por test/model-config.test.ts.
 */
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { defaultModelRef, type Effort, EFFORTS, HARNESS_ROLES, type HarnessModelConfig, type HarnessRole, INHERIT, isEffort, type PiSettingsView } from "./model-config.ts";

const TITLE = "⬢ pi-harness · models per role";
const NAV_HINT = "enter edit/select · ↑↓ move · esc cancel";
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

interface Field {
	role: HarnessRole;
	kind: "model" | "effort";
}
type PanelAction = { kind: "save" } | { kind: "cancel" } | { kind: "edit"; field: Field };

/** Texto do valor atual de um campo (com a herança explícita). */
function valueLabel(cfg: HarnessModelConfig, role: HarnessRole, kind: "model" | "effort", fallback?: string): string {
	const c = cfg.roles[role];
	if (kind === "model") return c.model ?? `inherit → ${fallback ?? "session model"}`;
	return c.thinking ?? "inherit";
}

function rolesPanel(ctx: ExtensionContext, cfg: HarnessModelConfig, fallback?: string): Promise<PanelAction> {
	return ctx.ui.custom<PanelAction>((tui, theme, _kb, done) => {
		const items: SelectItem[] = [{ value: "save", label: "✓ Save & apply", description: "persist to ~/.pi/agent/pi-harness/models.json" }];
		for (const role of HARNESS_ROLES) {
			items.push({ value: `model:${role}`, label: `${role} · model`, description: valueLabel(cfg, role, "model", fallback) });
			items.push({ value: `effort:${role}`, label: `${role} · effort`, description: valueLabel(cfg, role, "effort", fallback) });
		}
		const selectList = new SelectList(items, Math.min(items.length, 12), selectListTheme(theme));
		selectList.onSelect = (item) => {
			if (item.value === "save") return done({ kind: "save" });
			const [kind, role] = item.value.split(":") as ["model" | "effort", HarnessRole];
			done({ kind: "edit", field: { role, kind } });
		};
		selectList.onCancel = () => done({ kind: "cancel" });

		const container = new Container();
		const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(TITLE)), 1, 0));
		container.addChild(new Text(theme.fg("dim", SUBTITLE), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(selectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", NAV_HINT), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(border());

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

/** Sub-picker de uma opção; resolve `undefined` no esc (sem mudança). */
function pickOne(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const items: SelectItem[] = options.map((o) => ({ value: o, label: o }));
		const selectList = new SelectList(items, Math.min(items.length, 12), selectListTheme(theme));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);

		const container = new Container();
		const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border());
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(`⬢ ${title}`)), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(selectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "enter select · esc keep current"), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(border());

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
	/** "provider/id" selecionáveis (registry + enabledModels do settings). */
	models: string[];
	/** settings.json do usuário — pra exibir o default herdado. */
	settings: PiSettingsView;
}

/**
 * Abre o painel, deixa o usuário editar model/effort por role, e resolve com o config
 * atualizado (em memória — o caller persiste via saveModelConfig) ou `undefined` no cancel.
 */
export async function showModelConfig(ctx: ExtensionContext, input: ShowModelConfigInput): Promise<HarnessModelConfig | undefined> {
	const cfg: HarnessModelConfig = JSON.parse(JSON.stringify(input.config));
	const fallback = defaultModelRef(input.settings);
	for (;;) {
		const action = await rolesPanel(ctx, cfg, fallback);
		if (action.kind === "cancel") return undefined;
		if (action.kind === "save") return cfg;
		const { role, kind } = action.field;
		if (kind === "model") {
			const picked = await pickOne(ctx, `${role} · model`, [INHERIT, ...input.models]);
			if (picked !== undefined) cfg.roles[role].model = picked === INHERIT ? undefined : picked;
		} else {
			const picked = await pickOne(ctx, `${role} · effort`, [INHERIT, ...EFFORTS]);
			if (picked !== undefined) cfg.roles[role].thinking = isEffort(picked) ? (picked as Effort) : undefined;
		}
	}
}
