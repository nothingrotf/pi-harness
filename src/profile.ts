/**
 * Tier 1 — Repo Profile (profile.json): a camada determinística do gate de setup
 * (Fatia 2, docs/00-design §6). Código puro, sem LLM.
 *
 *   ensureProfile(repo, opts): GATE READ-ONLY — não escreve.
 *     p = read(profile.json)
 *     if !p                                          → "absent"  (rode /harness setup)
 *     elif opts.refresh                              → "refresh" (SETUP refresh: re-deriva + reconcilia)
 *     elif drift(fingerprint(repo), p.fingerprint)   → "drift"   (advisory)
 *     else                                           → "ok"
 *   O conteúdo é reconciliado pela setup skill (merge, não clobber — src/reconcile.ts);
 *   storeProfile re-carimba o metadata preservando a proveniência (firstGeneratedAt).
 *
 *   storeProfile(repo): o STAMP — chamado pela tool `store_profile` DEPOIS que a
 *     setup skill autorou o conteúdo. Valida que os artefatos do profile existem
 *     e são coerentes e só ENTÃO estampa profile.json. Espelha
 *     store_agent_readiness_report (LLM autora → tool TS valida + grava).
 *     Corrige o bug do baseline: o fingerprint só é capturado QUANDO o conteúdo
 *     existe — nunca antes.
 *
 * profile.json = { version, generatedAt, firstGeneratedAt, refreshedAt?, refreshCount,
 *                  sourceCommit, fingerprint:{lockfiles,rules,toolcfg} }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { changedParts, computeFingerprintParts, type FingerprintParts, gitHead } from "./fingerprint.ts";
import { writeJsonAtomic } from "./plan.ts";

export const PROFILE_VERSION = 1;

export interface Profile {
	version: number;
	/** Last stamp time (fresh OR refresh). */
	generatedAt: string;
	/** When the profile was FIRST authored — preserved across refreshes (merge, não clobber). */
	firstGeneratedAt: string;
	/** Last refresh time; absent on the first (fresh) stamp. */
	refreshedAt?: string;
	/** How many times the profile was refreshed (0 on the fresh stamp). */
	refreshCount: number;
	sourceCommit: string | null;
	fingerprint: FingerprintParts;
}

function profileDir(cwd: string): string {
	return path.join(cwd, ".harness", "profile");
}
export function profilePath(cwd: string): string {
	return path.join(profileDir(cwd), "profile.json");
}

export function readProfile(cwd: string): Profile | null {
	try {
		return JSON.parse(fs.readFileSync(profilePath(cwd), "utf8")) as Profile;
	} catch {
		return null;
	}
}

export function writeProfile(cwd: string, profile: Profile): void {
	fs.mkdirSync(profileDir(cwd), { recursive: true });
	writeJsonAtomic(profilePath(cwd), profile);
}

/**
 * Deriva o profile.json determinístico do estado atual do repo. Quando `prev` é
 * passado (re-store/refresh), RECONCILIA o metadata sem clobberar a proveniência:
 * preserva `firstGeneratedAt`, bumpa `refreshCount` e carimba `refreshedAt`.
 */
export function computeProfile(cwd: string, now: () => string = () => new Date().toISOString(), prev?: Profile | null): Profile {
	const ts = now();
	const isRefresh = !!prev;
	return {
		version: PROFILE_VERSION,
		generatedAt: ts,
		firstGeneratedAt: prev?.firstGeneratedAt ?? prev?.generatedAt ?? ts,
		...(isRefresh ? { refreshedAt: ts } : {}),
		refreshCount: isRefresh ? (prev.refreshCount ?? 0) + 1 : 0,
		sourceCommit: gitHead(cwd),
		fingerprint: computeFingerprintParts(cwd),
	};
}

export type EnsureStatus = "absent" | "drift" | "ok" | "refresh";

export interface EnsureResult {
	status: EnsureStatus;
	/** null quando "absent" (nunca foi estampado). */
	profile: Profile | null;
	/** partes que mudaram (só em status "drift"). */
	changed: string[];
}

/**
 * Gate determinístico do profile (READ-ONLY, docs/00-design §6). Nunca escreve:
 * reporta "absent" (sem profile.json — rode o setup), "drift" (fingerprint mudou —
 * advisory) ou "ok". O STAMP é exclusivo do `storeProfile` (tool store_profile),
 * que só roda depois que a setup skill autorou o conteúdo.
 */
export function ensureProfile(cwd: string, opts: { refresh?: boolean } = {}): EnsureResult {
	const prev = readProfile(cwd);
	if (!prev) return { status: "absent", profile: null, changed: [] };
	const cur = computeFingerprintParts(cwd);
	const changed = changedParts(prev.fingerprint, cur);
	// Refresh forçado (opts.refresh) → SETUP(refresh): re-deriva + reconcilia (design §6).
	if (opts.refresh) return { status: "refresh", profile: prev, changed };
	return { status: changed.length > 0 ? "drift" : "ok", profile: prev, changed };
}

/** Artefatos que o profile DEVE conter pra ser considerado autorado (não-vazios). */
export const REQUIRED_PROFILE_FILES = ["architecture.md", "services.yaml", "init.sh", "harness.md", "library/conventions-map.md", "library/coding-principles.md"] as const;
export const REQUIRED_PROFILE_DIRS = ["skills", "library"] as const;

function nonEmptyFile(abs: string): boolean {
	try {
		const st = fs.statSync(abs);
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
}
function nonEmptyDir(abs: string): boolean {
	try {
		return fs.statSync(abs).isDirectory() && fs.readdirSync(abs).length > 0;
	} catch {
		return false;
	}
}

export interface ProfileContentCheck {
	ok: boolean;
	/** artefatos ausentes ou vazios (rótulos legíveis). */
	missing: string[];
}

/** Valida que a setup skill realmente autorou o conteúdo do profile. */
export function validateProfileContent(cwd: string): ProfileContentCheck {
	const dir = profileDir(cwd);
	const missing: string[] = [];
	for (const f of REQUIRED_PROFILE_FILES) if (!nonEmptyFile(path.join(dir, f))) missing.push(f);
	for (const d of REQUIRED_PROFILE_DIRS) if (!nonEmptyDir(path.join(dir, d))) missing.push(`${d}/`);
	return { ok: missing.length === 0, missing };
}

export type StoreProfileResult = { ok: true; profile: Profile } | { ok: false; missing: string[] };

/**
 * O STAMP do profile (analog do store_agent_readiness_report). Valida que o
 * conteúdo foi autorado e SÓ ENTÃO grava profile.json com o fingerprint atual —
 * acoplando o metadata ao conteúdo (corrige o bug do baseline). Recusa (sem
 * escrever) se faltar artefato.
 */
export function storeProfile(cwd: string, opts: { now?: () => string } = {}): StoreProfileResult {
	const check = validateProfileContent(cwd);
	if (!check.ok) return { ok: false, missing: check.missing };
	// Reconcilia: se já há profile.json, preserva a proveniência (firstGeneratedAt) e
	// bumpa refreshCount/refreshedAt em vez de clobberar.
	const prev = readProfile(cwd);
	const profile = computeProfile(cwd, opts.now, prev);
	writeProfile(cwd, profile);
	return { ok: true, profile };
}
