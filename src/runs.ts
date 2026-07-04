/**
 * Runs — enumera os feature runs em `.harness/runs/*` pro picker "Runs" (docs/03-tui.md §6.1),
 * o rebrand do "Missions picker" do Droid. Cada run vira um RunSummary leve (estado + progresso
 * de assertions + updated). Lógica pura de IO, testável com dir temporário (test/runs.test.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type AssertionCounts, type ProgressCounts, readControlModel, relTime, type RunState, stateIcon, stateLabel } from "./control-model.ts";
import { readFeatureRun, readPlan, writeJsonAtomic } from "./plan.ts";

export interface RunSummary {
	featureId: string;
	state: RunState;
	/** segmentos da barra (work items = tasks + ship gate). */
	counts: ProgressCounts;
	assertions: AssertionCounts;
	tasksDone: number;
	tasksTotal: number;
	/** ISO do último update (feature-run.json.updatedAt → plan.createdAt → mtime do dir). */
	updatedAt: string | null;
	/** o run atualmente ativo na sessão (marcado `●`); setado pelo caller. */
	current: boolean;
	/** erro ao carregar ESTE run (dir corrompido) — a linha degrada, o picker não quebra (Droid: per-row load errors). */
	loadError?: string;
}

function runsRoot(cwd: string): string {
	return path.join(cwd, ".harness", "runs");
}

/** Lista os ids de feature (subdirs de .harness/runs que têm plan.json). */
export function listRunIds(cwd: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runsRoot(cwd), { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.filter((id) => fs.existsSync(path.join(runsRoot(cwd), id, "plan.json")));
}

function summarize(cwd: string, featureId: string, activeFeatureId?: string): RunSummary {
	// Per-row load errors (Droid missions picker): um run corrompido degrada A LINHA (⚠ + motivo),
	// nunca derruba o picker inteiro. O try/catch envolve toda a derivação deste run.
	try {
		// Reusa o modelo completo (mesma derivação do overlay: estado + counts da barra a partir
		// dos sinais em disco) — garante que o picker mostra o MESMO progresso que o Feature Control.
		const model = readControlModel(cwd, featureId);
		const plan = readPlan(cwd, featureId);
		const run = readFeatureRun(cwd, featureId);
		let updatedAt: string | null = run?.updatedAt ?? plan?.createdAt ?? null;
		if (!updatedAt) {
			try {
				updatedAt = fs.statSync(path.join(runsRoot(cwd), featureId)).mtime.toISOString();
			} catch {
				updatedAt = null;
			}
		}
		return {
			featureId,
			state: model?.state ?? "unknown",
			counts: model?.counts ?? { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 },
			assertions: model?.assertions ?? { passed: 0, failed: 0, pending: 0, total: 0 },
			tasksDone: model?.tasksDone ?? 0,
			tasksTotal: model?.tasksTotal ?? 0,
			updatedAt,
			current: featureId === activeFeatureId,
		};
	} catch (e) {
		return {
			featureId,
			state: "unknown",
			counts: { completed: 0, pending: 0, estimate: 0, cancelled: 0, total: 0 },
			assertions: { passed: 0, failed: 0, pending: 0, total: 0 },
			tasksDone: 0,
			tasksTotal: 0,
			updatedAt: null,
			current: featureId === activeFeatureId,
			loadError: (e as Error).message || "failed to load run",
		};
	}
}

/** Os runs ordenados por updatedAt desc (mais recente primeiro). */
export function listRuns(cwd: string, opts: { activeFeatureId?: string } = {}): RunSummary[] {
	return listRunIds(cwd)
		.map((id) => summarize(cwd, id, opts.activeFeatureId))
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rename (o Ctrl+R inline do missions picker do Droid) — renomeia o DIRETÓRIO do run.

export type RenameResult = { ok: true; featureId: string } | { ok: false; reason: string };

/** id válido de run: slug filesystem-safe (mesma família do featureIdFromRequest). */
export function isValidRunId(id: string): boolean {
	return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && id.length <= 80 && !id.startsWith(".");
}

/**
 * Renomeia um run (`.harness/runs/<old>` → `<new>`): valida o novo id, recusa colisão/ausente.
 * PURA de política (fs only) — o caller (view/extensão) decide se o run pode ser renomeado
 * (ex.: nunca o run ATIVO no processo). O featureId dos artefatos internos (plan.json etc.)
 * é REESCRITO onde é usado como chave (plan/status/feature-run), pra manter a coerência.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function renameRun(cwd: string, oldId: string, newId: string): RenameResult {
	const next = newId.trim();
	if (!next) return { ok: false, reason: "empty name" };
	if (!isValidRunId(next)) return { ok: false, reason: "invalid name (use letters, digits, - _ .)" };
	// oldId também passa pelo guard: a função é exportada e um id com separadores renomearia FORA de runs/
	if (!isValidRunId(oldId)) return { ok: false, reason: "invalid source id" };
	if (next === oldId) return { ok: true, featureId: oldId };
	const from = path.join(runsRoot(cwd), oldId);
	const to = path.join(runsRoot(cwd), next);
	if (!fs.existsSync(from)) return { ok: false, reason: `run "${oldId}" not found` };
	if (fs.existsSync(to)) return { ok: false, reason: `a run named "${next}" already exists` };
	// Não renomeia um run A CORRER (incl. noutro processo — headless): o runner continuaria a
	// persistir no path antigo e o estado órfão divergiria silenciosamente. O sinal é o run.lock
	// com pid VIVO (status "running" persistido também sobra após hard-kill — esse pode renomear).
	try {
		const lock = JSON.parse(fs.readFileSync(path.join(from, "run.lock"), "utf8")) as { pid?: number };
		if (typeof lock.pid === "number" && isPidAlive(lock.pid)) return { ok: false, reason: `run is active in another process (pid ${lock.pid}) — pause it before renaming` };
	} catch {
		// sem lock/corrompido — segue (rename seguro)
	}
	try {
		fs.renameSync(from, to);
	} catch (e) {
		return { ok: false, reason: (e as Error).message };
	}
	// Reescreve o featureId nos artefatos-chave (tolerante: um ficheiro ausente/corrompido não desfaz o rename).
	for (const f of ["plan.json", "status.json", "feature-run.json"]) {
		const p = path.join(to, f);
		try {
			const obj = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
			if (obj && typeof obj === "object" && "featureId" in obj) {
				obj.featureId = next;
				writeJsonAtomic(p, obj);
			}
		} catch {
			// ausente/corrompido — segue
		}
	}
	return { ok: true, featureId: next };
}

/**
 * Linha do picker pra um run (PURA, testável): label = marcador `●` (run atual) + ícone
 * de estado + featureId; description = estado · assertions passed/total (ou tasks) · updated.
 */
export function runRow(run: RunSummary, now: number): { label: string; description: string } {
	const marker = run.current ? "● " : "  ";
	if (run.loadError) {
		// Linha degradada (Droid: per-row load error): ⚠ + motivo; o run continua selecionável? Não —
		// a description explica; o Enter no picker deve avisar (a view decide).
		return { label: `${marker}⚠ ${run.featureId}`, description: `load error: ${run.loadError}` };
	}
	const label = `${marker}${stateIcon(run.state)} ${run.featureId}`;
	const parts = [stateLabel(run.state)];
	if (run.counts.total > 0) parts.push(`${run.counts.completed}/${run.counts.total}${run.counts.estimate > 0 ? ` [+${run.counts.estimate}]` : ""}`);
	const rel = relTime(run.updatedAt ?? undefined, now);
	if (rel) parts.push(rel);
	return { label, description: parts.join(" · ") };
}
