/**
 * Dispatch NATIVO (model-driven, in-session) — o jeito do modelo de referência (tool calls ao
 * vivo no terminal + "Plan · X/5"). Em vez de spawnar `pi --print` e parsear num
 * widget custom, a gente manda o modelo rodar a auditoria/fix NA PR\u00d3PRIA SESS\u00c3O.
 *
 * ADAPTATIVO: as mensagens s\u00f3 instruem usar `todo` (rpiv-todo) e `subagent`
 * (pi-subagents) quando esses tools est\u00e3o ATIVOS na sess\u00e3o (detectado via
 * `pi.getActiveTools()` no extension). Se faltarem, degrada pra in-session.
 * Determinismo onde importa fica no `store_agent_readiness_report`.
 */

export interface DispatchTools {
	/** rpiv-todo (`todo`) ativo? \u2192 cria o Plan (overlay vivo, sobrevive /reload). */
	todo?: boolean;
	/** pi-subagents (`subagent`) ativo? \u2192 isola cada worker/fix/review num subagente fresco. */
	subagent?: boolean;
	/** rpiv-advisor (`advisor`) ativo? \u2192 escala a verifica\u00e7\u00e3o pra um modelo mais forte (ship gate). */
	advisor?: boolean;
	/** rpiv-ask-user-question (`ask_user_question`) ativo? \u2192 pergunta estruturada em vez de adivinhar. */
	askUser?: boolean;
}

/** As 5 fases do auditor (viram uma todo cada \u2014 o "Plan \u00b7 X/5" do modelo de referência). */
export const AUDIT_PHASES: readonly string[] = [
	"Phase 1: Detect language & explore structure",
	"Phase 2: Application discovery",
	"Phase 3: Evaluate the 82 criteria",
	"Phase 4: Validate report",
	"Phase 5: Store report & summarize",
];

/** Mensagem que dispara a auditoria ao vivo (Plan via rpiv-todo quando ativo). */
export function buildAuditDispatch(tools: DispatchTools = {}): string {
	const lines = ["Run an agent-readiness audit of THIS repository now, live in this session.", ""];
	let n = 1;
	if (tools.todo) {
		lines.push(
			`${n++}. First, create a 5-phase plan with the \`todo\` tool — one todo per phase:`,
			...AUDIT_PHASES.map((p) => `   - ${p}`),
			`${n++}. Invoke the \`harness-readiness-audit\` skill and work through the phases in order, marking each todo in_progress → completed as you go (so the Plan tracks progress live).`,
		);
	} else {
		lines.push(`${n++}. Invoke the \`harness-readiness-audit\` skill and work through its 5 phases in order.`);
	}
	lines.push(
		`${n++}. In the final phase, call the \`store_agent_readiness_report\` tool with the full report (the 82 criterion ids + \`apps\`). It validates the strict contract and writes .harness/profile/readiness.json. Then print the level, the per-category criteria, and 2-3 action items.`,
	);
	if (tools.todo) {
		lines.push(
			`${n++}. Finally, after printing the summary, clear the plan with the \`todo\` tool (\`action: "clear"\`) so it doesn't linger in the UI.`,
		);
	}
	lines.push("", "Do not modify the repository during the audit.");
	return lines.join("\n");
}

/** Mensagem que dispara a remedia\u00e7\u00e3o ao vivo (todo por sinal + subagent quando ativos). */
export function buildFixDispatch(args: string, tools: DispatchTools = {}): string {
	const a = args.trim();
	const scope = a
		? `the failing readiness signals matching "${a}" (match by id, name, or meaning)`
		: "the failing readiness signals — group them by category and ask the user (ask_user_question) which to fix";
	const todoCreate = tools.todo ? " Create one `todo` per signal you will fix, so the Plan tracks them." : "";
	const todoStart = tools.todo ? " mark its todo in_progress;" : "";
	const todoDone = tools.todo ? " then mark the todo completed." : "";
	const isolate = tools.subagent
		? " For isolation, delegate each fix to a fresh subagent: `subagent({ agent: \"harness-readiness-remediator\", task: \"...\", async: false })`."
		: "";
	return [
		`Fix ${scope}, live in this session.`,
		"",
		"1. Read .harness/profile/readiness.json (the latest report). If it's missing, run the readiness audit first (the `harness-readiness-audit` skill).",
		`2. Compute the failing signals (numerator < denominator).${todoCreate}`,
		`3. For each signal, in sequence (keep writes single-threaded):${todoStart} make a GENUINE, substantive fix (no empty placeholders, no disabling checks, no gaming the metric); verify it;${todoDone}${isolate}`,
		`4. When done, suggest re-running the readiness audit to confirm the new level.${tools.todo ? " Then clear the plan with the `todo` tool (`action: \"clear\"`) so it doesn't linger in the UI." : ""}`,
	].join("\n");
}
