/**
 * Config GLOBAL de modelo por ROLE do harness (análogo ao Droid: orchestrator /
 * worker / validator). Lógica pura, sem dependência do Pi — testável isolada.
 *
 * O que governa: os CHILDREN que o harness spawna via `pi --print` (feature-spawn.ts) —
 * worker (task), validator (ship-gate) e orchestrator (converge headless). Cada role
 * pode fixar um `model` ("provider/id") e um `thinking`/effort; `undefined` = HERDA o
 * modelo do parent/sessão (comportamento atual). O `pi --print` aceita `--model` e
 * `--thinking` (off|minimal|low|medium|high|xhigh) — ver cli/args.
 *
 * NÃO governa o orchestrator VIVO em sessão nem os subagents in-session (esses seguem
 * o modelo da sessão do usuário / pi-subagents). Escopo: os spawns que o harness controla.
 *
 * Persistência: `${agentDir}/pi-harness/models.json` (global, junto do config do Pi).
 * O settings.json do usuário (`${agentDir}/settings.json`) é LIDO (não escrito) pra
 * pré-popular a UI com o default e os enabledModels que ele já tem.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const HARNESS_ROLES = ["orchestrator", "worker", "validator"] as const;
export type HarnessRole = (typeof HARNESS_ROLES)[number];

/** Níveis aceitos pelo `--thinking` do `pi --print` (inclui "off"). */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

export const MODEL_CONFIG_VERSION = 1 as const;

/** Sentinela de UI/display pra "herdar o modelo do parent". `undefined` no disco. */
export const INHERIT = "(inherit)";

export interface RoleChoice {
	/** "provider/id" ou id do modelo; `undefined` = herda o modelo do parent/sessão. */
	model?: string;
	/** nível de thinking; `undefined` = herda (não passa `--thinking`). */
	thinking?: Effort;
}

/** Toggles experimentais do ship gate (análogo do skipScrutiny/skipUserTesting do Droid, doc UI §8). */
export interface GateConfig {
	/** pula o code-review (3 eixos) no ship gate — análogo do `skipScrutiny`. */
	skipScrutiny: boolean;
	/** pula o qa-validator (contrato na superfície real) — análogo do `skipUserTesting`. */
	skipUserTesting: boolean;
	/** pula a entrega (harness-deliver: PR + Linear + CI watch + fix loop + merge/cancel). */
	skipDelivery: boolean;
}

export interface HarnessModelConfig {
	version: typeof MODEL_CONFIG_VERSION;
	roles: Record<HarnessRole, RoleChoice>;
	gates: GateConfig;
}

export interface ResolvedChoice {
	model?: string;
	thinking?: Effort;
}

export function defaultModelConfig(): HarnessModelConfig {
	return { version: MODEL_CONFIG_VERSION, roles: { orchestrator: {}, worker: {}, validator: {} }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
}

export function isEffort(s: unknown): s is Effort {
	return typeof s === "string" && (EFFORTS as readonly string[]).includes(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths (resolvíveis; `agentDir` injetável p/ teste — sem tocar no HOME real).

export interface PathOpts {
	/** Base que contém pi-harness/models.json e settings.json; default = agent dir do Pi. */
	agentDir?: string;
}

export function resolveAgentDir(opts: PathOpts = {}): string {
	return opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}
export function modelConfigPath(opts: PathOpts = {}): string {
	return path.join(resolveAgentDir(opts), "pi-harness", "models.json");
}
export function piSettingsPath(opts: PathOpts = {}): string {
	return path.join(resolveAgentDir(opts), "settings.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// Load / normalize / save (tolerante a JSON parcial ou corrompido).

function sanitizeChoice(raw: unknown): RoleChoice {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const choice: RoleChoice = {};
	if (typeof r.model === "string" && r.model.trim() && r.model.trim() !== INHERIT) choice.model = r.model.trim();
	if (isEffort(r.thinking)) choice.thinking = r.thinking;
	return choice;
}

/** Aceita qualquer entrada e devolve um config válido (defaults pros campos ausentes/ruins). */
export function normalizeModelConfig(raw: unknown): HarnessModelConfig {
	const cfg = defaultModelConfig();
	const rolesRaw = raw && typeof raw === "object" ? (raw as { roles?: unknown }).roles : undefined;
	if (rolesRaw && typeof rolesRaw === "object") {
		for (const role of HARNESS_ROLES) cfg.roles[role] = sanitizeChoice((rolesRaw as Record<string, unknown>)[role]);
	}
	const gatesRaw = raw && typeof raw === "object" ? (raw as { gates?: unknown }).gates : undefined;
	if (gatesRaw && typeof gatesRaw === "object") {
		const g = gatesRaw as Record<string, unknown>;
		cfg.gates.skipScrutiny = g.skipScrutiny === true;
		cfg.gates.skipUserTesting = g.skipUserTesting === true;
		cfg.gates.skipDelivery = g.skipDelivery === true;
	}
	return cfg;
}

/** Ship-gate skills a PULAR dado o config (skipScrutiny→code-review; skipUserTesting→qa-validator; skipDelivery→deliver). */
export function skippedGateSkills(cfg: HarnessModelConfig | undefined): Set<string> {
	const s = new Set<string>();
	if (cfg?.gates?.skipScrutiny) s.add("harness-code-review");
	if (cfg?.gates?.skipUserTesting) s.add("harness-qa-validator");
	if (cfg?.gates?.skipDelivery) s.add("harness-deliver");
	return s;
}

export function loadModelConfig(opts: PathOpts = {}): HarnessModelConfig {
	try {
		return normalizeModelConfig(JSON.parse(fs.readFileSync(modelConfigPath(opts), "utf8")));
	} catch {
		return defaultModelConfig();
	}
}

export function saveModelConfig(cfg: HarnessModelConfig, opts: PathOpts = {}): void {
	const file = modelConfigPath(opts);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(normalizeModelConfig(cfg), null, 2)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// settings.json do usuário (LIDO, nunca escrito) — pré-popula a UI.

export interface PiSettingsView {
	defaultModel?: string; // id (ex.: "claude-opus-4-8")
	defaultProvider?: string; // ex.: "anthropic"
	defaultThinkingLevel?: string; // off|minimal|…|xhigh
	enabledModels?: string[]; // ["provider/id", …]
}

export function readPiSettings(opts: PathOpts = {}): PiSettingsView {
	try {
		const s = JSON.parse(fs.readFileSync(piSettingsPath(opts), "utf8")) as Record<string, unknown>;
		const out: PiSettingsView = {};
		if (typeof s.defaultModel === "string") out.defaultModel = s.defaultModel;
		if (typeof s.defaultProvider === "string") out.defaultProvider = s.defaultProvider;
		if (typeof s.defaultThinkingLevel === "string") out.defaultThinkingLevel = s.defaultThinkingLevel;
		if (Array.isArray(s.enabledModels)) out.enabledModels = s.enabledModels.filter((x): x is string => typeof x === "string");
		return out;
	} catch {
		return {};
	}
}

/** O "provider/id" do modelo default do usuário — a baseline herdada exibida na UI. */
export function defaultModelRef(s: PiSettingsView): string | undefined {
	if (!s.defaultModel) return undefined;
	return s.defaultProvider && !s.defaultModel.includes("/") ? `${s.defaultProvider}/${s.defaultModel}` : s.defaultModel;
}

/** Lista ordenada e deduplicada de modelos selecionáveis (default primeiro, depois enabled, depois registry). */
export function modelOptions(available: string[], settings: PiSettingsView): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (m?: string): void => {
		if (m && !seen.has(m)) {
			seen.add(m);
			out.push(m);
		}
	};
	add(defaultModelRef(settings));
	for (const m of settings.enabledModels ?? []) add(m);
	for (const m of available) add(m);
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolução por step / role.

/** task → worker; ship-gate (qualquer outro kind) → validator. Converge = orchestrator (à parte). */
export function roleForStep(step: { kind: string }): HarnessRole {
	return step.kind === "task" ? "worker" : "validator";
}

/**
 * Resolve o modelo+effort efetivos de um role: override do role > fallback (modelo do
 * parent). `model` undefined → não passa `--model` (child herda). `thinking` undefined →
 * não passa `--thinking` (child usa o defaultThinkingLevel do settings dele).
 */
export function resolveChoice(cfg: HarnessModelConfig | undefined, role: HarnessRole, fallbackModel?: string): ResolvedChoice {
	const c = cfg?.roles?.[role] ?? {};
	return { model: c.model ?? fallbackModel, thinking: c.thinking };
}

// ─────────────────────────────────────────────────────────────────────────────
// Display amigável (model + effort combinados): "Claude Opus 4.8 (XHigh)".

export const EFFORT_LABELS: Record<Effort, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh" };

/** Rótulo do effort (capitalizado); `undefined` → "inherit". */
export function effortLabel(e?: Effort): string {
	return e ? EFFORT_LABELS[e] : "inherit";
}

export interface RoleDisplayOpts {
	/** ref "provider/id" → nome amigável (display names do registry). */
	labels?: Record<string, string>;
	/** ref do modelo herdado (fallback) — exibido quando o role herda. */
	fallback?: string;
}

/** Nome amigável de um ref: label do registry, senão o id (parte após "/"); `undefined` → "inherit". */
export function modelLabel(ref: string | undefined, opts: RoleDisplayOpts = {}): string {
	if (!ref) return "inherit";
	return opts.labels?.[ref] ?? ref.split("/").pop() ?? ref;
}

/** Display combinado de um role: "Model (Effort)" — ex.: "Claude Opus 4.8 (XHigh)". */
export function roleSummary(cfg: HarnessModelConfig, role: HarnessRole, opts: RoleDisplayOpts = {}): string {
	const c = cfg.roles[role];
	const modelPart = c.model ? modelLabel(c.model, opts) : `inherit→${opts.fallback ? modelLabel(opts.fallback, opts) : "session"}`;
	return `${modelPart} (${effortLabel(c.thinking)})`;
}

/** Uma linha legível por role pro notify/status. */
export function summarizeConfig(cfg: HarnessModelConfig, opts: RoleDisplayOpts = {}): string {
	return HARNESS_ROLES.map((role) => `${role}: ${roleSummary(cfg, role, opts)}`).join("  |  ");
}
