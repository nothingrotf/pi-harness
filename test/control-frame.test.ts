import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { rangeLabel, splitLineRender, tabRowText } from "../src/control-render.ts";

// Theme stub: estiliza com identidade, pra testar a ESTRUTURA das strings sem ANSI real.
const themeStub = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as unknown as Theme;
const len = (s: string) => s.length;

test("splitLineRender: justifica left/right na largura dada (space-between)", () => {
	const line = splitLineRender("left", "right", 20, 1, len);
	assert.equal(line.length, 20, "preenche a largura exata");
	assert.match(line, /^ left {9}right $/);
});

test("splitLineRender: gap mínimo 1 quando não cabe", () => {
	const line = splitLineRender("aaaaaa", "bbbbbb", 10, 1, len);
	assert.match(line, /aaaaaa bbbbbb/, "ainda separa por ≥1 espaço");
});

test("tabRowText: ` │ ` separador, ativo destacado (estrutura)", () => {
	assert.equal(tabRowText(themeStub, ["All", "Pending", "Done"], 1), "All │ Pending │ Done");
});

test("rangeLabel: '1-N of T'; vazio quando total 0", () => {
	assert.equal(rangeLabel(1, 4, 4), "1-4 of 4");
	assert.equal(rangeLabel(6, 10, 12), "6-10 of 12");
	assert.equal(rangeLabel(0, 0, 0), "");
});
