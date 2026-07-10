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
import { type BranchActionKind, type BranchConfig, featureBranchName, hasNonHarnessDirt, planBranchAction, readBranchConfig } from "./branch.ts";

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
 * Base EFETIVA de onde cortar. Usa a base configurada se ela existir (local ou origin); senão
 * DETECTA a default do repo — origin/HEAD → "main"/"master" locais → a branch atual. Sem isto,
 * um repo cujo default é "master" (e sem delivery.json) fica SEMPRE "off-base" contra o default
 * "main" e o run-start nunca corta a branch da feature (o sintoma reportado).
 */
export function resolveBase(cwd: string, configured: string): string {
	const exists = (ref: string) => gitRead(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== undefined;
	if (exists(`refs/heads/${configured}`) || exists(`refs/remotes/origin/${configured}`)) return configured;
	const head = gitRead(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	const m = head?.match(/refs\/remotes\/origin\/(.+)$/);
	if (m?.[1]) return m[1];
	for (const cand of ["main", "master"]) {
		if (exists(`refs/heads/${cand}`)) return cand;
	}
	return gitRead(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? configured;
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
	// Base efetiva (detecta a default do repo quando a configurada não existe — main×master).
	const base = resolveBase(cwd, cfg.base);
	// "Dirty" ignora sujeira `.harness/`-only (harness-owned; carregada limpa pelo switch) —
	// senão um profile doc mutado por sessão anterior veta o branch-per-feature da run inteira.
	const dirty = hasNonHarnessDirt(gitRead(cwd, ["status", "--porcelain"]) ?? "");
	const branchExists = gitRead(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== undefined;

	const action = planBranchAction({ name, current, base, dirty, branchExists, enabled: true });
	if (action.kind === "noop" || action.kind === "skip") return { ...action, base, mutated: false };

	if (action.kind === "switch") {
		const r = gitRun(cwd, ["switch", name]);
		return r.ok ? { ...action, base, mutated: true } : { kind: "error", branch: name, reason: `git switch failed: ${r.err ?? "?"}`, base, mutated: false };
	}

	// create: corta da base. Prefere origin/<base> (atualizado) se resolver; senão a base local.
	gitRead(cwd, ["fetch", "origin", base]); // best-effort; ignora falha (offline / sem remote)
	const originBase = gitRead(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`]) !== undefined ? `origin/${base}` : base;
	const r = gitRun(cwd, ["switch", "-c", name, originBase]);
	return r.ok ? { ...action, reason: `cut from ${originBase}`, base, mutated: true } : { kind: "error", branch: name, reason: `git switch -c failed: ${r.err ?? "?"}`, base, mutated: false };
}
