/**
 * Refresh reconciler (Fatia 1/2, docs/00-design §6 "Refresh NÃO clobbera").
 *
 * Camada determinística (código, não LLM) que sustenta o refresh do profile sem
 * clobberar o conhecimento acumulado entre features:
 *   - mapeia QUAIS partes do fingerprint mudaram → QUAIS artefatos reconciliar + estratégia
 *   - dá as primitivas de não-clobber (snapshot do conteúdo + diff de sumiço)
 *   - constrói o dispatch de refresh (instrui a setup skill a MERGE, não reescrever)
 *
 * O metadata (profile.json) é reconciliado pelo storeProfile (preserva firstGeneratedAt,
 * bumpa refreshCount). O conteúdo prosa/yaml é mergeado pela skill seguindo este plano.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureProfile } from "./profile.ts";
import type { DispatchTools } from "./readiness-dispatch.ts";

export type MergeStrategy =
	| "append-merge" // library/: acrescenta fatos novos, mantém todos os arquivos
	| "additive-merge" // services.yaml: ADD novos, KEEP existentes, DIFF remoções pra aprovação
	| "propose-diff" // architecture.md/harness.md: diff só nas regiões geradas-por-máquina
	| "regenerate" // conventions-map.md: re-mapeia a partir das rules/ADRs
	| "review"; // skills/: revisa contra as rules mudadas, não reescreve do zero

export interface ArtifactPlan {
	file: string;
	strategy: MergeStrategy;
	reason: string;
}

/** Mapeamento determinístico: parte do fingerprint que drifta → artefatos afetados. */
const SCOPE: Record<string, ArtifactPlan[]> = {
	lockfiles: [
		{ file: "library/", strategy: "append-merge", reason: "deps changed — refresh SDK/tech knowledge; append, never overwrite existing files" },
		{ file: "architecture.md", strategy: "propose-diff", reason: "dependency set changed — propose a diff in machine-generated regions only" },
	],
	rules: [
		{ file: "library/conventions-map.md", strategy: "regenerate", reason: "rules/ADRs changed — re-map conventions (the harness-conventions-review consumes this)" },
		{ file: "harness.md", strategy: "propose-diff", reason: "rules changed — the operational overlay may need updating; preserve human-curated prose" },
		{ file: "skills/", strategy: "review", reason: "rules changed — worker skills may encode old conventions; update, don't rewrite" },
	],
	toolcfg: [
		{ file: "services.yaml", strategy: "additive-merge", reason: "tooling changed — re-derive commands; ADD new, KEEP existing, DIFF removals for approval" },
		{ file: "architecture.md", strategy: "propose-diff", reason: "build/test/lint setup changed — propose a diff in machine-generated regions only" },
	],
};

const ALL_PARTS = ["lockfiles", "rules", "toolcfg"] as const;

export interface RefreshPlan {
	/** As partes que drifaram (ou todas, num refresh forçado sem drift). */
	parts: string[];
	/** Artefatos a reconciliar, deduplicados, com estratégia. */
	artifacts: ArtifactPlan[];
}

/**
 * Mapeia as partes que mudaram → artefatos a reconciliar + estratégia, deduplicando
 * artefatos que aparecem em mais de uma parte (a primeira ocorrência ganha a razão).
 * `changed` vazio = refresh FORÇADO (sem drift) → re-deriva todas as partes.
 */
export function buildRefreshPlan(changed: string[]): RefreshPlan {
	const filtered = changed.filter((p) => p in SCOPE);
	const parts = filtered.length > 0 ? filtered : [...ALL_PARTS];
	const seen = new Set<string>();
	const artifacts: ArtifactPlan[] = [];
	for (const p of parts) {
		for (const a of SCOPE[p] ?? []) {
			if (seen.has(a.file)) continue;
			seen.add(a.file);
			artifacts.push(a);
		}
	}
	return { parts, artifacts };
}

/** Conveniência: o plano de refresh pro repo atual (null se não há profile). */
export function refreshPlanFor(cwd: string): RefreshPlan | null {
	const e = ensureProfile(cwd, { refresh: true });
	if (e.status !== "refresh") return null;
	return buildRefreshPlan(e.changed);
}

/**
 * Snapshot dos artefatos de CONTEÚDO não-vazios em .harness/profile/ (exclui profile.json,
 * que é metadata). Determinístico (ordenado). Base do clobber check.
 */
export function listProfileContent(cwd: string): string[] {
	const root = path.join(cwd, ".harness", "profile");
	const out: string[] = [];
	const walk = (rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (rel === "" && e.name === "profile.json") continue; // metadata, não conteúdo
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				walk(r);
			} else if (e.isFile()) {
				try {
					if (fs.statSync(path.join(root, r)).size > 0) out.push(r);
				} catch {
					/* ignore */
				}
			}
		}
	};
	walk("");
	return out;
}

/**
 * Não-clobber: artefatos de conteúdo que existiam ANTES e sumiram/zeraram DEPOIS.
 * Um refresh nunca deve apagar conhecimento acumulado — se `detectClobber` retorna
 * algo não-vazio, o merge clobberou e deve ser corrigido antes de carimbar.
 */
export function detectClobber(before: string[], after: string[]): string[] {
	const present = new Set(after);
	return before.filter((f) => !present.has(f));
}

/**
 * Dispatch do refresh (model-driven): instrui a setup skill a MERGE (não clobber) só os
 * artefatos afetados pelo drift, seguindo as estratégias do plano, e a carimbar com
 * store_profile no fim. Espelha buildSetupDispatch, mas em modo refresh/merge.
 */
export function buildRefreshDispatch(changed: string[], _tools: DispatchTools = {}): string {
	const plan = buildRefreshPlan(changed);
	const lines = [
		"Refresh the existing Tier-1 Repo Profile for THIS repository — MERGE, do NOT clobber.",
		`Drifted inputs: ${plan.parts.join(", ")}. Reconcile ONLY the affected artifacts below; leave everything else intact.`,
		"",
		"Non-clobber rules (the profile accumulates knowledge across features — never wipe it):",
		"- library/: append/merge new facts; keep every existing file.",
		"- services.yaml: ADD new commands/services, KEEP existing; if one is gone, DIFF the removal and ask before dropping it.",
		"- architecture.md / harness.md: propose a diff in the machine-generated regions only; preserve human-curated prose.",
		"- skills/: review against the changed rules; update, don't rewrite from scratch.",
		"",
		"Targeted reconcile:",
		...plan.artifacts.map((a) => `- ${a.file} → ${a.strategy}: ${a.reason}`),
		"",
	];
	let n = 1;
	lines.push(
		`${n++}. Invoke the \`harness-setup\` skill in REFRESH mode: re-derive only the drifted inputs and reconcile per the strategies above. Do NOT re-author untouched artifacts.`,
		`${n++}. Finish by calling the \`store_profile\` tool — it re-stamps profile.json (preserving the original generation time, bumping the refresh count) only after the merged content is in place.`,
		`${n++}. Give a short summary of what was merged and list any removals that need approval.`,
	);
	return lines.join("\n");
}
