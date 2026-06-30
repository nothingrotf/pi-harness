/**
 * Delivery — view-model PURO + IO do passo de entrega (ship-gate step 3, `harness-deliver`).
 * Lê/escreve `.harness/runs/<id>/validation/delivery/record.json` (o registro do PR + CI +
 * fix-loop + decisão de merge) e projeta linhas de display pro cockpit (aba Delivery) e pro
 * overlay de merge (showMergeGate). Sem dependência do Pi — testável isolado.
 *
 * O record é escrito pela skill `harness-deliver` via a tool `store_delivery`; o cockpit
 * (read-only) e o overlay de merge LEEM daqui. A decisão de merge é humana (overlay), nunca
 * autônoma — quando `state === "awaiting_merge"`, a extensão abre o overlay.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runDir } from "./handoff.ts";

/** Estado de um check de CI individual. */
export type CheckState = "passed" | "failed" | "pending" | "skipped";
/** Estado agregado do CI. */
export type CiState = "passed" | "failed" | "pending" | "ci_blocked";
/** Estado do passo de entrega como um todo. */
export type DeliveryState = "preparing" | "open" | "awaiting_merge" | "merged" | "cancelled" | "ci_blocked";

export interface CiCheck {
	name: string;
	state: CheckState;
	/** link externo (Actions run / serviço) — opcional. */
	link?: string;
}

export interface LinkedIssues {
	linearIssueIds: string[];
	jiraIssueKeys: string[];
	/** chaves cruas (branch/commits) ainda não confirmadas — ver linear-link.ts. */
	candidateKeys: string[];
}

export interface DeliveryRecord {
	prNumber?: number;
	prUrl?: string;
	prTitle?: string;
	baseBranch?: string;
	headBranch?: string;
	linkedIssues: LinkedIssues;
	ci: {
		state: CiState;
		/** iterações do fix-loop já consumidas (cap 3). */
		iterations: number;
		checks: CiCheck[];
		/** job + erro raiz da falha primária (quando ci_blocked/failed). */
		primaryFailure?: string | null;
	};
	state: DeliveryState;
	/** fixes aplicados no loop, em ordem. */
	fixesApplied: string[];
	salientSummary?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// IO

export function deliveryDir(cwd: string, featureId: string): string {
	return path.join(runDir(cwd, featureId), "validation", "delivery");
}
export function deliveryPath(cwd: string, featureId: string): string {
	return path.join(deliveryDir(cwd, featureId), "record.json");
}

const EMPTY_LINKS: LinkedIssues = { linearIssueIds: [], jiraIssueKeys: [], candidateKeys: [] };

function strArr(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asCheckState(v: unknown): CheckState {
	return v === "passed" || v === "failed" || v === "pending" || v === "skipped" ? v : "pending";
}
function asCiState(v: unknown): CiState {
	return v === "passed" || v === "failed" || v === "pending" || v === "ci_blocked" ? v : "pending";
}
function asDeliveryState(v: unknown): DeliveryState {
	return v === "preparing" || v === "open" || v === "awaiting_merge" || v === "merged" || v === "cancelled" || v === "ci_blocked" ? v : "preparing";
}

/** Aceita qualquer entrada e devolve um DeliveryRecord válido (tolerante a JSON parcial). */
export function normalizeDeliveryRecord(raw: unknown): DeliveryRecord {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const li = (r.linkedIssues && typeof r.linkedIssues === "object" ? r.linkedIssues : {}) as Record<string, unknown>;
	const ci = (r.ci && typeof r.ci === "object" ? r.ci : {}) as Record<string, unknown>;
	const checks = Array.isArray(ci.checks)
		? ci.checks
				.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
				.map((c) => ({ name: typeof c.name === "string" ? c.name : "check", state: asCheckState(c.state), ...(typeof c.link === "string" ? { link: c.link } : {}) }))
		: [];
	return {
		...(typeof r.prNumber === "number" ? { prNumber: r.prNumber } : {}),
		...(typeof r.prUrl === "string" ? { prUrl: r.prUrl } : {}),
		...(typeof r.prTitle === "string" ? { prTitle: r.prTitle } : {}),
		...(typeof r.baseBranch === "string" ? { baseBranch: r.baseBranch } : {}),
		...(typeof r.headBranch === "string" ? { headBranch: r.headBranch } : {}),
		linkedIssues: { linearIssueIds: strArr(li.linearIssueIds), jiraIssueKeys: strArr(li.jiraIssueKeys), candidateKeys: strArr(li.candidateKeys) },
		ci: { state: asCiState(ci.state), iterations: typeof ci.iterations === "number" ? ci.iterations : 0, checks, primaryFailure: typeof ci.primaryFailure === "string" ? ci.primaryFailure : null },
		state: asDeliveryState(r.state),
		fixesApplied: strArr(r.fixesApplied),
		...(typeof r.salientSummary === "string" ? { salientSummary: r.salientSummary } : {}),
	};
}

export function readDeliveryRecord(cwd: string, featureId: string): DeliveryRecord | null {
	try {
		return normalizeDeliveryRecord(JSON.parse(fs.readFileSync(deliveryPath(cwd, featureId), "utf8")));
	} catch {
		return null;
	}
}

export function writeDeliveryRecord(cwd: string, featureId: string, rec: DeliveryRecord): void {
	const dir = deliveryDir(cwd, featureId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(deliveryPath(cwd, featureId), `${JSON.stringify(normalizeDeliveryRecord(rec), null, 2)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Display (puro) — usado pela aba Delivery do cockpit e pelo overlay de merge.

const CHECK_ICON: Record<CheckState, string> = { passed: "✓", failed: "✗", pending: "⧗", skipped: "○" };
const DELIVERY_LABEL: Record<DeliveryState, string> = {
	preparing: "Preparing",
	open: "Open",
	awaiting_merge: "Awaiting merge gate",
	merged: "Merged",
	cancelled: "Cancelled",
	ci_blocked: "CI blocked",
};

export function checkIcon(s: CheckState): string {
	return CHECK_ICON[s];
}
export function deliveryStateLabel(s: DeliveryState): string {
	return DELIVERY_LABEL[s];
}

/** Resumo de 1 linha do CI: "✓ build  ✓ test  ✗ lint  ⧗ e2e" (ou "—" sem checks). */
export function ciLine(rec: DeliveryRecord): string {
	if (rec.ci.checks.length === 0) return rec.ci.state === "pending" ? "—" : deliveryStateLabel(rec.state);
	return rec.ci.checks.map((c) => `${checkIcon(c.state)} ${c.name}`).join("   ");
}

/** Linhas do painel Delivery (cockpit). Read-only; `null` → estado "ainda não entregou". */
export function deliveryDisplayLines(rec: DeliveryRecord | null): string[] {
	if (!rec)
		return [
			"No PR yet — the harness-deliver gate hasn't run for this feature.",
			"",
			"Run /harness run (the ship gate now includes delivery), or invoke the",
			"harness-deliver skill, to open the PR, watch CI, and reach the merge gate.",
		];
	const lines: string[] = [];
	const idTitle = rec.prNumber ? `PR #${rec.prNumber}${rec.prTitle ? `  ${rec.prTitle}` : ""}` : "PR (not opened yet)";
	lines.push(`${idTitle}    ${deliveryStateLabel(rec.state)}`);
	if (rec.prUrl) lines.push(rec.prUrl);
	const issues = [...rec.linkedIssues.linearIssueIds.map((k) => `${k} (Linear)`), ...rec.linkedIssues.jiraIssueKeys.map((k) => `${k} (Jira)`)];
	lines.push(`Linked   ${issues.length ? issues.join(", ") : rec.linkedIssues.candidateKeys.length ? `${rec.linkedIssues.candidateKeys.join(", ")} (candidate — unconfirmed)` : "none"}`);
	if (rec.baseBranch && rec.headBranch) lines.push(`Branch   ${rec.headBranch} → ${rec.baseBranch}`);
	lines.push("");
	lines.push(`CI       ${ciLine(rec)}`);
	lines.push(`Fix-loop ${rec.ci.iterations}/3${rec.fixesApplied.length ? `   last: ${rec.fixesApplied[rec.fixesApplied.length - 1]}` : ""}`);
	if (rec.ci.primaryFailure) lines.push(`Failure  ${rec.ci.primaryFailure}`);
	lines.push("");
	const mergeMark = rec.state === "merged" ? "✓ merged" : rec.state === "cancelled" ? "✗ cancelled" : rec.state === "awaiting_merge" ? "◻ awaiting human gate" : "— pending CI";
	lines.push(`Merge    ${mergeMark}`);
	if (rec.salientSummary) {
		lines.push("");
		lines.push(rec.salientSummary);
	}
	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Painel rico (cockpit) — layout PURO via uma interface `Paint` (string→string), injetada pela
// view (control-view.ts) com o tema do Pi, e por testes/preview com ANSI/plain. Sem dep do Pi.

export type Tone = "success" | "error" | "warning" | "accent" | "muted" | "dim";

/** Primitivas de pintura/medida injetadas (o tema do Pi por trás, ou ANSI/identidade nos testes). */
export interface Paint {
	fg(tone: Tone, s: string): string;
	bold(s: string): string;
	dim(s: string): string;
	accent(s: string): string;
	accentB(s: string): string;
	width(s: string): number;
	truncate(s: string, n: number): string;
	/** splitLineRender(left, right, width, padX). */
	split(left: string, right: string, width: number, padX: number): string;
	/** régua horizontal (───) de `n` colunas, já colorida muted, com gutter. */
	rule(n: number): string;
}

const STATE_TONE: Record<DeliveryState, Tone> = { preparing: "muted", open: "accent", awaiting_merge: "warning", merged: "success", cancelled: "error", ci_blocked: "error" };
const CHECK_TONE: Record<CheckState, Tone> = { passed: "success", failed: "error", pending: "warning", skipped: "muted" };

function ciSummarySeg(rec: DeliveryRecord, p: Paint): string {
	const total = rec.ci.checks.length;
	const passed = rec.ci.checks.filter((c) => c.state === "passed").length;
	const failed = rec.ci.checks.filter((c) => c.state === "failed").length;
	if (total === 0) return p.dim("— no checks yet");
	if (failed > 0) return `${p.fg("error", "✗")} ${p.bold(p.fg("error", `${failed} failing`))}`;
	if (passed === total) return `${p.fg("success", "✓")} ${p.bold(p.fg("success", "all green"))}`;
	return `${p.fg("warning", "⧗")} ${p.fg("warning", "running")}`;
}

function chipRows(checks: CiCheck[], avail: number, p: Paint): string[] {
	if (checks.length === 0) return [];
	const maxName = Math.min(34, Math.max(...checks.map((c) => c.name.length)));
	const chipW = maxName + 4;
	const ncols = Math.max(1, Math.floor(avail / chipW));
	const rows: string[] = [];
	for (let i = 0; i < checks.length; i += ncols) {
		const cells = checks.slice(i, i + ncols).map((c) => {
			const name = p.truncate(c.name, chipW - 3);
			const plain = `${checkIcon(c.state)} ${name}`;
			const chip = `${p.fg(CHECK_TONE[c.state], checkIcon(c.state))} ${c.state === "failed" ? p.fg("error", name) : name}`;
			return chip + " ".repeat(Math.max(0, chipW - p.width(plain)));
		});
		rows.push(cells.join("").replace(/\s+$/, ""));
	}
	return rows;
}

function mergeSeg(rec: DeliveryRecord, p: Paint): string {
	if (rec.state === "merged") return `${p.fg("success", "✓")} ${p.bold(p.fg("success", "merged"))}`;
	if (rec.state === "cancelled") return `${p.fg("error", "✗")} ${p.fg("error", "cancelled")}`;
	if (rec.state === "awaiting_merge") return `${p.fg("warning", "◻")} ${p.fg("warning", "awaiting your decision")}  ${p.dim("— the merge gate overlay opens on the agent's turn")}`;
	return p.dim("— pending CI");
}

function wrapWords(text: string, width: number, p: Paint, maxLines = 3): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const out: string[] = [];
	let line = "";
	for (const word of words) {
		if (line && p.width(`${line} ${word}`) > width) {
			out.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	if (line) out.push(line);
	return out.slice(0, maxLines);
}

/** Linhas do painel Delivery do cockpit (read-only, rico). `inner` = largura interna do frame. */
export function deliveryPanelLines(rec: DeliveryRecord | null, p: Paint, inner: number): string[] {
	if (!rec)
		return [
			"",
			` ${p.fg("muted", "◌")}  ${p.dim("No PR yet — the harness-deliver gate hasn't run for this feature.")}`,
			"",
			` ${p.dim("Run")} ${p.accent("/harness run")} ${p.dim("(the ship gate now includes delivery), or invoke the")}`,
			` ${p.accent("harness-deliver")} ${p.dim("skill, to open the PR, watch CI, and reach the merge gate.")}`,
		];
	const out: string[] = [];
	const tone = STATE_TONE[rec.state];
	const badge = `${p.fg(tone, "●")} ${p.bold(p.fg(tone, deliveryStateLabel(rec.state).toUpperCase()))}`;
	const id = rec.prNumber ? `PR #${rec.prNumber}` : "PR (not opened)";
	const title = rec.prTitle ? `  ${p.dim(p.truncate(rec.prTitle, Math.max(8, inner - id.length - p.width(badge) - 8)))}` : "";
	out.push(p.split(`${p.accent("◈")} ${p.bold(id)}${title}`, badge, inner, 1));
	if (rec.prUrl) out.push(`   ${p.accent("↪")} ${p.dim(p.truncate(rec.prUrl, inner - 6))}`);
	out.push("");
	const issues = [...rec.linkedIssues.linearIssueIds.map((k) => `${p.fg("accent", k)} ${p.dim("(Linear)")}`), ...rec.linkedIssues.jiraIssueKeys.map((k) => `${p.fg("accent", k)} ${p.dim("(Jira)")}`)];
	const linked = issues.length ? issues.join(p.dim(",  ")) : rec.linkedIssues.candidateKeys.length ? `${p.fg("muted", rec.linkedIssues.candidateKeys.join(", "))} ${p.dim("(candidate — unconfirmed)")}` : p.dim("none");
	out.push(`   ${p.accentB("Linked")}    ${linked}`);
	if (rec.headBranch && rec.baseBranch) out.push(`   ${p.accentB("Branch")}    ${p.fg("accent", rec.headBranch)} ${p.dim("→")} ${p.fg("muted", rec.baseBranch)}`);
	out.push(p.rule(inner));
	const passed = rec.ci.checks.filter((c) => c.state === "passed").length;
	const count = rec.ci.checks.length ? p.dim(`${passed}/${rec.ci.checks.length} checks`) : "";
	out.push(p.split(`${p.accentB("CI")}        ${ciSummarySeg(rec, p)}`, count, inner, 1));
	for (const row of chipRows(rec.ci.checks, inner - 5, p)) out.push(`     ${row}`);
	if (rec.ci.primaryFailure) out.push(`   ${p.fg("error", "⚠")} ${p.fg("error", p.truncate(rec.ci.primaryFailure, inner - 6))}`);
	const used = Math.max(0, Math.min(3, rec.ci.iterations));
	const bar = `${used > 0 ? p.fg("warning", "▰".repeat(used)) : ""}${used < 3 ? p.fg("dim", "▱".repeat(3 - used)) : ""}`;
	const lastFix = rec.fixesApplied.length ? p.dim(`  last: ${p.truncate(rec.fixesApplied[rec.fixesApplied.length - 1], 28)}`) : "";
	out.push(`   ${p.accentB("Fix-loop")}  ${bar}  ${p.bold(`${rec.ci.iterations}/3`)}${lastFix}`);
	out.push(p.rule(inner));
	out.push(`   ${p.accentB("Merge")}     ${mergeSeg(rec, p)}`);
	if (rec.salientSummary) {
		out.push("");
		for (const l of wrapWords(rec.salientSummary, inner - 4, p)) out.push(`   ${p.dim(l)}`);
	}
	return out;
}

// ──────────────────────────────────────────────────────────────────────────────────
// Merge gate (overlay) — copy/opções/decisão. Padrão do showPlanProposal.

export type MergeChoice = { kind: "merge" } | { kind: "cancel" } | { kind: "leave_open" };

export interface MergeOption {
	value: "merge" | "cancel" | "leave_open";
	label: string;
	description: string;
}

export const MERGE_OPTIONS: readonly MergeOption[] = [
	{ value: "merge", label: "Merge (squash)", description: "gh pr merge --squash — transitions the linked Linear/Jira issue" },
	{ value: "cancel", label: "Cancel (close + delete branch)", description: "gh pr close --delete-branch — abandons this PR" },
	{ value: "leave_open", label: "Leave open", description: "keep the PR open; a human merges later" },
];

/** Linhas-resumo do overlay de merge (CI + issue + mergeability). */
export function mergeGateSummaryLines(rec: DeliveryRecord): string[] {
	const green = rec.ci.state === "passed";
	const ci = green ? "✓ CI all green" : `⚠ CI ${rec.ci.state}`;
	const issues = [...rec.linkedIssues.linearIssueIds, ...rec.linkedIssues.jiraIssueKeys];
	const closes = issues.length ? ` · Closes ${issues.join(", ")}` : "";
	return [`${rec.prTitle ?? "(untitled PR)"}`, `${ci} · mergeable${closes}`, rec.prUrl ?? ""].filter((l) => l !== "");
}

/** Mensagem injetada de volta ao agente após a decisão humana (ele executa o gh). */
export function mergeDecisionMessage(featureId: string, choice: MergeChoice): string {
	const head = `[harness-deliver] Human merge gate decision for feature "${featureId}":`;
	if (choice.kind === "merge") {
		return `${head} MERGE. Run \`gh pr merge --squash\` (honor harness.md merge strategy), confirm the linked Linear/Jira issue transitioned, then call \`store_delivery\` with state "merged" and finish the deliver step (return to orchestrator).`;
	}
	if (choice.kind === "cancel") {
		return `${head} CANCEL. Run \`gh pr close --delete-branch\`, then call \`store_delivery\` with state "cancelled" and finish the deliver step (return to orchestrator).`;
	}
	return `${head} LEAVE OPEN. Do not merge. Call \`store_delivery\` with state "open" and finish the deliver step (return to orchestrator); a human will merge later.`;
}
