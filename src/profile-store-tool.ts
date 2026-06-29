/**
 * Tool `store_profile` — o estágio "store" do setup do profile, espelhando
 * `store_agent_readiness_report`: a setup skill (LLM) autora o conteúdo do profile
 * em .harness/profile/, e CHAMA esta tool no fim. O TS (confiável) valida que os
 * artefatos existem e são não-vazios e só ENTÃO estampa profile.json (fingerprint
 * determinístico). Acopla o metadata ao conteúdo — nada de baseline estampado antes
 * do conteúdo existir.
 *
 * Recusa (THROW) se faltar artefato — convenção do runtime (o loop devolve o erro
 * pro modelo, que autora o que falta e chama de novo).
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { storeProfile } from "./profile.ts";

const PARAMS = Type.Object({});

export function registerProfileStoreTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "store_profile",
			label: "Store Repo Profile",
			description:
				"Validates the Tier-1 repo profile was authored (architecture.md, services.yaml, init.sh, harness.md, skills/, library/ all present and non-empty) and stamps .harness/profile/profile.json deterministically (version, generatedAt, sourceCommit, fingerprint). Call at the END of harness-setup. Rejects (throws) when artifacts are missing — author them and call again.",
			parameters: PARAMS,
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				const res = storeProfile(ctx.cwd);
				if (!res.ok) {
					throw new Error(
						`Profile REJECTED — these profile artifacts are missing or empty:\n- ${res.missing.join("\n- ")}\nAuthor them under .harness/profile/ then call store_profile again.`,
					);
				}
				return {
					content: [
						{
							type: "text",
							text: `✓ profile.json stamped (v${res.profile.version}, sourceCommit ${res.profile.sourceCommit ?? "n/a"}).`,
						},
					],
					details: { version: res.profile.version, sourceCommit: res.profile.sourceCommit },
				};
			},
		}),
	);
}
