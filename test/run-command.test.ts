/**
 * Parsing de `/harness run <featureId>`. Sem este ramo o comando caía no caminho de CONVERGE e o
 * próprio "run " entrava no slug (`run <id>` → featureIdFromRequest → "run-<id>"), criando uma
 * feature nova a cada invocação. Rastro real no disco: implemente-o-pr-c… → run-implemente-o-pr-c…
 * → run-run-implemente-o-pr-c…, três convergências pagas e três experimentos controlados perdidos.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { featureIdFromRequest } from "../src/mode.ts";

/** O mesmo padrão usado no handler do comando (extension/index.ts). */
const RUN_WITH_ID = /^run(\s+--headless)?\s+(?!-)(\S.*)$/;
const parse = (sub: string) => {
	const m = RUN_WITH_ID.exec(sub.trim());
	return m ? { featureId: m[2].trim(), headless: !!m[1] } : null;
};

test("`run <id>` é reconhecido como execução, não como descrição de feature nova", () => {
	assert.deepEqual(parse("run pr-b-do-docs-prd-ai"), { featureId: "pr-b-do-docs-prd-ai", headless: false });
	assert.deepEqual(parse("run --headless feat-x"), { featureId: "feat-x", headless: true });
	assert.deepEqual(parse("run  feat-y  "), { featureId: "feat-y", headless: false });
});

test("`run` sem id continua caindo no picker (não vira id vazio nem flag)", () => {
	assert.equal(parse("run"), null);
	assert.equal(parse("run --headless"), null, "flag sozinha nunca vira featureId");
	assert.equal(parse("run -x"), null);
});

test("uma descrição que apenas COMEÇA com 'run' continua sendo converge", () => {
	assert.equal(parse("runaway costs in the billing flow"), null);
	assert.equal(parse("rundown of the pipeline"), null);
});

test("REGRESSÃO: o slug de converge é exatamente o que produzia os ids run-run-*", () => {
	// Documenta o dano: sem o ramo de execução, isto era o id criado a cada `/harness run <id>`.
	assert.equal(featureIdFromRequest("run pr-b-do-docs-prd-ai-pipeline-redesign-md"), "run-pr-b-do-docs-prd-ai-pipeline-redesig");
	assert.equal(featureIdFromRequest("run run-pr-b-do-docs-prd-ai-pipeline-redesig"), "run-run-pr-b-do-docs-prd-ai-pipeline-red");
	// …e ambos são reconhecidos agora como execução da feature existente.
	assert.equal(parse("run run-pr-b-do-docs-prd-ai-pipeline-redesig")?.featureId, "run-pr-b-do-docs-prd-ai-pipeline-redesig");
});
