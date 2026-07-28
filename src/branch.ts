/**
 * Branch-per-feature — config + derivação PURA do nome da branch da feature (decisão: o harness
 * cria a branch no início do /harness run, seguindo o padrão de naming do repo). Sem git/IO de
 * mutação aqui (só leitura de ficheiros do profile/run); o `git switch` vive no hook do run-start.
 *
 * Fonte da convenção: `.harness/profile/delivery.json` (autorado pelo harness-setup, documentado
 * em harness.md §Delivery) — machine-readable porque o CÓDIGO do run-start o lê (services.yaml é
 * prosa lida só por LLM). Placeholders do template: {type} {key} {slug}.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runDir } from "./handoff.ts";
import { scanBareKeys } from "./linear-link.ts";

export interface BranchConfig {
	/** liga/desliga a criação de branch por feature (opt-out). */
	enabled: boolean;
	/** template com placeholders {type} {key} {slug} (ex.: "{type}/{key}-{slug}"). */
	template: string;
	/** tipo default quando não inferível do título (feat/fix/chore). */
	defaultType: string;
	/** branch base de onde cortar e pra onde o PR vai (ex.: develop, next, master). */
	base: string;
	/** comprimento máximo do slug. */
	maxSlugLen: number;
}

export const DEFAULT_BRANCH_CONFIG: BranchConfig = {
	enabled: true,
	template: "{type}/{key}-{slug}",
	defaultType: "feat",
	base: "main",
	maxSlugLen: 40,
};

export function deliveryConfigPath(cwd: string): string {
	return path.join(cwd, ".harness", "profile", "delivery.json");
}

/** Lê a config de branch do profile (tolerante); ausente/parcial → defaults. */
export function readBranchConfig(cwd: string): BranchConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(deliveryConfigPath(cwd), "utf8")) as { branch?: unknown };
		return normalizeBranchConfig(raw?.branch);
	} catch {
		return { ...DEFAULT_BRANCH_CONFIG };
	}
}

export function normalizeBranchConfig(raw: unknown): BranchConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_BRANCH_CONFIG;
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
		template: typeof r.template === "string" && r.template.includes("{slug}") ? r.template : d.template,
		defaultType: typeof r.defaultType === "string" && r.defaultType.trim() ? r.defaultType.trim() : d.defaultType,
		base: typeof r.base === "string" && r.base.trim() ? r.base.trim() : d.base,
		maxSlugLen: typeof r.maxSlugLen === "number" && r.maxSlugLen > 5 ? Math.floor(r.maxSlugLen) : d.maxSlugLen,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivação do nome (pura)

const ACCENTS: Record<string, string> = { á: "a", à: "a", â: "a", ã: "a", ä: "a", é: "e", è: "e", ê: "e", ë: "e", í: "i", ï: "i", î: "i", ó: "o", ò: "o", ô: "o", õ: "o", ö: "o", ú: "u", ü: "u", û: "u", ç: "c", ñ: "n" };

/** Slug kebab seguro: minúsculo, sem acento, não-alfanumérico→`-`, colapsa, corta no limite. */
export function slugify(text: string, maxLen = 40): string {
	const deaccented = [...text.toLowerCase()].map((c) => ACCENTS[c] ?? c).join("");
	let slug = deaccented
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (slug.length > maxLen) {
		slug = slug.slice(0, maxLen).replace(/-[^-]*$/, "").replace(/-$/, "") || slug.slice(0, maxLen).replace(/-$/, "");
	}
	return slug;
}

/** Sanitiza um nome candidato para um git ref válido (sem segmentos vazios, sem chars proibidos). */
export function sanitizeRef(name: string): string {
	return name
		.split("/")
		.map((seg) =>
			seg
				.replace(/[^a-zA-Z0-9._-]+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^[-.]+|[-.]+$/g, ""),
		)
		.filter(Boolean)
		.join("/");
}

/** Preenche o template e sanitiza. `key` vazio → o segmento {key} some limpo (sem `feat/-slug`). */
export function deriveBranchName(input: { template: string; type: string; key?: string; slug: string }): string {
	const key = (input.key ?? "").trim().toLowerCase();
	const filled = input.template
		.replace(/\{type\}/g, input.type)
		.replace(/\{(?:linear-)?key\}/g, key)
		.replace(/\{slug\}/g, input.slug);
	return sanitizeRef(filled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fontes do run (leitura): título da feature + chave Linear do feature id.

/** Título da feature (o H1 `# Feature — <título>` do feature.md); fallback ao feature id. */
export function readFeatureTitle(cwd: string, featureId: string): string {
	try {
		const md = fs.readFileSync(path.join(runDir(cwd, featureId), "feature.md"), "utf8");
		const h1 = md.match(/^#\s+(?:Feature\s*[—–-]\s*)?(.+)$/m);
		if (h1?.[1]) return h1[1].trim();
	} catch {
		// sem feature.md — usa o id
	}
	return featureId;
}

/** A chave Linear/Jira a usar no nome: 1ª chave crua achada no feature id (ex.: ADM-84). */
export function keyFromFeatureId(featureId: string): string | undefined {
	return scanBareKeys(featureId)[0];
}

/**
 * Nome final da branch para uma feature: lê a config + título + chave, deriva. `type` inferido do
 * título (`fix:`/`feat:` ou palavras-chave) com fallback ao defaultType. Slug do título, tirando o
 * prefixo da chave (ex.: "ADM-84 · Habilitação…" → "habilitacao…", não "adm-84-habilitacao…").
 */
export function featureBranchName(cwd: string, featureId: string, cfg: BranchConfig = readBranchConfig(cwd)): string {
	const title = readFeatureTitle(cwd, featureId);
	const key = keyFromFeatureId(featureId);
	// Tira a própria chave do início do título antes de slugar (evita duplicar adm-84 no slug).
	const titleSansKey = key ? title.replace(new RegExp(`\\b${key.replace("-", "[\\s-]?")}\\b`, "i"), "").trim() : title;
	const slug = slugify(titleSansKey || title, cfg.maxSlugLen) || slugify(featureId, cfg.maxSlugLen);
	const type = inferType(title, cfg.defaultType);
	return deriveBranchName({ template: cfg.template, type, key, slug });
}

// ───────────────────────────────────────────────────────────────────────────────────
// Decisão PURA do run-start (conservadora) — testada sem git real.

export type BranchActionKind = "create" | "switch" | "noop" | "skip";
export interface BranchAction {
	kind: BranchActionKind;
	branch: string;
	/** porquê, pro log/notify (sobretudo em skip). */
	reason: string;
}

/**
 * Decide a ação de branch no início do run, CONSERVADORA (decisão do usuário): só cria/troca
 * quando está na base; senão RESPEITA a branch atual (assume intencional) e não mexe. Nunca
 * move/descarta trabalho. Pura — o caller junta o estado do git e executa.
 *
 * A sujeira do tree só veta o **switch** (branch existente, onde o checkout pode conflitar). Pro
 * **create**, `git switch -c` LEVA as mudanças junto — é exatamente o que se quer, e vetar era
 * puro custo: nas runs reais 19 dos 29 skips foram "working tree dirty", e cada um deixou a
 * feature INTEIRA commitada na base branch. O sintoma só aparecia horas depois, no deliver:
 * "HEAD is master, which is also the configured PR base; opening a base-to-base PR is impossible"
 * (41 menções em handoffs), com um worker tendo de carvar os commits à mão.
 */
export function planBranchAction(input: { name: string; current: string; base: string; dirty: boolean; branchExists: boolean; enabled: boolean }): BranchAction {
	const { name, current, base, dirty, branchExists, enabled } = input;
	if (!enabled) return { kind: "skip", branch: name, reason: "branch-per-feature disabled (delivery.json)" };
	if (current === name) return { kind: "noop", branch: name, reason: "already on the feature branch" };
	if (current !== base) return { kind: "skip", branch: name, reason: `on "${current}" (not base "${base}") — respecting the current branch` };
	if (!branchExists) return { kind: "create", branch: name, reason: `cutting from "${base}"${dirty ? " (carrying the working tree along)" : ""}` };
	if (dirty) return { kind: "skip", branch: name, reason: `working tree dirty and "${name}" already exists — not switching (commit/stash first)` };
	return { kind: "switch", branch: name, reason: "feature branch exists — switching" };
}

/**
 * true se o `git status --porcelain` tem sujeira FORA de `.harness/` — a sujeira que de fato
 * bloqueia o branch-per-feature. Arquivos `.harness/` são do PRÓPRIO harness (profile/runs
 * mutados por sessões anteriores) e não devem vetar o switch: numa run real observada, docs do
 * profile modificados-e-não-commitados deixaram o run INTEIRO fora da branch da feature
 * (`branch_ready: skip — working tree dirty` a cada restart). Renames contam os DOIS lados.
 */
export function hasNonHarnessDirt(porcelain: string): boolean {
	for (const line of porcelain.split("\n")) {
		if (!line.trim()) continue;
		// porcelain v1: `XY <path>` (3 chars de prefixo); rename: `XY <old> -> <new>`.
		for (const side of line.slice(3).split(" -> ")) {
			const p = side.trim().replace(/^"|"$/g, "");
			if (p && p !== ".harness" && !p.startsWith(".harness/")) return true;
		}
	}
	return false;
}

/** Heurística simples de tipo a partir do título; cai no default. */
export function inferType(title: string, fallback: string): string {
	const t = title.toLowerCase();
	if (/^\s*(fix|bug|hotfix)\b/.test(t) || /\bbugfix\b/.test(t)) return "fix";
	if (/^\s*(chore|infra|build|ci)\b/.test(t)) return "chore";
	if (/^\s*docs?\b/.test(t)) return "docs";
	return fallback;
}
