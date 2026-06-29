/**
 * Port 1:1 da lógica do /readiness-fix do referência (modelo de referência):
 * a referência
 *
 * Reproduz os builders de prompt (funções $99, $h0, I99) VERBATIM (texto em
 * inglês), com as 3 variantes (report+args / report+no-args / no-report) e o
 * anti-gaming. A única diferença local: o report vem do snapshot LOCAL
 * (readiness.json) em vez do Firestore.
 */
import * as fs from "node:fs";
import { CRITERION_BY_ID } from "./readiness-criteria.ts";
import type { ReadinessSnapshot } from "./readiness.ts";

/** Carrega description+instructions do criteria.json (1:1 do referência). */
let CRITERIA_DATA: Map<string, { description: string; instructions: string }> | null = null;
function criteriaData(): Map<string, { description: string; instructions: string }> {
	if (CRITERIA_DATA) return CRITERIA_DATA;
	CRITERIA_DATA = new Map();
	try {
		const url = new URL("../skills/harness-readiness-audit/criteria.json", import.meta.url);
		const arr = JSON.parse(fs.readFileSync(url, "utf8")) as Array<{ id: string; description: string; instructions: string }>;
		for (const c of arr) CRITERIA_DATA.set(c.id, { description: c.description, instructions: c.instructions });
	} catch {
		// sem o catálogo, os campos description/instructions saem vazios (degrada)
	}
	return CRITERIA_DATA;
}

export interface FailingSignal {
	id: string;
	name: string;
	num: number;
	den: number;
	rationale: string;
}

/**
 * Sinais falhando = critérios com num não-null que não passam por completo
 * (num < den). Espelha o Ih0(report) do referência (status === "failed").
 */
export function failingSignals(snapshot: ReadinessSnapshot): FailingSignal[] {
	const out: FailingSignal[] = [];
	for (const [id, ev] of Object.entries(snapshot.evals)) {
		if (ev.num === null) continue;
		const den = ev.den > 0 ? ev.den : 1;
		if (ev.num >= den) continue; // passou → não é failing
		const crit = CRITERION_BY_ID.get(id);
		if (!crit) continue;
		out.push({ id, name: crit.name, num: ev.num, den, rationale: ev.rationale ?? "" });
	}
	return out;
}

/**
 * Prompt de remediação de UM critério (pro child harness-readiness-remediator code-spawned).
 * Header + o sinal renderizado (com Description + Evaluation instructions do
 * criteria.json) + Fix Instructions/Quality Standards verbatim (a referência).
 */
export function buildCriterionFixPrompt(signal: FailingSignal): string {
	return `${HEADER}
${renderFailing([signal])}
## Your Task
Fix this one failing signal end to end.
${fixInstructions()}`;
}

// ── builders verbatim (a referência) ───────────────────────────────────────────────

/** $99() — Fix Instructions + Quality Standards (verbatim). */
function fixInstructions(): string {
	return `## Fix Instructions
For each signal you are fixing:
1. Explore the repository to understand the current state related to the signal
2. Make **substantive improvements** to the codebase that genuinely address the signal
3. Verify your fix addresses the issue (e.g., run linter if fixing lint_config, run tests if adding tests)
4. Keep changes focused on the signal - don't refactor unrelated code
## Completion
- Provide a succinct summary of what you changed and why it genuinely improves the codebase
## CRITICAL: Quality Standards
Your fix must **genuinely improve the codebase**. Do NOT use workarounds or shortcuts:
- **NO** empty placeholder files (e.g., empty test files, stub configs)
- **NO** minimal implementations that technically pass but provide no real value
- **NO** disabling checks or adding skip markers to pass validation
- **NO** trivial changes that game the metric without improving quality
Examples of BAD fixes:
- Adding an empty \`test.js\` file to satisfy "has tests" criterion
- Creating a \`.eslintrc\` that disables all rules
- Adding \`// @ts-nocheck\` to satisfy TypeScript requirements
Examples of GOOD fixes:
- Writing actual unit tests with meaningful assertions for existing code
- Configuring ESLint with appropriate rules for the project's language/framework
- Adding proper TypeScript types to improve type safety`;
}

/** $h0(O) — render da lista de sinais falhando (verbatim). */
function renderFailing(failing: FailingSignal[]): string {
	const data = criteriaData();
	const rows = failing.map((f) => {
		const d = data.get(f.id);
		return `- (\`${f.id}\`): ${f.name} - ${f.rationale}
  Description: ${d?.description ?? ""}
  Evaluation instructions: ${d?.instructions ?? ""}`;
	});
	return `## Failing Signals (${failing.length} total)
${rows.join("\n")}`;
}

const HEADER =
	"You are fixing failing Agent Readiness signals. Agent Readiness evaluates how well a repository supports autonomous AI agents working on the codebase.";

/**
 * Camada de orquestração pi-harness (NÃO é do a referência — é nossa). Alinha a
 * coordenação com o referência: cada fix roda numa SESSÃO ISOLADA (fresh-context
 * worker via pi-subagents), uma por critério em sequência, espelhando as sessões
 * readiness-remediation do modelo de referência; progresso rastreado com rpiv-todo.
 */
const ORCHESTRATION_FOOTER = `## Execution (pi-harness orchestration — pi-subagents + rpiv-todo)
Run fixes in ISOLATION, one per criterion, mirroring the reference's per-criterion readiness-remediation sessions:
1. Create one todo per signal you will fix: \`todo({ action: "create", subject: "<criterion name>" })\`.
2. For each signal, in sequence (keep writes single-threaded):
   - mark it in_progress: \`todo({ action: "update", id, status: "in_progress" })\`;
   - spawn the dedicated remediator in its own isolated session:
     \`subagent({ agent: "harness-readiness-remediator", async: true, task: "Fix the readiness signal <id> (<name>). Use that signal's Description and Evaluation instructions from the list above. Follow the Fix Instructions and CRITICAL Quality Standards above — genuine improvement, no gaming. Report exactly what changed." })\`;
   - when it returns, mark it completed: \`todo({ action: "update", id, status: "completed" })\`.
3. Do NOT run multiple writer workers concurrently on the same worktree.
4. After all fixes, suggest running /readiness-report to re-audit and confirm the new level.`;

export type FixPlan =
	| { kind: "audit" } // sem report → roda a avaliação primeiro
	| { kind: "none"; text: string } // nada falhando
	| { kind: "prompt"; text: string }; // prompt de fix pronto pra despachar

/**
 * I99({ report, userArgs }) — constrói a variante certa. Port 1:1:
 *  - sem report → "run the evaluation first" (audit)
 *  - report + args → casar semanticamente os sinais pedidos e corrigir em sequência
 *  - report + no args → agrupar por categoria, AskUser categoria → AskUser sinal → corrigir
 */
export function buildFixPlan(snapshot: ReadinessSnapshot | null, userArgs: string): FixPlan {
	const args = userArgs.trim();
	if (snapshot === null) return { kind: "audit" };

	const failing = failingSignals(snapshot);
	if (failing.length === 0) {
		return { kind: "none", text: "All readiness signals are passing for this repository. No fixes needed." };
	}

	if (args.length > 0) {
		const text = `${HEADER}
${renderFailing(failing)}
## User Requested Signals
The user asked to fix: "${args}"
## Your Task
1. Semantically match the user's requested signals ("${args}") to the failing signals listed above.
   - Match by criterion ID (e.g., "lint_config"), criterion name (e.g., "Linter Configuration"), or semantic meaning (e.g., "the cyclomatic complexity criteria" matches \`cyclomatic_complexity\`).
   - If a requested signal already passes, note that it passes and skip it.
   - If a requested signal doesn't match any known criterion, note that and skip it.
2. For each matched failing signal, fix it in sequence.
${fixInstructions()}
${ORCHESTRATION_FOOTER}`;
		return { kind: "prompt", text };
	}

	const text = `${HEADER}
${renderFailing(failing)}
## Your Task
**Step 1:** Group the failing signals above by their category. Ask the user which category they want to fix using the AskUser tool. Only show categories that have at least one failing signal.
**Step 2:** Based on the chosen category, present each failing signal in that category as an option in a single AskUser call. Each option is exactly one signal (with its name and current score). The user picks one signal to fix. Do NOT say "select all that apply" or "select one or more".
After the user selects a signal, fix it.
${fixInstructions()}
${ORCHESTRATION_FOOTER}`;
	return { kind: "prompt", text };
}
