import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTaskSpec, parseContractAssertions, readContractAssertions } from "../src/contract.ts";
import type { Task } from "../src/plan.ts";

const CONTRACT = `# Acceptance Contract — Example

**Feature id:** \`feat-x\` — **FROZEN**

Preamble prose that must be ignored.

## Area: Authentication

### VAL-AUTH-001: Successful login
A user with valid credentials submits the login form and is redirected to the dashboard.
Tool: agent-browser
Evidence: screenshot, network(POST /api/auth/login -> 200)

### VAL-AUTH-002: Hash lookup is O(1)
operator() must be O(1) in pointer length: NO full token scan.
Tool: script
Evidence: benchmark output

## Cross-Area Flows

### VAL-CROSS-001: Auth gates pricing
A guest sees "Sign in for pricing"; after logging in, real prices show.
Tool: agent-browser
Evidence: screenshot(guest-view), screenshot(authed-view)
`;

test("parseContractAssertions extracts id → title+body blocks", () => {
	const m = parseContractAssertions(CONTRACT);
	assert.deepEqual([...m.keys()], ["VAL-AUTH-001", "VAL-AUTH-002", "VAL-CROSS-001"]);
	const a1 = m.get("VAL-AUTH-001") as string;
	assert.ok(a1.startsWith("Successful login"));
	assert.ok(a1.includes("redirected to the dashboard"));
	assert.ok(a1.includes("Evidence: screenshot"));
	// o corpo de uma assertion não vaza pra seguinte
	assert.ok(!a1.includes("O(1)"));
	// constraint dura preservada verbatim (o ponto do brief)
	assert.ok((m.get("VAL-AUTH-002") as string).includes("NO full token scan"));
});

test("parseContractAssertions ignores preamble, ## sections and non-assertion headings", () => {
	const m = parseContractAssertions(CONTRACT);
	assert.equal(m.size, 3);
	assert.ok(![...m.values()].some((t) => t.includes("Preamble")));
});

test("parseContractAssertions on prose without assertions returns empty map", () => {
	assert.equal(parseContractAssertions("# Title\n\nJust prose.\n## Section\nMore prose.").size, 0);
});

test("readContractAssertions reads from the run dir; empty map when absent", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-contract-"));
	assert.equal(readContractAssertions(cwd, "feat-x").size, 0);
	const dir = path.join(cwd, ".harness", "runs", "feat-x");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "contract.md"), CONTRACT);
	const m = readContractAssertions(cwd, "feat-x");
	assert.equal(m.size, 3);
});

function task(over: Partial<Task> = {}): Task {
	return { id: "T2", description: "hash op", skillName: "backend-worker", fulfills: ["VAL-AUTH-002"], ...over };
}

test("buildTaskSpec resolves fulfills into contractAssertions text", () => {
	const spec = buildTaskSpec(task(), parseContractAssertions(CONTRACT));
	assert.equal(spec.id, "T2");
	assert.deepEqual(spec.fulfills, ["VAL-AUTH-002"]);
	assert.equal(spec.contractAssertions?.length, 1);
	assert.equal(spec.contractAssertions?.[0].id, "VAL-AUTH-002");
	assert.ok(spec.contractAssertions?.[0].text.includes("NO full token scan"));
});

test("buildTaskSpec omits contractAssertions for foundational tasks and unknown ids", () => {
	const m = parseContractAssertions(CONTRACT);
	assert.equal(buildTaskSpec(task({ fulfills: [] }), m).contractAssertions, undefined);
	const unknown = buildTaskSpec(task({ fulfills: ["VAL-NOPE-999"] }), m);
	assert.equal(unknown.contractAssertions, undefined);
	assert.deepEqual(unknown.fulfills, ["VAL-NOPE-999"]); // id preservado — nada silenciosamente perdido
});

test("buildTaskSpec defaults optional arrays", () => {
	const spec = buildTaskSpec(task({ preconditions: undefined, expectedBehavior: undefined }), new Map());
	assert.deepEqual(spec.preconditions, []);
	assert.deepEqual(spec.expectedBehavior, []);
});
