/**
 * Tool `dismiss_handoff_items` — o análogo do `dismiss_handoff_items` do droid. O ORCHESTRATOR
 * (no chat) o chama pra marcar discoveredIssues de handoffs que ele decidiu, DELIBERADAMENTE, não
 * acionar — COM justificativa. O TS persiste em .harness/runs/<featureId>/dismissed.json + loga
 * `handoff_items_dismissed` na trilha; o buildRunReport então FILTRA esses itens, então não
 * ressurgem a cada run_feature. O valor é a trilha auditável: uma no-action decidida vira fato
 * registrado (com o porquê), não esquecimento silencioso — e as dismissals NÃO são comunicadas
 * automaticamente a mais ninguém (só o registro local), como no droid.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendDismissed } from "./handoff.ts";

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (selects .harness/runs/<featureId>/)." }),
	items: Type.Array(
		Type.Object({
			description: Type.String({ description: "The discovered-issue text to dismiss — copy it verbatim from the handoff/run report so it matches." }),
			reason: Type.String({ description: "Why you are NOT acting on it (out of scope, pre-existing, already tracked elsewhere, wontfix). Mandatory — the justification is the point." }),
		}),
		{ minItems: 1, description: "The handoff items you are deliberately dismissing." },
	),
});

export function registerDismissHandoffItemsTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "dismiss_handoff_items",
			label: "Dismiss Handoff Items",
			description:
				"Record handoff discovered-issues you (the orchestrator) deliberately chose NOT to act on, WITH a justification each — persists .harness/runs/<featureId>/dismissed.json + a handoff_items_dismissed log event so they don't resurface in later run_feature reports. Dismissals are a local audit trail; they are NOT auto-communicated to anyone. Use for out-of-scope / pre-existing / already-tracked / wontfix items — never to hide a real blocking finding.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { featureId, items } = params as { featureId: string; items: { description: string; reason: string }[] };
				const final = appendDismissed(ctx.cwd, featureId, items);
				return {
					content: [{ type: "text", text: `✓ dismissed ${items.length} handoff item(s) (${final.length} total on record). They won't resurface in run reports.` }],
					details: { dismissedNow: items.length, totalDismissed: final.length },
				};
			},
		}),
	);
}
