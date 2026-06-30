import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLinkedIssueMetadata, scanBareKeys } from "../src/linear-link.ts";

test("Linear URL no corpo do PR → linearIssueIds + linkedTicketUrls (droid §4.1)", () => {
	const r = extractLinkedIssueMetadata({ prBody: "Fixes https://linear.app/acme/issue/ENG-123/fix-login behavior." });
	assert.deepEqual(r.linearIssueIds, ["ENG-123"]);
	assert.deepEqual(r.linkedTicketUrls, ["https://linear.app/acme/issue/ENG-123/fix-login"]);
	assert.deepEqual(r.jiraIssueKeys, []);
});

test("Jira /browse/<KEY> → jiraIssueKeys; key inválida é ignorada", () => {
	const ok = extractLinkedIssueMetadata({ prBody: "see https://jira.acme.com/browse/PROJ-45 ." });
	assert.deepEqual(ok.jiraIssueKeys, ["PROJ-45"]);
	assert.deepEqual(ok.linearIssueIds, []);
	const bad = extractLinkedIssueMetadata({ prBody: "https://jira.acme.com/browse/not-a-key" });
	assert.deepEqual(bad.jiraIssueKeys, []);
});

test("trailing punctuation é removida da URL antes do parse (igual ao droid)", () => {
	const r = extractLinkedIssueMetadata({ prBody: "Closes https://linear.app/acme/issue/OPS-7/slug." });
	assert.deepEqual(r.linearIssueIds, ["OPS-7"]);
	assert.deepEqual(r.linkedTicketUrls, ["https://linear.app/acme/issue/OPS-7/slug"]);
});

test("branch convention `user/eng-123-slug` → candidato Linear (não autoritativo)", () => {
	const r = extractLinkedIssueMetadata({ branch: "gabriel/eng-123-fix-foo" });
	assert.deepEqual(r.candidateKeys, ["ENG-123"]);
	assert.deepEqual(r.linearIssueIds, [], "branch crua não vira link autoritativo");
});

test("feature id do harness (`work-on-linear-issue-adm-84-...`) → candidato ADM-84", () => {
	const r = extractLinkedIssueMetadata({ featureId: "work-on-linear-issue-adm-84-suggested-br" });
	assert.deepEqual(r.candidateKeys, ["ADM-84"]);
});

test("feature id cuja issue JÁ é link autoritativo não duplica em candidateKeys", () => {
	const r = extractLinkedIssueMetadata({
		featureId: "work-on-linear-issue-adm-84-x",
		prBody: "Closes https://linear.app/acme/issue/ADM-84/x",
	});
	assert.deepEqual(r.linearIssueIds, ["ADM-84"]);
	assert.deepEqual(r.candidateKeys, []);
});

test("chave crua que JÁ é link autoritativo não duplica em candidateKeys", () => {
	const r = extractLinkedIssueMetadata({
		prBody: "https://linear.app/acme/issue/ENG-123/x",
		branch: "gabriel/eng-123-fix",
		commits: ["feat: ENG-123 add thing"],
	});
	assert.deepEqual(r.linearIssueIds, ["ENG-123"]);
	assert.deepEqual(r.candidateKeys, [], "ENG-123 já é autoritativo → não candidato");
});

test("commits subjects são scaneados; tokens de ruído (UTF-8, SHA-1) são filtrados", () => {
	const r = extractLinkedIssueMetadata({ commits: ["fix UTF-8 decode and SHA-1 hash for ENG-9"] });
	assert.deepEqual(r.candidateKeys, ["ENG-9"]);
});

test("params explícitos linkedTicketUrls/linearIssueIds são preservados e normalizados", () => {
	const r = extractLinkedIssueMetadata({
		linearIssueIds: ["ENG-1"],
		linkedTicketUrls: ["https://linear.app/acme/issue/ENG-1/x?foo=bar"],
	});
	assert.deepEqual(r.linearIssueIds, ["ENG-1"]);
	assert.deepEqual(r.linkedTicketUrls, ["https://linear.app/acme/issue/ENG-1/x"], "query string é removida (origin+pathname)");
});

test("scanBareKeys: dedup + upper-case + filtro de prefixos não-issue", () => {
	assert.deepEqual(scanBareKeys("eng-1 ENG-1 ops-2 utf-8"), ["ENG-1", "OPS-2"]);
	assert.deepEqual(scanBareKeys(undefined), []);
});

test("múltiplas issues no corpo → todas coletadas, sem duplicar", () => {
	const r = extractLinkedIssueMetadata({
		prBody: "Fixes https://linear.app/acme/issue/ENG-1/a and https://linear.app/acme/issue/ENG-2/b and https://linear.app/acme/issue/ENG-1/a",
	});
	assert.deepEqual(r.linearIssueIds.sort(), ["ENG-1", "ENG-2"]);
});
