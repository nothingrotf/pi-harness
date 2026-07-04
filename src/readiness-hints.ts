/**
 * Proactive readiness hints — o porte do `getReadinessHint`/`cli-hints.json` do Droid
 * (droid-missions doc 06 §6): fora do gate, o harness dá um empurrão barato pra readiness.
 *
 * Dois tipos de hint:
 *   - **no report** → "Run /readiness-report to evaluate this repo for agent readiness."
 *   - **local gap** → pros 6 critérios L1 com check local BARATO (o `zyH` do Droid):
 *     `lint_config` · `type_check` · `formatter` · `unit_tests_exist` · `readme` · `env_template`
 *     → e.g. "No linter detected. Run /readiness-fix to set one up."
 *
 * Supressão persistida em `${agentDir}/pi-harness/cli-hints.json` (o análogo do
 * `~/.factory/cli-hints.json`): perPath → { hasPreviousReport, noReportShownAt,
 * gapsShown: {gap: ts}, lastSeenGaps }. Cada hint re-aparece no máx 1x/24h por path.
 * Checks são só-existência (baratos, multi-ecossistema, best-effort). Pi-free, testável.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type PathOpts, resolveAgentDir } from "./model-config.ts";
import { writeJsonAtomic } from "./plan.ts";

export type ReadinessGap = "lint_config" | "type_check" | "formatter" | "unit_tests_exist" | "readme" | "env_template";

export const READINESS_GAPS: readonly ReadinessGap[] = ["lint_config", "type_check", "formatter", "unit_tests_exist", "readme", "env_template"];

/** Re-show window (um hint suprimido volta depois disto). */
export const HINT_SUPPRESS_MS = 24 * 60 * 60 * 1000;

const GAP_MESSAGE: Record<ReadinessGap, string> = {
	lint_config: "No linter detected. Run /readiness-fix to set one up.",
	type_check: "No type-check setup detected. Run /readiness-fix to add one.",
	formatter: "No formatter config detected. Run /readiness-fix to set one up.",
	unit_tests_exist: "No unit tests detected. Run /readiness-fix to bootstrap them.",
	readme: "No README detected. Run /readiness-fix to create one.",
	env_template: "No env template (.env.example) detected. Run /readiness-fix to add one.",
};

const NO_REPORT_MESSAGE = "Run /readiness-report to evaluate this repo for agent readiness.";

// ─────────────────────────────────────────────────────────────────────────────
// Os 6 checks locais baratos (existência de ficheiro; leitura mínima onde preciso)

function existsAny(cwd: string, names: string[]): boolean {
	return names.some((n) => {
		try {
			fs.statSync(path.join(cwd, n));
			return true;
		} catch {
			return false;
		}
	});
}

function fileContains(cwd: string, file: string, needle: string): boolean {
	try {
		return fs.readFileSync(path.join(cwd, file), "utf8").includes(needle);
	} catch {
		return false;
	}
}

function isDir(cwd: string, name: string): boolean {
	try {
		return fs.statSync(path.join(cwd, name)).isDirectory();
	} catch {
		return false;
	}
}

function hasTestFiles(cwd: string): boolean {
	// exige DIRETÓRIO (um ficheiro solto chamado `test` não é suite); `spec/` de OpenAPI é o residual aceite
	if (["test", "tests", "__tests__", "spec"].some((n) => isDir(cwd, n))) return true;
	// scan raso: root + src, um nível (barato — sem glob recursivo)
	for (const dir of [cwd, path.join(cwd, "src")]) {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		if (names.some((n) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(n) || /_test\.(go|py|rs)$/.test(n) || /^test_.*\.py$/.test(n))) return true;
	}
	return false;
}

/** Detecta os gaps L1 locais (o `zyH`). Só-existência; multi-ecossistema; best-effort. */
export function detectLocalGaps(cwd: string): ReadinessGap[] {
	const gaps: ReadinessGap[] = [];
	// procura a key nos SPOTS conhecidos do package.json (scripts/deps/top-level) — a substring crua
	// casava a palavra em qualquer string (ex.: uma description que cite "prettier").
	const pkgHas = (key: string): boolean => {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as Record<string, unknown>;
			if (key in pkg) return true;
			for (const spot of ["scripts", "dependencies", "devDependencies", "peerDependencies"]) {
				const o = pkg[spot];
				if (o && typeof o === "object" && Object.keys(o).some((k) => k === key || k.includes(key))) return true;
				if (spot === "scripts" && o && typeof o === "object" && Object.values(o).some((v) => typeof v === "string" && v.includes(key))) return true;
			}
			return false;
		} catch {
			return false;
		}
	};
	const isNode = existsAny(cwd, ["package.json"]);
	const isPy = existsAny(cwd, ["pyproject.toml", "setup.py", "requirements.txt"]);
	const isGo = existsAny(cwd, ["go.mod"]);
	const isRust = existsAny(cwd, ["Cargo.toml"]);

	const lint =
		existsAny(cwd, [".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts", "biome.json", "biome.jsonc", ".oxlintrc.json", "ruff.toml", ".ruff.toml", ".golangci.yml", ".golangci.yaml"]) ||
		fileContains(cwd, "pyproject.toml", "[tool.ruff]") ||
		pkgHas("eslintConfig") ||
		isGo || // go vet vem com o toolchain
		isRust; // clippy vem com o toolchain
	if (!lint) gaps.push("lint_config");

	const typecheck = existsAny(cwd, ["tsconfig.json", "jsconfig.json", "pyrightconfig.json", "mypy.ini"]) || fileContains(cwd, "pyproject.toml", "[tool.mypy]") || isGo || isRust || (!isNode && !isPy && !isGo && !isRust);
	if (!typecheck) gaps.push("type_check");

	const fmt =
		existsAny(cwd, [".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.js", "prettier.config.js", "prettier.config.mjs", "biome.json", "biome.jsonc", "rustfmt.toml", ".rustfmt.toml", ".clang-format", ".editorconfig"]) ||
		fileContains(cwd, "pyproject.toml", "[tool.black]") ||
		fileContains(cwd, "pyproject.toml", "[tool.ruff.format]") ||
		pkgHas("prettier") ||
		isGo; // gofmt vem com o toolchain
	if (!fmt) gaps.push("formatter");

	if (!hasTestFiles(cwd)) gaps.push("unit_tests_exist");
	if (!existsAny(cwd, ["README.md", "README", "readme.md", "README.rst"])) gaps.push("readme");
	if (!existsAny(cwd, [".env.example", ".env.template", ".env.sample", "env.example"])) gaps.push("env_template");
	return gaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Estado de supressão (cli-hints.json)

interface PathHintState {
	hasPreviousReport?: boolean;
	noReportShownAt?: number;
	gapsShown?: Record<string, number>;
	lastSeenGaps?: string[];
	lastPrimedAt?: number;
}
interface HintsFile {
	perPath?: Record<string, PathHintState>;
}

export function hintsPath(opts: PathOpts = {}): string {
	return path.join(resolveAgentDir(opts), "pi-harness", "cli-hints.json");
}

function loadHints(opts: PathOpts): HintsFile {
	try {
		const raw = JSON.parse(fs.readFileSync(hintsPath(opts), "utf8")) as HintsFile;
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

function saveHints(f: HintsFile, opts: PathOpts): void {
	try {
		const p = hintsPath(opts);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		writeJsonAtomic(p, f, false);
	} catch {
		// best-effort
	}
}

export interface ReadinessHint {
	kind: "no_report" | "gap";
	gap?: ReadinessGap;
	text: string;
}

export interface HintOpts extends PathOpts {
	now?: number;
	/** existe snapshot de readiness pro repo (readSnapshot != null). */
	hasReport: boolean;
}

/**
 * O hint a mostrar AGORA (ou null): sem report → o no-report hint (1x/24h); com report →
 * o primeiro gap local ainda não suprimido (1x/24h por gap). Também prime o estado
 * (hasPreviousReport, lastSeenGaps) — o `primeReadinessHint` do Droid.
 */
export function getReadinessHint(cwd: string, opts: HintOpts): ReadinessHint | null {
	const now = opts.now ?? Date.now();
	const file = loadHints(opts);
	const st: PathHintState = file.perPath?.[cwd] ?? {};
	const gaps = detectLocalGaps(cwd);
	st.hasPreviousReport = opts.hasReport;
	st.lastSeenGaps = gaps;
	st.lastPrimedAt = now;
	saveHints({ perPath: { ...(file.perPath ?? {}), [cwd]: st } }, opts);

	if (!opts.hasReport) {
		if (st.noReportShownAt && now - st.noReportShownAt < HINT_SUPPRESS_MS) return null;
		return { kind: "no_report", text: NO_REPORT_MESSAGE };
	}
	for (const g of gaps) {
		const shown = st.gapsShown?.[g];
		if (shown && now - shown < HINT_SUPPRESS_MS) continue;
		return { kind: "gap", gap: g, text: GAP_MESSAGE[g] };
	}
	return null;
}

/** Grava o marcador de supressão do hint mostrado (o `markReadinessHintAsShown`). */
export function markReadinessHintShown(cwd: string, hint: ReadinessHint, opts: PathOpts & { now?: number } = {}): void {
	const now = opts.now ?? Date.now();
	const file = loadHints(opts);
	const st: PathHintState = file.perPath?.[cwd] ?? {};
	if (hint.kind === "no_report") st.noReportShownAt = now;
	else if (hint.gap) st.gapsShown = { ...(st.gapsShown ?? {}), [hint.gap]: now };
	saveHints({ perPath: { ...(file.perPath ?? {}), [cwd]: st } }, opts);
}
