/**
 * Commit-gate — verificação determinística OPT-IN na fronteira de task do `next_task`.
 *
 * Motivação (incidente real): um batch worker commitou T3–T7 com a árvore NÃO-compilável
 * (224 erros de typecheck) e o sequenciador avançou mesmo assim — o git-gate do next_task é
 * booleano ("HEAD avançou?") e o "rode a verificação antes do handoff" do worker-base é
 * advisory. Todo worker seguinte herdou o gate vermelho → horas de resend/retry em cascata.
 *
 * O fix: quando `.harness/profile/delivery.json` traz `commitGate` (machine-readable, como o
 * `branch` — services.yaml é prosa só-LLM), o next_task roda o comando configurado ANTES de
 * completar a task ativa. Vermelho → NÃO completa, re-entrega a MESMA task com o tail do erro.
 * "Árvore verde a cada fronteira de task" vira invariante de máquina, não confiança no worker.
 *
 * Opt-in deliberado: sem `commitGate` no delivery.json nada muda (zero custo em repos que não
 * o autoraram). O comando deve ser RÁPIDO (tipicamente o typecheck repo-wide) — o harness-setup
 * documenta e prova o comando no Phase 7.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { deliveryConfigPath } from "./branch.ts";
import { detectZeroTests, isTestCommand } from "./gate-output.ts";

export interface CommitGateConfig {
	/** liga/desliga sem apagar a config (default true quando `command` existe). */
	enabled: boolean;
	/** comando shell verificado (ex.: "bun run typecheck"). Sem comando → gate inexistente. */
	command: string;
	/** timeout em segundos (estourou → gate FALHA com nota de timeout, nunca pendura o worker). */
	timeoutSec: number;
}

export const DEFAULT_COMMIT_GATE_TIMEOUT_SEC = 300;

/** Normaliza a config crua (tolerante). Sem objeto ou sem `command` não-vazio → undefined (sem gate). */
export function normalizeCommitGateConfig(raw: unknown): CommitGateConfig | undefined {
	const r = (raw && typeof raw === "object" ? raw : undefined) as Record<string, unknown> | undefined;
	if (!r) return undefined;
	const command = typeof r.command === "string" ? r.command.trim() : "";
	if (!command) return undefined;
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : true,
		command,
		timeoutSec: typeof r.timeoutSec === "number" && r.timeoutSec > 0 ? Math.floor(r.timeoutSec) : DEFAULT_COMMIT_GATE_TIMEOUT_SEC,
	};
}

/** Lê `commitGate` do delivery.json do profile. Ausente/inválido/disabled → undefined (sem gate). */
export function readCommitGateConfig(cwd: string): CommitGateConfig | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(deliveryConfigPath(cwd), "utf8")) as { commitGate?: unknown };
		const cfg = normalizeCommitGateConfig(raw?.commitGate);
		return cfg?.enabled ? cfg : undefined;
	} catch {
		return undefined;
	}
}

/** Últimos `maxChars` de um texto (o fim é onde o erro de build/typecheck mora). */
export function tail(text: string, maxChars = 2000): string {
	const t = text.trimEnd();
	return t.length <= maxChars ? t : `…(truncated)…\n${t.slice(-maxChars)}`;
}

export interface CommitGateResult {
	ok: boolean;
	/** tail combinado de stdout+stderr (pro worker ver O QUE quebrou sem re-rodar). */
	output: string;
	timedOut: boolean;
	/** exit 0 mas NENHUM teste coletado — gate quebrado, tratado como vermelho (ver gate-output.ts). */
	zeroTests?: boolean;
}

/** Roda o gate (bash -c, com timeout). Nunca lança — falha de exec = gate vermelho com a razão. */
export function runCommitGate(cwd: string, cfg: CommitGateConfig): CommitGateResult {
	try {
		const out = execFileSync("bash", ["-c", cfg.command], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: cfg.timeoutSec * 1000,
			maxBuffer: 16 * 1024 * 1024,
		});
		// Exit 0 não basta: um comando de teste que coletou zero specs também sai 0. Verde vazio é
		// pior que vermelho — aprova código que nenhum teste tocou.
		if (isTestCommand(cfg.command)) {
			const z = detectZeroTests(out);
			if (z.zero) {
				return {
					ok: false,
					zeroTests: true,
					timedOut: false,
					output: tail(`${out}\n\n[harness] The gate command exited 0 but collected ZERO tests ("${z.evidence}"). That is a BROKEN gate command, not a passing suite — fix the command in .harness/profile/services.yaml (a misplaced flag or filter is the usual cause), then re-run.`),
				};
			}
		}
		return { ok: true, output: tail(out), timedOut: false };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; signal?: string; killed?: boolean; message?: string };
		const timedOut = err.killed === true || err.signal === "SIGTERM";
		const combined = [err.stdout ?? "", err.stderr ?? ""].filter((s) => s.trim()).join("\n") || err.message || "commit gate command failed";
		return { ok: false, output: tail(combined), timedOut };
	}
}
