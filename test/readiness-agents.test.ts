import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = fileURLToPath(new URL("../agents", import.meta.url));

function frontmatter(file: string): Record<string, string> {
	const txt = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8");
	const m = txt.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(m, `${file}: sem frontmatter`);
	const fm: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return fm;
}

test("readiness-auditor: read-only + store tool, fresh, liga a skill", () => {
	const fm = frontmatter("readiness-auditor.md");
	assert.equal(fm.name, "readiness-auditor");
	assert.equal(fm.defaultContext, "fresh");
	assert.match(fm.tools, /store_agent_readiness_report/);
	assert.doesNotMatch(fm.tools, /\bedit\b|\bwrite\b/, "auditor não modifica o repo");
	assert.match(fm.skills, /harness-readiness-audit/);
});

test("readiness-remediator: pode editar, fresh", () => {
	const fm = frontmatter("readiness-remediator.md");
	assert.equal(fm.name, "readiness-remediator");
	assert.equal(fm.defaultContext, "fresh");
	assert.match(fm.tools, /\bedit\b/);
	assert.match(fm.tools, /\bwrite\b/);
});
