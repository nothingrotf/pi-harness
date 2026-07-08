/**
 * Tool `next_task` — a face do sequenciador determinístico (next-task.ts) exposta ao worker.
 * O worker chama a cada task; o TS grava as fronteiras (task_started/task_completed) e devolve a
 * spec da próxima. Fonte de verdade por-task no caminho nativo (substitui o `task_progress`
 * advisory e o parsing de mensagem de commit). Ver next-task.ts pro racional do git-gate.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendProgress } from "./handoff.ts";
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
				"Pull your next task when delivering a feature in one worker session. Returns the next task's spec (id, skillName, description, preconditions, expectedBehavior, fulfills). The harness records task boundaries deterministically: it marks the previous task done ONLY after you committed (git HEAD advanced) — you cannot advance without committing. Call it again after each commit; when it reports all tasks are done, call EndFeatureRun once.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { featureId } = params as { featureId: string };
				const plan = readPlan(ctx.cwd, featureId);
				if (!plan) return { content: [{ type: "text", text: `No plan.json for feature "${featureId}".` }], details: { error: "no_plan" } };
				// Escopa o universo à fatia do batch em execução (doc 05 §5.1): o step in_progress do
				// feature-run.json carrega as tasks DESTE batch. Fallback (K=1/sem run) = plano inteiro.
				const { taskIds, batchId } = batchUniverse(readFeatureRun(ctx.cwd, featureId), plan.tasks.map((t) => t.id));
				const completed = completedTaskIds(readProgressEvents(ctx.cwd, featureId));
				const state = readNextTaskState(ctx.cwd, featureId);
				const head = gitHead(ctx.cwd);
				const d = planNextTask(taskIds, completed, state, head, (a, b) => gitIsAncestor(ctx.cwd, a, b));

				if (d.completePrev) appendProgress(ctx.cwd, featureId, "task_completed", { taskId: d.completePrev });

				if (d.action === "done") {
					clearNextTaskState(ctx.cwd, featureId);
					return { content: [{ type: "text", text: `✓ All tasks in this batch are committed. Call EndFeatureRun ONCE now (taskId="${batchId}"), then end your turn.` }], details: { action: "done", batchId } };
				}

				const task = plan.tasks.find((t) => t.id === d.taskId);
				if (!task) return { content: [{ type: "text", text: `Task ${d.taskId} not found in plan.` }], details: { error: "no_task" } };
				const spec = { id: task.id, description: task.description, skillName: task.skillName, fulfills: task.fulfills ?? [], preconditions: task.preconditions ?? [], expectedBehavior: task.expectedBehavior ?? [] };
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
