/**
 * Plan — a fila de tasks de uma feature (o analog do features.json do modelo de referência, em escopo
 * feature). A `harness-feature-converge` (LLM) autora feature.md + contract.md (markdown, humano)
 * e CHAMA `store_plan` no fim com as tasks estruturadas + os ids das assertions do
 * contract; o TS (confiável) valida a INVARIANTE DE COBERTURA (cada assertion reivindicada
 * por exatamente uma task) e persiste:
 *   - plan.json   (a fila canônica que o FeatureRunner consome)
 *   - status.json (assertions → pending; o harness-qa-validator escreve depois)
 *
 * Espelha store_profile / store_agent_readiness_report: o modelo autora, a tool valida+grava.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type FeatureRun, grantRetryBudget, planFeatureRun, STEP_ATTEMPT_BUDGET } from "./feature-runner.ts";
import { appendProgress, runDir } from "./handoff.ts";

export interface Task {
	id: string;
	description: string;
	/** worker skill do PROFILE (.harness/profile/skills/<skillName>). */
	skillName: string;
	/** assertion IDs do contract que esta task COMPLETA. */
	fulfills: string[];
	preconditions?: string[];
	expectedBehavior?: string[];
}

export interface Plan {
	featureId: string;
	tasks: Task[];
	/** todos os ids de assertion do contract.md (pra checar cobertura). */
	assertions: string[];
	createdAt: string;
}

export type AssertionStatus = "pending" | "passed" | "failed";
export interface PlanStatus {
	featureId: string;
	assertions: Record<string, AssertionStatus>;
}

/**
 * Escrita atómica (tmp + rename): um hard kill a meio de um writeFileSync truncava o JSON —
 * feature-run.json corrupto fazia o loader reconstruir a run DO ZERO por cima de trabalho
 * já commitado. rename é atómico no mesmo filesystem.
 */
export function writeJsonAtomic(file: string, data: unknown, pretty = true): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, pretty ? 2 : undefined)}\n`);
	fs.renameSync(tmp, file);
}

function planPath(cwd: string, featureId: string): string {
	return path.join(runDir(cwd, featureId), "plan.json");
}
function statusPath(cwd: string, featureId: string): string {
	return path.join(runDir(cwd, featureId), "status.json");
}

export interface PlanCheck {
	ok: boolean;
	issues: string[];
}

/**
 * Valida a estrutura + a invariante de cobertura (a "coverage gate" do orchestrator):
 * toda assertion do contract é reivindicada por EXATAMENTE uma task — sem órfãs, sem
 * duplicatas. Tasks foundational podem ter fulfills vazio.
 */
export function validatePlan(plan: Plan): PlanCheck {
	const issues: string[] = [];
	if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) issues.push("plan has no tasks");
	const seen = new Set<string>();
	for (const t of plan.tasks ?? []) {
		if (!t.id) issues.push("a task is missing id");
		else if (seen.has(t.id)) issues.push(`duplicate task id: ${t.id}`);
		else seen.add(t.id);
		if (!t.skillName) issues.push(`task ${t.id || "?"} is missing skillName`);
		if (!t.description) issues.push(`task ${t.id || "?"} is missing description`);
		if (!Array.isArray(t.fulfills)) issues.push(`task ${t.id || "?"} fulfills must be an array`);
	}
	// cobertura: cada assertion reivindicada por exatamente uma task
	const claims = new Map<string, string[]>(); // assertionId -> taskIds
	for (const t of plan.tasks ?? []) {
		for (const a of t.fulfills ?? []) {
			claims.set(a, [...(claims.get(a) ?? []), t.id]);
		}
	}
	const assertionSet = new Set(plan.assertions ?? []);
	for (const [a, tasks] of claims) {
		if (!assertionSet.has(a)) issues.push(`task(s) ${tasks.join(",")} fulfill unknown assertion: ${a}`);
		if (tasks.length > 1) issues.push(`assertion ${a} claimed by multiple tasks: ${tasks.join(",")}`);
	}
	for (const a of assertionSet) {
		if (!claims.has(a)) issues.push(`assertion ${a} is orphaned (no task fulfills it)`);
	}
	return { ok: issues.length === 0, issues };
}

export type StorePlanResult = { ok: true; plan: Plan } | { ok: false; issues: string[] };

/** Valida e persiste plan.json + status.json (assertions pending). Recusa (sem gravar) se inválido. */
export function storePlan(cwd: string, plan: Plan): StorePlanResult {
	const check = validatePlan(plan);
	if (!check.ok) return { ok: false, issues: check.issues };
	const dir = runDir(cwd, plan.featureId);
	fs.mkdirSync(dir, { recursive: true });
	writeJsonAtomic(planPath(cwd, plan.featureId), plan);
	// MERGE, não clobber: re-armazenar o plano mid-run (revisão de converge) preservava tudo
	// `pending` e apagava verdicts `passed` já conquistados → completion gate deadlock.
	const prior = readStatus(cwd, plan.featureId);
	const status: PlanStatus = { featureId: plan.featureId, assertions: {} };
	for (const a of plan.assertions) status.assertions[a] = prior?.assertions[a] ?? "pending";
	writeJsonAtomic(statusPath(cwd, plan.featureId), status);
	appendProgress(cwd, plan.featureId, "plan_stored", { tasks: plan.tasks.length, assertions: plan.assertions.length });
	return { ok: true, plan };
}

export function readPlan(cwd: string, featureId: string): Plan | null {
	try {
		return JSON.parse(fs.readFileSync(planPath(cwd, featureId), "utf8")) as Plan;
	} catch {
		return null;
	}
}

export interface CompletionGateResult {
	ok: boolean;
	/** assertions ainda não `passed` (pending/failed) — vazio quando ok. */
	failing: string[];
}

/**
 * Completion gate (o "end-of-mission gate" do droid, docs 02: mission completa ⇔ toda assertion
 * do contrato `passed`): o run só pode virar `completed` quando o status.json diz que TODAS as
 * assertions passaram. Sem status.json / sem assertions → falha (contrato não verificado — o
 * ship gate ainda não escreveu). O análogo do README-gate do droid é o próprio ship gate
 * (deliver documenta a feature no PR) + a regra de docs do orchestrator SKILL.
 */
export function completionGate(cwd: string, featureId: string): CompletionGateResult {
	const status = readStatus(cwd, featureId);
	if (!status) return { ok: false, failing: ["(no status.json — contract not verified)"] };
	const entries = Object.entries(status.assertions);
	if (entries.length === 0) return { ok: false, failing: ["(no assertions in status.json)"] };
	const failing = entries.filter(([, v]) => v !== "passed").map(([k]) => k);
	return { ok: failing.length === 0, failing };
}

/**
 * Garante que os ids existem no status.json (novos = `pending`). Fix tasks com `fulfills` de
 * assertions NOVAS (bug reports) ficavam invisíveis ao completion gate sem este merge — e o
 * qa-validator só testa o que está no status.
 */
export function ensureAssertions(cwd: string, featureId: string, ids: string[]): void {
	if (ids.length === 0) return;
	const status = readStatus(cwd, featureId);
	if (!status) return;
	let changed = false;
	for (const id of ids) {
		if (!(id in status.assertions)) {
			status.assertions[id] = "pending";
			changed = true;
		}
	}
	if (changed) writeJsonAtomic(statusPath(cwd, featureId), status);
}

export function readStatus(cwd: string, featureId: string): PlanStatus | null {
	try {
		return JSON.parse(fs.readFileSync(statusPath(cwd, featureId), "utf8")) as PlanStatus;
	} catch {
		return null;
	}
}

/** Ids de task com evento `task_completed` no progress_log (1 worker por feature: o sinal por-task
 * vem do tool `next_task` (fronteiras) + do runner ao completar o impl step, não de N steps). */
function completedTaskIds(cwd: string, featureId: string): Set<string> {
	const ids = new Set<string>();
	try {
		const raw = fs.readFileSync(path.join(runDir(cwd, featureId), "progress_log.jsonl"), "utf8");
		for (const ln of raw.split("\n")) {
			if (!ln.trim()) continue;
			try {
				const e = JSON.parse(ln) as { event?: string; taskId?: unknown };
				if (e.event === "task_completed" && e.taskId != null) ids.add(String(e.taskId));
			} catch {
				// linha não-JSON
			}
		}
	} catch {
		// sem progress_log
	}
	return ids;
}

/**
 * Progresso do feature run pro `/harness status`: tasks completas/total + assertions
 * passed/failed/total (do status.json). null se a feature não convergiu (sem plan). tasksDone vem
 * dos eventos task_completed (paridade nos dois paths: 1 worker por feature, sem N steps).
 */
export function featureProgress(cwd: string, featureId: string): import("./mode.ts").ProgressSummary | null {
	const plan = readPlan(cwd, featureId);
	if (!plan) return null;
	const status = readStatus(cwd, featureId);
	const done = completedTaskIds(cwd, featureId);
	const tasksDone = plan.tasks.filter((t) => done.has(t.id)).length;
	let assertionsTotal = 0;
	let assertionsPassed = 0;
	let assertionsFailed = 0;
	if (status) {
		for (const v of Object.values(status.assertions)) {
			assertionsTotal++;
			if (v === "passed") assertionsPassed++;
			else if (v === "failed") assertionsFailed++;
		}
	}
	return { tasksTotal: plan.tasks.length, tasksDone, assertionsTotal, assertionsPassed, assertionsFailed };
}

/**
 * A ponte converge → runner: lê plan.json e constrói o FeatureRun. Paridade droid: as tasks viram
 * a lista INTERNA de UM step de implementação (1 worker por feature) — passa os campos ricos
 * (description/preconditions/expectedBehavior) pra o bootstrap apresentar a fila ao worker. null se não há plan.
 */
export function buildFeatureRun(cwd: string, featureId: string, now?: () => string): FeatureRun | null {
	const plan = readPlan(cwd, featureId);
	if (!plan) return null;
	return planFeatureRun(
		featureId,
		plan.tasks.map((t) => ({ id: t.id, skillName: t.skillName, description: t.description, fulfills: t.fulfills, preconditions: t.preconditions, expectedBehavior: t.expectedBehavior })),
		now,
	);
}

/** Estado runtime do FeatureRunner headless (state.json analog) — persistência pro resume. */
function featureRunPath(cwd: string, featureId: string): string {
	return path.join(runDir(cwd, featureId), "feature-run.json");
}
export function writeFeatureRun(cwd: string, run: FeatureRun): void {
	fs.mkdirSync(runDir(cwd, run.featureId), { recursive: true });
	writeJsonAtomic(featureRunPath(cwd, run.featureId), run);
}
export function readFeatureRun(cwd: string, featureId: string): FeatureRun | null {
	try {
		return JSON.parse(fs.readFileSync(featureRunPath(cwd, featureId), "utf8")) as FeatureRun;
	} catch {
		return null;
	}
}

export interface ResumePlan {
	run: FeatureRun;
	/** true = continuar um run pausado GRACEFULLY (re-attacha o in_progress). */
	resume: boolean;
}

/**
 * Carrega o feature-run persistido p/ CONTINUAR, ou constrói fresh do plano (analog do
 * "qual resume" do start_mission_run, doc 07). A distinção graceful×hard sai do estado em disco:
 *   - status "paused"  → saída GRACEFUL (abort/402) → resume:true, re-attacha o worker in_progress;
 *   - status "running" congelado (HARD kill, sem hook) → resume:false → o runLoop reclama o órfão
 *     (in_progress → pending, re-roda do zero sobre os commits que o worker morto já fez);
 *   - sem run persistido → fresh do plan.json.
 * Concede budget fresco quando a pausa anterior foi por esgotamento (grantRetryBudgetForExhaustedFeatures).
 */
export function loadOrBuildFeatureRun(cwd: string, featureId: string, now?: () => string): ResumePlan | null {
	const existing = readFeatureRun(cwd, featureId);
	// Arquivo EXISTE mas não parseia → quarentena (preserva a evidência) em vez de rebuild
	// silencioso: reconstruir do zero re-executaria steps já commitados sem nenhum rasto do porquê.
	if (!existing) {
		const file = path.join(runDir(cwd, featureId), "feature-run.json");
		if (fs.existsSync(file)) {
			try {
				fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
			} catch {
				/* melhor-esforço */
			}
			appendProgress(cwd, featureId, "feature_run_corrupt_quarantined", { file });
		}
	}
	const run = existing ?? buildFeatureRun(cwd, featureId, now);
	if (!run) return null;
	const resume = existing?.status === "paused";
	if (existing?.pauseReason === "step_retry_limit_exceeded") {
		// Re-grant DISCIPLINADO: só a steps esgotados contra o budget EFETIVO (base + bônus já dado
		// — comparar com a constante re-concedia +5 a cada resume) e com teto de bônus total (2× o
		// budget): um step que estourou 3 ciclos não se resolve com mais budget, só com fix tasks.
		for (const s of run.steps) {
			const bonus = run.retryBudgetBonus?.[s.id] ?? 0;
			if (s.attempts >= STEP_ATTEMPT_BUDGET + bonus && bonus < STEP_ATTEMPT_BUDGET * 2) grantRetryBudget(run, s.id);
		}
	}
	return { run, resume };
}
