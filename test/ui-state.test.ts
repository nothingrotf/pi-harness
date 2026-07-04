import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadUiState, markOnboardingSeen, shouldShowOnboarding, uiStatePath } from "../src/ui-state.ts";

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "harness-uistate-"));
}

test("onboarding once-only (hasSeenMissionOnboarding analog): mostra 1x, depois nunca mais", () => {
	const agentDir = tmp();
	assert.equal(shouldShowOnboarding({ agentDir }), true, "primeira vez → mostra");
	markOnboardingSeen({ agentDir });
	assert.equal(shouldShowOnboarding({ agentDir }), false, "depois de visto → nunca mais");
	assert.equal(loadUiState({ agentDir }).hasSeenFeatureOnboarding, true);
	assert.ok(fs.existsSync(uiStatePath({ agentDir })));
});

test("ui-state tolerante: json corrompido → default (mostra onboarding)", () => {
	const agentDir = tmp();
	fs.mkdirSync(path.join(agentDir, "pi-harness"), { recursive: true });
	fs.writeFileSync(uiStatePath({ agentDir }), "{corrupt");
	assert.equal(shouldShowOnboarding({ agentDir }), true);
	markOnboardingSeen({ agentDir }); // não lança
	assert.equal(shouldShowOnboarding({ agentDir }), false);
});
