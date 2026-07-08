/**
 * Run control — a lógica PURA do tool `run_feature` (o análogo do `start_mission_run` do droid,
 * doc 07 §6). Três modos de resume (1:1 com a referência):
 *
 *   default                      → continua o worker pausado (re-attacha a última sessão);
 *   restartFeature: true         → requeue (in_progress → pending) e worker NOVO do zero;
 *   resumeWorkerSessionId: "…"   → re-attacha uma sessão ESPECÍFICA escolhida (o "selecionar
 *                                  o worker e fazer ele voltar").
 *
 * Também insere fix tasks (o análogo do orchestrator editar features.json antes do resume) e
 * monta o report que o tool devolve ao orchestrator. Puro/testável — sem IO além dos tipos.
 */
import type { FeatureRun, PlanTaskRef } from "./feature-runner.ts";
import { insertFixTask } from "./feature-runner.ts";
import { dismissalRef, type PersistedHandoff } from "./handoff.ts";

export interface ResumeModeOpts {
	/** requeue: re-roda o step in_progress do zero com um worker novo (droid: restartFeature). */
	restartFeature?: boolean;
	/** re-attacha esta sessão específica (droid: resumeWorkerSessionId). */
	resumeWorkerSessionId?: string;
}

export interface ResumeMode {
	/** o `resume` a passar pro runLoop (re-attach vs fresh/orphan-cleanup). */
	resume: boolean;
	note?: string;
}

/**
 * Aplica o modo de resume ao run (muta) e devolve o `resume` efetivo do runLoop.
 * `baseResume` = a distinção graceful×hard que loadOrBuildFeatureRun já derivou do disco.
 */
export function applyResumeMode(run: FeatureRun, baseResume: boolean, opts: ResumeModeOpts = {}): ResumeMode {
	if (opts.restartFeature) {
		// droid: TDT — reset in_progress → pending; o runLoop (resume:false) roda do zero.
		let reset = 0;
		for (const s of run.steps) {
			if (s.status === "in_progress") {
				s.status = "pending";
				reset++;
			}
		}
		return { resume: false, note: reset > 0 ? "feature step requeued — fresh worker will re-run it" : "nothing in progress — fresh start" };
	}
	if (opts.resumeWorkerSessionId) {
		const id = opts.resumeWorkerSessionId;
		const step = run.steps.find((s) => s.workerSessionIds?.includes(id));
		if (!step) return { resume: baseResume, note: `worker session "${id}" not found in this run — default resume` };
		// NUNCA regride um step concluído: re-attachar uma sessão de trabalho já commitado re-executaria
		// os commits e duplicaria task_completed. Quem quer re-rodar usa restartFeature.
		if (step.status === "completed") return { resume: baseResume, note: `worker session "${id}" belongs to completed step "${step.id}" — refusing to regress it (use restartFeature to re-run)` };
		// re-attacha a sessão ESCOLHIDA: vira a última (o runLoop usa .at(-1)) e o step fica in_progress.
		step.workerSessionIds = [...step.workerSessionIds.filter((w) => w !== id), id];
		step.status = "in_progress";
		return { resume: true, note: `re-attaching worker session "${id}" on step "${step.id}"` };
	}
	return { resume: baseResume };
}

/** Insere fix tasks acima do ship gate (dedup por id de step já existente). Retorna os ids inseridos. */
export function insertFixTasks(run: FeatureRun, tasks: PlanTaskRef[]): string[] {
	const existing = new Set(run.steps.map((s) => s.id));
	const inserted: string[] = [];
	for (const t of tasks) {
		if (!t.id || !t.skillName || existing.has(t.id)) continue;
		insertFixTask(run, t);
		existing.add(t.id);
		inserted.push(t.id);
	}
	return inserted;
}

const STEP_ICON: Record<string, string> = { completed: "✓", in_progress: "●", pending: "○", cancelled: "✗" };

/**
 * Report do run pro orchestrator (o retorno do tool): status + steps + handoffs relevantes +
 * a próxima ação recomendada por status. `handoffs` = o handoff mais recente por step (quando há).
 */
export function buildRunReport(run: FeatureRun, handoffs: Map<string, PersistedHandoff>, extra: { note?: string; insertedFixTasks?: string[]; dismissed?: ReadonlySet<string> } = {}): string {
	const dismissed = extra.dismissed ?? new Set<string>();
	const lines: string[] = [];
	lines.push(`Feature run "${run.featureId}": status=${run.status}${run.pauseReason ? ` (${run.pauseReason})` : ""}`);
	if (extra.note) lines.push(`Mode: ${extra.note}`);
	if (extra.insertedFixTasks?.length) lines.push(`Fix tasks inserted above the gate: ${extra.insertedFixTasks.join(", ")}`);
	lines.push("", "Steps:");
	for (const s of run.steps) {
		const icon = STEP_ICON[s.status] ?? "?";
		const ws = s.workerSessionIds?.at(-1);
		lines.push(`  ${icon} ${s.id} [${s.kind}] attempts=${s.attempts}${ws ? ` lastWorkerSession=${ws}` : ""}`);
	}
	const interesting = run.steps.filter((s) => s.status !== "completed" && handoffs.has(s.id));
	if (interesting.length > 0) {
		lines.push("", "Latest handoffs (non-completed steps):");
		for (const s of interesting) {
			const h = handoffs.get(s.id);
			if (!h) continue;
			lines.push(`  · ${s.id}: successState=${h.successState} returnToOrchestrator=${h.returnToOrchestrator}`);
			const summary = h.handoff?.salientSummary || h.handoff?.whatWasImplemented;
			if (summary) lines.push(`    summary: ${summary}`);
			if (h.handoff?.whatWasLeftUndone) lines.push(`    leftUndone: ${h.handoff.whatWasLeftUndone}`);
			// discoveredIssues já dispensados (dismiss_handoff_items) NÃO ressurgem — só os pendentes.
			let dismissedHere = 0;
			for (const d of h.handoff?.discoveredIssues ?? []) {
				if (dismissed.has(dismissalRef(d.description))) {
					dismissedHere++;
					continue;
				}
				lines.push(`    issue [${d.severity}]: ${d.description}`);
			}
			if (dismissedHere > 0) lines.push(`    (${dismissedHere} issue(s) previously dismissed — hidden)`);
		}
	}
	lines.push("", nextActionFor(run));
	return lines.join("\n");
}

function nextActionFor(run: FeatureRun): string {
	switch (run.status) {
		case "completed":
			return "Next: verify status.json (all assertions passed) and summarize what shipped.";
		case "orchestrator_turn":
			return "Next: analyze the handoff (delegate root-cause to Agent subagents), then call run_feature again — with fixTasks:[…] if a fix is needed (inserted above the ship gate).";
		case "paused":
			switch (run.pauseReason) {
				case "usage_limit":
					return "Next: usage/billing limit hit — inform the user; call run_feature again after it's resolved (it re-attaches the same worker session).";
				case "step_retry_limit_exceeded":
					return "Next: attempt budget exhausted — analyze WHY it keeps failing before retrying; calling run_feature again grants a fresh budget (do not loop blindly).";
				case "aborted":
					return "Next: run paused (user/shutdown). Call run_feature to resume the same worker; restartFeature:true for a fresh one; resumeWorkerSessionId to pick a specific session.";
				default:
					return "Next: run paused. Call run_feature to resume.";
			}
		default:
			return "Next: run still in progress.";
	}
}
