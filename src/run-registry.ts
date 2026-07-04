/**
 * Run registry — o análogo do `EDH` (Map<baseSessionId, MissionRunner>) + do worker vivo do
 * modelo de referência (droid). Registra, POR FEATURE, o run ATIVO (AbortController → pause
 * graceful de qualquer lugar, o análogo do `RDT` "pause from anywhere") e o CLIENT RPC do worker
 * corrente (→ steer via `prompt`, o análogo do `addUserMessage` do interrupt-and-chat).
 *
 * Estado em memória do PROCESSO (o runner roda in-process, como o in-process daemon do droid);
 * a durabilidade é o disco (feature-run.json / progress_log.jsonl) — matar o processo não perde
 * nada além do turno em voo (doc 07 §5).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** O subconjunto steerable do RpcWorkerClient (injeta uma mensagem no worker vivo). */
export interface SteerableClient {
	prompt(message: string): Promise<void>;
}

const runs = new Map<string, AbortController>();
const workers = new Map<string, SteerableClient>();

const lockPath = (cwd: string, featureId: string): string => path.join(cwd, ".harness", "runs", featureId, "run.lock");

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Lock ON-DISK por feature (complementa o mutex in-memory, que só vê ESTE processo): uma TUI e
 * um run headless/CI no mesmo repo corriam em paralelo e clobberávam feature-run.json
 * (last-write-wins) + commits duplicados no mesmo branch. Lock stale (pid morto) é roubado.
 */
function acquireDiskLock(cwd: string, featureId: string): void {
	const file = lockPath(cwd, featureId);
	try {
		const held = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
		if (typeof held.pid === "number" && held.pid !== process.pid && pidAlive(held.pid)) {
			throw new Error(`feature "${featureId}" is locked by a live run in another process (pid ${held.pid})`);
		}
	} catch (e) {
		if ((e as Error).message?.includes("is locked by")) throw e;
		// sem lock / corrupto / pid morto → adquire
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
}

function releaseDiskLock(cwd: string, featureId: string): void {
	try {
		const held = JSON.parse(fs.readFileSync(lockPath(cwd, featureId), "utf8")) as { pid?: number };
		if (held.pid === process.pid) fs.rmSync(lockPath(cwd, featureId));
	} catch {
		/* noop */
	}
}

/**
 * Registra um run ativo. Lança se a feature já tem um (1 runner por feature, como o EDH) —
 * neste processo (mutex) OU noutro (lock on-disk, quando `cwd` é dado).
 */
export function registerRun(featureId: string, cwd?: string): AbortController {
	if (runs.has(featureId)) throw new Error(`feature "${featureId}" already has an active run`);
	if (cwd) acquireDiskLock(cwd, featureId);
	const c = new AbortController();
	runs.set(featureId, c);
	return c;
}

export function unregisterRun(featureId: string, cwd?: string): void {
	runs.delete(featureId);
	if (cwd) releaseDiskLock(cwd, featureId);
}

export function isRunActive(featureId: string): boolean {
	return runs.has(featureId);
}

export function activeRunIds(): string[] {
	return [...runs.keys()];
}

/**
 * Pause graceful (análogo do RDT): aborta o run ativo → o runLoop persiste `paused`/`aborted` e o
 * spawn interrompe o worker RETENDO o transcript (resume re-attacha). false = nada ativo.
 */
export function pauseRun(featureId: string): boolean {
	const c = runs.get(featureId);
	if (!c) return false;
	c.abort();
	return true;
}

/** Pausa TODOS os runs ativos (shutdown hook — o análogo do gracefulMissionExit). */
export function pauseAllRuns(): string[] {
	const ids = [...runs.keys()];
	for (const c of runs.values()) c.abort();
	return ids;
}

/** Registra o client RPC do worker vivo de uma feature (setado pelo spawn; limpo ao terminar). */
export function registerWorkerClient(featureId: string, client: SteerableClient): void {
	workers.set(featureId, client);
}

export function clearWorkerClient(featureId: string): void {
	workers.delete(featureId);
}

export function hasWorkerClient(featureId: string): boolean {
	return workers.has(featureId);
}

export type SteerResult = "sent" | "no_worker" | "error";

/**
 * Steer o worker vivo (análogo do `addUserMessage({sessionId,text})` do Worker Session viewer):
 * injeta a mensagem na sessão do worker corrente. Best-effort — "error" se o wire recusar.
 */
export async function steerWorker(featureId: string, text: string): Promise<SteerResult> {
	const c = workers.get(featureId);
	if (!c) return "no_worker";
	try {
		await c.prompt(text);
		return "sent";
	} catch {
		return "error";
	}
}
