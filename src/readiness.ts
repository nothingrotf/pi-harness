/**
 * Modelo de readiness — lógica pura, sem dependência do Pi (testável isolado em
 * test/readiness.test.ts). O readiness-gate.ts liga isto ao TUI; o
 * readiness-pipeline.ts faz ensure/store; o store-tool valida via validateReport.
 *
 * Port 1:1 do "Agent Readiness Model" do referência (modelo de referência):
 *   - mantém: pass-rate ponderado igual por critério → nível L1..L5; scope
 *     repository (den=1) vs application (den=N); skippable (num=null fora do score).
 *   - corta: o gate dele é cloud-centric (git remote + Firestore → warnings
 *     no-git/no-remote). pi-harness é LOCAL: snapshot em .harness/profile/.
 *   - overlay local: critérios `cloudOnly` (readiness-criteria.ts) saem do score.
 *
 * Ciclo de vida do snapshot (ver docs/02-readiness-ux.md):
 *   absent → (create/audit) draft → (validate) ready|weak → (drift) stale
 */

import {
	type Category,
	type Criterion,
	CRITERION_BY_ID,
	isLocallySkippable,
	READINESS_CRITERIA,
	type Scope,
} from "./readiness-criteria.ts";

export type { Category, Criterion, Scope } from "./readiness-criteria.ts";
export { CLOUD_ONLY_IDS, READINESS_CRITERIA } from "./readiness-criteria.ts";

/** Versão do schema do snapshot — bump em mudança incompatível. */
export const READINESS_VERSION = 1;

/** Avaliação de um critério. Repo scope: num 1/0/null, den 1. App scope: num 0..N, den N. */
export interface CriterionEval {
	num: number | null; // null = skipped/N-A/cloudOnly (fora do score)
	den: number;
	rationale?: string;
}

/** O que o auditor produz / o store-tool recebe (antes de virar snapshot). */
export interface ReadinessReport {
	evals: Record<string, CriterionEval>;
	apps?: number; // N — denominador das app-scope (default 1)
}

/** O artefato persistido em .harness/profile/readiness.json. */
export interface ReadinessSnapshot {
	version: number;
	generatedAt: string;
	fingerprint: string;
	apps: number; // N
	evals: Record<string, CriterionEval>;
	level: number; // 1..5 (derivado, gravado pra leitura barata)
	passRate: number; // 0..1
}

/** Os 82 ids canônicos (ordem do registry). */
export function criteriaIds(): string[] {
	return READINESS_CRITERIA.map((x) => x.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring (pure)

/**
 * Pass-rate = média de (num/den) sobre sinais não-skipados (num !== null).
 * Cada sinal pesa igual, independente do denominador (igual ao referência).
 */
export function computePassRate(evals: Record<string, CriterionEval>): number {
	let sum = 0;
	let n = 0;
	for (const ev of Object.values(evals)) {
		if (ev.num === null) continue; // skipped → fora
		const den = ev.den > 0 ? ev.den : 1;
		sum += Math.max(0, Math.min(1, ev.num / den));
		n++;
	}
	return n === 0 ? 0 : sum / n;
}

/** Bandas: L1 0-20, L2 20-40, L3 40-60, L4 60-80, L5 80-100 (% pass-rate). */
export function levelFromPassRate(rate: number): number {
	if (rate < 0.2) return 1;
	if (rate < 0.4) return 2;
	if (rate < 0.6) return 3;
	if (rate < 0.8) return 4;
	return 5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate stage (contrato estrito do report — espelha a Phase 4 do auditor)

export interface ValidationResult {
	ok: boolean;
	issues: string[];
}

const MAX_RATIONALE = 500;

/**
 * Valida um report contra o contrato (estrito, como o store_agent_readiness_report
 * do referência): exatamente os 82 ids, denominadores certos por scope, num null
 * só em skippable/cloudOnly, rationale presente e ≤500. É o gate do estágio
 * "validate" — usado pelo store-tool antes de gravar.
 */
export function validateReport(report: ReadinessReport): ValidationResult {
	const issues: string[] = [];
	const apps = report.apps ?? 1;
	if (!Number.isInteger(apps) || apps < 1) issues.push(`invalid apps: ${apps} (expected integer >= 1)`);

	const provided = new Set(Object.keys(report.evals));
	for (const crit of READINESS_CRITERIA) {
		if (!provided.has(crit.id)) {
			issues.push(`missing criterion: ${crit.id}`);
			continue;
		}
		validateOneEval(crit, report.evals[crit.id], apps, issues);
	}
	for (const id of provided) {
		if (!CRITERION_BY_ID.has(id)) issues.push(`unknown criterion (invalid id): ${id}`);
	}
	return { ok: issues.length === 0, issues };
}

function validateOneEval(crit: Criterion, ev: CriterionEval, apps: number, issues: string[]): void {
	const expectedDen = crit.scope === "repository" ? 1 : apps;
	if (!Number.isInteger(ev.den) || ev.den !== expectedDen) {
		issues.push(`${crit.id}: den ${ev.den} (expected ${expectedDen} for scope ${crit.scope})`);
	}
	if (ev.num === null) {
		if (!isLocallySkippable(crit)) issues.push(`${crit.id}: num=null is only allowed for skippable/cloudOnly`);
	} else if (!Number.isInteger(ev.num) || ev.num < 0 || ev.num > ev.den) {
		issues.push(`${crit.id}: num ${ev.num} out of range [0..${ev.den}]`);
	}
	if (ev.rationale !== undefined && ev.rationale.length > MAX_RATIONALE) {
		issues.push(`${crit.id}: rationale > ${MAX_RATIONALE} chars`);
	}
}

/** Constrói o snapshot a partir de um report (assume validado). Computa level+passRate. */
export function buildSnapshot(report: ReadinessReport, opts: { fingerprint: string; generatedAt?: string }): ReadinessSnapshot {
	const passRate = computePassRate(report.evals);
	return {
		version: READINESS_VERSION,
		generatedAt: opts.generatedAt ?? new Date().toISOString(),
		fingerprint: opts.fingerprint,
		apps: report.apps ?? 1,
		evals: report.evals,
		level: levelFromPassRate(passRate),
		passRate,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Stance (o que o gate projeta)

export type Stance = "unknown" | "stale" | "weak" | "ready";

export interface GateOpts {
	/** Nível mínimo pra liberar sem fricção (default 4). */
	targetLevel?: number;
	/** Fingerprint do repo divergiu do snapshot? (drift detection — Fatia 2) */
	drift?: boolean;
}

/**
 * Projeta o snapshot num único "stance" — substitui os 4 warnings soltos do
 * referência por um campo só (ver docs/02-readiness-ux.md).
 */
export function deriveStance(snapshot: ReadinessSnapshot | null, opts: GateOpts = {}): Stance {
	if (!snapshot) return "unknown";
	if (opts.drift) return "stale";
	const target = opts.targetLevel ?? 4;
	return snapshot.level >= target ? "ready" : "weak";
}

// ─────────────────────────────────────────────────────────────────────────────
// Render helpers (strings puras; cor é aplicada pelo caller via theme)

const FULL = "▰";
const EMPTY = "▱";

/** Medidor de nível: 5 células, `level` preenchidas. */
export function levelBar(level: number): string {
	const lvl = Math.max(0, Math.min(5, Math.round(level)));
	return FULL.repeat(lvl) + EMPTY.repeat(5 - lvl);
}

/** Barra de razão passed/total com largura fixa. */
export function ratioBar(passed: number, total: number, width = 6): string {
	if (total <= 0) return EMPTY.repeat(width);
	const filled = Math.max(0, Math.min(width, Math.round((passed / total) * width)));
	return FULL.repeat(filled) + EMPTY.repeat(width - filled);
}

export interface CategorySummary {
	category: Category;
	passed: number; // critérios que passam por completo (num >= den)
	total: number; // critérios não-skipados na categoria
}

/** Resumo por categoria, ordenado do mais fraco (menor fração) pro mais forte. */
export function categorySummaries(snapshot: ReadinessSnapshot): CategorySummary[] {
	const acc = new Map<Category, { passed: number; total: number }>();
	for (const [id, ev] of Object.entries(snapshot.evals)) {
		if (ev.num === null) continue;
		const crit = CRITERION_BY_ID.get(id);
		if (!crit) continue;
		const cur = acc.get(crit.category) ?? { passed: 0, total: 0 };
		cur.total++;
		const den = ev.den > 0 ? ev.den : 1;
		if (ev.num >= den) cur.passed++;
		acc.set(crit.category, cur);
	}
	return [...acc.entries()]
		.map(([category, v]) => ({ category, passed: v.passed, total: v.total }))
		.sort((a, b) => a.passed / a.total - b.passed / b.total);
}

/** Resumo de uma linha pro report/notify: "L2/5 · 34% · fracas: security 1/12, testing 2/8". */
export function summarizeSnapshot(snapshot: ReadinessSnapshot): string {
	const pct = Math.round(snapshot.passRate * 100);
	const weak = categorySummaries(snapshot)
		.filter((s) => s.passed < s.total)
		.slice(0, 3)
		.map((s) => `${s.category} ${s.passed}/${s.total}`)
		.join(", ");
	return `L${snapshot.level}/5 · ${pct}%${weak ? ` · weak: ${weak}` : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatório completo navegável (puro; string[] — o caller mostra em painel/print)

export type CriterionStatus = "pass" | "fail" | "partial" | "skip";
const STATUS_SYMBOL: Record<CriterionStatus, string> = { pass: "✓", fail: "✗", partial: "◐", skip: "⊘" };

/** Status de um critério: app-scope pode ser parcial (0<num<den); null = skipped. */
export function criterionStatus(ev: CriterionEval): CriterionStatus {
	if (ev.num === null) return "skip";
	const den = ev.den > 0 ? ev.den : 1;
	if (ev.num >= den) return "pass";
	if (ev.num <= 0) return "fail";
	return "partial";
}

/**
 * Renderiza o relatório completo: medidor de nível + contagem, depois uma seção por
 * categoria (mais fraca primeiro), cada critério com ✓/✗/◐/⊘ + id + nome + nível +
 * (ratio app-scope) + (motivo do skip) + rationale truncada. Determinístico e testável
 * sem TUI; é o que a ação "View full report" mostra.
 */
export function renderReadinessReport(snapshot: ReadinessSnapshot, opts: { targetLevel?: number } = {}): string[] {
	const target = opts.targetLevel ?? 4;
	const pct = Math.round(snapshot.passRate * 100);
	const entries = Object.entries(snapshot.evals);
	let evaluated = 0;
	let passed = 0;
	let skipped = 0;
	for (const [, ev] of entries) {
		const s = criterionStatus(ev);
		if (s === "skip") skipped++;
		else {
			evaluated++;
			if (s === "pass") passed++;
		}
	}

	const lines: string[] = [];
	lines.push(`Agent Readiness — L${snapshot.level} / L5  ${levelBar(snapshot.level)}  ${pct}%   (target ≥ L${target})`);
	lines.push(`${entries.length} criteria · ${evaluated} evaluated · ${passed} passed · ${skipped} skipped`);
	lines.push("");

	// ordem de registry (pra desempate estável dentro da categoria)
	const regOrder = new Map<string, number>();
	READINESS_CRITERIA.forEach((c, i) => regOrder.set(c.id, i));
	const rank = (id: string): number => {
		const st = criterionStatus(snapshot.evals[id]);
		const stRank = st === "fail" ? 0 : st === "partial" ? 1 : st === "pass" ? 2 : 3;
		return stRank * 1000 + (regOrder.get(id) ?? 999);
	};

	const byCat = new Map<Category, string[]>();
	for (const [id] of entries) {
		const crit = CRITERION_BY_ID.get(id);
		if (!crit) continue;
		byCat.set(crit.category, [...(byCat.get(crit.category) ?? []), id]);
	}

	const summaries = categorySummaries(snapshot); // mais fraca → mais forte (exclui skipped do total)
	const seen = new Set<Category>();
	const emit = (cat: Category): void => {
		seen.add(cat);
		const summ = summaries.find((s) => s.category === cat);
		const pN = summ?.passed ?? 0;
		const tN = summ?.total ?? 0;
		lines.push(`${ratioBar(pN, tN)} ${String(cat).padEnd(14)} ${pN}/${tN}`);
		for (const id of (byCat.get(cat) ?? []).slice().sort((a, b) => rank(a) - rank(b))) {
			const crit = CRITERION_BY_ID.get(id);
			if (!crit) continue;
			const ev = snapshot.evals[id];
			const st = criterionStatus(ev);
			const ratio = ev.num !== null && ev.den > 1 ? ` ${ev.num}/${ev.den}` : "";
			const skipNote = st === "skip" ? (crit.cloudOnly ? "  (skipped: cloud-only)" : "  (skipped)") : "";
			const rationale = ev.rationale ? `  — ${ev.rationale.length > 80 ? `${ev.rationale.slice(0, 77)}...` : ev.rationale}` : "";
			lines.push(`  ${STATUS_SYMBOL[st]} ${id.padEnd(26)} ${crit.name.padEnd(28)} [L${crit.level}]${ratio}${skipNote}${rationale}`);
		}
		lines.push("");
	};
	for (const s of summaries) emit(s.category); // categorias com sinais avaliados, mais fraca primeiro
	for (const cat of byCat.keys()) if (!seen.has(cat)) emit(cat); // categorias 100% skipped, ao fim
	return lines;
}

/** Conveniência: o relatório como texto (uma string). */
export function renderReadinessReportText(snapshot: ReadinessSnapshot, opts: { targetLevel?: number } = {}): string {
	return renderReadinessReport(snapshot, opts).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate view model (o que o readiness-gate.ts renderiza)

export type GateActionValue = "fix" | "report" | "proceed" | "cancel" | "reaudit";
export type Tone = "success" | "warning" | "error" | "muted";

export interface GateAction {
	label: string;
	value: GateActionValue;
	description?: string;
}

export interface WeakRow {
	label: string; // nome da categoria
	bar: string; // ratioBar
	ratio: string; // "1/12"
}

export interface GateModel {
	stance: Stance;
	chip: string; // "▲ ABAIXO DA BARRA"
	tone: Tone;
	meter: string; // "L2 / L5  ▰▰▱▱▱  34%   ·  target ≥ L4"  ("" no unknown)
	weakest: WeakRow[]; // top fracos (weak/stale); [] no unknown/ready
	actions: GateAction[];
}

function meterText(snapshot: ReadinessSnapshot, target: number, drift: boolean): string {
	const pct = Math.round(snapshot.passRate * 100);
	const base = `L${snapshot.level} / L5  ${levelBar(snapshot.level)}  ${pct}%`;
	if (drift) return `${base}  ·  may be stale`;
	return `${base}  ·  target ≥ L${target}`;
}

function weakestRows(snapshot: ReadinessSnapshot, k = 3): WeakRow[] {
	return categorySummaries(snapshot)
		.filter((cat) => cat.passed < cat.total)
		.slice(0, k)
		.map((cat) => ({ label: cat.category, bar: ratioBar(cat.passed, cat.total), ratio: `${cat.passed}/${cat.total}` }));
}

/**
 * Constrói o view model do gate a partir do snapshot. Pura — testável sem TUI.
 * Os 4 stances mapeiam pra chip + tone + ação primária (docs/02-readiness-ux.md).
 */
export function buildGateModel(snapshot: ReadinessSnapshot | null, opts: GateOpts = {}): GateModel {
	const target = opts.targetLevel ?? 4;
	const stance = deriveStance(snapshot, opts);

	if (stance === "unknown") {
		return {
			stance,
			chip: "◆ NOT EVALUATED",
			tone: "muted",
			meter: "",
			weakest: [],
			actions: [
				{ label: "Run readiness audit", value: "reaudit", description: "~30s · writes .harness/profile" },
				{ label: "Proceed without a snapshot", value: "proceed", description: "you accept the risk" },
				{ label: "Cancel", value: "cancel" },
			],
		};
	}

	const snap = snapshot as ReadinessSnapshot;

	if (stance === "ready") {
		return {
			stance,
			chip: "✓ READY",
			tone: "success",
			meter: meterText(snap, target, false),
			weakest: [],
			actions: [
				{ label: "Proceed with the feature", value: "proceed" },
				{ label: "View full report", value: "report", description: "criteria by category" },
				{ label: "Cancel", value: "cancel" },
			],
		};
	}

	if (stance === "stale") {
		return {
			stance,
			chip: "↻ MAY BE STALE",
			tone: "warning",
			meter: meterText(snap, target, true),
			weakest: weakestRows(snap),
			actions: [
				{ label: "Re-audit", value: "reaudit", description: "re-derive the snapshot" },
				{ label: "View last report", value: "report" },
				{ label: "Proceed anyway", value: "proceed" },
				{ label: "Cancel", value: "cancel" },
			],
		};
	}

	// weak
	return {
		stance,
		chip: "▲ BELOW THE BAR",
		tone: snap.level <= 1 ? "error" : "warning",
		meter: meterText(snap, target, false),
		weakest: weakestRows(snap),
		actions: [
			{ label: "Fix readiness signals", value: "fix", description: "guided remediation" },
			{ label: "View full report", value: "report", description: "criteria by category" },
			{ label: "Proceed anyway", value: "proceed", description: "run the feature anyway" },
			{ label: "Cancel", value: "cancel" },
		],
	};
}
