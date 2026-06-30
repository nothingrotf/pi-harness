import { test } from "node:test";
import assert from "node:assert/strict";
import { drawMain, drawSub, fullRow, mainBodyRows, mainLayout, rule, subBodyRows, twoRow } from "../src/control-draw.ts";

// Sem deps → identidade + `.length`: testa a GEOMETRIA pura (sem ANSI).

test("rule: largura exata, cantos quadrados, tee default", () => {
	assert.equal(rule(10, { left: "┌", right: "┐" }), "┌────────┐");
	assert.equal(rule(10), "├────────┤");
	assert.equal(rule(10, { left: "└", right: "┘" }), "└────────┘");
	assert.equal(rule(10).length, 10);
});

test("rule: `┬`/`┴` caem exatamente na coluna midPos", () => {
	const top = rule(12, { mid: "┬", midPos: 5 });
	const bot = rule(12, { mid: "┴", midPos: 5 });
	assert.equal(top.length, 12);
	assert.equal(bot.length, 12);
	assert.equal(top[5], "┬");
	assert.equal(bot[5], "┴");
	assert.equal(top, "├────┬─────┤");
});

test("fullRow: `│<inner>│`, miolo padeado a cols-2", () => {
	const r = fullRow(12, "hi");
	assert.equal(r.length, 12);
	assert.equal(r, "│hi        │");
});

test("fullRow: corta conteúdo que excede o miolo", () => {
	const r = fullRow(6, "abcdefghij");
	assert.equal(r.length, 6);
	assert.equal(r, "│abcd│");
});

test("twoRow: `│ L │ R │`, divisor do meio no índice midPos", () => {
	const r = twoRow(14, "ab", "cd", 6);
	assert.equal(r.length, 14);
	assert.equal(r[0], "│");
	assert.equal(r[6], "│"); // divisor no midPos
	assert.equal(r[13], "│");
	assert.equal(r, "│ab   │cd    │");
});

test("twoRow: divisor alinha com `┬`/`┴` do mesmo midPos", () => {
	const cols = 30;
	const midPos = 13;
	const split = rule(cols, { mid: "┬", midPos });
	const row = twoRow(cols, "L", "R", midPos);
	assert.equal(split[midPos], "┬");
	assert.equal(row[midPos], "│");
});

function deps() {
	return {}; // identidade
}

test("mainLayout: banda Active Worker reclama ~35% com worker; 0 sem worker; soma = interior", () => {
	const withW = mainLayout(24, true);
	const no = mainLayout(24, false);
	assert.equal(withW.bodyRows + withW.workerRows, 24 - 9, "oT+BT = ET = rows-9");
	assert.equal(no.workerRows, 0);
	assert.equal(no.bodyRows, 24 - 9);
	assert.ok(withW.workerRows >= 4, "banda mín 4 quando há espaço");
	assert.ok(withW.workerRows <= Math.ceil((24 - 9) * 0.4), "~35% (não domina)");
	// tela minúscula: sem espaço pra banda útil → esconde (workerRows 0), corpo >=1
	const tiny = mainLayout(12, true);
	assert.ok(tiny.bodyRows >= 1);
	assert.equal(mainBodyRows(24, false), 24 - 9);
});

test("drawMain: produz EXATAMENTE rows linhas com a banda Active Worker (multi-linha)", () => {
	const cols = 60;
	const rows = 24;
	const { bodyRows, workerRows } = mainLayout(rows, true);
	const out = drawMain(
		cols,
		rows,
		{
			header: " Feature Control",
			bar: " ● Running ████▒▒  3/8",
			left: ["Active Task", "  [T2] x"],
			right: ["Progress Log"],
			worker: [" Active Worker  #2  T2          Duration 2m", "", " ⛬ assistant text"],
			footer: " F Tasks  W Workers  Esc",
			midPos: 30,
		},
		deps(),
	);
	assert.equal(out.length, rows);
	for (const l of out) assert.equal(l.length, cols, `linha "${l}" deve ter ${cols} cols`);
	assert.equal(out[0][0], "┌");
	assert.equal(out[rows - 1][cols - 1], "┘");
	// split (┬) na linha 4; join (┴) logo após as bodyRows; banda começa logo depois do join
	assert.equal(out[4][30], "┬");
	const joinIdx = 5 + bodyRows;
	assert.equal(out[joinIdx][30], "┴", "join ┴ após as linhas de duas colunas");
	assert.match(out[joinIdx + 1], /Active Worker  #2  T2/, "título da banda logo após o join");
	assert.equal(out.length, 9 + bodyRows + workerRows);
});

test("drawMain: sem worker (worker:[]) → colunas enchem, sem banda", () => {
	const out = drawMain(40, 16, { header: " H", bar: " B", left: ["only-left"], right: [], worker: [], footer: " F", midPos: 20 }, deps());
	assert.equal(out.length, 16);
	assert.match(out[5], /^│only-left/);
	const lastBody = out[5 + mainLayout(16, false).bodyRows - 1];
	assert.equal(lastBody[0], "│");
	assert.equal(lastBody[lastBody.length - 1], "│");
});

test("drawSub: rows exatas, header+corpo+footer emoldurados", () => {
	const cols = 50;
	const rows = 20;
	const out = drawSub(cols, rows, { headerRows: [" Tasks (3)", " All │ Pending"], body: ["✓ T1", "● T2"], footer: " Esc back" }, deps());
	assert.equal(out.length, rows);
	for (const l of out) assert.equal(l.length, cols);
	assert.equal(out[0][0], "┌");
	assert.equal(out[rows - 1][0], "└");
	assert.match(out[1], /Tasks \(3\)/);
	assert.match(out[2], /All . Pending/);
	assert.equal(out.length, 5 + 2 + subBodyRows(rows, 2));
});
