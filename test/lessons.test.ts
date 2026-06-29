import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addLesson,
	autoPrune,
	emptyStore,
	listLessons,
	type LessonsStore,
	lessonsMdPath,
	normalizeLessonText,
	penalizeLesson,
	readLessonsStore,
	renderLessons,
	writeLessonsStore,
} from "../src/lessons.ts";

const T = (s: string) => () => s;
function add(store: LessonsStore, feature: string, text: string, extra: Partial<{ signal: string; source: string; scope: string; now: string }> = {}) {
	return addLesson(store, {
		feature,
		signal: extra.signal ?? "failed_assertion",
		source: extra.source ?? "VAL-AUTH-001",
		text,
		scope: extra.scope,
		now: extra.now ? T(extra.now) : undefined,
	});
}

test("addLesson: grounding gate — recusa sem source/feature, text curto, signal inválido", () => {
	const s = emptyStore();
	assert.equal(addLesson(s, { feature: "f", signal: "failed_assertion", source: "", text: "assert the exact value" }).ok, false);
	assert.equal(addLesson(s, { feature: "", signal: "failed_assertion", source: "x:1", text: "assert the exact value" }).ok, false);
	assert.equal(addLesson(s, { feature: "f", signal: "failed_assertion", source: "x:1", text: "too short" }).ok, false);
	assert.equal(addLesson(s, { feature: "f", signal: "nope", source: "x:1", text: "assert the exact value" }).ok, false);
	assert.equal(s.lessons.length, 0, "nada gravado quando recusado");
});

test("addLesson: nova → candidate (recurrence 1); id L-NNN sequencial", () => {
	const s = emptyStore();
	const r = add(s, "feat-a", "Assert the exact persisted status value, not just that a status field exists");
	assert.ok(r.ok && r.action === "added" && r.lesson.status === "candidate" && r.lesson.recurrence === 1);
	assert.ok(r.ok && r.lesson.id === "L-001");
	const r2 = add(s, "feat-a", "Validate idempotency keys on retried writes to avoid duplicates");
	assert.ok(r2.ok && r2.lesson.id === "L-002");
});

test("addLesson: recorrência por feature DISTINTA → candidate→confirmed em promoteThreshold (2)", () => {
	const s = emptyStore();
	const text = "Assert the exact persisted status value, not just that the field exists";
	add(s, "feat-a", text);
	// mesma feature de novo NÃO bumpa recurrence
	const same = add(s, "feat-a", text);
	assert.ok(same.ok && same.lesson.recurrence === 1 && same.lesson.status === "candidate", "mesma feature não promove");
	// feature distinta → recurrence 2 → confirmed
	const promo = add(s, "feat-b", text);
	assert.ok(promo.ok && promo.action === "updated" && promo.promoted === true);
	assert.ok(promo.ok && promo.lesson.recurrence === 2 && promo.lesson.status === "confirmed");
	assert.equal(s.lessons.length, 1, "dedup: uma lição só");
});

test("normalizeLessonText + dedup: pontuação/caixa diferentes mergeiam", () => {
	assert.equal(normalizeLessonText("Assert the EXACT value!"), normalizeLessonText("assert  the exact value"));
	const s = emptyStore();
	add(s, "feat-a", "Assert the exact value, always!");
	const merged = add(s, "feat-b", "assert the exact value always");
	assert.ok(merged.ok && merged.lesson.recurrence === 2, "frases equivalentes após normalização mergeiam");
	assert.equal(s.lessons.length, 1);
});

test("addLesson: signal diferente NÃO mergeia (key inclui o signal)", () => {
	const s = emptyStore();
	add(s, "feat-a", "Cover the error path explicitly", { signal: "failed_assertion" });
	add(s, "feat-b", "Cover the error path explicitly", { signal: "blocking_finding" });
	assert.equal(s.lessons.length, 2, "mesmo texto, signal diferente → lições distintas");
});

test("penalizeLesson: harmful++ ; 2 penalidades → quarantine", () => {
	const s = emptyStore();
	const text = "Always assert the resulting state, not the mock call count";
	add(s, "feat-a", text);
	add(s, "feat-b", text); // → confirmed
	const id = s.lessons[0].id;
	assert.equal(penalizeLesson(s, id).ok, true);
	assert.equal(s.lessons[0].harmful, 1);
	assert.equal(s.lessons[0].status, "confirmed");
	penalizeLesson(s, id);
	assert.equal(s.lessons[0].status, "quarantined", "2ª penalidade quarantena");
	assert.equal(penalizeLesson(s, "L-999").ok, false, "id inexistente");
});

test("autoPrune: candidato stale (recurrence<thr, idade>janela) dropa; confirmed/recente ficam", () => {
	// Constrói o store DIRETO (sem adds sequenciais, que prunam entre si) pra isolar o autoPrune.
	const s = emptyStore();
	const mk = (id: string, status: "candidate" | "confirmed", lastSeen: string, recurrence = 1): import("../src/lessons.ts").Lesson => ({
		id,
		key: id,
		text: `${id} text`,
		signal: "failed_assertion",
		scope: "",
		status,
		features: recurrence === 2 ? ["a", "b"] : ["a"],
		recurrence,
		harmful: 0,
		evidence: ["x:1"],
		created: lastSeen,
		lastSeen,
	});
	s.lessons.push(
		mk("L-001", "candidate", "2026-01-01T00:00:00Z"), // stale (~179 dias > janela 45)
		mk("L-002", "candidate", "2026-06-28T00:00:00Z"), // recente (1 dia)
		mk("L-003", "confirmed", "2026-01-01T00:00:00Z", 2), // confirmed: imune
	);
	const dropped = autoPrune(s, new Date("2026-06-29T00:00:00Z"));
	assert.deepEqual(dropped, ["L-001"], "só o candidato stale dropa");
	assert.equal(s.lessons.length, 2);
	assert.ok(s.lessons.some((l) => l.id === "L-003"), "confirmed sobrevive mesmo velho");
	assert.ok(s.lessons.some((l) => l.id === "L-002"), "candidato recente sobrevive");
});

test("listLessons: default confirmed; filtros status/query/scope", () => {
	const s = emptyStore();
	const text = "Validate auth boundaries on every protected route";
	add(s, "feat-a", text, { scope: "routes" });
	add(s, "feat-b", text, { scope: "routes" }); // confirmed
	add(s, "feat-a", "A lonely candidate about logging"); // candidate
	assert.equal(listLessons(s).length, 1, "default só confirmed");
	assert.equal(listLessons(s, { status: "all" }).length, 2);
	assert.equal(listLessons(s, { scope: "routes" }).length, 1);
	assert.equal(listLessons(s, { query: "auth boundaries" }).length, 1);
	assert.equal(listLessons(s, { status: "candidate" }).length, 1);
});

test("renderLessons + persistência: json + LESSONS.md acoplados; round-trip", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lessons-"));
	const s = emptyStore();
	const text = "Assert the exact persisted value, not merely that a field is present";
	add(s, "feat-a", text, { scope: "billing", source: "src/billing.ts:88" });
	add(s, "feat-b", text, { scope: "billing", source: "src/billing.ts:90" }); // confirmed
	writeLessonsStore(d, s);
	const md = fs.readFileSync(lessonsMdPath(d), "utf8");
	assert.match(md, /## Confirmed/);
	assert.match(md, /L-001 — Assert the exact persisted value/);
	assert.match(md, /recurrence: 2 feature/);
	assert.match(md, /scope: `billing`/);
	// round-trip do json
	const back = readLessonsStore(d);
	assert.equal(back.lessons.length, 1);
	assert.equal(back.lessons[0].status, "confirmed");
	assert.equal(back.nextId, 2);
	// render direto bate
	assert.ok(renderLessons(back).includes("L-001"));
});
