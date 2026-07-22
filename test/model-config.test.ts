import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultModelConfig,
	defaultModelRef,
	effortLabel,
	type HarnessModelConfig,
	isEffort,
	modelLabel,
	roleSummary,
	loadModelConfig,
	modelConfigPath,
	modelOptions,
	normalizeModelConfig,
	orchestratorModelNudge,
	skippedGateSkills,
	type PiSettingsView,
	piSettingsPath,
	readPiSettings,
	resolveChoice,
	roleForStep,
	saveModelConfig,
	summarizeConfig,
} from "../src/model-config.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-models-"));
}

test("defaultModelConfig: 3 roles, todos herdam (vazios)", () => {
	const c = defaultModelConfig();
	assert.equal(c.version, 1);
	assert.deepEqual(c.roles, { orchestrator: {}, worker: {}, validator: {} });
});

test("isEffort: aceita os 7 níveis do --thinking, rejeita o resto", () => {
	for (const e of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.ok(isEffort(e), e);
	for (const x of ["", "extreme", "HIGH", 3, null, undefined]) assert.ok(!isEffort(x as unknown), String(x));
});

test("normalizeModelConfig: tolera garbage/parcial; descarta thinking inválido e model vazio/sentinela", () => {
	assert.deepEqual(normalizeModelConfig(null).roles, defaultModelConfig().roles);
	assert.deepEqual(normalizeModelConfig({ roles: 42 }).roles, defaultModelConfig().roles);
	const c = normalizeModelConfig({
		roles: {
			orchestrator: { model: "anthropic/claude-opus-4-8", thinking: "high" },
			worker: { model: "  ", thinking: "extreme" }, // model vazio + thinking inválido → limpos
			validator: { model: "(inherit)", thinking: "off" }, // sentinela → vira herdar
			bogus: { model: "x" }, // role desconhecido é ignorado
		},
	});
	assert.deepEqual(c.roles.orchestrator, { model: "anthropic/claude-opus-4-8", thinking: "high" });
	assert.deepEqual(c.roles.worker, {}, "model vazio e thinking inválido caem");
	assert.deepEqual(c.roles.validator, { thinking: "off" }, "(inherit) limpa o model; off é válido");
	assert.equal((c.roles as Record<string, unknown>).bogus, undefined);
});

test("load/save: round-trip num agentDir isolado; ausente → defaults", () => {
	const dir = tmp();
	assert.deepEqual(loadModelConfig({ agentDir: dir }), defaultModelConfig(), "ausente → defaults");
	const cfg: HarnessModelConfig = {
		version: 1,
		roles: { orchestrator: { model: "anthropic/claude-opus-4-8", thinking: "xhigh" }, worker: { model: "anthropic/claude-haiku-4-5" }, validator: { thinking: "high" } },
		gates: { skipScrutiny: true, skipUserTesting: false, skipDelivery: true },
	};
	saveModelConfig(cfg, { agentDir: dir });
	assert.ok(fs.existsSync(modelConfigPath({ agentDir: dir })), "gravou em pi-harness/models.json");
	assert.deepEqual(loadModelConfig({ agentDir: dir }), cfg, "lê de volta idêntico (incl. gates)");
});

test("gates: default OFF; normalize coáge só booleano true; skippedGateSkills mapeia", () => {
	assert.deepEqual(defaultModelConfig().gates, { skipScrutiny: false, skipUserTesting: false, skipDelivery: false });
	const n = normalizeModelConfig({ gates: { skipScrutiny: true, skipUserTesting: "yes", skipDelivery: "yes" } });
	assert.deepEqual(n.gates, { skipScrutiny: true, skipUserTesting: false, skipDelivery: false }, "só `true` literal vira ON");
	assert.deepEqual([...skippedGateSkills(n)], ["harness-code-review"]);
	const both = normalizeModelConfig({ gates: { skipScrutiny: true, skipUserTesting: true, skipDelivery: true } });
	assert.deepEqual([...skippedGateSkills(both)].sort(), ["harness-code-review", "harness-deliver", "harness-qa-validator"]);
	assert.deepEqual([...skippedGateSkills(defaultModelConfig())], [], "nada skip por default");
});

test("load: JSON corrompido → defaults (não explode)", () => {
	const dir = tmp();
	const file = modelConfigPath({ agentDir: dir });
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{ not json");
	assert.deepEqual(loadModelConfig({ agentDir: dir }), defaultModelConfig());
});

test("readPiSettings + defaultModelRef: lê o settings.json do usuário", () => {
	const dir = tmp();
	fs.writeFileSync(
		piSettingsPath({ agentDir: dir }),
		JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8", defaultThinkingLevel: "xhigh", enabledModels: ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.5"] }),
	);
	const s = readPiSettings({ agentDir: dir });
	assert.equal(s.defaultModel, "claude-opus-4-8");
	assert.equal(s.defaultThinkingLevel, "xhigh");
	assert.deepEqual(s.enabledModels, ["anthropic/claude-haiku-4-5", "openai-codex/gpt-5.5"]);
	assert.equal(defaultModelRef(s), "anthropic/claude-opus-4-8", "prefixa o provider quando o id não tem '/'");
	assert.equal(defaultModelRef({ defaultModel: "anthropic/x" }), "anthropic/x", "id já com '/' não duplica");
	assert.equal(defaultModelRef({}), undefined);
});

test("readPiSettings: settings ausente → vazio", () => {
	assert.deepEqual(readPiSettings({ agentDir: tmp() }), {});
});

test("modelOptions: dedup, default primeiro, depois enabled, depois registry", () => {
	const settings: PiSettingsView = { defaultProvider: "anthropic", defaultModel: "claude-opus-4-8", enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-8"] };
	const registry = ["openai-codex/gpt-5.5", "anthropic/claude-haiku-4-5"];
	assert.deepEqual(modelOptions(registry, settings), ["anthropic/claude-opus-4-8", "anthropic/claude-haiku-4-5", "openai-codex/gpt-5.5"]);
});

test("roleForStep: task → worker; ship-gate → validator", () => {
	assert.equal(roleForStep({ kind: "task" }), "worker");
	assert.equal(roleForStep({ kind: "ship_gate" }), "validator");
	assert.equal(roleForStep({ kind: "whatever" }), "validator");
});

test("resolveChoice: override do role > fallback; thinking 'off' passa; undefined herda", () => {
	const cfg: HarnessModelConfig = {
		version: 1,
		roles: { orchestrator: { model: "anthropic/claude-opus-4-8", thinking: "xhigh" }, worker: { thinking: "off" }, validator: {} },
		gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false },
	};
	// orchestrator: usa o override
	assert.deepEqual(resolveChoice(cfg, "orchestrator", "fallback/model"), { model: "anthropic/claude-opus-4-8", thinking: "xhigh" });
	// worker: sem model no override → cai no fallback; thinking 'off' é explícito
	assert.deepEqual(resolveChoice(cfg, "worker", "fallback/model"), { model: "fallback/model", thinking: "off" });
	// validator: tudo herdado → model = fallback, thinking undefined
	assert.deepEqual(resolveChoice(cfg, "validator", "fallback/model"), { model: "fallback/model", thinking: undefined });
	// sem config nenhum → só o fallback
	assert.deepEqual(resolveChoice(undefined, "worker", "fb"), { model: "fb", thinking: undefined });
	// sem config e sem fallback → herda tudo (nada é passado)
	assert.deepEqual(resolveChoice(undefined, "worker"), { model: undefined, thinking: undefined });
});

test("effortLabel/modelLabel: capitaliza effort; usa label do registry senão o id", () => {
	assert.equal(effortLabel("xhigh"), "XHigh");
	assert.equal(effortLabel("max"), "Max");
	assert.equal(effortLabel("off"), "Off");
	assert.equal(effortLabel(undefined), "inherit");
	assert.equal(modelLabel("anthropic/claude-opus-4-8", { labels: { "anthropic/claude-opus-4-8": "Claude Opus 4.8" } }), "Claude Opus 4.8");
	assert.equal(modelLabel("anthropic/claude-opus-4-8"), "claude-opus-4-8", "sem label → id (parte após /)");
	assert.equal(modelLabel(undefined), "inherit");
});

test("roleSummary: display combinado 'Model (Effort)'", () => {
	const labels = { "anthropic/claude-opus-4-8": "Claude Opus 4.8" };
	const cfg: HarnessModelConfig = { version: 1, roles: { orchestrator: { model: "anthropic/claude-opus-4-8", thinking: "xhigh" }, worker: {}, validator: { thinking: "high" } }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	assert.equal(roleSummary(cfg, "orchestrator", { labels }), "Claude Opus 4.8 (XHigh)");
	assert.equal(roleSummary(cfg, "worker", { labels, fallback: "anthropic/claude-opus-4-8" }), "inherit→Claude Opus 4.8 (inherit)");
	assert.equal(roleSummary(cfg, "validator", { labels }), "inherit→session (High)");
});

test("summarizeConfig: uma linha por role, display combinado", () => {
	const cfg: HarnessModelConfig = { version: 1, roles: { orchestrator: { model: "anthropic/claude-opus-4-8", thinking: "xhigh" }, worker: {}, validator: { thinking: "high" } }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	const s = summarizeConfig(cfg, { fallback: "anthropic/claude-opus-4-8", labels: { "anthropic/claude-opus-4-8": "Claude Opus 4.8" } });
	assert.match(s, /orchestrator: Claude Opus 4.8 \(XHigh\)/);
	assert.match(s, /worker: inherit→Claude Opus 4.8 \(inherit\)/);
	assert.match(s, /validator: inherit→Claude Opus 4.8 \(High\)/);
});

test("orchestratorModelNudge: avisa quando o modelo da sessão diverge do role configurado", () => {
	const cfg: HarnessModelConfig = { version: 1, roles: { orchestrator: { model: "anthropic/claude-opus-4-8" }, worker: {}, validator: {} }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	const msg = orchestratorModelNudge({ provider: "openai", id: "gpt-5.6-luna" }, cfg);
	assert.ok(msg?.includes('configured as "anthropic/claude-opus-4-8"'));
	assert.ok(msg?.includes("openai/gpt-5.6-luna"));
	assert.ok(msg?.includes("headless converge"));
});

test("orchestratorModelNudge: silencioso quando coincide (ref completa, id puro, sufixo /id)", () => {
	const cfg: HarnessModelConfig = { version: 1, roles: { orchestrator: { model: "anthropic/claude-opus-4-8" }, worker: {}, validator: {} }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	assert.equal(orchestratorModelNudge({ provider: "anthropic", id: "claude-opus-4-8" }, cfg), null);
	assert.equal(orchestratorModelNudge({ id: "claude-opus-4-8" }, cfg), null, "sem provider → match por sufixo /id");
	const bareCfg: HarnessModelConfig = { version: 1, roles: { orchestrator: { model: "claude-opus-4-8" }, worker: {}, validator: {} }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	assert.equal(orchestratorModelNudge({ provider: "anthropic", id: "claude-opus-4-8" }, bareCfg), null, "config sem provider → match por id");
});

test("orchestratorModelNudge: silencioso sem override configurado ou sem modelo de sessão", () => {
	const noOverride: HarnessModelConfig = { version: 1, roles: { orchestrator: {}, worker: {}, validator: {} }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	assert.equal(orchestratorModelNudge({ provider: "openai", id: "gpt-5.6-luna" }, noOverride), null);
	const cfg: HarnessModelConfig = { version: 1, roles: { orchestrator: { model: "anthropic/claude-opus-4-8" }, worker: {}, validator: {} }, gates: { skipScrutiny: false, skipUserTesting: false, skipDelivery: false } };
	assert.equal(orchestratorModelNudge(undefined, cfg), null);
	assert.equal(orchestratorModelNudge({}, cfg), null);
	assert.equal(orchestratorModelNudge({ id: "x" }, undefined), null);
});
