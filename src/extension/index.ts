/**
 * pi-harness — extensão fina.
 *
 * Registra o comando /harness, dá a "cara" do modo (badge aboveEditor + input
 * recolorido + status no rodapé) e despacha pro resto (setup, convergência) que
 * mora em skills/runner. A extensão NÃO implementa harness — só chrome + dispatch.
 *
 * Fluxo (docs/01-integration.md):
 *   /harness <pedido>  → ensureProfile → readiness gate → ativa modo → CONVERGE
 *   /harness setup     → (re)roda o setup do profile
 *   /harness status    → mostra a fase atual
 *   /harness exit      → sai do modo
 *
 * ponytail: ensureProfile/converge/setup ainda são stubs (Fatias 1-3). O que está
 * vivo aqui é a camada de UX, com smoke test ao vivo pendente pro recolor do input.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { featureIdFromRequest, idleMode, statusDetail, statusText, type HarnessMode } from "../mode.ts";
import { buildGateModel, type GateActionValue, summarizeSnapshot } from "../readiness.ts";
import { appendAudit, ensureReadinessInputs, readSnapshot } from "../readiness-pipeline.ts";
import { buildAuditDispatch, buildFixDispatch } from "../readiness-dispatch.ts";
import { buildSetupDispatch } from "../setup-dispatch.ts";
import { buildRefreshDispatch } from "../reconcile.ts";
import { registerReadinessStoreTool } from "../readiness-store-tool.ts";
import { registerProfileStoreTool } from "../profile-store-tool.ts";
import { registerEndFeatureRunTool } from "../endfeaturerun-tool.ts";
import { registerNextTaskTool } from "../next-task-tool.ts";
import { registerPlanStoreTool } from "../plan-store-tool.ts";
import { registerRunFeatureTool } from "../run-tool.ts";
import { activeRunIds, clearWorkerClient, isRunActive, pauseAllRuns, pauseRun, registerRun, registerWorkerClient, steerWorker, unregisterRun } from "../run-registry.ts";
import { registerLessonsStoreTool } from "../lessons-store-tool.ts";
import { registerDeliveryStoreTool } from "../delivery-store-tool.ts";
import { buildConvergeDispatch } from "../converge-dispatch.ts";
import { buildResumeDispatch, buildRunDispatch } from "../run-dispatch.ts";
import { defaultModelRef, loadModelConfig, modelOptions, readPiSettings, saveModelConfig, skippedGateSkills, summarizeConfig } from "../model-config.ts";
import { buildFeatureRun, featureProgress, readFeatureRun, readPlan } from "../plan.ts";
import { appendProgress } from "../handoff.ts";
import { computeFingerprint } from "../fingerprint.ts";
import { ensureProfile } from "../profile.ts";
import { StripController } from "../control-strip.ts";
import { readControlModel } from "../control-model.ts";
import { mergeDecisionMessage, readDeliveryRecord } from "../delivery.ts";
import { registerRunCardRenderer, sendRunCard } from "../run-card-view.ts";
import { agentsFromArgs, agentsFromDetails, clearAllLiveAgents, clearLiveAgents, isSubagentTool, setLiveAgents } from "../live-agents.ts";
import { clearMode, loadMode, saveMode } from "../mode-store.ts";

const STATUS_KEY = "harness";

/** Nível mínimo de readiness pra liberar sem fricção. */
const READINESS_TARGET_LEVEL = 4;



/**
 * Sinal de modo COMPATÍVEL: APENAS `setStatus` — composto pela statusline (o pi-fusiontui
 * lê getExtensionStatuses() e o mostra; o core também renderiza setStatus). NUNCA tocamos
 * no editor (setEditorComponent) nem em widgets aboveEditor: o pi-fusiontui é dono do editor
 * Droid + do footer, e clobberá-los quebra a UI dele. Compatibilidade > chrome próprio.
 */
async function applyModeChrome(ctx: ExtensionContext, mode: HarnessMode): Promise<void> {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, statusText(mode));
}

function clearModeChrome(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

/**
 * Contribui os agentes namespaced (harness-*) pro @tintinweb/pi-subagents espelhando-os no dir
 * GLOBAL de agents (`<globalAgentDir>/agents/`) via symlink — sem escrever no repo do usuário. O
 * @tintinweb descobre agents em `<cwd>/.pi/agents/` e `<globalAgentDir>/agents/`, então o espelho
 * global cobre qualquer repo. Ver contributeAgentsDir().
 */
/** Modelos disponíveis (auth configurada) via o modelRegistry da sessão: ref "provider/id" + nome amigável. */
function registryModels(ctx: ExtensionContext): Array<{ ref: string; label: string }> {
	try {
		const reg = (ctx as unknown as { modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string; name?: string }>; getAll?: () => Array<{ provider: string; id: string; name?: string }> } }).modelRegistry;
		const list = reg?.getAvailable?.() ?? reg?.getAll?.() ?? [];
		return list.map((m) => ({ ref: `${m.provider}/${m.id}`, label: m.name ?? `${m.provider}/${m.id}` }));
	} catch {
		return [];
	}
}

/**
 * Abre a UI de config de modelo por role (orchestrator/worker/validator) e persiste a
 * escolha em ~/.pi/agent/pi-harness/models.json. Sem UI (print/json) → mostra o estado
 * atual. Lê o settings.json do usuário pra pré-popular default + enabledModels.
 */
async function openModelConfig(ctx: ExtensionContext): Promise<void> {
	const cfg = loadModelConfig();
	const settings = readPiSettings();
	const fallback = defaultModelRef(settings);
	const reg = registryModels(ctx);
	const labels: Record<string, string> = {};
	for (const m of reg) labels[m.ref] = m.label;
	if (!ctx.hasUI) {
		ctx.ui.notify(`pi-harness models — ${summarizeConfig(cfg, { fallback, labels })}`);
		return;
	}
	const models = modelOptions(
		reg.map((m) => m.ref),
		settings,
	);
	const { showModelConfig } = await import("../model-config-view.ts");
	const updated = await showModelConfig(ctx, { config: cfg, models, labels, settings });
	if (!updated) {
		ctx.ui.notify("pi-harness: model config unchanged");
		return;
	}
	saveModelConfig(updated);
	ctx.ui.notify(`pi-harness: models saved — ${summarizeConfig(updated, { fallback, labels })}`);
}

function contributeAgentsDir(): void {
	let srcDir: string | undefined;
	try {
		srcDir = fileURLToPath(new URL("../../agents", import.meta.url));
	} catch {
		// best-effort: sem isso, os dispatches caem nos builtins delegate/worker.
	}
	// @tintinweb/pi-subagents (o tool `Agent`) descobre agents em <cwd>/.pi/agents/ e
	// <globalAgentDir>/agents/. Sem espelhar aqui, o orquestrador não acha os agents de ANÁLISE
	// (reviewers dos 3 eixos, qa-flow-validator, readiness auditor/remediator). Espelhamos os agents
	// namespaced (harness-*) no dir GLOBAL via symlink (fora do repo do usuário). Implementação NÃO
	// passa por aqui — workers são sessões runner-driven (run_feature → pi --mode rpc).
	try {
		if (!srcDir) return;
		const globalAgentsDir = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "agents");
		fs.mkdirSync(globalAgentsDir, { recursive: true });
		// LEGACY cleanup: o agent `harness-worker` (worker de implementação via Agent) foi removido —
		// workers agora são SEMPRE sessões runner-driven (run_feature → pi --mode rpc). Remove o
		// symlink espelhado antigo pra não deixar um agent quebrado/obsoleto descobrível.
		try {
			fs.rmSync(path.join(globalAgentsDir, "harness-worker.md"), { force: true });
		} catch {
			/* noop */
		}
		for (const file of fs.readdirSync(srcDir)) {
			if (!file.startsWith("harness-") || !file.endsWith(".md")) continue;
			const src = path.join(srcDir, file);
			const dest = path.join(globalAgentsDir, file);
			// idempotente: pula se o symlink já aponta pro nosso arquivo.
			try {
				if (fs.realpathSync(dest) === fs.realpathSync(src)) continue;
			} catch {
				/* dest ausente/quebrado — (re)cria abaixo */
			}
			try {
				fs.rmSync(dest, { force: true });
			} catch {
				/* noop */
			}
			try {
				fs.symlinkSync(src, dest);
			} catch {
				// symlink pode falhar (perms/Windows) — cai pra cópia.
				try {
					fs.copyFileSync(src, dest);
				} catch {
					/* noop */
				}
			}
		}
	} catch {
		// best-effort: sem isso, @tintinweb/pi-subagents não spawna os agents harness-*.
	}
}

export default function registerHarnessExtension(pi: ExtensionAPI): void {
	const mode: HarnessMode = idleMode();
	let lastCtx: ExtensionContext | undefined;
	// Faixa de progresso sempre-visível (Feature Control §2). Vive durante converge/run.
	const strip = new StripController();
	// Run card (cap. 09): featureIds cujo cartão já foi inserido no transcript nesta sessão
	// (evita duplicar ao re-disparar /harness run).
	const cardSent = new Set<string>();
	// Proposal confirmation pendente: setado quando store_plan persiste; consumido no agent_end.
	let pendingProposal: string | null = null;
	// Merge gate pendente: setado quando store_delivery grava state:"awaiting_merge"; consumido no agent_end.
	let pendingMerge: string | null = null;

	// Estágio STORE da criação do readiness (analógo do store_agent_readiness_report).
	registerReadinessStoreTool(pi);
	// Estágio STORE do setup do profile (valida o conteúdo autorado → estampa profile.json).
	registerProfileStoreTool(pi);
	// Saída do worker/validator: registra o handoff que o FeatureRunner lê (handoff.ts).
	registerEndFeatureRunTool(pi);
	// Sinal de progresso por-task do worker único (1 worker por feature) → TUI granular ao vivo.
	registerNextTaskTool(pi);
	// Estágio STORE da convergência: valida cobertura → grava plan.json + status.json.
	registerPlanStoreTool(pi);
	// store_lesson — a camada de lições auto-melhorável (grounded em sinais do ship gate).
	registerLessonsStoreTool(pi);
	// store_delivery — record do passo de entrega (PR + Linear + CI + merge) → aba Delivery do cockpit.
	registerDeliveryStoreTool(pi);
	// run_feature — o start_mission_run analog: o orchestrator (chat) entrega a execução ao
	// FeatureRunner (workers/validators = sessões `pi --mode rpc`; model config enforced; BLOCKING).
	registerRunFeatureTool(pi);
	// Run card (cap. 09): renderer da mensagem custom `harness-run` que vive no transcript e
	// se auto-atualiza (Preparing → live → Done). Enviado ao iniciar um run (sendRunCard).
	registerRunCardRenderer(pi);
	// Agentes dedicados pro @tintinweb/pi-subagents (harness-readiness-auditor / harness-readiness-remediator).
	contributeAgentsDir();

	// Dispatch ao agente, ROBUSTO a turno em andamento. Quando o agente está STREAMING (mid-turn),
	// o runtime EXIGE saber como enfileirar a mensagem — senão lança "Agent is already processing.
	// Specify streamingBehavior (...)". Usamos `deliverAs: "followUp"` (espera o turno corrente
	// terminar e então roda), não `"steer"` (interromper): os nossos dispatches (converge/run/setup/
	// audit/fix, proposal-reject, merge) INICIAM trabalho — não devem cortar o turno em andamento.
	// Agente idle → entrega imediata (deliverAs é ignorado). Tolerante: nunca propaga o throw.
	const dispatchToAgent = (content: string): void => {
		try {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		} catch {
			// fallback defensivo: tenta sem opção (idle) — se ainda falhar, engole (não trava o handler).
			try {
				pi.sendUserMessage(content);
			} catch {
				/* noop */
			}
		}
	};

	// DISPATCH NATIVO (model-driven, in-session) — o jeito nativo: os tool calls
	// streamam ao vivo no terminal e o **rpiv-todo** mostra o Plan das 5 fases. Sem
	// widget custom nem subprocesso. (O ReadinessRunner code-initiated continua
	// disponível pro headless/CI — ver src/readiness-runner.ts e docs/02.)
	// Detecta em runtime quais tools companheiros estão ATIVOS na sessão, pra usar
	// (e avisar) os que existem: rpiv-todo (`todo`) e @tintinweb/pi-subagents (`Agent`).
	const activeTools = (): Set<string> => {
		try {
			return new Set(pi.getActiveTools());
		} catch {
			return new Set();
		}
	};
	// Subagent PROVIDER ÚNICO: @tintinweb/pi-subagents (o tool `Agent`). Habilita o caminho nativo de
	// spawn (worker + reviewers em sessão fresca; transcript ao vivo no Active Worker via `.output`).
	const hasSubagentTool = (t: Set<string>): boolean => t.has("Agent");
	const toolBadge = (t: Set<string>, names: string[]): string =>
		names.map((n) => `${n} ${t.has(n) ? "✓" : "✗"}`).join(" · ");

	const runAudit = (ctx: ExtensionCommandContext, via: string): void => {
		const ensured = ensureReadinessInputs(ctx.cwd);
		if (!ensured.ok) {
			ctx.ui.notify(`pi-harness: readiness blocked — ${ensured.issues.join("; ")}`, "warning");
			return;
		}
		const t = activeTools();
		appendAudit(ctx.cwd, "audit_dispatched", { via, todo: t.has("todo") });
		dispatchToAgent(buildAuditDispatch({ todo: t.has("todo") }));
		ctx.ui.notify(`pi-harness: live audit — tools: ${toolBadge(t, ["todo", "store_agent_readiness_report"])}`);
	};

	const runFix = (ctx: ExtensionCommandContext, args: string): void => {
		if (!readSnapshot(ctx.cwd)) {
			ctx.ui.notify("pi-harness: no report yet — running the audit first.");
			runAudit(ctx, "/readiness-fix");
			return;
		}
		const t = activeTools();
		appendAudit(ctx.cwd, "fix_dispatched", { hasArgs: args.trim().length > 0, todo: t.has("todo"), subagent: hasSubagentTool(t) });
		dispatchToAgent(buildFixDispatch(args, { todo: t.has("todo"), subagent: hasSubagentTool(t) }));
		ctx.ui.notify(`pi-harness: live remediation — tools: ${toolBadge(t, ["todo", "Agent"])}`);
	};

	// Feature Control (overlay Ctrl+T): loop que reabre o overlay após o config de modelos.
	// `resume` (teclas R · Shift+R · r em Workers) fecha o overlay e dispara o orchestrator no chat
	// (que chama run_feature com o modo escolhido) — paridade com a tecla R do Mission Control.
	const openControl = async (ctx: ExtensionContext, featureId: string): Promise<void> => {
		const { showFeatureControl } = await import("../control-view.ts");
		for (;;) {
			const res = await showFeatureControl(ctx, featureId);
			if (res.kind === "models") {
				await openModelConfig(ctx);
				continue;
			}
			if (res.kind === "resume") {
				mode.active = true;
				mode.featureId = featureId;
				mode.phase = "run";
				await applyModeChrome(ctx, mode);
				saveMode(ctx.cwd, mode);
				dispatchToAgent(buildResumeDispatch(featureId, { restartFeature: res.restartFeature, resumeWorkerSessionId: res.resumeWorkerSessionId }));
				const label = res.restartFeature ? "restart (fresh worker)" : res.resumeWorkerSessionId ? `resume session ${res.resumeWorkerSessionId.slice(0, 8)}` : "resume (re-attach worker)";
				ctx.ui.notify(`pi-harness: ${label} of "${featureId}" — orchestrator will call run_feature.`);
				if (ctx.hasUI) strip.start(ctx, featureId);
				return;
			}
			return;
		}
	};
	// Ponto de entrada: run ativo → overlay direto; senão o Runs picker → overlay.
	const openControlEntry = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("pi-harness: Feature Control needs the TUI.", "warning");
			return;
		}
		const activeId = mode.active ? mode.featureId : undefined;
		if (activeId && readControlModel(ctx.cwd, activeId)) return openControl(ctx, activeId);
		const { listRuns } = await import("../runs.ts");
		const runs = listRuns(ctx.cwd, { activeFeatureId: mode.featureId });
		if (runs.length === 0) {
			ctx.ui.notify('pi-harness: no runs yet — /harness "<feature>" to start one.');
			return;
		}
		const { showRunsPicker } = await import("../runs-view.ts");
		const pick = await showRunsPicker(ctx, runs);
		if (pick.kind === "open") return openControl(ctx, pick.featureId);
		if (pick.kind === "new") ctx.ui.notify('pi-harness: run /harness "<feature description>" to converge a new run.');
	};

	// Edita plan.json à mão (opção "Manually edit"): re-valida a cobertura e re-persiste.
	const editPlan = async (ctx: ExtensionContext, featureId: string): Promise<void> => {
		const planPath = path.join(ctx.cwd, ".harness", "runs", featureId, "plan.json");
		let current = "";
		try {
			current = fs.readFileSync(planPath, "utf8");
		} catch {
			// sem plan.json (não deveria) — abre vazio
		}
		const edited = await ctx.ui.editor("Edit plan.json (coverage re-validated on save)", current);
		if (edited === undefined) return;
		try {
			const parsed = JSON.parse(edited);
			const { validatePlan, storePlan } = await import("../plan.ts");
			const check = validatePlan(parsed);
			if (!check.ok) {
				ctx.ui.notify(`pi-harness: plan invalid — ${check.issues.slice(0, 3).join("; ")}`, "warning");
				return;
			}
			storePlan(ctx.cwd, parsed);
			ctx.ui.notify(`pi-harness: plan saved — run /harness run to execute "${featureId}".`);
		} catch (e) {
			ctx.ui.notify(`pi-harness: invalid JSON — ${(e as Error).message}`, "warning");
		}
	};

	// Inicia o run NATIVO da feature (compartilhado por `/harness run` e pela APROVAÇÃO do
	// proposal — aprovar o plano JÁ dispara a execução, sem um `/harness run` separado).
	// Faz branch-per-feature (não-fatal) + run_started + buildRunDispatch + cartão vivo.
	// `steering` (aprovação com comentário) é prefixado ao dispatch como guidance de execução.
	// O modo já deve estar em phase "run" (o caller transiciona antes — paridade com /harness run).
	const startFeatureRun = async (ctx: ExtensionContext, featureId: string, steering?: string): Promise<void> => {
		const t = activeTools();
		// Branch-per-feature (run-start, determinístico/conservador): cria/troca a branch da
		// feature só na base+limpo; senão respeita a atual. Nunca-fatal (erro de git não trava o run).
		try {
			const { ensureFeatureBranch } = await import("../branch-ops.ts");
			const br = ensureFeatureBranch(ctx.cwd, featureId);
			appendProgress(ctx.cwd, featureId, "branch_ready", { branch: br.branch, action: br.kind, reason: br.reason });
			if (br.kind === "create") ctx.ui.notify(`pi-harness: created feature branch ${br.branch} (${br.reason}).`);
			else if (br.kind === "switch") ctx.ui.notify(`pi-harness: switched to feature branch ${br.branch}.`);
			else if (br.kind === "skip" || br.kind === "error") ctx.ui.notify(`pi-harness: feature branch — ${br.reason} (committing on the current branch).`, "warning");
		} catch (e) {
			ctx.ui.notify(`pi-harness: branch step skipped (${(e as Error).message}).`, "warning");
		}
		// Marca o início do run no disco (deriveRunState → "running" a partir do disco).
		appendProgress(ctx.cwd, featureId, "run_started", {});
		const dispatch = buildRunDispatch(featureId, { todo: t.has("todo"), subagent: hasSubagentTool(t), advisor: t.has("advisor"), askUser: t.has("ask_user_question") }, loadModelConfig().gates);
		dispatchToAgent(steering ? `${steering}\n\n${dispatch}` : dispatch);
		ctx.ui.notify(`pi-harness: executing "${featureId}" — orchestrator in chat → run_feature (runner-driven workers) → ship gate. tools: ${toolBadge(t, ["todo", "run_feature", "Agent", "advisor"])}`);
		if (ctx.hasUI) {
			strip.start(ctx, featureId);
			// cap. 09: dropa o cartão vivo no transcript (1x por run/sessão). Ctrl+T = cockpit.
			if (!cardSent.has(featureId)) {
				cardSent.add(featureId);
				sendRunCard(pi, featureId);
			}
		}
	};

	// Proposal confirmation (analog do missionProposalConfirmation): overlay após store_plan.
	// Aprovar (proceed | comment) NÃO pede um `/harness run` — já inicia a execução aqui.
	const showProposal = async (ctx: ExtensionContext, featureId: string): Promise<void> => {
		const model = readControlModel(ctx.cwd, featureId);
		const { showPlanProposal } = await import("../proposal-view.ts");
		const choice = await showPlanProposal(ctx, { featureId, model, savePath: `.harness/runs/${featureId}/` });
		if (choice.kind === "edit") return editPlan(ctx, featureId);
		const { proposalCommentMessage, proposalRejectMessage } = await import("../proposal.ts");
		if (choice.kind === "reject") {
			dispatchToAgent(proposalRejectMessage(featureId, choice.reason));
			ctx.ui.notify("pi-harness: plan sent back to revise.");
			return;
		}
		// Aprovado: transiciona o modo p/ run e DISPARA a execução (comentário = steering).
		mode.active = true;
		mode.featureId = featureId;
		mode.phase = "run";
		await applyModeChrome(ctx, mode);
		saveMode(ctx.cwd, mode);
		const steering = choice.kind === "comment" ? proposalCommentMessage(featureId, choice.comment) : undefined;
		await startFeatureRun(ctx, featureId, steering);
	};

	// Merge gate (ship-gate step 3): overlay humano quando store_delivery grava awaiting_merge.
	// Espelha showProposal — a escolha volta pro agente (ele executa o gh). Nunca mergeia sozinho.
	const showMerge = async (ctx: ExtensionContext, featureId: string): Promise<void> => {
		const record = readDeliveryRecord(ctx.cwd, featureId);
		if (!record) return;
		const { showMergeGate } = await import("../delivery-view.ts");
		const choice = await showMergeGate(ctx, { featureId, record });
		dispatchToAgent(mergeDecisionMessage(featureId, choice));
		const label = choice.kind === "leave_open" ? "leave open" : choice.kind;
		ctx.ui.notify(`pi-harness: merge gate — ${label} (forwarded to the deliver step).`);
	};

	// Reference flows as their own commands (1:1): /readiness-report and /readiness-fix.
	pi.registerCommand("readiness-report", {
		description: "Audit Agent-Readiness live in the session (5-phase Plan via todo) and store the snapshot.",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			runAudit(ctx, "/readiness-report");
		},
	});
	pi.registerCommand("readiness-fix", {
		description: "Fix failing readiness signals live — one todo per signal (isolatable via subagent).",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			runFix(ctx, args);
		},
	});
	// Config global de modelo+effort por role (orchestrator/worker/validator). Mesmo handler
	// do subcomando `/harness models`; comando dedicado pra descoberta.
	pi.registerCommand("harness-models", {
		description: "Configure model + effort per harness role (orchestrator/worker/validator).",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			await openModelConfig(ctx);
		},
	});
	// Feature Control — o dashboard ao vivo (Mission Control rebrandeado). Comando + atalho Ctrl+T.
	pi.registerCommand("harness-control", {
		description: "Open Feature Control: live dashboard (progress, tasks, coverage, workers, handoffs) for a run.",
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			await openControlEntry(ctx);
		},
	});
	try {
		pi.registerShortcut("ctrl+t", {
			description: "pi-harness: Feature Control",
			handler: async (ctx: ExtensionContext): Promise<void> => {
				await openControlEntry(ctx);
			},
		});
	} catch {
		// registerShortcut indisponível nesta versão do Pi — o comando /harness control cobre.
	}

	pi.registerCommand("harness", {
		description: "Enter harness mode: profile setup → readiness → feature (sequential).",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			lastCtx = ctx;
			const sub = args.trim();

			if (sub === "exit") {
				Object.assign(mode, idleMode());
				clearModeChrome(ctx);
				strip.stop(ctx);
				cardSent.clear();
				clearAllLiveAgents();
				clearMode(ctx.cwd);
				ctx.ui.notify("pi-harness: mode exited");
				return;
			}
			if (sub === "status") {
				const progress = mode.featureId ? featureProgress(ctx.cwd, mode.featureId) : null;
				ctx.ui.notify(statusDetail(mode, progress));
				return;
			}
			if (sub === "models") {
				await openModelConfig(ctx);
				return;
			}
			// Pause graceful (análogo do RDT "pause from anywhere"): aborta o run ativo → o runner
			// persiste paused/aborted e o worker é interrompido RETENDO o transcript (resume re-attacha).
			if (sub === "pause") {
				const fid = mode.featureId;
				if (fid && pauseRun(fid)) {
					ctx.ui.notify(`pi-harness: pausing "${fid}" — the worker is interrupted gracefully (transcript retained). Resume with run_feature / /harness run.`);
					return;
				}
				const others = activeRunIds();
				if (others.length > 0) {
					for (const id of others) pauseRun(id);
					ctx.ui.notify(`pi-harness: pausing ${others.join(", ")}.`);
				} else {
					ctx.ui.notify("pi-harness: no active run to pause.", "warning");
				}
				return;
			}
			// Steer o worker VIVO (análogo do interrupt-and-chat / addUserMessage do Worker Session viewer).
			if (sub.startsWith("steer ")) {
				const text = sub.slice("steer ".length).trim();
				const fid = mode.featureId;
				if (!text || !fid) {
					ctx.ui.notify('Usage: /harness steer "<message to the live worker>" (needs an active feature run)', "warning");
					return;
				}
				const res = await steerWorker(fid, text);
				if (res === "sent") ctx.ui.notify(`pi-harness: message sent to the live worker of "${fid}".`);
				else if (res === "no_worker") ctx.ui.notify(`pi-harness: no live worker for "${fid}" (is a run active${isRunActive(fid) ? ", but the worker isn't up yet" : ""}?).`, "warning");
				else ctx.ui.notify("pi-harness: the worker wire refused the message (try again between turns).", "warning");
				return;
			}
			if (sub === "control") {
				await openControlEntry(ctx);
				return;
			}
			// /harness "<feature>" --headless → CI: converge (code-initiated, gray-areas [assumido]) →
			// runner, BLOQUEANTE. O elo converge→runner sem TUI (src/headless.ts).
			if (sub !== "run --headless" && /(^|\s)--headless\b/.test(sub)) {
				const request = sub.replace(/--headless/g, "").trim();
				if (!request) {
					ctx.ui.notify('Usage: /harness "<feature>" --headless', "warning");
					return;
				}
				if (ensureProfile(ctx.cwd).status === "absent") {
					ctx.ui.notify("pi-harness: no profile — run /harness setup first.", "warning");
					return;
				}
				const fid = featureIdFromRequest(request);
				mode.active = true;
				mode.featureId = fid;
				mode.phase = "run";
				await applyModeChrome(ctx, mode);
				saveMode(ctx.cwd, mode);
				ctx.ui.notify(`pi-harness: HEADLESS feature "${fid}" — converge (pi --print) → runner (pi --mode rpc workers). Blocks until done.`);
				const { makeRealConvergeFn } = await import("../feature-spawn.ts");
				const { makeRpcSpawn } = await import("../rpc-worker.ts");
				const { runHeadlessFeature } = await import("../headless.ts");
				const model = (ctx as { model?: { id?: string } }).model?.id;
				const cfg = loadModelConfig(); // per-role model+effort overrides (global)
				// Registra no run-registry → P (pause) e S (steer) do Feature Control valem aqui também.
				let controller: AbortController;
				try {
					controller = registerRun(fid);
				} catch {
					ctx.ui.notify(`pi-harness: a run for "${fid}" is already active.`, "warning");
					return;
				}
				let res: Awaited<ReturnType<typeof runHeadlessFeature>>;
				try {
					res = await runHeadlessFeature(ctx.cwd, {
						request,
						featureId: fid,
						converge: makeRealConvergeFn({ model, config: cfg }),
						spawn: makeRpcSpawn({ featureId: fid, model, config: cfg, onClient: (c) => (c ? registerWorkerClient(fid, c) : clearWorkerClient(fid)) }),
						gateSkip: skippedGateSkills(cfg), // paridade com /harness run --headless
						signal: controller.signal,
					});
				} finally {
					unregisterRun(fid);
					clearWorkerClient(fid);
				}
				ctx.ui.notify(
					res.ok
						? `pi-harness: headless "${fid}" SHIPPED — all assertions passed.`
						: `pi-harness: headless "${fid}" stopped at ${res.stage} (${res.reason ?? res.status ?? "unknown"}).`,
					res.ok ? undefined : "warning",
				);
				return;
			}
			if (sub === "run" || sub === "run --headless") {
				// Execução da feature convergida (Fatia 3). DEFAULT = nativo TUI + TODO (orquestrador
				// no chat, agentes via subagent, visíveis). --headless = FeatureRunner code-initiated.
				// Resume (analog do "Select a mission to resume" do Droid): sem ponteiro ativo (ex.:
				// após um /reload onde a restauração não pegou, ou sessão nova), escolhe um run do disco.
				if (!mode.active || !mode.featureId) {
					const { listRuns } = await import("../runs.ts");
					const runs = listRuns(ctx.cwd);
					if (runs.length === 0) {
						ctx.ui.notify('pi-harness: no runs to resume. Run /harness "<feature>" to converge first.', "warning");
						return;
					}
					let fid: string | undefined;
					if (ctx.hasUI) {
						const { showRunsPicker } = await import("../runs-view.ts");
						const pick = await showRunsPicker(ctx, runs);
						if (pick.kind === "new") {
							ctx.ui.notify('pi-harness: run /harness "<feature description>" to converge a new run.');
							return;
						}
						if (pick.kind !== "open") {
							ctx.ui.notify("pi-harness: cancelled");
							return;
						}
						fid = pick.featureId;
					} else {
						fid = runs[0].featureId; // headless: o mais recente
					}
					mode.active = true;
					mode.featureId = fid;
					mode.phase = "run";
					ctx.ui.notify(`pi-harness: resuming "${fid}".`);
				}
				if (!readPlan(ctx.cwd, mode.featureId)) {
					ctx.ui.notify(`pi-harness: no plan.json for "${mode.featureId}" yet — finish convergence first.`, "warning");
					return;
				}
				mode.phase = "run";
				await applyModeChrome(ctx, mode);
				saveMode(ctx.cwd, mode);
				if (sub === "run --headless") {
					// CI/headless: o FeatureRunner dirige cada worker via o WIRE RPC (`pi --mode rpc`,
					// RpcClient — src/rpc-worker.ts), NÃO in-chat, e BLOQUEIA até terminar. Opt-in explícito
					// — o default visível é o nativo (subagents in-session) acima.
					const fid = mode.featureId;
					const { makeRpcSpawn } = await import("../rpc-worker.ts");
					const { runLoop } = await import("../feature-runner.ts");
					const { completionGate, loadOrBuildFeatureRun, writeFeatureRun } = await import("../plan.ts");
					const { appendProgress } = await import("../handoff.ts");
					// Resume graceful×hard: continua o feature-run persistido (re-attacha worker) ou reclama órfão.
					const rp = loadOrBuildFeatureRun(ctx.cwd, fid);
					if (!rp) {
						ctx.ui.notify("pi-harness: no plan to run.", "warning");
						return;
					}
					const { run, resume } = rp;
					ctx.ui.notify(`pi-harness: HEADLESS ${resume ? "resume" : "run"} of "${fid}" (FeatureRunner; pi --mode rpc workers, not in-chat). Blocks until done.`);
					// Branch-per-feature também no headless (mesma semântica conservadora; nunca-fatal).
					try {
						const { ensureFeatureBranch } = await import("../branch-ops.ts");
						const br = ensureFeatureBranch(ctx.cwd, fid);
						appendProgress(ctx.cwd, fid, "branch_ready", { branch: br.branch, action: br.kind, reason: br.reason });
					} catch {
						// non-fatal
					}
					const model = (ctx as { model?: { id?: string } }).model?.id;
					const cfg = loadModelConfig();
					// Registra no run-registry → P (pause) e S (steer) do Feature Control valem aqui também.
					let controller: AbortController;
					try {
						controller = registerRun(fid);
					} catch {
						ctx.ui.notify(`pi-harness: a run for "${fid}" is already active.`, "warning");
						return;
					}
					const spawn = makeRpcSpawn({ featureId: fid, model, config: cfg, onClient: (c) => (c ? registerWorkerClient(fid, c) : clearWorkerClient(fid)) });
					try {
						await runLoop(
							ctx.cwd,
							run,
							{
								spawn,
								persist: (r) => writeFeatureRun(ctx.cwd, r),
								log: (ev, extra) => appendProgress(ctx.cwd, fid, ev, extra ?? {}),
								gateSkip: skippedGateSkills(cfg), // skipScrutiny/skipUserTesting do config
								// End-of-run gate (droid parity): só completa com TODAS as assertions `passed`.
								// Bypass quando o qa-validator (quem flipa status.json) foi pulado.
								completionGate: skippedGateSkills(cfg).has("harness-qa-validator") ? undefined : () => completionGate(ctx.cwd, fid),
							},
							controller.signal,
							{ resume, heartbeatMs: 180000 },
						);
					} finally {
						unregisterRun(fid);
						clearWorkerClient(fid);
					}
					ctx.ui.notify(`pi-harness: headless run ${run.status}${run.pauseReason ? ` (${run.pauseReason})` : ""}.`);
					return;
				}
				// Run nativo: branch + run_started + dispatch + cartão vivo (compartilhado com a aprovação do proposal).
				if (mode.featureId) await startFeatureRun(ctx, mode.featureId);
				return;
			}

			const forceSetup = sub === "setup";
			const request = forceSetup ? "" : sub;

			// 1. ensureProfile — gate determinístico (Fatia 2): cria/refresha profile.json
			// (fingerprint de conteúdo) ou avisa drift. O CONTEÚDO do profile
			// (architecture/services/skills) é a setup skill (Fatia 1, LLM) — ainda stub.
			if (forceSetup) {
				// Fatia 1/2: profile EXISTE → REFRESH (merge, não clobber — src/reconcile.ts);
				// ausente → SETUP fresh. Em ambos o profile.json é estampado pela tool
				// `store_profile` no FIM da skill (acopla metadata↔conteúdo; sem baseline prematuro).
				const t = activeTools();
				const existing = ensureProfile(ctx.cwd, { refresh: true });
				if (existing.status === "refresh") {
					const parts = existing.changed.length ? existing.changed.join(", ") : "all";
					dispatchToAgent(buildRefreshDispatch(existing.changed, { todo: t.has("todo") }));
					ctx.ui.notify(`pi-harness: profile REFRESH live — merging (not clobbering) ${parts} → store_profile. tools: ${toolBadge(t, ["todo", "store_profile"])}`);
				} else {
					dispatchToAgent(buildSetupDispatch({ todo: t.has("todo") }));
					ctx.ui.notify(`pi-harness: profile setup live — authoring .harness/profile/ then store_profile. tools: ${toolBadge(t, ["todo", "store_profile"])}`);
				}
				return;
			}
			const prof = ensureProfile(ctx.cwd);
			if (prof.status === "absent") {
				// Sem profile o converge não tem o que ler — bloqueia (não segue pro readiness/converge).
				ctx.ui.notify("pi-harness: no profile yet. Run /harness setup to author .harness/profile/ first.", "warning");
				return;
			} else if (prof.status === "drift") {
				ctx.ui.notify(`pi-harness: profile may be stale (changed: ${prof.changed.join(", ")}). Run /harness setup to refresh.`, "warning");
			}

			// 1.5 onboarding card (feature NOVA — sem plan.json) — analog do missionOnboarding intro, antes
			// do gate. ONCE-ONLY (o `hasSeenMissionOnboarding` do Droid): aparece na primeira feature de
			// todas e nunca mais (flag global em ui-state.json; "continue" grava, cancelar NÃO — re-aparece).
			if (request && ctx.hasUI && !readControlModel(ctx.cwd, featureIdFromRequest(request))) {
				const { markOnboardingSeen, shouldShowOnboarding } = await import("../ui-state.ts");
				if (shouldShowOnboarding()) {
					const { showFeatureOnboarding } = await import("../proposal-view.ts");
					if ((await showFeatureOnboarding(ctx)) === "cancel") {
						ctx.ui.notify("pi-harness: cancelled");
						return;
					}
					markOnboardingSeen();
				}
			}

			// 2. readiness gate — projeta o snapshot num stance + ação primária. O drift
			// (stance `stale`) dispara quando o fingerprint do repo mudou desde a auditoria.
			const snapshot = readSnapshot(ctx.cwd);
			const drift = snapshot ? snapshot.fingerprint !== computeFingerprint(ctx.cwd) : false;
			const gateModel = buildGateModel(snapshot, { targetLevel: READINESS_TARGET_LEVEL, drift });
			let action: GateActionValue = gateModel.stance === "ready" ? "proceed" : "cancel";
			if (ctx.hasUI) {
				const { showReadinessGate } = await import("../readiness-gate.ts");
				action = await showReadinessGate(ctx, gateModel);
			}
			if (action === "cancel") {
				ctx.ui.notify("pi-harness: cancelled");
				return;
			}
			if (action === "reaudit") {
				runAudit(ctx, "gate");
				return;
			}
			if (action === "fix") {
				runFix(ctx, "");
				return;
			}
			if (action === "report") {
				if (!snapshot) {
					ctx.ui.notify("pi-harness: no snapshot — run the audit first.", "warning");
				} else if (ctx.hasUI) {
					const { showReadinessReport } = await import("../readiness-report-view.ts");
					await showReadinessReport(ctx, snapshot, { targetLevel: READINESS_TARGET_LEVEL });
				} else {
					ctx.ui.notify(`pi-harness: readiness ${summarizeSnapshot(snapshot)}`);
				}
				return;
			}

			// 3. activate mode and enter the feature → dispatch convergence (Fatia 3)
			if (!request) {
				ctx.ui.notify('Usage: /harness "<feature description>"', "warning");
				return;
			}
			mode.active = true;
			mode.featureId = featureIdFromRequest(request);
			mode.phase = "converge";
			await applyModeChrome(ctx, mode);
			saveMode(ctx.cwd, mode);
			// Fatia 3: dispara a harness-feature-converge ao vivo (autora feature.md/contract.md/plan.json
			// e chama store_plan, que valida a cobertura e grava plan.json + status.json). O
			// FeatureRunner consome plan.json via buildFeatureRun (ponte converge→runner).
			const t = activeTools();
			dispatchToAgent(buildConvergeDispatch(request, mode.featureId, { todo: t.has("todo") }));
			ctx.ui.notify(`pi-harness: converging "${mode.featureId}" live — authoring .harness/runs/${mode.featureId}/ then store_plan. tools: ${toolBadge(t, ["todo", "store_plan"])}`);
		},
	});

	// Live workers (cap. 06 do overlay): o caminho NATIVO spawna cada worker como `subagent`;
	// eles não têm handoff em disco até o EndFeatureRun, então sem observar os eventos do tool
	// eles NÃO apareciam no Feature Control. Aqui populamos o registro em memória (live-agents)
	// que o overlay (Active Worker + Workers) e o run card leem. Gated em mode.active (só
	// durante um feature run — ignora subagents de readiness/setup/converge).
	// Robusto à STALENESS de mode.phase pós-/reload: o ponteiro em memória pode voltar a idle
	// antes do session_start restaurar, e o guard `phase === "run"` derrubava os eventos do
	// worker (→ Active Worker vazio no overlay). Confia no DISCO: featureId + plan FROZEN
	// (store_plan já correu = passámos do converge) ⇒ trata os subagents como workers do run.
	const runWorkerDispatch = (): boolean => {
		const fid = mode.featureId;
		if (!fid) return false;
		if (mode.phase === "run" || mode.phase === "ship") return true;
		if (mode.phase === "converge" || mode.phase === "setup" || mode.phase === "readiness") return false;
		const cwd = lastCtx?.cwd;
		return !!cwd && readPlan(cwd, fid) !== null;
	};
	pi.on("tool_execution_start", (event) => {
		if (!isSubagentTool(event.toolName) || !runWorkerDispatch()) return;
		const agents = agentsFromArgs(event.args);
		setLiveAgents(event.toolCallId, agents);
		// Sinal DURÁVEL em disco: o caminho nativo não escreve feature-run.json nem step_started,
		// então sem isto o overlay nunca via uma task in_progress / Active Task. Um task_started
		// por task dispatched (ignora reviewers, cujo id é "—") sobrevive a /reload.
		const cwd = lastCtx?.cwd;
		const fid = mode.featureId;
		if (cwd && fid) {
			const seen = new Set<string>();
			for (const a of agents) {
				if (a.taskId === "—" || seen.has(a.taskId)) continue;
				seen.add(a.taskId);
				appendProgress(cwd, fid, "task_started", { taskId: a.taskId, agent: a.agent });
			}
		}
	});
	pi.on("tool_execution_update", (event) => {
		if (!isSubagentTool(event.toolName) || !runWorkerDispatch()) return;
		const live = agentsFromDetails(event.partialResult?.details);
		if (live.length > 0) setLiveAgents(event.toolCallId, live);
	});
	// Proposal confirmation: store_plan persistiu → marca; mostra o overlay quando o agente fica
	// idle. Também limpa o live agent quando o subagent termina (vira handoff em disco).
	pi.on("tool_execution_end", (event, ctx) => {
		if (isSubagentTool(event.toolName)) clearLiveAgents(event.toolCallId);
		if (event.toolName === "store_plan" && !event.isError && mode.active && mode.featureId) pendingProposal = mode.featureId;
		// store_delivery com awaiting_merge → abre o merge gate quando o agente ficar idle.
		if (event.toolName === "store_delivery" && !event.isError && mode.active && mode.featureId) {
			const rec = readDeliveryRecord(ctx.cwd, mode.featureId);
			if (rec?.state === "awaiting_merge") pendingMerge = mode.featureId;
		}
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (pendingProposal) {
			const fid = pendingProposal;
			pendingProposal = null;
			await showProposal(ctx, fid);
		}
		if (pendingMerge) {
			const fid = pendingMerge;
			pendingMerge = null;
			await showMerge(ctx, fid);
		}
	});

	// captura o ctx vivo + RESUME após reload/startup: o ponteiro de modo é memória, mas o run
	// vive no disco (Droid: o runtime lê state.json). Se o run ainda existe, restaura o ponteiro.
	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		// Proactive readiness hint (droid doc 06 §6: getReadinessHint + cli-hints.json): no STARTUP
		// (não no reload), um nudge barato — sem report → /readiness-report; com report → o primeiro
		// gap L1 local (linter/typecheck/formatter/tests/readme/env template). Supressão 24h por path.
		if (event.reason === "startup" && ctx.hasUI) {
			try {
				const { getReadinessHint, markReadinessHintShown } = await import("../readiness-hints.ts");
				const hint = getReadinessHint(ctx.cwd, { hasReport: !!readSnapshot(ctx.cwd) });
				if (hint) {
					ctx.ui.notify(`pi-harness: ${hint.text}`);
					markReadinessHintShown(ctx.cwd, hint);
				}
			} catch {
				// best-effort — um hint nunca quebra o startup
			}
		}
		if (mode.active) return;
		if (event.reason !== "reload" && event.reason !== "startup") return;
		const restored = loadMode(ctx.cwd);
		if (restored && readPlan(ctx.cwd, restored.featureId)) {
			mode.active = true;
			mode.featureId = restored.featureId;
			mode.phase = restored.phase;
			await applyModeChrome(ctx, mode);
			if (ctx.hasUI && mode.phase === "run") {
				strip.start(ctx, restored.featureId);
				// cap. 09: re-insere o cartão vivo após reload (o transcript anterior pode ter sumido).
				if (!cardSent.has(restored.featureId)) {
					cardSent.add(restored.featureId);
					sendRunCard(pi, restored.featureId);
				}
			}
		} else if (restored) {
			clearMode(ctx.cwd); // ponteiro órfão (run sumiu) — limpa
		}
	});
	// Sinais NATIVOS de sessão (pi 0.80.3): a árvore de sessão do orchestrator avançou (nova
	// mensagem/turn, incl. progresso de um subagent) → re-tica o status/run-card a partir do disco,
	// complementando o watcher de fs. Aditivo e guarded (só durante um run com UI).
	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.hasUI && mode.active && (mode.phase === "run" || mode.phase === "ship")) strip.refresh();
	});
	// Sessão renomeada — mantém o ctx vivo (sem ação obrigatória; o nome não entra no nosso chrome).
	pi.on("session_info_changed", (_event, ctx) => {
		lastCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		// gracefulMissionExit analog: pausa TODOS os runs ativos antes de sair — o runner persiste
		// paused/aborted e os workers são interrompidos retendo o transcript (resume re-attacha).
		pauseAllRuns();
		clearAllLiveAgents();
		if (lastCtx) {
			clearModeChrome(lastCtx);
			strip.stop(lastCtx);
		}
	});
}
