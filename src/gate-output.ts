/**
 * Leitura do OUTPUT de um gate — o sinal que o exit code não dá.
 *
 * Um runner de testes que não coletou NADA sai com 0. Para o harness isso é indistinguível de
 * "tudo passou", e foi exatamente o incidente: `services.yaml` trazia `bunx vp test --project X run`
 * com `run` DEPOIS de `--project`, que o vp interpreta como filtro de nome — zero specs coletados,
 * exit 0, gate verde. Seis ocorrências reais em sotaq+hibou, cada uma aprovando código que nenhum
 * teste tocou. Um comando de teste que coleta zero é um gate QUEBRADO, não um gate limpo.
 *
 * A detecção é por SENTINELA (denylist de frases de "não rodei nada"), não por parse do total:
 * cada framework imprime o sumário à sua maneira, e exigir parse daria falso-positivo em todo
 * runner desconhecido. Sentinela erra pro lado seguro — só acusa o que reconhece com certeza.
 */

/** Frases que provam coleta vazia. Cobre vitest/jest/pytest/go/cargo/mocha/phpunit. */
const ZERO_TEST_SENTINELS: RegExp[] = [
	/\bno test files found\b/i,
	/\bno tests? found\b/i,
	/\bno tests? ran\b/i,
	/\bno tests? to run\b/i,
	/\bno tests? were found\b/i,
	/\bno test suites? found\b/i,
	/\bcollected 0 items\b/i,
	/\btests?:\s*0\b(?!\s*failed)/i,
	/\btest files\s+no tests\b/i,
	/\b0 (?:tests?|specs?|examples?) (?:ran|passed|completed|found)\b/i,
	/\btest result:\s*ok\.\s*0 passed\b/i,
	/\bno test specified\b/i,
	/\btesting:\s*warning: no tests to run\b/i,
	/\[no tests to run\]/i,
];

export interface ZeroTestVerdict {
	/** true quando o output PROVA que nenhum teste foi coletado. */
	zero: boolean;
	/** a linha que provou (pro relatório do gate). */
	evidence?: string;
}

/** Detecta coleta vazia no output de um comando de teste. Desconhecido → `zero: false`. */
export function detectZeroTests(output: string): ZeroTestVerdict {
	if (!output) return { zero: false };
	for (const line of output.split("\n")) {
		const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
		if (!clean) continue;
		for (const re of ZERO_TEST_SENTINELS) {
			if (re.test(clean)) return { zero: true, evidence: clean.slice(0, 200) };
		}
	}
	return { zero: false };
}

/**
 * true se o comando é (ou contém) uma invocação de testes — só aí a sentinela de coleta se aplica.
 * Literais entre aspas são removidos antes do match: sem isso um `echo "no tests found"` dentro de um
 * comando de typecheck se classificaria como teste e o gate ficaria vermelho por causa do PRÓPRIO
 * texto que imprime.
 */
export function isTestCommand(command: string): boolean {
	const unquoted = command.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
	return /(^|[\s;&|])(test|tests|spec|specs|vitest|jest|pytest|mocha|phpunit|rspec|go\s+test|cargo\s+test)\b/i.test(unquoted);
}
