/**
 * Lessons — a camada auto-melhorável (Tier 1, cross-feature). Transforma falhas de
 * verificação grounded em guidance reutilizável project-local, sem deixar o arquivo
 * apodrecer num log morto.
 *
 * O split que mantém vivo: o MODELO dá o juízo (qual falha, como frasear a lição, qual
 * sinal a aterra); o TS (aqui) dona TODO o mecânico — IDs, recorrência por feature
 * DISTINTA, promoção candidate→confirmed, prune, demotion, render. Bookkeeping na mão é
 * exatamente o que apodrece, então não é trabalho do prompt.
 *
 * O que alimenta: SÓ sinais de verificação reais (ship gate / handoffs). Sem sinal → sem
 * lição. Gate duro: uma lição sem `source` é opinião — addLesson recusa (no nosso padrão,
 * a tool store_lesson dá throw).
 *
 * Estado: .harness/profile/lessons.json (máquina, NUNCA editar à mão) + LESSONS.md
 * (renderizado). Vive no profile (committed) porque acumula ENTRE features.
 *
 * Port fiel da maquinaria do lessons.py de referência (stdlib-only → TS puro).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./plan.ts";

/** Sinais válidos — sempre grounded num output de verificação do harness. */
export const LESSON_SIGNALS = {
	blocking_finding: "harness-code-review surfaced a blocking finding (correctness/quality/conventions)",
	failed_assertion: "harness-qa-validator assertion failed or was blocked",
	gate_fail: "the programmatic gate (test/typecheck/lint) failed at integration",
	spec_deviation: "implementation diverged from the contract (SPEC_DEVIATION)",
	discovered_issue: "a worker handoff surfaced a blocking discovered issue",
} as const;
export type LessonSignal = keyof typeof LESSON_SIGNALS;

export const LESSON_DEFAULTS = { promoteThreshold: 2, windowDays: 45, quarantineThreshold: 2 } as const;
export const LESSONS_SCHEMA = 1;
const MIN_TEXT = 12;

export type LessonStatus = "candidate" | "confirmed" | "quarantined";

export interface Lesson {
	id: string;
	key: string;
	text: string;
	signal: LessonSignal;
	scope: string;
	status: LessonStatus;
	/** features DISTINTAS onde o sinal recorreu (recurrence = features.length). */
	features: string[];
	recurrence: number;
	/** quantas vezes a lição falhou quando aplicada (penalize). 2 → quarantine. */
	harmful: number;
	evidence: string[];
	created: string;
	lastSeen: string;
}

export interface LessonsStore {
	schema: number;
	promoteThreshold: number;
	windowDays: number;
	quarantineThreshold: number;
	nextId: number;
	lessons: Lesson[];
}

export function emptyStore(): LessonsStore {
	return {
		schema: LESSONS_SCHEMA,
		promoteThreshold: LESSON_DEFAULTS.promoteThreshold,
		windowDays: LESSON_DEFAULTS.windowDays,
		quarantineThreshold: LESSON_DEFAULTS.quarantineThreshold,
		nextId: 1,
		lessons: [],
	};
}

function nowIso(): string {
	return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Dedup key: lowercase, troca não-alfanumérico por espaço, colapsa whitespace.
 * Exact-after-normalization (sem embeddings — zero-dep). Frase canônica e terse pra
 * recorrências MERGEAREM (duas lições que dizem o mesmo precisam ler igual). */
export function normalizeLessonText(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
function lessonKey(signal: string, text: string): string {
	return `${signal}::${normalizeLessonText(text)}`;
}

const STOPWORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for", "from", "has", "have", "in", "into", "is", "it", "its", "must", "never", "no", "not", "of", "on", "one", "or", "so", "that", "the", "their", "them", "then", "there", "this", "to", "was", "were", "when", "which", "with", "you", "your"]);

/**
 * Bag de tokens significativos de uma lição (normalizada, sem stopwords, sem tokens <3 chars).
 * Base do matching por similaridade — ver `lessonSimilarity`.
 */
export function lessonTokens(text: string): Set<string> {
	return new Set(
		normalizeLessonText(text)
			.split(" ")
			.filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
	);
}

/**
 * Jaccard sobre tokens significativos. Substitui o dedup EXATO-após-normalização, que era a razão
 * de nenhuma lição jamais promover: duas lições sobre a MESMA coisa nunca ficam byte-idênticas, o
 * key nunca colidia, `recurrence` ficava travado em 1 e `promoteThreshold` nunca era atingido
 * (evidência: 37 lições reais em sotaq+hibou, 100% `candidate`, 100% recurrence 1 — inclusive
 * L-003/L-004 do sotaq, o MESMO texto com pontuação diferente, contadas como duas).
 */
export function lessonSimilarity(a: string, b: string): number {
	const ta = lessonTokens(a);
	const tb = lessonTokens(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter += 1;
	return inter / (ta.size + tb.size - inter);
}

/** Acima disto duas lições são A MESMA e fazem merge (recurrence++). Conservador de propósito. */
export const LESSON_MERGE_THRESHOLD = 0.6;

/** Lição já registada que é a mesma que `text` (key exata primeiro, depois similaridade). */
export function findMatchingLesson(store: LessonsStore, signal: string, text: string, threshold = LESSON_MERGE_THRESHOLD): Lesson | undefined {
	const key = lessonKey(signal, text);
	const exact = store.lessons.find((l) => l.key === key);
	if (exact) return exact;
	let best: Lesson | undefined;
	let bestScore = threshold;
	for (const l of store.lessons) {
		if (l.signal !== signal) continue;
		const score = lessonSimilarity(l.text, text);
		if (score >= bestScore) {
			best = l;
			bestScore = score;
		}
	}
	return best;
}

function ageDays(iso: string, now: Date): number {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return 0;
	return Math.floor((now.getTime() - t) / 86_400_000);
}

/** Dropa candidatos que nunca recorreram dentro da janela. Muta o store; devolve ids dropados. */
export function autoPrune(store: LessonsStore, now: Date = new Date()): string[] {
	const dropped: string[] = [];
	store.lessons = store.lessons.filter((l) => {
		if (l.status === "candidate" && l.recurrence < store.promoteThreshold && ageDays(l.lastSeen ?? l.created, now) > store.windowDays) {
			dropped.push(l.id);
			return false;
		}
		return true;
	});
	return dropped;
}

export interface AddLessonInput {
	feature: string;
	signal: string;
	source: string;
	text: string;
	scope?: string;
	now?: () => string;
}
export type AddLessonResult =
	| { ok: true; lesson: Lesson; action: "added" | "updated"; promoted: boolean }
	| { ok: false; error: string };

/**
 * Registra uma lição grounded. Gate de grounding (determinístico, não no prompt):
 * signal válido, feature e source obrigatórios, text >= 12 chars. Dedup por key
 * normalizada: recorrência conta features DISTINTAS; candidate→confirmed ao bater
 * promoteThreshold. Muta o store.
 */
export function addLesson(store: LessonsStore, input: AddLessonInput): AddLessonResult {
	const now = (input.now ?? nowIso)();
	const signal = input.signal as LessonSignal;
	const source = (input.source ?? "").trim();
	const text = (input.text ?? "").trim();
	const feature = (input.feature ?? "").trim();
	const scope = (input.scope ?? "").trim();

	if (!(signal in LESSON_SIGNALS)) return { ok: false, error: `invalid signal: ${input.signal} (expected one of ${Object.keys(LESSON_SIGNALS).join(", ")})` };
	if (!feature) return { ok: false, error: "feature is required (the feature the signal came from)" };
	if (!source) return { ok: false, error: "source is required (file:line / assertion id / finding ref) — a lesson with no grounding is an opinion, refused" };
	if (text.length < MIN_TEXT) return { ok: false, error: `text too short (>=${MIN_TEXT} chars) — state the actionable lesson in one terse sentence` };

	autoPrune(store);
	const key = lessonKey(signal, text);
	const existing = findMatchingLesson(store, signal, text);
	const ev = scope ? `${source} (${scope})` : source;

	if (existing) {
		if (!existing.features.includes(feature)) existing.features.push(feature);
		existing.recurrence = existing.features.length;
		existing.lastSeen = now;
		// cap: mantém a primeira (origem) + as últimas 9 — evidência crescia sem teto por recorrência
		if (!existing.evidence.includes(ev)) {
			existing.evidence.push(ev);
			if (existing.evidence.length > 10) existing.evidence.splice(1, existing.evidence.length - 10);
		}
		let promoted = false;
		if (existing.status === "candidate" && existing.recurrence >= store.promoteThreshold) {
			existing.status = "confirmed";
			promoted = true;
		}
		return { ok: true, lesson: existing, action: "updated", promoted };
	}

	const lesson: Lesson = {
		id: `L-${String(store.nextId).padStart(3, "0")}`,
		key,
		text,
		signal,
		scope,
		status: "candidate",
		features: [feature],
		recurrence: 1,
		harmful: 0,
		evidence: [ev],
		created: now,
		lastSeen: now,
	};
	store.nextId += 1;
	store.lessons.push(lesson);
	return { ok: true, lesson, action: "added", promoted: false };
}

/** Demotion: marca uma lição confirmed como falha-quando-aplicada. 2 penalidades → quarantine. */
export function penalizeLesson(store: LessonsStore, id: string, now: () => string = nowIso): { ok: boolean; lesson?: Lesson; error?: string } {
	const lesson = store.lessons.find((l) => l.id.toLowerCase() === id.toLowerCase());
	if (!lesson) return { ok: false, error: `no lesson with id ${id}` };
	// só confirmed viram guidance — penalizar um candidate quarentenava algo que nunca foi aplicado
	if (lesson.status !== "confirmed") return { ok: false, error: `lesson ${lesson.id} is ${lesson.status} — only confirmed lessons (active guidance) can be penalized` };
	lesson.harmful += 1;
	lesson.lastSeen = now();
	if (lesson.harmful >= store.quarantineThreshold) lesson.status = "quarantined";
	return { ok: true, lesson };
}

export interface ListLessonsFilter {
	status?: LessonStatus | "all";
	query?: string;
	scope?: string;
}
/** Lê lições filtradas (default: confirmed — as únicas que viram guidance). */
export function listLessons(store: LessonsStore, filter: ListLessonsFilter = {}): Lesson[] {
	const want = filter.status ?? "confirmed";
	const q = (filter.query ?? "").toLowerCase().trim();
	const sc = (filter.scope ?? "").toLowerCase().trim();
	return store.lessons
		.filter((l) => (want === "all" || l.status === want) && (!q || l.text.toLowerCase().includes(q)) && (!sc || (l.scope ?? "").toLowerCase().includes(sc)))
		.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Render (LESSONS.md — legível pro modelo; confirmed é o playbook a carregar)

export function renderLessons(store: LessonsStore): string {
	const out: string[] = [
		"# LESSONS — auto-mantido pela tool store_lesson",
		"",
		"> Máquina. NÃO editar à mão — sobrescrito no próximo write. Estado canônico: lessons.json.",
		`> promoteThreshold=${store.promoteThreshold} features distintas · windowDays=${store.windowDays} · quarantineThreshold=${store.quarantineThreshold}`,
		"",
	];
	const buckets: Record<LessonStatus, Lesson[]> = { confirmed: [], candidate: [], quarantined: [] };
	for (const l of store.lessons) buckets[l.status].push(l);

	const block = (title: string, items: Lesson[], note: string): void => {
		out.push(`## ${title}`, "");
		if (note) out.push(note, "");
		if (items.length === 0) {
			out.push("_none_", "");
			return;
		}
		for (const l of [...items].sort((a, b) => (a.id < b.id ? -1 : 1))) {
			const scope = l.scope ? ` · scope: \`${l.scope}\`` : "";
			out.push(`### ${l.id} — ${l.text}`);
			out.push(`- signal: \`${l.signal}\` · recurrence: ${l.recurrence} feature(s)${scope} · harmful: ${l.harmful}`);
			out.push(`- features: ${l.features.join(", ") || "—"}`);
			if (l.evidence.length > 0) out.push(`- evidence: ${l.evidence[0]}${l.evidence.length > 1 ? ` (+${l.evidence.length - 1} more)` : ""}`);
			out.push(`- last seen: ${l.lastSeen}`, "");
		}
	};
	block("Confirmed (carregue na convergência / no worker)", buckets.confirmed, "Corroboradas em múltiplas features. Seguras como guidance.");
	block("Candidates (em observação — NÃO carregue como guidance)", buckets.candidate, "Vistas 1x ou ainda não corroboradas. Rastreadas, não confiadas.");
	block("Quarantined (falharam quando aplicadas — ignore)", buckets.quarantined, "Confirmed que recorreu junto de falha. Mantida pro mantenedor revisar.");
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** Tetos do briefing injetado — o custo é contexto de TODA sessão de worker, então é apertado. */
export const LESSON_BRIEFING_LIMITS = { confirmed: 25, candidate: 15 } as const;

/**
 * Bloco COMPACTO de lições pra injetar no system prompt de todo worker/validator.
 *
 * O buraco que isto fecha: `lessons.json` era write-only. `store_lesson` gravava, `LESSONS.md`
 * renderizava, e NENHUM prompt lia — 37 lições reais acumuladas em sotaq+hibou sem jamais chegar
 * a um worker. A lição L-020 do hibou ("two call sites needing the same derived value must share
 * one named function") foi escrita DEPOIS de 3 rounds de review a repetirem o mesmo defeito, e
 * nunca preveniu nada porque ninguém a leu.
 *
 * `candidate` entra marcado e sem autoridade (é 1 ocorrência, pode ser ruído) mas ENTRA: enquanto
 * a promoção estiver rara, carregar só `confirmed` injeta o conjunto vazio. `quarantined` nunca.
 */
export function lessonsBriefing(store: LessonsStore): string {
	const confirmed = listLessons(store, { status: "confirmed" }).slice(0, LESSON_BRIEFING_LIMITS.confirmed);
	const candidate = listLessons(store, { status: "candidate" }).slice(0, LESSON_BRIEFING_LIMITS.candidate);
	if (confirmed.length === 0 && candidate.length === 0) return "";

	const line = (l: Lesson): string => `- ${l.id}${l.scope ? ` [${l.scope}]` : ""}: ${l.text}`;
	const out: string[] = [
		"# Lessons from prior features in THIS repo",
		"",
		"Grounded in real verification failures here (ship-gate findings, failed assertions, red gates).",
		"Read them BEFORE you design anything. They are the cheapest defect prevention you have: each one",
		"cost this repo at least one failed review round. Full detail: `.harness/profile/LESSONS.md`.",
		"",
	];
	if (confirmed.length > 0) {
		out.push("## Confirmed — recurred across multiple features. Treat as binding.", "", ...confirmed.map(line), "");
	}
	if (candidate.length > 0) {
		out.push("## Candidates — seen once. Not binding, but check your work against them.", "", ...candidate.map(line), "");
	}
	out.push("If your change repeats one of these, you are about to fail the ship gate for a known reason.");
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistência (.harness/profile/)

function profileDir(cwd: string): string {
	return path.join(cwd, ".harness", "profile");
}
export function lessonsJsonPath(cwd: string): string {
	return path.join(profileDir(cwd), "lessons.json");
}
export function lessonsMdPath(cwd: string): string {
	return path.join(profileDir(cwd), "LESSONS.md");
}

function maxLessonIdNum(lessons: Lesson[]): number {
	let max = 0;
	for (const l of lessons) {
		const m = /^L-(\d+)$/.exec(l.id ?? "");
		if (m) max = Math.max(max, Number(m[1]));
	}
	return max;
}

export function readLessonsStore(cwd: string): LessonsStore {
	try {
		const data = JSON.parse(fs.readFileSync(lessonsJsonPath(cwd), "utf8")) as Partial<LessonsStore>;
		return {
			schema: data.schema ?? LESSONS_SCHEMA,
			promoteThreshold: data.promoteThreshold ?? LESSON_DEFAULTS.promoteThreshold,
			windowDays: data.windowDays ?? LESSON_DEFAULTS.windowDays,
			quarantineThreshold: data.quarantineThreshold ?? LESSON_DEFAULTS.quarantineThreshold,
			// nextId NUNCA abaixo de max(id)+1: um lessons.json sem nextId (merge manual/schema antigo)
			// com nextId=1 gerava L-001 DUPLICADO.
			nextId: Math.max(data.nextId ?? 1, maxLessonIdNum(data.lessons ?? []) + 1),
			lessons: data.lessons ?? [],
		};
	} catch {
		return emptyStore();
	}
}

/** Grava lessons.json + re-renderiza LESSONS.md (acoplados — o md nunca diverge do json). */
export function writeLessonsStore(cwd: string, store: LessonsStore): void {
	fs.mkdirSync(profileDir(cwd), { recursive: true });
	writeJsonAtomic(lessonsJsonPath(cwd), store);
	fs.writeFileSync(lessonsMdPath(cwd), renderLessons(store));
}
