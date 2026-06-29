/**
 * Tool `store_lesson` — o estágio "store" da camada de lições, espelhando store_plan /
 * store_profile: o MODELO (orchestrator/validators) dá o juízo (feature, signal, source,
 * text, scope) depois do ship gate; o TS valida o GROUNDING (source obrigatório — sem ele
 * é opinião, não lição), dona IDs/recorrência/promoção/quarentena, e persiste
 * .harness/profile/lessons.json + LESSONS.md. `action: "penalize"` demota uma confirmed
 * que falhou quando aplicada.
 *
 * Recusa (THROW) se inválido — o loop devolve o erro pro modelo, que corrige e chama de novo.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addLesson, LESSON_SIGNALS, penalizeLesson, readLessonsStore, writeLessonsStore } from "./lessons.ts";

const SignalEnum = Type.Union(
	Object.keys(LESSON_SIGNALS).map((s) => Type.Literal(s)),
	{ description: "The verification signal that grounds this lesson." },
);

const PARAMS = Type.Object({
	action: Type.Optional(Type.Union([Type.Literal("add"), Type.Literal("penalize")], { description: "add (default) records a grounded lesson; penalize demotes a confirmed lesson that failed when applied." })),
	feature: Type.Optional(Type.String({ description: "add: the feature id the signal came from (recurrence counts DISTINCT features)." })),
	signal: Type.Optional(SignalEnum),
	source: Type.Optional(Type.String({ description: "add: grounding — file:line / assertion id / finding ref. MANDATORY for add." })),
	text: Type.Optional(Type.String({ description: "add: the lesson as ONE terse, actionable, codebase-general sentence (>=12 chars). Canonical phrasing so recurrences merge." })),
	scope: Type.Optional(Type.String({ description: "add: optional path/layer/tag for retrieval filtering (e.g. billing, routes)." })),
	id: Type.Optional(Type.String({ description: "penalize: the lesson id (e.g. L-003)." })),
});

export function registerLessonsStoreTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "store_lesson",
			label: "Store Project Lesson",
			description:
				"Records a grounded, project-local lesson distilled from a verification failure (ship-gate blocking finding, failed assertion, gate fail, spec deviation, discovered issue), or penalizes a confirmed lesson that failed when applied. Owns IDs, recurrence across distinct features, candidate→confirmed promotion, and quarantine; persists .harness/profile/lessons.json + LESSONS.md. Rejects (throws) a lesson with no `source` (grounding gate). Call AFTER the ship gate when a real failure occurred — no signal, no lesson.",
			parameters: PARAMS,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const store = readLessonsStore(ctx.cwd);
				const action = params.action ?? "add";

				if (action === "penalize") {
					if (!params.id) throw new Error("store_lesson penalize requires `id` (e.g. L-003).");
					const res = penalizeLesson(store, params.id);
					if (!res.ok) throw new Error(`store_lesson penalize REJECTED: ${res.error}`);
					writeLessonsStore(ctx.cwd, store);
					const l = res.lesson;
					return {
						content: [{ type: "text", text: `✓ penalized ${l?.id} (harmful=${l?.harmful}, status=${l?.status}).` }],
						details: { id: l?.id, status: l?.status, harmful: l?.harmful },
					};
				}

				const res = addLesson(store, {
					feature: params.feature ?? "",
					signal: params.signal ?? "",
					source: params.source ?? "",
					text: params.text ?? "",
					scope: params.scope,
				});
				if (!res.ok) throw new Error(`store_lesson REJECTED: ${res.error}\nFix and call store_lesson again.`);
				writeLessonsStore(ctx.cwd, store);
				const { lesson, action: act, promoted } = res;
				const msg = `✓ ${act} ${lesson.id} (recurrence=${lesson.recurrence}, status=${lesson.status})${promoted ? " — PROMOTED to confirmed" : ""}.`;
				return {
					content: [{ type: "text", text: msg }],
					details: { id: lesson.id, status: lesson.status, recurrence: lesson.recurrence, promoted },
				};
			},
		}),
	);
}
