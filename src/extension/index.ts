/**
 * pi-harness — extensão fina.
 *
 * Registra o comando /harness, dá a "cara" do modo (badge aboveEditor + input
 * recolorido + status no rodapé) e despacha pro resto (setup, convergência) que
 * mora em skills/runner. A extensão NÃO implementa harness — só chrome + dispatch.
 *
 * Fluxo (docs/01-integration.md):
 *   /harness <pedido>  → ensureProfile → readiness gate → ativa modo → CONVERGE
 *   /harness setup     → (re)roda o setup do profile
 *   /harness status    → mostra a fase atual
 *   /harness exit      → sai do modo
 *
 * ponytail: ensureProfile/converge/setup ainda são stubs (Fatias 1-3). O que está
 * vivo aqui é a camada de UX, com smoke test ao vivo pendente pro recolor do input.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { badgeText, featureIdFromRequest, idleMode, statusText, type HarnessMode } from "../mode.ts";

const WIDGET_KEY = "harness-mode";
const STATUS_KEY = "harness";

function profilePath(cwd: string): string {
	return path.join(cwd, ".harness", "profile", "profile.json");
}

async function applyModeChrome(ctx: ExtensionContext, mode: HarnessMode): Promise<void> {
	if (!ctx.hasUI) return;
	const accent = (s: string) => ctx.ui.theme.fg("accent", s);
	// 1. badge colado no input (sinal PRIMÁRIO, sempre)
	ctx.ui.setWidget(WIDGET_KEY, [accent(badgeText(mode))], { placement: "aboveEditor" });
	// 2. status no rodapé
	ctx.ui.setStatus(STATUS_KEY, statusText(mode));
	// 3. input recolorido (REFORÇO, opcional): isolado pra não derrubar o badge se
	// o CustomEditor sumir numa versão futura do Pi.
	try {
		const { harnessEditorFactory } = await import("../harness-editor.ts");
		ctx.ui.setEditorComponent(harnessEditorFactory(accent));
	} catch {
		// recolor indisponível — badge + status seguem valendo.
	}
}

function clearModeChrome(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setEditorComponent(undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export default function registerHarnessExtension(pi: ExtensionAPI): void {
	const mode: HarnessMode = idleMode();
	let lastCtx: ExtensionContext | undefined;

	pi.registerCommand("harness", {
		description: "Entra no modo harness: setup do profile → readiness → feature (sequencial).",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			lastCtx = ctx;
			const sub = args.trim();

			if (sub === "exit") {
				Object.assign(mode, idleMode());
				clearModeChrome(ctx);
				ctx.ui.notify("pi-harness: modo encerrado");
				return;
			}
			if (sub === "status") {
				ctx.ui.notify(statusText(mode));
				return;
			}

			const forceSetup = sub === "setup";
			const request = forceSetup ? "" : sub;

			// 1. ensureProfile — gate determinístico (stub: existência; Fatia 2 = fingerprint/refresh)
			const hasProfile = fs.existsSync(profilePath(ctx.cwd));
			if (!hasProfile || forceSetup) {
				const title = hasProfile ? "Re-rodar o setup do profile?" : "Repo sem profile. Rodar o setup agora?";
				const choice = await ctx.ui.select(title, ["Rodar setup", "Cancelar"]);
				if (!choice || choice === "Cancelar") {
					ctx.ui.notify("pi-harness: cancelado");
					return;
				}
				// ponytail: setup skill conecta na Fatia 1
				ctx.ui.notify("Setup skill ainda não conectado (Fatia 1).", "warning");
				if (forceSetup) return;
			}

			// 2. readiness gate — placeholder até o setup computar (Fatia 1)
			const gate = await ctx.ui.select(
				"Readiness do repo (placeholder — Fatia 1)",
				["Prosseguir com a feature", "Rodar setup", "Cancelar"],
			);
			if (!gate || gate === "Cancelar") {
				ctx.ui.notify("pi-harness: cancelado");
				return;
			}
			if (gate === "Rodar setup") {
				ctx.ui.notify("Setup ainda não conectado (Fatia 1).", "warning");
				return;
			}

			// 3. ativa o modo e entra na feature (converge conecta na Fatia 3)
			if (!request) {
				ctx.ui.notify('Uso: /harness "<descrição da feature>"', "warning");
				return;
			}
			mode.active = true;
			mode.featureId = featureIdFromRequest(request);
			mode.phase = "converge";
			await applyModeChrome(ctx, mode);
			ctx.ui.notify(`pi-harness: feature "${mode.featureId}" — convergência ainda não conectada (Fatia 3).`);
		},
	});

	// captura o ctx vivo pra poder limpar o chrome no shutdown
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		lastCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (lastCtx) clearModeChrome(lastCtx);
	});
}
