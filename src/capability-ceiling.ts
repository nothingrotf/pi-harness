/**
 * F3 — capability ceiling do pi-subagents: a regra nº 1 do harness ("o orchestrator NUNCA
 * implementa; `subagent` é só análise") vira MECANISMO em vez de prosa. Registramos um teto de
 * sessão no registry compartilhado do provider (`Symbol.for("pi-subagents.capability-ceiling.v1")`
 * — contrato público versionado, process-local); spawns de agents fora da allowlist FALHAM antes
 * do launch, e o teto propaga monotonicamente pra filhos aninhados.
 *
 * Escrevemos direto no registry global (mesma shape do registerSubagentCapabilityCeiling do
 * provider) em vez de importar o pacote: a extensão pi-harness resolve módulos a partir do seu
 * próprio dir e o pi-subagents vive no dir global de pacotes do pi — o Symbol.for existe
 * exatamente pra módulos independentes se encontrarem num processo. Se o provider não estiver
 * instalado, o registro é inerte (ninguém lê) — zero acoplamento duro.
 */

const REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";
const SOURCE = "pi-harness";

interface ResolvedCeiling {
	version: 1;
	allowedTools?: string[];
	allowedAgents?: string[];
	denyExtensions: boolean;
	sources: string[];
}
interface Registration {
	source: string;
	ceiling: ResolvedCeiling;
}
type Registry = Map<string, Map<symbol, Registration>>;

function registry(): Registry {
	const key = Symbol.for(REGISTRY_KEY);
	const store = globalThis as typeof globalThis & { [k: symbol]: unknown };
	const existing = store[key];
	if (existing instanceof Map) return existing as Registry;
	const created: Registry = new Map();
	store[key] = created;
	return created;
}

/** Sessão do ORCHESTRATOR em run/ship: análise/investigação apenas — nada edit-capable. */
export const ORCHESTRATOR_ANALYSIS_AGENTS: readonly string[] = [
	"scout",
	"researcher",
	"planner",
	"oracle",
	"advisor",
	"delegate",
	"context-builder",
	"harness-correctness-review",
	"harness-quality-review",
	"harness-conventions-review",
	"harness-readiness-auditor",
];

/** Sessão de SHIP-GATE: os validators/reviewers do harness (+ delegate p/ análise avulsa). */
export const GATE_ALLOWED_AGENTS: readonly string[] = [
	"harness-correctness-review",
	"harness-quality-review",
	"harness-conventions-review",
	"harness-qa-flow-validator",
	"delegate",
	"scout",
];

const token = Symbol(SOURCE);
let registeredSession: string | null = null;

/**
 * Sincroniza o teto da sessão (idempotente — seguro chamar todo turno): `agents` não-nulo
 * registra/atualiza a allowlist; null remove o teto. Troca de sessionId migra o registro.
 */
export function syncCapabilityCeiling(sessionId: string | null | undefined, agents: readonly string[] | null): void {
	const reg = registry();
	if (registeredSession && registeredSession !== sessionId) {
		const old = reg.get(registeredSession);
		old?.delete(token);
		if (old && old.size === 0) reg.delete(registeredSession);
		registeredSession = null;
	}
	if (!sessionId || !agents) {
		if (registeredSession) {
			const cur = reg.get(registeredSession);
			cur?.delete(token);
			if (cur && cur.size === 0) reg.delete(registeredSession);
			registeredSession = null;
		}
		return;
	}
	let session = reg.get(sessionId);
	if (!session) {
		session = new Map();
		reg.set(sessionId, session);
	}
	session.set(token, {
		source: SOURCE,
		ceiling: { version: 1, allowedAgents: [...new Set(agents)].sort(), denyExtensions: false, sources: [SOURCE] },
	});
	registeredSession = sessionId;
}

/** Estado atual (testes/diagnóstico): a allowlist registrada pra sessão, ou null. */
export function currentCeilingAgents(sessionId: string): string[] | null {
	const session = registry().get(sessionId);
	const entry = session?.get(token);
	return entry?.ceiling.allowedAgents ?? null;
}
