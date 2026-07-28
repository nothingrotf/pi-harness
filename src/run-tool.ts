/**
 * Tool `run_feature` — o porte 1:1 do `start_mission_run` do modelo de referência (droid, doc 07
 * §6). O ORCHESTRATOR (o chat vivo) chama este tool pra entregar a execução ao RUNNER
 * determinístico: o FeatureRunner spawna UM worker session-backed pra feature inteira (`pi --mode
 * rpc`, loop `next_task`, commit por task), injeta o ship gate (code-review → qa-validator →
 * deliver) como validator sessions, e BLOQUEIA até devolver controle. Workers NUNCA rodam
 * in-chat nem como `Agent` — implementação é sempre sessão dirigida por código (paridade droid).
 *
 * Modos de resume (1:1 com a referência):
 *   default                    → continua o worker pausado (re-attacha a última sessão);
 *   restartFeature: true       → requeue e worker novo do zero;
 *   resumeWorkerSessionId      → re-attacha uma sessão específica (selecionar o worker).
 *
 * `fixTasks` = o análogo do orchestrator editar features.json antes do resume: insere steps de
 * UMA task acima do ship gate (preempção por ordenação — a fix corre primeiro no resume).
 *
 * O corpo vive em run-exec.ts (compartilhado com o Feature Control); pause vem de fora
 * (run-registry: /harness pause, tecla P do cockpit, shutdown hook) via AbortController.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { saveMode } from "./mode-store.ts";
import { executeFeatureRun } from "./run-exec.ts";

const FixTask = Type.Object({
	id: Type.String({ description: "Unique fix-task/step id (e.g. FIX1)." }),
	skillName: Type.String({ description: "A profile worker skill in .harness/profile/skills/." }),
	description: Type.Optional(Type.String()),
	fulfills: Type.Optional(Type.Array(Type.String(), { description: "Contract assertion IDs this fix completes (new bug assertions included)." })),
	preconditions: Type.Optional(Type.Array(Type.String())),
	expectedBehavior: Type.Optional(Type.Array(Type.String())),
});

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (selects .harness/runs/<featureId>/)." }),
	restartFeature: Type.Optional(Type.Boolean({ description: "Requeue the in-progress step and re-run it FROM SCRATCH with a fresh worker (instead of re-attaching the paused session)." })),
	resumeWorkerSessionId: Type.Optional(Type.String({ description: "Re-attach a SPECIFIC recorded worker session id (see the run report / feature-run.json workerSessionIds)." })),
	fixTasks: Type.Optional(Type.Array(FixTask, { description: "Fix tasks to insert ABOVE the ship gate before running (they preempt — run first). BLOCKING findings only — dispatching a fix for a non-blocking finding is the single most expensive mistake in this system." })),
	grantGateRound: Type.Optional(
		Type.Boolean({
			description:
				"Grant ONE extra ship-gate round after the runner returned turnReason 'gate_round_cap'. Deliberate act — re-calling run_feature alone will NOT resume a capped gate. Use only for a demonstrated correctness/security/contract defect; otherwise ship what is green and move the rest to a follow-up feature.",
		}),
	),
});

export function registerRunFeatureTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "run_feature",
			label: "Run Feature",
			description:
				"Hand control to the deterministic feature runner (BLOCKING — the droid start_mission_run analog). It spawns ONE session-backed worker for the whole feature (next_task loop, commit per task), then runs the ship-gate validators, enforcing per-role model config, attempt budgets and pause/resume. Returns a report when the feature completes, pauses, or returns to you (orchestrator_turn). Resume modes: default re-attaches the paused worker; restartFeature re-runs fresh; resumeWorkerSessionId picks a specific session. Pass fixTasks to insert fixes above the gate before resuming.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { featureId, restartFeature, resumeWorkerSessionId, fixTasks, grantGateRound } = params as {
					featureId: string;
					restartFeature?: boolean;
					resumeWorkerSessionId?: string;
					fixTasks?: { id: string; skillName: string; description?: string; fulfills?: string[]; preconditions?: string[]; expectedBehavior?: string[] }[];
					grantGateRound?: boolean;
				};
				// Sincroniza o ponteiro de feature ativa (.session.json) com a feature que ESTÁ a correr:
				// sem isto, num fluxo multi-feature o ponteiro só-comando congelava na 1ª feature — o cockpit
				// (Alt+T) e o resume pós-/reload abriam a feature errada. Best-effort (saveMode nunca lança).
				saveMode(ctx.cwd, { active: true, featureId, phase: "run" });
				// leadUsage: o session file DESTA sessão (o orchestrator vivo) entra no report (docs/06 §2).
				const orchestratorSessionFile = (() => {
					try {
						return ctx.sessionManager?.getSessionFile?.();
					} catch {
						return undefined;
					}
				})();
				const res = await executeFeatureRun(ctx.cwd, featureId, { restartFeature, resumeWorkerSessionId, fixTasks, grantGateRound, orchestratorSessionFile });
				if (!res.ok) return { content: [{ type: "text", text: res.message }], details: { error: res.error } };
				return { content: [{ type: "text", text: res.report }], details: { status: res.run.status, pauseReason: res.run.pauseReason } };
			},
		}),
	);
}
