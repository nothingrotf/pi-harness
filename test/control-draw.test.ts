import { test } from "node:test";
import assert from "node:assert/strict";
import { drawMain, drawSub, fullRow, mainBodyRows, rule, subBodyRows, twoRow } from "../src/control-draw.ts";

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

test("drawMain: produz EXATAMENTE rows linhas, cada uma com cols colunas", () => {
	const cols = 60;
	const rows = 24;
	const out = drawMain(
		cols,
		rows,
		{
			header: " Feature Control",
			bar: " ● Running ████▒▒  3/8",
			left: ["Active Task", "  [T2] x"],
			right: ["Progress Log"],
			worker: " Active Worker: #2",
			footer: " F Tasks  W Workers  Esc",
			midPos: 30,
		},
		deps(),
	);
	assert.equal(out.length, rows);
	for (const l of out) assert.equal(l.length, cols, `linha "${l}" deve ter ${cols} cols`);
	assert.equal(out[0][0], "┌");
	assert.equal(out[0][cols - 1], "┐");
	assert.equal(out[rows - 1][0], "└");
	assert.equal(out[rows - 1][cols - 1], "┘");
	// régua de split (┬) na linha 4 (0-idx), join (┴) logo antes do worker
	assert.equal(out[4][30], "┬");
	assert.equal(out.length, 10 + mainBodyRows(rows));
});

test("drawMain: corpo de duas colunas preenche a altura (linhas extras viram vazias)", () => {
	const out = drawMain(40, 16, { header: " H", bar: " B", left: ["only-left"], right: [], worker: " W", footer: " F", midPos: 20 }, deps());
	// linha 5 (primeira do corpo) tem o conteúdo; uma linha de corpo posterior é vazia mas ainda emoldurada
	assert.match(out[5], /^│only-left/);
	const lastBody = out[5 + mainBodyRows(16) - 1];
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
