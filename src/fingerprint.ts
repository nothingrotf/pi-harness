/**
 * Fingerprint determinístico do repo (código, NÃO LLM) — base do gate de profile
 * (Fatia 2, docs/00-design §6) e do drift/stale do readiness.
 *
 * Hash de CONTEÚDO (não depende de relógio nem de ordem do filesystem) sobre os
 * inputs que importam pra "como esse repo é montado":
 *   - lockfiles   (deps pinadas)
 *   - rules       (.agents/rules/ + AGENTS.md + ADRs/decisões — convenções; ADRs não
 *                  moram num único lugar canônico, então cobrimos os homes comuns)
 *   - toolcfg     (configs de lint/format/typecheck/build)
 *
 * Igual ao referência no espírito: o modelo de referência chaveia a staleness por commit/estado
 * git (determinístico); aqui usamos um hash de conteúdo determinístico — pega até
 * mudança não-commitada (working tree sujo) e ignora commits irrelevantes de src.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FingerprintParts {
	lockfiles: string;
	rules: string;
	toolcfg: string;
}

const LOCKFILES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"go.sum",
	"go.mod",
	"Cargo.lock",
	"requirements.txt",
	"poetry.lock",
	"uv.lock",
	"Gemfile.lock",
	"composer.lock",
];

// Fontes de convenção/decisão. ADRs e docs de regra NÃO moram num lugar canônico único —
// cobrimos os homes comuns (docs/adr, docs/decisions, adr/, .cursor/rules, …). Para um repo
// que guarda noutro lugar, os caminhos DESCOBERTOS no profile (conventions-map) são a fonte
// precisa; esta lista é a rede determinística best-effort do drift de `rules`.
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "CONVENTIONS.md", "CONTRIBUTING.md"];
const RULE_DIRS = [
	".agents/rules",
	".cursor/rules",
	".agents/skills",
	"docs/adr",
	"docs/decisions",
	"docs/architecture/decisions",
	"docs/rfc",
	"adr",
];

const TOOLCFG = [
	// package.json e vite/vitest configs contam: há repos que configuram lint/format/test AÍ
	// (eslintConfig/prettier keys, plugins vite-plus) — drift ali era invisível ao fingerprint.
	"package.json",
	"vite.config.ts",
	"vite.config.js",
	"vitest.config.ts",
	"vitest.config.js",
	"vitest.workspace.ts",
	"tsconfig.json",
	"tsconfig.base.json",
	"biome.json",
	".eslintrc",
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	"eslint.config.js",
	"eslint.config.mjs",
	".prettierrc",
	".prettierrc.json",
	"prettier.config.js",
	".golangci.yml",
	".golangci.yaml",
	"ruff.toml",
	"pyproject.toml",
	"setup.cfg",
	".editorconfig",
	".rubocop.yml",
	".flake8",
	"rustfmt.toml",
];

function sha(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function fileHash(abs: string): string | null {
	try {
		const st = fs.statSync(abs);
		if (!st.isFile()) return null;
		return sha(fs.readFileSync(abs));
	} catch {
		return null;
	}
}

function walkFiles(dir: string, acc: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkFiles(p, acc);
		else if (e.isFile()) acc.push(p);
	}
}

/** Hash de um grupo: arquivos fixos + dirs recursivos. Determinístico (ordenado). */
function hashGroup(cwd: string, files: string[], dirs: string[]): string {
	const entries: string[] = [];
	for (const f of files) {
		const h = fileHash(path.join(cwd, f));
		if (h) entries.push(`${f}\u0000${h}`);
	}
	for (const d of dirs) {
		const found: string[] = [];
		walkFiles(path.join(cwd, d), found);
		for (const abs of found) {
			const h = fileHash(abs);
			if (h) entries.push(`${path.relative(cwd, abs).split(path.sep).join("/")}\u0000${h}`);
		}
	}
	entries.sort();
	return sha(entries.join("\n")).slice(0, 16);
}

/** As 3 partes do fingerprint (pro profile.json + diff de drift). */
export function computeFingerprintParts(cwd: string): FingerprintParts {
	return {
		lockfiles: hashGroup(cwd, LOCKFILES, []),
		rules: hashGroup(cwd, RULE_FILES, RULE_DIRS),
		toolcfg: hashGroup(cwd, TOOLCFG, []),
	};
}

/** String combinada das partes (o fingerprint do readiness.json). */
export function combinedFingerprint(p: FingerprintParts): string {
	return sha(`${p.lockfiles}:${p.rules}:${p.toolcfg}`).slice(0, 16);
}

/** Fingerprint determinístico do repo (uma string). */
export function computeFingerprint(cwd: string): string {
	return combinedFingerprint(computeFingerprintParts(cwd));
}

/** Quais partes mudaram entre dois fingerprints (pro aviso de drift). */
export function changedParts(prev: FingerprintParts, cur: FingerprintParts): string[] {
	const out: string[] = [];
	if (prev.lockfiles !== cur.lockfiles) out.push("lockfiles");
	if (prev.rules !== cur.rules) out.push("rules");
	if (prev.toolcfg !== cur.toolcfg) out.push("toolcfg");
	return out;
}

/** HEAD sha curto (sourceCommit). Best-effort; null fora de um repo git. */
export function gitHead(cwd: string): string | null {
	try {
		const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf8").trim();
		if (head.startsWith("ref:")) {
			const ref = head.slice(4).trim();
			try {
				return fs.readFileSync(path.join(cwd, ".git", ref), "utf8").trim().slice(0, 12);
			} catch {
				// ref não solto — após `git gc`/`git pack-refs` vive em packed-refs (sourceCommit ficava null)
				const packed = fs.readFileSync(path.join(cwd, ".git", "packed-refs"), "utf8");
				for (const line of packed.split("\n")) {
					if (line.endsWith(` ${ref}`)) return line.slice(0, 12);
				}
				return null;
			}
		}
		return head.slice(0, 12);
	} catch {
		return null;
	}
}
