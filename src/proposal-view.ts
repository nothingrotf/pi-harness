/**
 * Views do fluxo de gerar-feature (docs/03-tui.md §9), sobre a frame compartilhada:
 *   showFeatureOnboarding — card intro (Enter continue · Esc cancel)
 *   showPlanProposal      — menu Proceed/Comment/Edit/Reject + input inline (comment/reason)
 *
 * Copy/modelo puros em proposal.ts (testado); aqui é só layout + teclas. Smoke ao vivo.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { frame, selectListTheme } from "./control-frame.ts";
import type { ControlModel } from "./control-model.ts";
import { ONBOARDING_TITLE, type ProposalChoice, PROPOSAL_OPTIONS, featureOnboardingLines, proposalSummaryLines } from "./proposal.ts";



/** Card de onboarding/intro da feature. Enter → continue · Esc/q → cancel. */
export function showFeatureOnboarding(ctx: ExtensionContext): Promise<"continue" | "cancel"> {
	return ctx.ui.custom<"continue" | "cancel">((tui, theme, _kb, done) => {
		const body = new Text(featureOnboardingLines().join("\n"), 1, 0);
		const container = frame(theme, {
			title: ONBOARDING_TITLE,
			body,
			help: "Enter to continue • Esc to cancel",
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
				if (matchesKey(data, "enter") || matchesKey(data, "return")) return done("continue");
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) return done("cancel");
				tui.requestRender();
			},
		};
	});
}

/** Menu de aprovação do plano (após store_plan persistir). Resolve com a escolha. */
export function showPlanProposal(ctx: ExtensionContext, input: { featureId: string; model: ControlModel | null; savePath: string }): Promise<ProposalChoice> {
	return ctx.ui.custom<ProposalChoice>((tui, theme, _kb, done) => {
		let view: "menu" | "comment" | "reject" = "menu";
		let buffer = "";
		let container: Container = new Container();

		const buildMenu = (): void => {
			const items: SelectItem[] = PROPOSAL_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }));
			const list = new SelectList(items, items.length, selectListTheme(theme));
			// onSelect SÓ muta estado (comment/reject); o rebuild acontece FORA do handleInput da
			// SelectList (rebuild re-entrante mid-input trava o loop).
			list.onSelect = (it) => {
				if (it.value === "proceed") return done({ kind: "proceed" });
				if (it.value === "edit") return done({ kind: "edit" });
				view = it.value === "comment" ? "comment" : "reject";
				buffer = "";
			};
			list.onCancel = () => done({ kind: "reject", reason: "" });
			const summary = proposalSummaryLines(input.model).map((l) => theme.fg("muted", l)).join("\n");
			container = frame(theme, {
				title: "Feature plan proposal",
				subtitle: `Saved to: ${input.savePath}`,
				body: wrap(new Text(summary, 1, 0), list),
				help: "↑↓ navigate · Enter select · Esc reject",
				helpRight: `feature: ${input.featureId}`,
			});
			activeList = list;
		};

		const buildInput = (): void => {
			activeList = undefined;
			const label = view === "comment" ? "Comment:" : "Reason:";
			const prompt = `${theme.fg("accent", label)} ${buffer}${theme.fg("dim", "▮")}`;
			const hint = view === "comment" ? "approve + guidance" : "send back to revise";
			container = frame(theme, {
				title: view === "comment" ? "Proceed with comment" : "No — explain why",
				subtitle: hint,
				body: new Text(prompt, 1, 0),
				help: "Enter submit · Esc back",
			});
		};

		let activeList: SelectList | undefined;
		const rebuild = (): void => {
			if (view === "menu") buildMenu();
			else buildInput();
		};
		rebuild();

		const submit = (): void => {
			if (view === "comment") return done({ kind: "comment", comment: buffer.trim() });
			return done({ kind: "reject", reason: buffer.trim() });
		};

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
					if (view === "menu") {
						if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done({ kind: "reject", reason: "" });
						const before: string = view;
						activeList?.handleInput(data);
						if (view !== before) rebuild();
						return tui.requestRender();
					}
					// input mode (comment/reject)
					if (matchesKey(data, "ctrl+c")) return done({ kind: "reject", reason: "" });
					if (matchesKey(data, "enter") || matchesKey(data, "return")) return submit();
					if (matchesKey(data, "escape")) {
						view = "menu";
						rebuild();
						return tui.requestRender();
					}
					if (matchesKey(data, "backspace")) buffer = buffer.slice(0, -1);
					else if (data.length === 1 && data >= " ") buffer += data;
					else return;
					rebuild();
					tui.requestRender();
				} catch {
					tui.requestRender();
				}
			},
		};
	});
}

/** Empilha resumo + corpo num Container (helper local). */
function wrap(summary: Text, body: SelectList): Container {
	const c = new Container();
	c.addChild(summary);
	c.addChild(new Spacer(1));
	c.addChild(body);
	return c;
}
