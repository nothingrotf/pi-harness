/**
 * Branch-per-feature — o lado IO (git) do hook de run-start. Determinístico e CONSERVADOR
 * (decisão do usuário): só cria/troca a branch da feature quando se está na base com a árvore
 * limpa; senão respeita a branch atual. **Nunca-fatal**: qualquer erro de git é capturado e
 * vira um resultado `error` (o run segue normalmente).
 *
 * A decisão pura (planBranchAction) e a derivação do nome vivem em branch.ts (testadas sem git).
 * Aqui só juntamos o estado do git (HEAD, dirty, branch existe) e executamos a ação.
 */
import { execFileSync } from "node:child_process";
import { type BranchActionKind, type BranchConfig, featureBranchName, planBranchAction, readBranchConfig } from "./branch.ts";

/** As ações puras + `error` (falha de git, capturada — nunca-fatal). */
export type EnsureBranchKind = BranchActionKind | "error";

export interface EnsureBranchResult {
	kind: EnsureBranchKind;
	branch: string;
	reason: string;
	/** base configurada (pro PR do deliver e pro notify). */
	base: string;
	/** true se um git mutante (switch/create) realmente correu. */
	mutated: boolean;
}

/** Roda um git read-only; devolve stdout trimado ou undefined em erro (silencioso). */
function gitRead(cwd: string, args: string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

/** Roda um git mutante; devolve ok + a mensagem de erro (capturada). */
function gitRun(cwd: string, args: string[]): { ok: boolean; err?: string } {
	try {
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true };
	} catch (e) {
		return { ok: false, err: (e as Error).message };
	}
}

/**
 * Garante a branch da feature no início do run. Retorna o que foi feito (create/switch/noop/skip/
 * error) + a base. Não lança — em qualquer falha de git devolve `kind:"error"` e o run prossegue.
 */
export function ensureFeatureBranch(cwd: string, featureId: string, cfg: BranchConfig = readBranchConfig(cwd)): EnsureBranchResult {
	const name = featureBranchName(cwd, featureId, cfg);
	if (!cfg.enabled) return { kind: "skip", branch: name, reason: "branch-per-feature disabled (delivery.json)", base: cfg.base, mutated: false };

	const current = gitRead(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (current === undefined) return { kind: "error", branch: name, reason: "not a git repo / git unavailable", base: cfg.base, mutated: false };
	const dirty = (gitRead(cwd, ["status", "--porcelain"]) ?? "").length > 0;
	const branchExists = gitRead(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== undefined;

	const action = planBranchAction({ name, current, base: cfg.base, dirty, branchExists, enabled: true });
	if (action.kind === "noop" || action.kind === "skip") return { ...action, base: cfg.base, mutated: false };

	if (action.kind === "switch") {
		const r = gitRun(cwd, ["switch", name]);
		return r.ok ? { ...action, base: cfg.base, mutated: true } : { kind: "error", branch: name, reason: `git switch failed: ${r.err ?? "?"}`, base: cfg.base, mutated: false };
	}

	// create: corta da base. Prefere origin/<base> (atualizado) se resolver; senão a base local.
	gitRead(cwd, ["fetch", "origin", cfg.base]); // best-effort; ignora falha (offline / sem remote)
	const originBase = gitRead(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${cfg.base}`]) !== undefined ? `origin/${cfg.base}` : cfg.base;
	const r = gitRun(cwd, ["switch", "-c", name, originBase]);
	return r.ok ? { ...action, reason: `cut from ${originBase}`, base: cfg.base, mutated: true } : { kind: "error", branch: name, reason: `git switch -c failed: ${r.err ?? "?"}`, base: cfg.base, mutated: false };
}
