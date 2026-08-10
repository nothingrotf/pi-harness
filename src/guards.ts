/**
 * F2 do doc 09 (§3.2) — guards PROGRAMÁTICOS: as regras que hoje são prosa em SKILL.md e o
 * modelo viola viram um handler de `tool_call` que devolve `{ block: true, reason }`. O modelo
 * não contorna. Regra de ouro: todo guard devolve um reason ACIONÁVEL (o que fazer em vez
 * disso) — guard que só nega ensina o modelo a brigar; guard que redireciona ensina o caminho.
 *
 * Escopos (decididos pela extensão, passados no GuardScope):
 *   - worker "task" (env PI_HARNESS_WORKER_FEATURE + KIND=task): contract.md FROZEN,
 *     plan.json/status.json são dos tools, AGENTS.md do repo é do repo, merge é humano;
 *   - worker "ship-gate": igual, MAS status.json é permitido (o qa-validator escreve os
 *     statuses das assertions por contrato);
 *   - orchestrator (sessão viva em phase run/ship): NUNCA implementa — escrita fora de
 *     .harness/ é bloqueada com o redirect pra fixTasks.
 *
 * Avaliação PURA (testável); a extensão só monta o GuardScope e repassa.
 */
import * as path from "node:path";

export interface GuardCall {
	toolName: string;
	/** input.path dos tools write/edit. */
	path?: string;
	/** input.command do bash. */
	command?: string;
}

export interface GuardScope {
	cwd: string;
	featureId: string | null;
	role: "worker" | "orchestrator";
	/** kind do step do worker (task | ship-gate). Irrelevante pro orchestrator. */
	kind?: "task" | "ship-gate";
	/** plan.json já existe? (contract congela no store_plan). */
	planExists: boolean;
}

export interface GuardVerdict {
	block: true;
	reason: string;
}

const WRITE_TOOLS = new Set(["write", "edit", "Write", "Edit", "apply_patch"]);

function norm(cwd: string, p: string): string {
	return path.resolve(cwd, p);
}

function isRunFile(cwd: string, featureId: string, p: string, name: string): boolean {
	return norm(cwd, p) === path.join(cwd, ".harness", "runs", featureId, name);
}

function underHarness(cwd: string, p: string): boolean {
	return norm(cwd, p).startsWith(path.join(cwd, ".harness") + path.sep);
}

function underRepo(cwd: string, p: string): boolean {
	const rel = path.relative(cwd, norm(cwd, p));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Redirecionamento de escrita pro contract.md via bash (>, >>, tee, sed -i) — evasão do guard. */
function bashTargetsContract(command: string): boolean {
	if (!/contract\.md/.test(command)) return false;
	return /(?:>>?|\btee\b|\bsed\s+-i\b)\s*[^|]*contract\.md/.test(command) || /contract\.md\s*<<?/.test(command);
}

const MERGE_RE = /\bgit\s+merge\b|\bgh\s+pr\s+merge\b/;

export function evaluateGuard(call: GuardCall, scope: GuardScope): GuardVerdict | null {
	const fid = scope.featureId;
	if (scope.role === "worker") {
		if (WRITE_TOOLS.has(call.toolName) && call.path && fid) {
			if (scope.planExists && isRunFile(scope.cwd, fid, call.path, "contract.md")) {
				return { block: true, reason: `contract.md is FROZEN after store_plan. If an assertion is genuinely wrong, do NOT edit it — report it in your EndFeatureRun handoff (discoveredIssues) so the orchestrator re-converges.` };
			}
			if (isRunFile(scope.cwd, fid, call.path, "plan.json")) {
				return { block: true, reason: "plan.json is tool-owned (store_plan writes it). Pull work with next_task; never edit the plan by hand." };
			}
			if (scope.kind !== "ship-gate" && isRunFile(scope.cwd, fid, call.path, "status.json")) {
				return { block: true, reason: "status.json is owned by the ship gate (qa-validator updates assertion statuses). Implement and commit; the gate records the passes." };
			}
			const rel = path.relative(scope.cwd, norm(scope.cwd, call.path));
			if (rel === "AGENTS.md" || rel === "CLAUDE.md") {
				return { block: true, reason: "The repo's AGENTS.md/CLAUDE.md belongs to the repo, not the harness. Suggest guidance changes in .harness/profile/harness.md (or your handoff), never by editing the repo's own agent docs." };
			}
		}
		if (call.toolName === "bash" && call.command) {
			if (MERGE_RE.test(call.command)) {
				return { block: true, reason: "Merging is a HUMAN decision (the deliver step stops at the merge gate). Push your branch and let store_delivery/awaiting_merge surface it — never merge yourself." };
			}
			if (scope.planExists && bashTargetsContract(call.command)) {
				return { block: true, reason: "contract.md is FROZEN after store_plan — writing to it via bash redirection is not allowed. Report contract problems in your handoff instead." };
			}
		}
		return null;
	}
	// orchestrator: NUNCA implementa (doc 09 §3.2). Escrita fora de .harness/ durante run/ship →
	// redirect pro caminho certo (fixTasks). Leitura/análise continuam livres.
	if (WRITE_TOOLS.has(call.toolName) && call.path && underRepo(scope.cwd, call.path) && !underHarness(scope.cwd, call.path)) {
		return { block: true, reason: "You are the ORCHESTRATOR — you never implement. Dispatch this change as a fix task: call run_feature with fixTasks:[…] (it runs in a worker session, above the ship gate). Writes under .harness/ remain allowed." };
	}
	return null;
}
