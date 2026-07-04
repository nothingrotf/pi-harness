/**
 * Persistência do PONTEIRO de modo (qual feature está ativa) — o que faltava pro harness
 * sobreviver a um /reload. No Droid o estado da mission vive no disco (state.json) e o
 * runtime/picker resume a partir dele (docs 02-runtime §"persistence guarantees"); aqui o
 * run já vive no disco (.harness/runs/<id>/), mas o ponteiro "feature ativa" era só memória.
 *
 * Gravado em .harness/runs/.session.json (dentro do runs/ gitignored; o listRunIds ignora
 * dotfiles/dirs-sem-plan). Best-effort: falha de IO nunca quebra o fluxo. Pi-free, testável.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessMode, Phase } from "./mode.ts";

export interface PersistedMode {
	active: boolean;
	featureId: string;
	phase: Phase;
}

function sessionPath(cwd: string): string {
	return path.join(cwd, ".harness", "runs", ".session.json");
}

/** Persiste o ponteiro (active+featureId+phase). Sem feature ativa → limpa. */
export function saveMode(cwd: string, mode: HarnessMode): void {
	try {
		if (!mode.active || !mode.featureId) {
			clearMode(cwd);
			return;
		}
		const data: PersistedMode = { active: true, featureId: mode.featureId, phase: mode.phase };
		fs.mkdirSync(path.dirname(sessionPath(cwd)), { recursive: true });
		fs.writeFileSync(sessionPath(cwd), `${JSON.stringify(data)}\n`);
	} catch {
		// best-effort — a ausência só significa "sem auto-resume"
	}
}

/** Lê o ponteiro persistido. null se ausente/inválido. */
export function loadMode(cwd: string): PersistedMode | null {
	try {
		const raw = JSON.parse(fs.readFileSync(sessionPath(cwd), "utf8")) as PersistedMode;
		if (raw?.active && typeof raw.featureId === "string" && raw.featureId) {
			return { active: true, featureId: raw.featureId, phase: (raw.phase ?? "run") as Phase };
		}
	} catch {
		// ausente/corrompido
	}
	return null;
}

/** Rename do run (picker Ctrl+R): se o ponteiro aponta pro id antigo, segue o novo. Best-effort. */
export function renameModePointer(cwd: string, oldId: string, newId: string): void {
	try {
		const cur = loadMode(cwd);
		if (cur && cur.featureId === oldId) {
			fs.writeFileSync(sessionPath(cwd), `${JSON.stringify({ ...cur, featureId: newId })}\n`);
		}
	} catch {
		// best-effort
	}
}

/** Remove o ponteiro (saída do modo / órfão). */
export function clearMode(cwd: string): void {
	try {
		fs.rmSync(sessionPath(cwd));
	} catch {
		// já ausente
	}
}
