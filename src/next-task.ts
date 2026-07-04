/**
 * `next_task` — o SEQUENCIADOR determinístico do worker único (a fonte de verdade por-task).
 *
 * Num worker que entrega a feature inteira numa sessão, NENHUMA máquina sabe onde uma task termina
 * e outra começa — só o worker. Em vez de despejar a lista e torcer pro worker reportar (o antigo
 * `task_progress` advisory) ou adivinhar por mensagem de commit (frágil: um `[T3]` errado marcaria
 * a task errada), o harness vira o sequenciador: o worker PUXA cada task com `next_task`, e o TS
 * grava `task_started`/`task_completed` nas fronteiras. O worker não consegue trabalho sem passar
 * pelo protocolo → a fronteira é um tool execution gravado por máquina.
 *
 * A ÚNICA participação do git é uma checagem BOOLEANA — "o HEAD avançou desde que a task começou?"
 * — que decide entre AVANÇAR (finished) e REENVIAR a mesma task (retomada/ainda sem commit). Ela
 * NÃO lê a mensagem do commit e NUNCA marca outra task: o "qual task" vem SEMPRE do estado do
 * protocolo (`activeTaskId`), não do commit. Sem git (head undefined) degrada pro protocolo puro
 * (avança na chamada). Lógica pura testável isolada (test/next-task.test.ts).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { runDir } from "./handoff.ts";
import { writeJsonAtomic } from "./plan.ts";

/** Memória do loop (não confia no progress_log pra "ativo" — evita ruído do task_started de spawn). */
export interface NextTaskState {
	activeTaskId?: string;
	/** HEAD sha registrado quando a task ativa começou (pra checar avanço). */
	head?: string;
}

export interface NextTaskDecision {
	action: "start" | "resend" | "done";
	/** taskId a marcar completed (a anterior, quando avançou). */
	completePrev?: string;
	/** taskId a trabalhar (start/resend). */
	taskId?: string;
}

/** Primeiro taskId (na ordem do plano) ainda não completo, excluindo `exclude`. */
export function firstUncompleted(taskIds: string[], completed: Set<string>, exclude?: string): string | undefined {
	return taskIds.find((id) => id !== exclude && !completed.has(id));
}

/**
 * Decisão PURA do próximo passo. `state.activeTaskId` = a task que o worker estava fazendo.
 *   - ativo presente e AVANÇOU (HEAD mudou, ou sem git) → completa o ativo + começa o próximo (ou done).
 *   - ativo presente e NÃO avançou (mesmo HEAD) → reenvia o ativo (retomada ou faltou commitar).
 *   - sem ativo → começa o primeiro não-completo (ou done).
 * A checagem de git é booleana e só afeta a task CORRENTE — nunca marca outra.
 */
export function planNextTask(taskIds: string[], completed: Set<string>, state: NextTaskState, currentHead: string | undefined, isAncestor?: (ancestor: string, descendant: string) => boolean): NextTaskDecision {
	const active = state.activeTaskId;
	if (active && !completed.has(active)) {
		// "Avançou" = commits NOVOS sobre o head registado, não apenas "HEAD mexeu": amend/rebase da
		// task anterior ou um commit alheio mudam o sha sem entregar ESTA task. Com isAncestor,
		// exige ancestralidade (state.head ⊆ currentHead); sem git → confia na chamada.
		let advanced = currentHead ? currentHead !== state.head : true;
		if (advanced && currentHead && state.head && isAncestor) advanced = isAncestor(state.head, currentHead);
		if (!advanced) return { action: "resend", taskId: active };
		const next = firstUncompleted(taskIds, completed, active);
		return next ? { action: "start", completePrev: active, taskId: next } : { action: "done", completePrev: active };
	}
	const next = firstUncompleted(taskIds, completed);
	return next ? { action: "start", taskId: next } : { action: "done" };
}

// ─────────────────────────────────────────────────────────────────────────────
// IO (estado do loop + git HEAD + leitura do progress_log). Tolerante.

const stateFile = (cwd: string, featureId: string): string => path.join(runDir(cwd, featureId), "next-task.json");

export function readNextTaskState(cwd: string, featureId: string): NextTaskState {
	try {
		const o = JSON.parse(fs.readFileSync(stateFile(cwd, featureId), "utf8")) as NextTaskState;
		return { activeTaskId: typeof o.activeTaskId === "string" ? o.activeTaskId : undefined, head: typeof o.head === "string" ? o.head : undefined };
	} catch {
		return {};
	}
}
export function writeNextTaskState(cwd: string, featureId: string, state: NextTaskState): void {
	const dir = runDir(cwd, featureId);
	fs.mkdirSync(dir, { recursive: true });
	writeJsonAtomic(stateFile(cwd, featureId), state, false);
}
export function clearNextTaskState(cwd: string, featureId: string): void {
	try {
		fs.rmSync(stateFile(cwd, featureId));
	} catch {
		/* noop */
	}
}

/** HEAD sha atual. undefined se não há git/commit (→ protocolo puro). */
export function gitHead(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** true se `ancestor` é antepassado de `descendant` (há commits novos EM CIMA dele). */
export function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: ["ignore", "ignore", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

interface RawEvent {
	event?: string;
	taskId?: string;
	id?: string;
}
/** taskIds com task_completed (ou step_completed) no progress_log — o conjunto "completo". */
export function completedTaskIds(events: RawEvent[]): Set<string> {
	const s = new Set<string>();
	for (const e of events) {
		if (e.event === "task_completed" || e.event === "step_completed") {
			const id = String(e.taskId ?? e.id ?? "");
			if (id) s.add(id);
		}
	}
	return s;
}
/** Lê os eventos do progress_log.jsonl (linhas inválidas puladas). */
export function readProgressEvents(cwd: string, featureId: string): RawEvent[] {
	try {
		const text = fs.readFileSync(path.join(runDir(cwd, featureId), "progress_log.jsonl"), "utf8");
		const out: RawEvent[] = [];
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			try {
				out.push(JSON.parse(t) as RawEvent);
			} catch {
				/* skip */
			}
		}
		return out;
	} catch {
		return [];
	}
}
