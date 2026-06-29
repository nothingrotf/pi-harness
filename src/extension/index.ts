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
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { badgeText, featureIdFromRequest, idleMode, statusDetail, statusText, type HarnessMode } from "../mode.ts";
import { buildGateModel, type GateActionValue, summarizeSnapshot } from "../readiness.ts";
import { appendAudit, ensureReadinessInputs, readSnapshot } from "../readiness-pipeline.ts";
import { buildAuditDispatch, buildFixDispatch } from "../readiness-dispatch.ts";
import { buildSetupDispatch } from "../setup-dispatch.ts";
import { buildRefreshDispatch } from "../reconcile.ts";
import { registerReadinessStoreTool } from "../readiness-store-tool.ts";
import { registerProfileStoreTool } from "../profile-store-tool.ts";
import { registerEndFeatureRunTool } from "../endfeaturerun-tool.ts";
import { registerPlanStoreTool } from "../plan-store-tool.ts";
import { registerLessonsStoreTool } from "../lessons-store-tool.ts";
import { buildConvergeDispatch } from "../converge-dispatch.ts";
import { buildRunDispatch } from "../run-dispatch.ts";
import { defaultModelRef, loadModelConfig, modelOptions, readPiSettings, saveModelConfig, summarizeConfig } from "../model-config.ts";
import { buildFeatureRun, featureProgress, readFeatureRun, readPlan } from "../plan.ts";
import { computeFingerprint } from "../fingerprint.ts";
import { ensureProfile } from "../profile.ts";

const WIDGET_KEY = "harness-mode";
const STATUS_KEY = "harness";

/** Nível mínimo de readiness pra liberar sem fricção. */
const READINESS_TARGET_LEVEL = 4;



async function applyModeChrome(ctx: ExtensionContext, mode: HarnessMode): Promise<void> {
	if (!ctx.hasUI) return;
	const accent = (s: string) => ctx.ui.theme.fg("accent", s);
	// 1. badge colado no input (sinal PRIMÁRIO, sempre)
	ctx.ui.setWidget(WIDGET_KEY, [accent(badgeText(mode))], { placement: "aboveEditor" });
	// 2. status no rodapé
	ctx.ui.setStatus(STATUS_KEY, statusText(mode));
	// 3. input recolorido (REFORÇO, opcional): isolado pra não derrubar o badge se
	// o CustomEditor sumir numa versão futura do Pi.
	try {
		const { harnessEditorFactory } = await import("../harness-editor.ts");
		ctx.ui.setEditorComponent(harnessEditorFactory(accent));
	} catch {
		// recolor indisponível — badge + status seguem valendo.
	}
}

function clearModeChrome(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setEditorComponent(undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

/**
 * Contribui os agentes dedicados (harness-readiness-auditor/remediator) pro pi-subagents
 * via PI_SUBAGENT_EXTRA_AGENT_DIRS — sem escrever no repo do usuário. pi-subagents
 * lê esse env na descoberta (por chamada de subagent), então setar no load basta.
 */
/** Modelos disponíveis (auth configurada) via o modelRegistry da sessão: ref "provider/id" + nome amigável. */
function registryModels(ctx: ExtensionCommandContext): Array<{ ref: string; label: string }> {
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
async function openModelConfig(ctx: ExtensionCommandContext): Promise<void> {
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
	try {
		const dir = fileURLToPath(new URL("../../agents", import.meta.url));
		const env = "PI_SUBAGENT_EXTRA_AGENT_DIRS";
		const cur = process.env[env];
		if (!cur) process.env[env] = dir;
		else if (!cur.split(path.delimiter).includes(dir)) process.env[env] = `${cur}${path.delimiter}${dir}`;
	} catch {
		// best-effort: sem isso, os dispatches caem nos builtins delegate/worker.
	}
}

export default function registerHarnessExtension(pi: ExtensionAPI): void {
	const mode: HarnessMode = idleMode();
	let lastCtx: ExtensionContext | undefined;

	// Estágio STORE da criação do readiness (analógo do store_agent_readiness_report).
	registerReadinessStoreTool(pi);
	// Estágio STORE do setup do profile (valida o conteúdo autorado → estampa profile.json).
	registerProfileStoreTool(pi);
	// Saída do worker/validator: registra o handoff que o FeatureRunner lê (handoff.ts).
	registerEndFeatureRunTool(pi);
	// Estágio STORE da convergência: valida cobertura → grava plan.json + status.json.
	registerPlanStoreTool(pi);
	// store_lesson — a camada de lições auto-melhorável (grounded em sinais do ship gate).
	registerLessonsStoreTool(pi);
	// Agentes dedicados pro pi-subagents (harness-readiness-auditor / harness-readiness-remediator).
	contributeAgentsDir();

	// DISPATCH NATIVO (model-driven, in-session) — o jeito nativo: os tool calls
	// streamam ao vivo no terminal e o **rpiv-todo** mostra o Plan das 5 fases. Sem
	// widget custom nem subprocesso. (O ReadinessRunner code-initiated continua
	// disponível pro headless/CI — ver src/readiness-runner.ts e docs/02.)
	// Detecta em runtime quais tools companheiros estão ATIVOS na sessão, pra usar
	// (e avisar) os que existem: rpiv-todo (`todo`) e pi-subagents (`subagent`).
	const activeTools = (): Set<string> => {
		try {
			return new Set(pi.getActiveTools());
		} catch {
			return new Set();
		}
	};
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
		pi.sendUserMessage(buildAuditDispatch({ todo: t.has("todo") }));
		ctx.ui.notify(`pi-harness: live audit — tools: ${toolBadge(t, ["todo", "store_agent_readiness_report"])}`);
	};

	const runFix = (ctx: ExtensionCommandContext, args: string): void => {
		if (!readSnapshot(ctx.cwd)) {
			ctx.ui.notify("pi-harness: no report yet — running the audit first.");
			runAudit(ctx, "/readiness-fix");
			return;
		}
		const t = activeTools();
		appendAudit(ctx.cwd, "fix_dispatched", { hasArgs: args.trim().length > 0, todo: t.has("todo"), subagent: t.has("subagent") });
		pi.sendUserMessage(buildFixDispatch(args, { todo: t.has("todo"), subagent: t.has("subagent") }));
		ctx.ui.notify(`pi-harness: live remediation — tools: ${toolBadge(t, ["todo", "subagent"])}`);
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

	pi.registerCommand("harness", {
		description: "Enter harness mode: profile setup → readiness → feature (sequential).",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			lastCtx = ctx;
			const sub = args.trim();

			if (sub === "exit") {
				Object.assign(mode, idleMode());
				clearModeChrome(ctx);
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
				ctx.ui.notify(`pi-harness: HEADLESS feature "${fid}" — converge (pi --print) → runner. Blocks until done.`);
				const { makeRealConvergeFn, makeRealSpawn } = await import("../feature-spawn.ts");
				const { runHeadlessFeature } = await import("../headless.ts");
				const model = (ctx as { model?: { id?: string } }).model?.id;
				const cfg = loadModelConfig(); // per-role model+effort overrides (global)
				const res = await runHeadlessFeature(ctx.cwd, {
					request,
					featureId: fid,
					converge: makeRealConvergeFn({ model, config: cfg }),
					spawn: makeRealSpawn({ featureId: fid, model, config: cfg }),
				});
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
				if (!mode.active || !mode.featureId) {
					ctx.ui.notify('pi-harness: no active feature. Run /harness "<feature>" to converge first.', "warning");
					return;
				}
				if (!readPlan(ctx.cwd, mode.featureId)) {
					ctx.ui.notify(`pi-harness: no plan.json for "${mode.featureId}" yet — finish convergence first.`, "warning");
					return;
				}
				mode.phase = "run";
				await applyModeChrome(ctx, mode);
				if (sub === "run --headless") {
					// CI/headless: o FeatureRunner spawna `pi --print` por step (NÃO in-chat) e BLOQUEIA
					// até terminar. Opt-in explícito — o default visível é o nativo acima.
					const fid = mode.featureId;
					const run = readFeatureRun(ctx.cwd, fid) ?? buildFeatureRun(ctx.cwd, fid);
					if (!run) {
						ctx.ui.notify("pi-harness: no plan to run.", "warning");
						return;
					}
					ctx.ui.notify(`pi-harness: HEADLESS run of "${fid}" (FeatureRunner; pi --print children, not in-chat). Blocks until done.`);
					const { makeRealSpawn } = await import("../feature-spawn.ts");
					const { runLoop } = await import("../feature-runner.ts");
					const { writeFeatureRun } = await import("../plan.ts");
					const { appendProgress } = await import("../handoff.ts");
					const model = (ctx as { model?: { id?: string } }).model?.id;
					const spawn = makeRealSpawn({ featureId: fid, model, config: loadModelConfig() });
					await runLoop(ctx.cwd, run, {
						spawn,
						persist: (r) => writeFeatureRun(ctx.cwd, r),
						log: (ev, extra) => appendProgress(ctx.cwd, fid, ev, extra ?? {}),
					});
					ctx.ui.notify(`pi-harness: headless run ${run.status}${run.pauseReason ? ` (${run.pauseReason})` : ""}.`);
					return;
				}
				const t = activeTools();
				pi.sendUserMessage(buildRunDispatch(mode.featureId, { todo: t.has("todo"), subagent: t.has("subagent"), advisor: t.has("advisor"), askUser: t.has("ask_user_question") }));
				ctx.ui.notify(`pi-harness: executing "${mode.featureId}" live — workers → ship gate. tools: ${toolBadge(t, ["todo", "subagent", "advisor", "ask_user_question"])}`);
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
					pi.sendUserMessage(buildRefreshDispatch(existing.changed, { todo: t.has("todo") }));
					ctx.ui.notify(`pi-harness: profile REFRESH live — merging (not clobbering) ${parts} → store_profile. tools: ${toolBadge(t, ["todo", "store_profile"])}`);
				} else {
					pi.sendUserMessage(buildSetupDispatch({ todo: t.has("todo") }));
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
			// Fatia 3: dispara a harness-feature-converge ao vivo (autora feature.md/contract.md/plan.json
			// e chama store_plan, que valida a cobertura e grava plan.json + status.json). O
			// FeatureRunner consome plan.json via buildFeatureRun (ponte converge→runner).
			const t = activeTools();
			pi.sendUserMessage(buildConvergeDispatch(request, mode.featureId, { todo: t.has("todo") }));
			ctx.ui.notify(`pi-harness: converging "${mode.featureId}" live — authoring .harness/runs/${mode.featureId}/ then store_plan. tools: ${toolBadge(t, ["todo", "store_plan"])}`);
		},
	});

	// captura o ctx vivo pra poder limpar o chrome no shutdown
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		lastCtx = ctx;
	});
	pi.on("session_shutdown", () => {
		if (lastCtx) clearModeChrome(lastCtx);
	});
}
