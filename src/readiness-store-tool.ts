/**
 * Tool `store_agent_readiness_report` — mesmo NOME do referência (modelo de referência),
 * com store LOCAL (a deviação documentada): em vez do Firestore, grava
 * .harness/profile/readiness.json. É o estágio "store" que o auditor chama na
 * Phase 5 com o report completo; o TS (confiável) valida o contrato estrito,
 * computa level/passRate, grava o snapshot e registra na trilha readiness.jsonl.
 *
 * Schema STRICT (igual ao referência): rejeita reports fora do contrato.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { repoFingerprint, storeReport } from "./readiness-pipeline.ts";
import type { ReadinessReport } from "./readiness.ts";

const EvalSchema = Type.Object({
	num: Type.Union([Type.Integer(), Type.Null()], {
		description: "repository scope: 1 pass / 0 fail / null skipped. application scope: 0..N apps that pass / null. null ONLY for skippable/cloudOnly.",
	}),
	den: Type.Integer({ description: "1 for repository scope; N (apps) for application scope." }),
	rationale: Type.String({ description: "<=500 chars, terse and actionable (especially on failures)." }),
});

const PARAMS = Type.Object({
	report: Type.Record(Type.String(), EvalSchema, {
		description: "Map of criterionId -> evaluation. MUST contain exactly the 82 canonical ids (criteria.json).",
	}),
	apps: Type.Optional(Type.Integer({ description: "N — number of applications discovered (application-scope denominator). Default 1." })),
});

export function registerReadinessStoreTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "store_agent_readiness_report",
			label: "Store Agent Readiness Report",
			description:
				"Validates (strict contract: 82 ids, per-scope denominators, num=null only for skippable/cloudOnly) and writes the readiness report to .harness/profile/readiness.json, computing the L1..L5 level. Rejects out-of-contract reports — fix and call again.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const report: ReadinessReport = { evals: params.report as ReadinessReport["evals"], apps: params.apps };
				const res = storeReport(ctx.cwd, report, repoFingerprint(ctx.cwd));
				if (!res.ok) {
					// Runtime convention: tools signal failure by THROWING (no isError on
					// AgentToolResult). The loop encodes the message into an error tool result
					// that the model reads and fixes — same as the reference's strict store.
					const shown = res.issues.slice(0, 20).join("\n- ");
					throw new Error(`Report REJECTED (${res.issues.length} contract problems):\n- ${shown}`);
				}
				return {
					content: [{ type: "text", text: `✓ Snapshot written to .harness/profile/readiness.json — ${res.summary}` }],
					details: { level: res.snapshot?.level ?? 0, passRate: res.snapshot?.passRate ?? 0 },
				};
			},
		}),
	);
}
