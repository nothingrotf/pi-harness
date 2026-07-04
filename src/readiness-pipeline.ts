/**
 * Pipeline de criação do snapshot de readiness — os estágios determinísticos em
 * volta do auditor LLM (skills/harness-readiness-audit). Espelha o create→ensure→validate
 * →store do referência (modelo de referência) adaptado pra storage LOCAL.
 *
 *   ensure   (este módulo)         — preflight: inputs existem/graváveis
 *   create   (skills/harness-readiness-audit) — o auditor LLM produz o report (5 fases)
 *   validate (readiness.ts)        — validateReport: contrato estrito
 *   store    (este módulo)         — grava readiness.json + append readiness.jsonl
 *
 * Tudo aqui é fs puro (sem dep do Pi) → testável com tmp dir.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { computeFingerprint } from "./fingerprint.ts";
import { buildSnapshot, type ReadinessReport, type ReadinessSnapshot, summarizeSnapshot, validateReport } from "./readiness.ts";
import { writeJsonAtomic } from "./plan.ts";

export function profileDir(cwd: string): string {
	return path.join(cwd, ".harness", "profile");
}
export function snapshotPath(cwd: string): string {
	return path.join(profileDir(cwd), "readiness.json");
}
export function auditLogPath(cwd: string): string {
	return path.join(profileDir(cwd), "readiness.jsonl");
}
export function runStatePath(cwd: string): string {
	return path.join(profileDir(cwd), "readiness-run.json");
}

/** Lê o record do runner (state.json analog), ou null. */
export function readRun<T = unknown>(cwd: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(runStatePath(cwd), "utf8")) as T;
	} catch {
		return null;
	}
}

/** Grava o record do runner (persistência determinística do estado). */
export function writeRun(cwd: string, run: unknown): void {
	try {
		fs.mkdirSync(profileDir(cwd), { recursive: true });
		writeJsonAtomic(runStatePath(cwd), run);
	} catch {
		// best-effort
	}
}

/**
 * Fingerprint determinístico do repo (Fatia 2): hash de conteúdo de lockfiles +
 * .agents/rules/ + AGENTS.md + docs/adr/ + configs de tooling (ver fingerprint.ts).
 * Gravado no readiness.json; o gate compara com o atual pra detectar drift (stale).
 */
export function repoFingerprint(cwd: string): string {
	return computeFingerprint(cwd);
}

/** Lê o snapshot do profile, ou null se ausente/corrompido. */
export function readSnapshot(cwd: string): ReadinessSnapshot | null {
	try {
		return JSON.parse(fs.readFileSync(snapshotPath(cwd), "utf8")) as ReadinessSnapshot;
	} catch {
		return null;
	}
}

/**
 * auditSucceeded canonico pro ReadinessRunner: snapshot válido E mais novo que o início do step.
 * Sem a frescura, um readiness.json PRÉ-EXISTENTE fazia um child que não gravou nada "passar".
 */
export function auditSnapshotFresh(cwd: string, sinceIso?: string): boolean {
	const snap = readSnapshot(cwd);
	if (!snap) return false;
	if (!sinceIso) return true;
	return typeof snap.generatedAt === "string" && snap.generatedAt >= sinceIso;
}

export interface EnsureResult {
	ok: boolean;
	issues: string[];
}

/**
 * Estágio ENSURE (preflight) — confere que dá pra rodar a auditoria:
 * é um repo git, e o .harness/profile é criável/gravável. Cria o dir se faltar.
 */
export function ensureReadinessInputs(cwd: string): EnsureResult {
	const issues: string[] = [];
	if (!fs.existsSync(path.join(cwd, ".git"))) {
		issues.push("not a git repository (no .git) — readiness evaluates the repo");
	}
	try {
		fs.mkdirSync(profileDir(cwd), { recursive: true });
	} catch (e) {
		issues.push(`could not create .harness/profile: ${(e as Error).message}`);
	}
	return { ok: issues.length === 0, issues };
}

/** Evento da trilha auditável readiness.jsonl. */
export interface AuditEvent {
	ts: string;
	ev: string;
	[k: string]: unknown;
}

/** Append append-only na trilha readiness.jsonl (best-effort). */
export function appendAudit(cwd: string, ev: string, extra: Record<string, unknown> = {}): void {
	try {
		fs.mkdirSync(profileDir(cwd), { recursive: true });
		const row: AuditEvent = { ts: new Date().toISOString(), ev, ...extra };
		fs.appendFileSync(auditLogPath(cwd), `${JSON.stringify(row)}\n`);
	} catch {
		// trilha é best-effort; não derruba o store por causa dela
	}
}

export interface StoreResult {
	ok: boolean;
	issues: string[];
	snapshot?: ReadinessSnapshot;
	summary?: string;
}

/**
 * Estágio STORE — valida o report (contrato estrito), computa level/passRate,
 * grava readiness.json e registra na trilha. Recusa relatórios inválidos
 * (1:1 com o store_agent_readiness_report do referência, que rejeita schema ruim).
 */
export function storeReport(cwd: string, report: ReadinessReport, fingerprint: string): StoreResult {
	const v = validateReport(report);
	if (!v.ok) {
		appendAudit(cwd, "report_rejected", { issues: v.issues.slice(0, 10), issueCount: v.issues.length });
		return { ok: false, issues: v.issues };
	}
	const snapshot = buildSnapshot(report, { fingerprint });
	const ensured = ensureReadinessInputs(cwd);
	// ensure pode reclamar de "sem .git" mas ainda assim gravamos o snapshot;
	// só falha de verdade se o dir não pôde ser criado.
	try {
		writeJsonAtomic(snapshotPath(cwd), snapshot);
	} catch (e) {
		const issue = `failed to write readiness.json: ${(e as Error).message}`;
		appendAudit(cwd, "store_failed", { issue });
		return { ok: false, issues: [issue, ...ensured.issues] };
	}
	appendAudit(cwd, "snapshot_stored", { level: snapshot.level, passRate: snapshot.passRate, fingerprint });
	return { ok: true, issues: [], snapshot, summary: summarizeSnapshot(snapshot) };
}
