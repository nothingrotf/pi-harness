/**
 * gate-output — a sentinela de coleta vazia. Um comando de teste que não coletou nada sai 0 e
 * passa por gate verde; seis ocorrências reais em sotaq+hibou aprovaram código que nenhum teste
 * tocou (`bunx vp test --project X run` — o `run` depois do `--project` vira filtro de nome).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectZeroTests, isTestCommand } from "../src/gate-output.ts";

test("detectZeroTests: reconhece coleta vazia dos runners comuns", () => {
	const zeros = [
		"No test files found, exiting with code 1",
		" Test Files  no tests",
		"Tests: 0 total",
		"collected 0 items",
		"testing: warning: no tests to run",
		"test result: ok. 0 passed; 0 failed",
		"No tests found, exiting",
		"0 specs ran",
		'Error: no test specified',
	];
	for (const out of zeros) {
		const v = detectZeroTests(out);
		assert.equal(v.zero, true, `deveria acusar: ${out}`);
		assert.ok(v.evidence, "guarda a linha que provou");
	}
});

test("detectZeroTests: suíte real que rodou NÃO é acusada (o falso-positivo é o risco)", () => {
	const greens = [
		" Test Files  12 passed (12)\n      Tests  318 passed (318)",
		"Tests:       41 passed, 41 total",
		"===== 87 passed in 3.10s =====",
		"ok  	github.com/x/y	0.412s",
		"test result: ok. 132 passed; 0 failed; 0 ignored",
		" 486 pass\n 0 fail\nRan 486 tests across 50 files.",
		"Tests: 0 failed, 120 passed",
	];
	for (const out of greens) assert.equal(detectZeroTests(out).zero, false, `falso-positivo em: ${out}`);
	assert.equal(detectZeroTests("").zero, false);
});

test("detectZeroTests: ignora códigos ANSI (o output real vem colorido)", () => {
	assert.equal(detectZeroTests("\u001b[31mNo test files found\u001b[0m").zero, true);
});

test("isTestCommand: a sentinela só se aplica a comandos de teste", () => {
	for (const c of ["bun test", "bunx vp test run --project unit", "npm run test:unit", "pytest -q", "go test ./...", "cargo test", "bun run test && bun lint"]) {
		assert.equal(isTestCommand(c), true, `deveria ser teste: ${c}`);
	}
	for (const c of ["bun typecheck", "tsc --noEmit", "bun run lint", "bun build", "bun run check:dup", "CI=1 bunx vp lint apps packages scripts"]) {
		assert.equal(isTestCommand(c), false, `NÃO é teste: ${c}`);
	}
	// literal entre aspas não classifica o comando (senão o gate ficaria vermelho pelo próprio texto)
	assert.equal(isTestCommand(`echo 'no tests found here'; tsc --noEmit`), false);
	assert.equal(isTestCommand(`echo "running tests" && bun typecheck`), false);
	assert.equal(isTestCommand(`echo "starting" && bun test`), true, "o comando real ainda conta");
});
