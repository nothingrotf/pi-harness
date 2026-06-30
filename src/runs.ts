/**
 * Runs — enumera os feature runs em `.harness/runs/*` pro picker "Runs" (docs/03-tui.md §6.1),
 * o rebrand do "Missions picker" do Droid. Cada run vira um RunSummary leve (estado + progresso
 * de assertions + updated). Lógica pura de IO, testável com dir temporário (test/runs.test.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type AssertionCounts, type ProgressCounts, readControlModel, relTime, type RunState, stateIcon, stateLabel } from "./control-model.ts";
import { readFeatureRun, readPlan } from "./plan.ts";

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
}

/** Os runs ordenados por updatedAt desc (mais recente primeiro). */
export function listRuns(cwd: string, opts: { activeFeatureId?: string } = {}): RunSummary[] {
	return listRunIds(cwd)
		.map((id) => summarize(cwd, id, opts.activeFeatureId))
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/**
 * Linha do picker pra um run (PURA, testável): label = marcador `●` (run atual) + ícone
 * de estado + featureId; description = estado · assertions passed/total (ou tasks) · updated.
 */
export function runRow(run: RunSummary, now: number): { label: string; description: string } {
	const marker = run.current ? "● " : "  ";
	const label = `${marker}${stateIcon(run.state)} ${run.featureId}`;
	const parts = [stateLabel(run.state)];
	if (run.counts.total > 0) parts.push(`${run.counts.completed}/${run.counts.total}${run.counts.estimate > 0 ? ` [+${run.counts.estimate}]` : ""}`);
	const rel = relTime(run.updatedAt ?? undefined, now);
	if (rel) parts.push(rel);
	return { label, description: parts.join(" · ") };
}
