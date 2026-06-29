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

/** Sinais válidos — sempre grounded num output de verificação do harness. */
export const LESSON_SIGNALS = {
	blocking_finding: "code-review surfaced a blocking finding (correctness/quality/conventions)",
	failed_assertion: "qa-validator assertion failed or was blocked",
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
	const existing = store.lessons.find((l) => l.key === key);
	const ev = scope ? `${source} (${scope})` : source;

	if (existing) {
		if (!existing.features.includes(feature)) existing.features.push(feature);
		existing.recurrence = existing.features.length;
		existing.lastSeen = now;
		if (!existing.evidence.includes(ev)) existing.evidence.push(ev);
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

export function readLessonsStore(cwd: string): LessonsStore {
	try {
		const data = JSON.parse(fs.readFileSync(lessonsJsonPath(cwd), "utf8")) as Partial<LessonsStore>;
		return {
			schema: data.schema ?? LESSONS_SCHEMA,
			promoteThreshold: data.promoteThreshold ?? LESSON_DEFAULTS.promoteThreshold,
			windowDays: data.windowDays ?? LESSON_DEFAULTS.windowDays,
			quarantineThreshold: data.quarantineThreshold ?? LESSON_DEFAULTS.quarantineThreshold,
			nextId: data.nextId ?? 1,
			lessons: data.lessons ?? [],
		};
	} catch {
		return emptyStore();
	}
}

/** Grava lessons.json + re-renderiza LESSONS.md (acoplados — o md nunca diverge do json). */
export function writeLessonsStore(cwd: string, store: LessonsStore): void {
	fs.mkdirSync(profileDir(cwd), { recursive: true });
	fs.writeFileSync(lessonsJsonPath(cwd), `${JSON.stringify(store, null, 2)}\n`);
	fs.writeFileSync(lessonsMdPath(cwd), renderLessons(store));
}
