/**
 * Sinal de progresso COMPAT\u00cdVEL (docs/03-tui.md §2) — uma string compacta publicada via
 * `ctx.ui.setStatus("harness-progress", …)`, NUNCA um widget aboveEditor nem o editor. A
 * statusline (pi-fusiontui lê getExtensionStatuses(); o core também) compõe junto do modo
 * ("◆ run" + "████▒▒ 6/12 · T2"). Atualiza ao vivo via watchRun. A barra rica vive no overlay
 * Feature Control (Alt+T); aqui é só o resumo de uma linha. Compatibilidade > chrome próprio.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type ControlModel, readControlModel, type StripParts, stripParts } from "./control-model.ts";
import { type Watcher, watchRun } from "./control-watch.ts";
import { clearRunModel, setRunModel } from "./run-store.ts";

const PROGRESS_KEY = "harness-progress";

/** Texto compacto pro status: barra mini + ratio + task ativa (sem repetir o estado/modo). */
export function progressStatusText(theme: Theme, model: ControlModel): string {
	const p: StripParts = stripParts(model, 10);
	const barColor = model.state === "paused" ? "warning" : "success";
	const bar = `${theme.fg(barColor, p.bar.filled)}${theme.fg("muted", p.bar.pending)}${theme.fg("dim", p.bar.estimate)}`;
	const active = p.active && p.active !== "idle" ? ` ${theme.fg("dim", `· ${p.active}`)}` : "";
	return `${bar} ${theme.bold(p.ratio)}${active}`;
}

/** Publica/atualiza o status de progresso pro model dado (no-op sem UI). */
export function setProgress(ctx: ExtensionContext, model: ControlModel): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(PROGRESS_KEY, progressStatusText(ctx.ui.theme, model));
}

/** Remove o status de progresso. */
export function clearProgress(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(PROGRESS_KEY, undefined);
}

/**
 * Controla o status de progresso ao longo de um run: publica inicial + watcher que re-publica
 * ao vivo. `start` é idempotente (re-troca o featureId); `stop` para o watcher e limpa. Enquanto
 * não há plan.json (converge), readControlModel é null → o status fica limpo (só o modo aparece).
 */
export class StripController {
	private watcher?: Watcher;
	private featureId?: string;
	private ctx?: ExtensionContext;

	start(ctx: ExtensionContext, featureId: string): void {
		if (this.featureId === featureId && this.watcher) {
			this.ctx = ctx;
			return;
		}
		this.stopWatcher();
		this.featureId = featureId;
		this.ctx = ctx;
		this.refresh();
		this.watcher = watchRun(ctx.cwd, featureId, () => this.refresh());
	}

	/**
	 * Re-lê o model + republica o status/run-card. Chamado pelo watcher de fs E por sinais NATIVOS
	 * do pi (evento `session_tree`: a sessão do orchestrator avançou). Idempotente, no-op sem ctx/feature.
	 */
	refresh(): void {
		if (!this.ctx || !this.featureId) return;
		const m = readControlModel(this.ctx.cwd, this.featureId);
		// Alimenta o live store do run card (cap. 09): o renderer no transcript relê isto e
		// `setProgress`/`setStatus` dispara o ciclo de render que faz o cartão ticar ao vivo.
		setRunModel(this.featureId, m);
		if (m) setProgress(this.ctx, m);
		else clearProgress(this.ctx);
	}

	stop(ctx: ExtensionContext): void {
		this.stopWatcher();
		if (this.featureId) clearRunModel(this.featureId);
		this.featureId = undefined;
		this.ctx = undefined;
		clearProgress(ctx);
	}

	private stopWatcher(): void {
		this.watcher?.close();
		this.watcher = undefined;
	}
}
