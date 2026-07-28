/**
 * preflight — leitura das portas declaradas no services.yaml + quem as escuta. Torna visível no
 * run-start o conflito que hoje só aparece como gate vermelho enigmático (14 menções de colisão de
 * porta e 25 de "gate rodou sem os serviços" nas runs reais).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { duplicatePorts, parseServicePorts, portListeners, preflightPorts, preflightSummary, readServicePorts } from "../src/preflight.ts";

/** Recorte fiel do services.yaml real do hibou (comentários, campos livres e tudo). */
const REAL_YAML = `# Single source of truth for commands and services. Ports are hardcoded.

commands:
  test: bunx vp test run
  typecheck: bun typecheck

services:
  postgres:
    start: docker compose up -d postgres
    healthcheck: docker exec hibou-postgres pg_isready -U postgres -p 5432
    port: 5432
    depends_on: []
    notes: container hibou-postgres; dbs hibou_dev + hibou_test

  redis:
    start: docker compose up -d redis
    port: 6379
    depends_on: []

  minio:
    start: docker compose up -d minio
    port: "9000"
    notes: host 9000 is contended by another project

env:
  APP_ENV: development
`;

test("parseServicePorts: extrai serviço→porta do bloco services (aspas, comentários e campos livres)", () => {
	assert.deepEqual(parseServicePorts(REAL_YAML), [
		{ service: "postgres", port: 5432 },
		{ service: "redis", port: 6379 },
		{ service: "minio", port: 9000 },
	]);
});

test("parseServicePorts: não vaza portas de fora do bloco services, nem quebra sem o bloco", () => {
	assert.deepEqual(parseServicePorts("commands:\n  test: x\n    port: 1234\n"), [], "port fora de services: ignorada");
	assert.deepEqual(parseServicePorts(""), []);
	assert.deepEqual(parseServicePorts("services:\n"), []);
	// `5432` no healthcheck NÃO pode virar uma porta declarada
	assert.deepEqual(parseServicePorts("services:\n  db:\n    healthcheck: pg_isready -p 5432\n"), []);
});

test("readServicePorts: services.yaml ausente → vazio (nunca lança)", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness-preflight-"));
	assert.deepEqual(readServicePorts(d), []);
	fs.mkdirSync(path.join(d, ".harness", "profile"), { recursive: true });
	fs.writeFileSync(path.join(d, ".harness", "profile", "services.yaml"), REAL_YAML);
	assert.equal(readServicePorts(d).length, 3);
	fs.rmSync(d, { recursive: true, force: true });
});

test("duplicatePorts: duas entradas na mesma porta é erro de autoria do manifesto", () => {
	assert.deepEqual(duplicatePorts(parseServicePorts(REAL_YAML)), []);
	assert.deepEqual(
		duplicatePorts([
			{ service: "a", port: 5432 },
			{ service: "b", port: 5432 },
			{ service: "c", port: 6379 },
		]),
		[5432],
	);
});

test("portListeners: detecta um listener REAL e ignora porta livre", async () => {
	const net = await import("node:net");
	const srv = net.createServer();
	await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
	const port = (srv.address() as { port: number }).port;
	try {
		const found = portListeners([port, 1]);
		// lsof pode não existir no ambiente — só assere quando a ferramenta respondeu.
		if (found.size > 0) {
			assert.ok(found.has(port), "acha o listener que acabamos de abrir");
			assert.ok(!found.has(1), "porta livre não aparece");
		}
	} finally {
		srv.close();
	}
	assert.equal(portListeners([]).size, 0, "sem portas → sem chamada");
});

test("preflightPorts + preflightSummary: reporta livre vs ocupada, sem iniciar nada", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "harness-preflight-"));
	fs.mkdirSync(path.join(d, ".harness", "profile"), { recursive: true });
	fs.writeFileSync(path.join(d, ".harness", "profile", "services.yaml"), REAL_YAML);
	const st = preflightPorts(d);
	assert.equal(st.length, 3);
	for (const s of st) assert.equal(typeof s.listening, "boolean");
	assert.match(preflightSummary(st) ?? "", /ports/);
	assert.equal(preflightSummary([]), undefined, "sem serviços declarados → nada a dizer");
	fs.rmSync(d, { recursive: true, force: true });
});
