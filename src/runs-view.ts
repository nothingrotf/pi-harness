/**
 * Runs picker (docs/03-tui.md §6.1) — o rebrand do "Missions picker" do Droid, sobre a
 * frame compartilhada (control-frame.ts). Linha especial "+ New feature" no topo, `●` no
 * run atual, selecionado em bold (SelectList). Resolve com o featureId escolhido / new / cancel.
 *
 * ponytail: a view exige smoke ao vivo (não dá pra rodar o TUI aqui); o conteúdo das linhas
 * (runRow) é puro e testado em test/runs.test.ts.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { frame, rangeLabel, selectListTheme } from "./control-frame.ts";
import { type RunSummary, runRow } from "./runs.ts";

const NEW = "__new__";

export type RunsPickerResult = { kind: "open"; featureId: string } | { kind: "new" } | { kind: "cancel" };

/** Abre o picker de runs; resolve com a escolha. Sem UI (print/json) o caller deve pular. */
export function showRunsPicker(ctx: ExtensionContext, runs: RunSummary[], opts: { now?: number } = {}): Promise<RunsPickerResult> {
	const now = opts.now ?? Date.now();
	return ctx.ui.custom<RunsPickerResult>((tui, theme, _kb, done) => {
		const items: SelectItem[] = [
			{ value: NEW, label: "+ New feature", description: 'run /harness "<description>" to converge a new one' },
			...runs.map((r) => {
				const row = runRow(r, now);
				return { value: r.featureId, label: row.label, description: row.description };
			}),
		];
		const list = new SelectList(items, Math.min(items.length, 12), selectListTheme(theme));
		list.onSelect = (it) => done(it.value === NEW ? { kind: "new" } : { kind: "open", featureId: it.value });
		list.onCancel = () => done({ kind: "cancel" });

		const total = runs.length;
		const container = frame(theme, {
			title: "Runs",
			titleBold: false,
			subtitle: total === 0 ? 'No runs yet. Use /harness "<description>" to start one.' : "State · Assertions · Updated",
			body: list,
			help: "↑↓ navigate · Enter open · Esc cancel",
			helpRight: rangeLabel(1, total, total),
		});
		return {
			render: (w) => {
				try {
					return container.render(w);
				} catch (e) {
					return [` ⚠ render error: ${(e as Error).message}`, " Esc / Ctrl+C"];
				}
			},
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, "ctrl+c")) return done({ kind: "cancel" });
				try {
					list.handleInput(data);
				} catch {}
				tui.requestRender();
			},
		};
	});
}
