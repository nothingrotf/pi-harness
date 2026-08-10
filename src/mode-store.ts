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
import { writeJsonAtomic } from "./plan.ts";

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
		writeJsonAtomic(sessionPath(cwd), data, false);
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

export function resolveSessionMode(reason: string, restored: PersistedMode | null, liveFeatureId: string | null): PersistedMode | null {
	if (liveFeatureId) return { active: true, featureId: liveFeatureId, phase: "run" };
	if (reason === "reload") return restored;
	return null;
}

/** Rename do run (picker Ctrl+R): se o ponteiro aponta pro id antigo, segue o novo. Best-effort. */
export function renameModePointer(cwd: string, oldId: string, newId: string): void {
	try {
		const cur = loadMode(cwd);
		if (cur && cur.featureId === oldId) {
			writeJsonAtomic(sessionPath(cwd), { ...cur, featureId: newId }, false);
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

// ─────────────────────────────────────────────────────────────────────────────
// Auto-heal do ponteiro: um run.lock com pid VIVO é a feature que está DE FACTO a correr — fonte
// de verdade FORTE (> ponteiro só-comando, que congela na 1ª feature num fluxo multi-feature).
// Puro de IO (lê .harness/runs/<id>/run.lock), `pidAlive` injetável p/ teste.

/** Pid gravado no run.lock de uma feature (null se ausente/ilegível/sem pid). */
export function readRunLockPid(cwd: string, featureId: string): number | null {
	try {
		const lock = JSON.parse(fs.readFileSync(path.join(cwd, ".harness", "runs", featureId, "run.lock"), "utf8")) as { pid?: number };
		return typeof lock.pid === "number" ? lock.pid : null;
	} catch {
		return null;
	}
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A feature que está DE FACTO a correr entre `featureIds`: o primeiro run.lock com pid VIVO,
 * preferindo `prefer` quando ele próprio está vivo (não troca à toa quando o ponteiro já bate).
 * null quando nenhum lock vivo — o caller mantém então o ponteiro persistido.
 */
export function liveLockedFeature(cwd: string, featureIds: string[], opts: { prefer?: string; pidAlive?: (pid: number) => boolean } = {}): string | null {
	const alive = opts.pidAlive ?? defaultPidAlive;
	const live = featureIds.filter((id) => {
		const pid = readRunLockPid(cwd, id);
		return pid !== null && alive(pid);
	});
	if (live.length === 0) return null;
	if (opts.prefer && live.includes(opts.prefer)) return opts.prefer;
	return live[0];
}
