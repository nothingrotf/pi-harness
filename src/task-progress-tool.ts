/**
 * Tool `task_progress` — o sinal de progresso POR-TASK do worker único (paridade droid: 1 worker
 * por feature). Como o worker entrega a feature inteira numa só sessão (um EndFeatureRun no fim),
 * sem este sinal a TUI não saberia QUAL task está em andamento até o handoff final. O worker
 * chama `task_progress({ featureId, taskId, status })` ao começar/terminar cada task; o TS
 * apende um evento `task_started`/`task_completed` (por taskId) no progress_log.jsonl — exatamente
 * os eventos que o control-model já consome (buildTaskRows/activeItem) → a TUI fica granular ao
 * vivo. É puramente ADVISORY: o runner ainda emite `task_completed` por sub-task ao completar o
 * impl step, então o estado final fica correto mesmo se o worker esquecer de chamar este tool.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendProgress } from "./handoff.ts";

const PARAMS = Type.Object({
	featureId: Type.String({ description: "The feature id (from your bootstrap) — selects the run directory." }),
	taskId: Type.String({ description: "The plan.json task id you are starting/finishing." }),
	status: Type.Union([Type.Literal("started"), Type.Literal("completed")], { description: "'started' when you begin the task; 'completed' when it's implemented, verified and committed." }),
});

export function registerTaskProgressTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "task_progress",
			label: "Task Progress",
			description:
				"Mark per-task progress while delivering a feature in one worker session. Call with status:'started' when you begin a plan.json task and status:'completed' when it's implemented, verified and committed — this keeps the live Feature Control accurate. Advisory: it does not replace EndFeatureRun (call that ONCE at the end).",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { featureId, taskId, status } = params as { featureId: string; taskId: string; status: "started" | "completed" };
				appendProgress(ctx.cwd, featureId, status === "started" ? "task_started" : "task_completed", { taskId });
				return { content: [{ type: "text", text: `✓ task ${taskId} ${status}` }], details: { taskId, status } };
			},
		}),
	);
}
