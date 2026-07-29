/**
 * Tool `next_task` — a face do sequenciador determinístico (next-task.ts) exposta ao worker.
 * O worker chama a cada task; o TS grava as fronteiras (task_started/task_completed) e devolve a
 * spec da próxima. Fonte de verdade por-task no caminho nativo (substitui o `task_progress`
 * advisory e o parsing de mensagem de commit). Ver next-task.ts pro racional do git-gate.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readCommitGateConfig, runCommitGate } from "./commit-gate.ts";
import { buildTaskSpec, readContractAssertions } from "./contract.ts";
import { appendProgress } from "./handoff.ts";
import { decideReseam, reseamThreshold } from "./reseam.ts";
import { lastTurnContext } from "./usage.ts";
import { readFeatureRun, readPlan } from "./plan.ts";
import { batchUniverse, clearNextTaskState, completedTaskIds, gitHead, gitIsAncestor, planNextTask, readNextTaskState, readProgressEvents, writeNextTaskState } from "./next-task.ts";

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (from your bootstrap) — selects the run directory." }),
});

export function registerNextTaskTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "next_task",
			label: "Next Task",
			description:
				"Pull your next task when delivering a feature in one worker session. Returns the next task's spec (id, skillName, description, preconditions, expectedBehavior, fulfills). The harness records task boundaries deterministically: it marks the previous task done ONLY after you committed (git HEAD advanced) AND, when the profile configures a commit gate (delivery.json commitGate), that gate command passes — you cannot advance a red tree. Call it again after each commit; when it reports all tasks are done, call EndFeatureRun once.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { featureId } = params as { featureId: string };
				const plan = readPlan(ctx.cwd, featureId);
				if (!plan) return { content: [{ type: "text", text: `No plan.json for feature "${featureId}".` }], details: { error: "no_plan" } };
				// Contexto real DESTA sessão (o tool roda dentro do worker). Sempre registrado — é a série
				// que sustenta o teto. Nunca-fatal: sem medida, o loop segue igual.
				const contextTokens = (() => {
					try {
						return lastTurnContext((ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager?.getSessionFile?.());
					} catch {
						return null;
					}
				})();
				if (contextTokens) appendProgress(ctx.cwd, featureId, "task_context", { contextTokens });
				// Escopa o universo à fatia do batch em execução (doc 05 §5.1): o step in_progress do
				// feature-run.json carrega as tasks DESTE batch. Fallback (K=1/sem run) = plano inteiro.
				const featureRun = readFeatureRun(ctx.cwd, featureId);
				const { taskIds, batchId } = batchUniverse(featureRun, plan.tasks.map((t) => t.id));
				// Brief autocontido (contract OQ1): resolve fulfills → texto das assertions no spec.
				// Contract é FROZEN — leitura por chamada é barata e sempre consistente.
				const contractAssertions = readContractAssertions(ctx.cwd, featureId);
				const completed = completedTaskIds(readProgressEvents(ctx.cwd, featureId));
				const state = readNextTaskState(ctx.cwd, featureId);
				const head = gitHead(ctx.cwd);
				const d = planNextTask(taskIds, completed, state, head, (a, b) => gitIsAncestor(ctx.cwd, a, b));

				// Commit-gate (opt-in, delivery.json `commitGate`): o commit da task ativa só a COMPLETA se a
				// árvore passar o gate rápido do repo. Vermelho → re-entrega a MESMA task com o tail do erro
				// (o incidente que isto previne: batch commitou árvore não-compilável e o run inteiro herdou).
				if (d.completePrev) {
					const gate = readCommitGateConfig(ctx.cwd);
					if (gate) {
						const g = runCommitGate(ctx.cwd, gate);
						appendProgress(ctx.cwd, featureId, g.ok ? "commit_gate_passed" : "commit_gate_failed", { taskId: d.completePrev, command: gate.command, ...(g.timedOut ? { timedOut: true } : {}), ...(g.zeroTests ? { zeroTests: true } : {}) });
						// Verde vazio é falha de MANIFESTO, não de código — evento próprio pro cockpit.
						if (g.zeroTests) appendProgress(ctx.cwd, featureId, "commit_gate_zero_tests", { taskId: d.completePrev, command: gate.command });
						if (!g.ok) {
							// NÃO completa nem avança; estado intocado (activeTaskId/head originais) — o fix
							// exige um commit NOVO, que a checagem de ancestralidade aceita naturalmente.
							const active = plan.tasks.find((t) => t.id === d.completePrev);
							const spec = active ? JSON.stringify(buildTaskSpec(active, contractAssertions), null, 2) : "";
							const why = g.timedOut ? `timed out after ${gate.timeoutSec}s` : g.zeroTests ? "exited 0 but collected ZERO tests" : "failed";
							const text = [
								`✗ Your commit for ${d.completePrev} landed, but the commit gate ${why}: \`${gate.command}\`. The tree must be GREEN at every task boundary — the harness will NOT advance you on a red tree.`,
								`Fix the failure and add a FRESH commit ([${d.completePrev}] fix: <summary>), then call next_task again.`,
								`If the failure is pre-existing and NOT caused by your work (check harness.md "Known Pre-Existing Issues"), do not burn attempts: call EndFeatureRun (successState: "partial", returnToOrchestrator: true) naming the exact failure as the blocker.`,
								"",
								"Gate output (tail):",
								"```",
								g.output,
								"```",
							].join("\n");
							return { content: [{ type: "text", text: spec ? `${text}\n\n${spec}` : text }], details: { action: "resend", taskId: d.completePrev, gateFailed: true } };
						}
					}
					appendProgress(ctx.cwd, featureId, "task_completed", { taskId: d.completePrev });
				}

				if (d.action === "done") {
					clearNextTaskState(ctx.cwd, featureId);
					return { content: [{ type: "text", text: `✓ All tasks in this batch are committed. Call EndFeatureRun ONCE now (taskId="${batchId}"), then end your turn.` }], details: { action: "done", batchId } };
				}

				const task = plan.tasks.find((t) => t.id === d.taskId);

				// Re-costura por contexto: numa fronteira REAL (a anterior acabou de commitar), se a sessão
				// já carrega tokens demais, fecha o batch aqui. As tasks restantes ficam pendentes e o runner
				// abre um step de continuação com um worker fresco. Ver reseam.ts pro custo medido e pras
				// travas (piso de tasks + coesão) que impedem virar um-worker-por-task.
				// FAIL-SAFE por skew de versão: só corta se o RUNNER que conduz este run souber abrir um step
				// de continuação. Os workers são processos novos (código atual); o runner vive na sessão do
				// orchestrator e pode ser mais velho. Sem o carimbo, cortar DESCARTA as tasks restantes — numa
				// run real 7 tasks foram marcadas como feitas sem nunca terem começado.
				const canContinue = featureRun?.capabilities?.batchContinuation === true;
				if (d.action === "start" && d.completePrev && task && canContinue) {
					const completedNow = new Set([...completed, d.completePrev]);
					const r = decideReseam({
						contextTokens,
						threshold: reseamThreshold(),
						completedInBatch: taskIds.filter((id) => completedNow.has(id)).length,
						prev: plan.tasks.find((t) => t.id === d.completePrev),
						next: task,
					});
					if (r.cut) {
						const remaining = taskIds.filter((id) => !completedNow.has(id));
						appendProgress(ctx.cwd, featureId, "context_reseam_cut", { contextTokens: r.contextTokens, threshold: r.threshold, batchId, remaining });
						clearNextTaskState(ctx.cwd, featureId);
						const text = [
							`✂ Batch closed early: this session now carries ${Math.round(r.contextTokens / 1000)}k tokens of context per turn (threshold ${Math.round(r.threshold / 1000)}k).`,
							`Your work is committed and the tree is green — nothing is lost. The remaining ${remaining.length} task(s) (${remaining.join(", ")}) continue in a FRESH worker with a clean window.`,
							`Call EndFeatureRun ONCE now (taskId="${batchId}", successState "success") and end your turn. Do NOT start ${task.id}.`,
						].join("\n");
						return { content: [{ type: "text", text }], details: { action: "batch_closed", batchId, reason: "context_reseam", remaining } };
					}
				}
				if (!task) return { content: [{ type: "text", text: `Task ${d.taskId} not found in plan.` }], details: { error: "no_task" } };
				const spec = buildTaskSpec(task, contractAssertions);
				const specJson = JSON.stringify(spec, null, 2);

				if (d.action === "resend") {
					const text = `⚠ No new commit since you started ${task.id}. Commit your work (message: [${task.id}] <summary>), then call next_task again — the harness will NOT advance you until a commit lands.`;
					return { content: [{ type: "text", text: `${text}\n\n${specJson}` }], details: { action: "resend", taskId: task.id } };
				}

				// start
				appendProgress(ctx.cwd, featureId, "task_started", { taskId: task.id });
				writeNextTaskState(ctx.cwd, featureId, { activeTaskId: task.id, head });
				const n = taskIds.indexOf(task.id) + 1;
				const prev = d.completePrev ? ` (previous ${d.completePrev} ✓ recorded)` : "";
				const text = `▶ Task ${n}/${taskIds.length} — ${task.id}. Invoke its skill (${task.skillName}), implement it, run its verification, and COMMIT ([${task.id}] <summary>). Then call next_task again for the next one.${prev}`;
				return { content: [{ type: "text", text: `${text}\n\n${specJson}` }], details: { action: "start", taskId: task.id } };
			},
		}),
	);
}
