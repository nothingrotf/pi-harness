/**
 * Contract reader — parser determinístico do `contract.md` (FROZEN) de uma feature.
 *
 * Formato canônico (harness-feature-converge Phase 3): cada assertion é um heading
 * `### <ID>: <título>` seguido do corpo (descrição + Tool + Evidence) até o próximo heading.
 * O contract é FROZEN após a convergência, então o parse é estável durante o run.
 *
 * Uso principal: o brief da task (research 2026-07-13 harness-fusion-methodology, OQ1) — o
 * `next_task` resolve os `fulfills` (IDs) para o TEXTO das assertions e injeta no spec entregue
 * ao worker. Racional: constraint escrita no brief sobrevive; referência que o worker precisa ir
 * buscar evapora (o exemplo do hash O(1) do artigo Fusion). Parser em TS (não duplicação via
 * store_plan) elimina o risco de paráfrase do LLM e não incha o plan.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runDir } from "./handoff.ts";
import type { Task } from "./plan.ts";

/** `### VAL-AUTH-001: Successful login` → id + resto da linha como título. */
const HEADING = /^###\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;

/**
 * Extrai as assertions de um contract.md: id → texto ("Título.\ncorpo até o próximo heading").
 * Tolerante a prosa/preâmbulo/seções `##` (ignorados). Puro (testável).
 */
export function parseContractAssertions(md: string): Map<string, string> {
	const out = new Map<string, string>();
	let id: string | null = null;
	let buf: string[] = [];
	const flush = (): void => {
		if (id) out.set(id, buf.join("\n").trim());
		id = null;
		buf = [];
	};
	for (const line of md.split("\n")) {
		const m = HEADING.exec(line);
		if (m) {
			flush();
			id = m[1];
			if (m[2].trim()) buf.push(m[2].trim());
			continue;
		}
		if (/^##[^#]/.test(line)) {
			flush(); // nova área/seção — fecha a assertion corrente
			continue;
		}
		if (id) buf.push(line);
	}
	flush();
	return out;
}

/** Lê + parseia o contract.md da feature. Map vazio quando o ficheiro não existe/não parseia. */
export function readContractAssertions(cwd: string, featureId: string): Map<string, string> {
	try {
		const md = fs.readFileSync(path.join(runDir(cwd, featureId), "contract.md"), "utf8");
		return parseContractAssertions(md);
	} catch {
		return new Map();
	}
}

export interface TaskSpec {
	id: string;
	description: string;
	skillName: string;
	fulfills: string[];
	preconditions: string[];
	expectedBehavior: string[];
	/** texto das assertions do contract que esta task completa (brief autocontido). */
	contractAssertions?: { id: string; text: string }[];
}

/**
 * Spec da task entregue ao worker pelo `next_task` — com os `fulfills` RESOLVIDOS para o texto
 * das assertions (quando o contract os tem). IDs sem texto no contract ficam só na lista
 * `fulfills` (o worker ainda pode consultar o contract.md; nada é silenciosamente perdido).
 */
export function buildTaskSpec(task: Task, assertions: ReadonlyMap<string, string>): TaskSpec {
	const spec: TaskSpec = {
		id: task.id,
		description: task.description,
		skillName: task.skillName,
		fulfills: task.fulfills ?? [],
		preconditions: task.preconditions ?? [],
		expectedBehavior: task.expectedBehavior ?? [],
	};
	const resolved = (task.fulfills ?? []).filter((a) => assertions.has(a)).map((a) => ({ id: a, text: assertions.get(a) as string }));
	if (resolved.length > 0) spec.contractAssertions = resolved;
	return spec;
}
