/**
 * Run exec — o CORE reutilizável de "hand control to the runner" (o corpo do start_mission_run).
 * Usado por DUAS superfícies com a MESMA semântica:
 *   - o tool `run_feature` (o orchestrator no chat chama; BLOCKING no turno);
 *   - o Feature Control (tecla R/Resume — dispara direto, como o resume callback da mission view
 *     do droid), com o report voltando ao orchestrator via mensagem.
 *
 * Sempre: registra o run no run-registry (pause/steer de qualquer lugar), aplica o modo de
 * resume, insere fixTasks, spawna via RPC com model config enforced + onClient (steer), roda o
 * runLoop com gateSkip do config, e devolve o run final + o report textual.
 */
import { type FeatureRun, runLoop } from "./feature-runner.ts";
import { appendProgress, dismissedRefs, handoffOutcome, latestHandoff, type PersistedHandoff } from "./handoff.ts";
import { loadModelConfig, resolveChoice, roleForStep, skippedGateSkills } from "./model-config.ts";
import { appendFixTasksToPlan, completionGate, ensureAssertions, loadOrBuildFeatureRun, readPlan, writeFeatureRun } from "./plan.ts";
import { applyGateRoundGrant, applyResumeMode, buildRunReport, insertFixTasks, type ResumeModeOpts } from "./run-control.ts";
import { clearWorkerClient, registerRun, registerWorkerClient, unregisterRun } from "./run-registry.ts";
import { makeRpcSpawn } from "./rpc-worker.ts";
import { featureUsageFromRun, sessionUsageFromFile } from "./usage.ts";

const HEARTBEAT_MS = 180000; // doc 07: FTi

export interface ExecuteRunOpts extends ResumeModeOpts {
	/** fix tasks a inserir ACIMA do ship gate antes de rodar (preempção). */
	fixTasks?: { id: string; skillName: string; description?: string; fulfills?: string[]; preconditions?: string[]; expectedBehavior?: string[] }[];
	/** modelo do parent (fallback dos roles) — opcional. */
	model?: string;
	/** session file do orchestrator VIVO (ctx.sessionManager.getSessionFile()) — inclui o custo
	 * cumulativo do líder no run report (docs/06 §2 confound #1). Opcional (headless não tem). */
	orchestratorSessionFile?: string;
}

export type ExecuteRunResult = { ok: true; run: FeatureRun; report: string } | { ok: false; error: "already_running" | "no_plan" | "no_run"; message: string };

/** Executa (ou resume) o run de uma feature. BLOCKING até o runner devolver controle. */
export async function executeFeatureRun(cwd: string, featureId: string, opts: ExecuteRunOpts = {}): Promise<ExecuteRunResult> {
	if (!readPlan(cwd, featureId)) {
		return { ok: false, error: "no_plan", message: `No plan.json for "${featureId}" — the feature isn't converged yet.` };
	}
	const rp = loadOrBuildFeatureRun(cwd, featureId);
	if (!rp) return { ok: false, error: "no_run", message: `Could not build a feature run for "${featureId}".` };
	const { run } = rp;
	const mode = applyResumeMode(run, rp.resume, opts);
	const grantNote = applyGateRoundGrant(run, opts.grantGateRound);
	const inserted = opts.fixTasks?.length ? insertFixTasks(run, opts.fixTasks) : [];
	if (inserted.length) {
		const fixes = (opts.fixTasks ?? []).filter((t) => inserted.includes(t.id));
		// Registra a fix no plan.json TAMBÉM: `next_task` só lê de lá, e sem isto o worker de fix cai
		// fora do loop e commita sem passar pelo commitGate (ver appendFixTasksToPlan).
		const planned = appendFixTasksToPlan(
			cwd,
			featureId,
			fixes.map((t) => ({ id: t.id, description: t.description ?? "", skillName: t.skillName, fulfills: t.fulfills ?? [], preconditions: t.preconditions, expectedBehavior: t.expectedBehavior })),
		);
		if (planned.issues.length) appendProgress(cwd, featureId, "fix_plan_append_failed", { fixTasks: inserted, issues: planned.issues });
		// Assertions novas trazidas por fix tasks (bug reports) entram no status.json como pending —
		// sem isto o completion gate nunca as vê e o qa-validator não as testa.
		ensureAssertions(cwd, featureId, fixes.flatMap((t) => t.fulfills ?? []));
	}

	const cfg = loadModelConfig(); // per-role model+effort (worker/validator) — ENFORCED nos children
	let controller: AbortController;
	try {
		controller = registerRun(featureId, cwd);
	} catch {
		return { ok: false, error: "already_running", message: `A run for "${featureId}" is already active. Pause it (/harness pause) or wait for it to return.` };
	}
	appendProgress(cwd, featureId, "run_started", { via: "runner", resume: mode.resume, fixTasks: inserted, ...(grantNote ? { gateRoundGranted: run.gateRoundBonus } : {}) });
	try {
		const spawn = makeRpcSpawn({
			featureId,
			model: opts.model,
			config: cfg,
			onClient: (client) => (client ? registerWorkerClient(featureId, client) : clearWorkerClient(featureId)),
		});
		const final = await runLoop(
			cwd,
			run,
			{
				spawn,
				persist: (r) => writeFeatureRun(cwd, r),
				log: (ev, extra) => appendProgress(cwd, featureId, ev, extra ?? {}),
				gateSkip: skippedGateSkills(cfg),
				// End-of-run gate (droid parity): só completa com TODAS as assertions `passed`.
				// Bypass quando o qa-validator (quem flipa status.json) foi pulado — senão deadlocka.
				completionGate: skippedGateSkills(cfg).has("harness-qa-validator") ? undefined : () => completionGate(cwd, featureId),
				// Grava o modelo EFETIVO por step no step_started (o que o child realmente recebe via --model).
				describeStepModel: (step) => resolveChoice(cfg, roleForStep(step), opts.model),
				// Reconciliação pós-HARD-kill: se a última sessão do step já gravou success em disco, NÃO re-roda.
				reconcileCompleted: (step) => {
					const wsid = step.workerSessionIds?.at(-1);
					return !!wsid && handoffOutcome(cwd, featureId, step.id, wsid).success;
				},
			},
			controller.signal,
			{ resume: mode.resume, heartbeatMs: HEARTBEAT_MS },
		);
		const handoffs = new Map<string, PersistedHandoff>();
		for (const s of final.steps) {
			const h = latestHandoff(cwd, featureId, s.id);
			if (h) handoffs.set(s.id, h);
		}
		return { ok: true, run: final, report: buildRunReport(final, handoffs, { note: mode.note, insertedFixTasks: inserted, dismissed: dismissedRefs(cwd, featureId), usage: featureUsageFromRun(cwd, final), leadUsage: sessionUsageFromFile(opts.orchestratorSessionFile) }) };
	} finally {
		unregisterRun(featureId, cwd);
		clearWorkerClient(featureId);
	}
}
