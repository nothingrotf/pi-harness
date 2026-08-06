import { test } from "node:test";
import assert from "node:assert/strict";
import { currentCeilingAgents, GATE_ALLOWED_AGENTS, ORCHESTRATOR_ANALYSIS_AGENTS, syncCapabilityCeiling } from "../src/capability-ceiling.ts";

const REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";

function rawRegistry(): Map<string, Map<symbol, { source: string; ceiling: { version: number; allowedAgents?: string[]; denyExtensions: boolean; sources: string[] } }>> {
	const key = Symbol.for(REGISTRY_KEY);
	return (globalThis as Record<symbol, unknown>)[key] as ReturnType<typeof rawRegistry>;
}

test("syncCapabilityCeiling: registra a allowlist no registry global versionado do pi-subagents", () => {
	syncCapabilityCeiling("sess-1", ORCHESTRATOR_ANALYSIS_AGENTS);
	const agents = currentCeilingAgents("sess-1");
	assert.ok(agents?.includes("scout"));
	assert.ok(agents?.includes("harness-correctness-review"));
	assert.ok(!agents?.includes("worker"), "o builtin edit-capable `worker` fica FORA do teto do orchestrator");
	assert.ok(!agents?.includes("reviewer"), "`reviewer` (edit-capable) fora");
	// shape exata do contrato do provider (Registration com ceiling.version 1 + sources)
	const entry = [...(rawRegistry().get("sess-1")?.values() ?? [])][0];
	assert.equal(entry?.source, "pi-harness");
	assert.equal(entry?.ceiling.version, 1);
	assert.equal(entry?.ceiling.denyExtensions, false);
	assert.deepEqual(entry?.ceiling.sources, ["pi-harness"]);
	syncCapabilityCeiling("sess-1", null);
});

test("syncCapabilityCeiling: idempotente por turno; null remove; troca de sessão migra", () => {
	syncCapabilityCeiling("sess-a", GATE_ALLOWED_AGENTS);
	syncCapabilityCeiling("sess-a", GATE_ALLOWED_AGENTS);
	assert.equal(rawRegistry().get("sess-a")?.size, 1, "re-sync não duplica registros");
	syncCapabilityCeiling("sess-b", GATE_ALLOWED_AGENTS);
	assert.equal(currentCeilingAgents("sess-a"), null, "troca de sessão remove o registro antigo");
	assert.ok(currentCeilingAgents("sess-b")?.includes("harness-qa-flow-validator"));
	syncCapabilityCeiling("sess-b", null);
	assert.equal(currentCeilingAgents("sess-b"), null, "null remove o teto");
	assert.equal(rawRegistry().get("sess-b"), undefined, "sessão vazia sai do registry");
});

test("listas: gate cobre os 4 validators do harness; orchestrator só análise", () => {
	for (const a of ["harness-correctness-review", "harness-quality-review", "harness-conventions-review", "harness-qa-flow-validator"]) {
		assert.ok(GATE_ALLOWED_AGENTS.includes(a), `gate permite ${a}`);
	}
	assert.ok(!ORCHESTRATOR_ANALYSIS_AGENTS.includes("harness-qa-flow-validator"), "qa-flow é do gate, não do orchestrator");
	assert.ok(!GATE_ALLOWED_AGENTS.includes("worker"));
});
