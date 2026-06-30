/**
 * Overlay do merge gate humano (ship-gate step 3, `harness-deliver`) — espelha o
 * showPlanProposal: um menu Merge / Cancel / Leave-open sobre a frame compartilhada, com um
 * resumo do PR + CI + issue Linear no corpo. A extensão (index.ts) abre isto quando a tool
 * `store_delivery` grava `state:"awaiting_merge"` e o agente fica idle (agent_end). A escolha
 * volta pro agente como mensagem (mergeDecisionMessage) — ele executa o `gh`. O merge NUNCA é
 * autônomo: sem decisão humana, nada é mergeado.
 *
 * Copy/modelo puros em delivery.ts (testado); aqui é só layout + teclas. Smoke ao vivo.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { frame, selectListTheme } from "./control-frame.ts";
import { type DeliveryRecord, MERGE_OPTIONS, type MergeChoice, mergeGateSummaryLines } from "./delivery.ts";

/** Menu do merge gate. Enter numa opção resolve; Esc = leave_open (nunca mergeia por omissão). */
export function showMergeGate(ctx: ExtensionContext, input: { featureId: string; record: DeliveryRecord }): Promise<MergeChoice> {
	return ctx.ui.custom<MergeChoice>((tui, theme, _kb, done) => {
		const items: SelectItem[] = MERGE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }));
		const list = new SelectList(items, items.length, selectListTheme(theme));
		const choose = (v: string): void => {
			if (v === "merge") return done({ kind: "merge" });
			if (v === "cancel") return done({ kind: "cancel" });
			return done({ kind: "leave_open" });
		};
		// onSelect SÓ resolve (sem rebuild re-entrante mid-input).
		list.onSelect = (it) => choose(it.value);
		list.onCancel = () => done({ kind: "leave_open" });

		const summary = mergeGateSummaryLines(input.record)
			.map((l) => theme.fg("muted", l))
			.join("\n");
		const body = new Container();
		body.addChild(new Text(summary, 1, 0));
		body.addChild(new Spacer(1));
		body.addChild(list);
		const container = frame(theme, {
			title: `Merge gate — ${input.record.prNumber ? `PR #${input.record.prNumber}` : "PR"}`,
			subtitle: "CI is green — your call (nothing merges without you)",
			body,
			help: "↑↓ navigate · Enter select · Esc leave open",
			helpRight: `feature: ${input.featureId}`,
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
				try {
					// Esc / Ctrl+C = leave open (default seguro: jamais mergeia sem decisão explícita).
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done({ kind: "leave_open" });
					list.handleInput(data);
					tui.requestRender();
				} catch {
					tui.requestRender();
				}
			},
		};
	});
}
