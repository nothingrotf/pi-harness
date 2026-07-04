/**
 * UI state GLOBAL persistido (`${agentDir}/pi-harness/ui-state.json`) — flags de UX que
 * sobrevivem entre sessões/repos. O primeiro morador é o `hasSeenFeatureOnboarding`, o análogo
 * exato do `hasSeenMissionOnboarding` do Droid: o card de intro do fluxo de feature aparece UMA
 * vez (na primeira feature de todas), depois nunca mais — o fluxo segue direto pro readiness
 * gate/converge. Tolerante a JSON ausente/corrompido; IO best-effort (nunca quebra o fluxo).
 * Pi-free, testável (agentDir injetável — mesmo padrão do model-config).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type PathOpts, resolveAgentDir } from "./model-config.ts";

export interface UiState {
	/** o card de onboarding da feature já foi visto (Droid: hasSeenMissionOnboarding). */
	hasSeenFeatureOnboarding?: boolean;
}

export function uiStatePath(opts: PathOpts = {}): string {
	return path.join(resolveAgentDir(opts), "pi-harness", "ui-state.json");
}

export function loadUiState(opts: PathOpts = {}): UiState {
	try {
		const raw = JSON.parse(fs.readFileSync(uiStatePath(opts), "utf8")) as UiState;
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

export function saveUiState(state: UiState, opts: PathOpts = {}): void {
	try {
		const p = uiStatePath(opts);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// best-effort — sem persistência o card só re-aparece
	}
}

/** O onboarding deve aparecer? (uma vez, ever — o gate `hasSeenMissionOnboarding` do Droid). */
export function shouldShowOnboarding(opts: PathOpts = {}): boolean {
	return !loadUiState(opts).hasSeenFeatureOnboarding;
}

/** Marca o onboarding como visto (chamado quando o usuário CONTINUA do card). */
export function markOnboardingSeen(opts: PathOpts = {}): void {
	saveUiState({ ...loadUiState(opts), hasSeenFeatureOnboarding: true }, opts);
}
