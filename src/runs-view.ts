/**
 * Runs picker (docs/03-tui.md §6.1) — o rebrand do "Missions picker" do Droid, sobre a
 * frame compartilhada (control-frame.ts). Linha especial "+ New feature" no topo, `●` no
 * run atual, selecionado em bold (SelectList). Resolve com o featureId escolhido / new / cancel.
 *
 * Paridade extra com o picker do Droid:
 *   - **Ctrl+R rename inline**: renomeia o run selecionado (runs.renameRun) sem sair do picker;
 *     o run ATIVO (`current`) e a linha "+ New feature" não renomeiam. O ponteiro persistido
 *     (.session.json) segue o novo nome (renameModePointer).
 *   - **Per-row load errors**: um run corrompido vira linha `⚠ … load error: <motivo>` e o
 *     Enter nela é recusado com aviso — o picker nunca quebra por causa de um run.
 *
 * ponytail: a view exige smoke ao vivo (não dá pra rodar o TUI aqui); o conteúdo das linhas
 * (runRow/renameRun) é puro e testado em test/runs.test.ts.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { clipToWidth, frame, rangeLabel, selectListTheme } from "./control-frame.ts";
import { renameModePointer } from "./mode-store.ts";
import { type RunSummary, renameRun, runRow } from "./runs.ts";

const NEW = "__new__";

export type RunsPickerResult = { kind: "open"; featureId: string } | { kind: "new" } | { kind: "cancel" };

/** Abre o picker de runs; resolve com a escolha. Sem UI (print/json) o caller deve pular. */
export function showRunsPicker(ctx: ExtensionContext, runs: RunSummary[], opts: { now?: number } = {}): Promise<RunsPickerResult> {
	const now = opts.now ?? Date.now();
	return ctx.ui.custom<RunsPickerResult>((tui, theme, _kb, done) => {
		// estado mutável: a lista de runs (rename atualiza in-place) + rename mode.
		let rows = [...runs];
		let renaming: string | null = null; // featureId em rename
		let buffer = "";
		let notice: string | undefined;
		let list: SelectList | undefined;
		let container: ReturnType<typeof frame> | undefined;

		const byId = (id: string): RunSummary | undefined => rows.find((r) => r.featureId === id);

		const build = (): void => {
			const items: SelectItem[] = [
				{ value: NEW, label: "+ New feature", description: 'run /harness "<description>" to converge a new one' },
				...rows.map((r) => {
					const row = runRow(r, now);
					return { value: r.featureId, label: row.label, description: row.description };
				}),
			];
			const keep = list?.getSelectedItem()?.value;
			list = new SelectList(items, Math.min(items.length, 12), selectListTheme(theme));
			if (keep) {
				const idx = items.findIndex((i) => i.value === keep);
				if (idx >= 0) list.setSelectedIndex(idx);
			} else {
				// Pré-seleção segura: o run atual (●) se marcado, senão o PRIMEIRO run (mais recente) —
				// NUNCA a linha "+ New feature" (um Enter distraído não pode disparar uma convergência nova).
				const curIdx = items.findIndex((i) => i.value !== NEW && byId(i.value)?.current);
				const firstRun = items.findIndex((i) => i.value !== NEW);
				const idx = curIdx >= 0 ? curIdx : firstRun;
				if (idx > 0) list.setSelectedIndex(idx);
			}
			list.onSelect = (it) => {
				if (it.value === NEW) return done({ kind: "new" });
				const r = byId(it.value);
				if (r?.loadError) {
					notice = `cannot open "${it.value}" — ${r.loadError}`;
					return tui.requestRender();
				}
				done({ kind: "open", featureId: it.value });
			};
			list.onCancel = () => done({ kind: "cancel" });

			const total = rows.length;
			container = frame(theme, {
				title: "Runs",
				titleBold: false,
				subtitle: renaming
					? `Rename "${renaming}" → ${buffer}▏  (Enter apply · Esc cancel)`
					: total === 0
						? 'No runs yet. Use /harness "<description>" to start one.'
						: "State · Assertions · Updated",
				body: list,
				help: renaming ? "type the new name · Enter apply · Esc cancel" : `↑↓ navigate · Enter open · Ctrl+R rename · Esc cancel${notice ? ` · ⚠ ${notice}` : ""}`,
				helpRight: rangeLabel(1, total, total),
			});
		};
		build();

		const applyRename = (): void => {
			const oldId = renaming as string;
			const next = buffer.trim();
			renaming = null;
			buffer = "";
			if (!next || next === oldId) return build();
			const res = renameRun(ctx.cwd, oldId, next);
			if (res.ok) {
				renameModePointer(ctx.cwd, oldId, res.featureId);
				rows = rows.map((r) => (r.featureId === oldId ? { ...r, featureId: res.featureId } : r));
				notice = undefined;
			} else {
				notice = `rename failed: ${res.reason}`;
			}
			build();
		};

		return {
			render: (w) => {
				try {
					if (!container) build();
					return (container as ReturnType<typeof frame>).render(w);
				} catch (e) {
					return [clipToWidth(` ⚠ render error: ${(e as Error).message}`, w), " Esc / Ctrl+C"];
				}
			},
			invalidate: () => container?.invalidate(),
			handleInput: (data) => {
				try {
					if (renaming) {
						// modo rename: captura texto até Enter/Esc.
						if (matchesKey(data, "escape")) {
							renaming = null;
							buffer = "";
							build();
						} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
							applyRename();
						} else if (matchesKey(data, "backspace")) {
							buffer = buffer.slice(0, -1);
							build();
						} else if (data.length === 1 && data >= " ") {
							buffer += data;
							build();
						}
						return tui.requestRender();
					}
					if (matchesKey(data, "ctrl+c")) return done({ kind: "cancel" });
					if (matchesKey(data, "ctrl+r")) {
						const it = list?.getSelectedItem();
						const r = it && it.value !== NEW ? byId(it.value) : undefined;
						if (!r) notice = "select a run to rename";
						else if (r.current) notice = "cannot rename the active run";
						else {
							renaming = r.featureId;
							buffer = r.featureId;
							notice = undefined;
						}
						build();
						return tui.requestRender();
					}
					list?.handleInput(data);
				} catch {
					/* tolerante */
				}
				tui.requestRender();
			},
		};
	});
}
