/**
 * Usage/custo por feature run — telemetria POST-HOC pura (zero captura no RPC).
 *
 * Fonte: os session files que os workers já gravam (`.harness/runs/<id>/sessions/<ts>_<wsid>.jsonl`)
 * persistem, por mensagem assistant, `usage.{input,output,cacheRead,cacheWrite}` + `cost.total` (em
 * dólares, já calculado pelo pi) + `model`. O join é determinístico: `feature-run.json.steps[]
 * .workerSessionIds` → ficheiro de sessão (findWorkerSessionFile). Este módulo só LÊ e agrega —
 * por step, por role (worker = task steps; validator = ship-gate) e total.
 *
 * Racional (research 2026-07-13 harness-fusion-methodology): a economia de um agente é dominada
 * por turnos/contexto/delegação, não por preço-por-token — mas sem medir custo por resultado
 * aceito, nenhuma decisão de sizing (budget de batch, modelo por role) é verificável. Este módulo
 * torna cada feature real um datapoint. Limitações conhecidas (documentadas em docs/06):
 * o orchestrator VIVO e os subagents nested (pi-subagents) ficam fora deste agregado.
 */
import * as fs from "node:fs";
import { findWorkerSessionFile } from "./control-worker.ts";
import type { FeatureRun } from "./feature-runner.ts";
import { type HarnessRole, roleForStep } from "./model-config.ts";
import { readFeatureRun } from "./plan.ts";

export interface UsageTotals {
	/** nº de mensagens assistant com usage (≈ turnos do modelo). */
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** custo em dólares (soma de usage.cost.total por mensagem). */
	cost: number;
}

export function emptyUsage(): UsageTotals {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(into: UsageTotals, u: UsageTotals): void {
	into.turns += u.turns;
	into.input += u.input;
	into.output += u.output;
	into.cacheRead += u.cacheRead;
	into.cacheWrite += u.cacheWrite;
	into.cost += u.cost;
}

interface SessionLine {
	message?: { role?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
}

export interface SessionUsage extends UsageTotals {
	/** modelos vistos nas mensagens assistant (normalmente 1). */
	models: string[];
}

/**
 * Contexto carregado no ÚLTIMO turno de uma sessão (input+cacheRead+cacheWrite da última mensagem
 * assistant com usage) — o "tamanho" atual da conversa, o número que a re-costura vigia. Não é
 * cumulativo: cada turno re-cobra o histórico inteiro, então o último turno JÁ É o total carregado.
 * Tolerante a linha parcial (ficheiro em escrita). null sem ficheiro/sem turno com usage.
 */
export function lastTurnContext(file: string | undefined): number | null {
	if (!file) return null;
	let last: number | null = null;
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			let o: SessionLine;
			try {
				o = JSON.parse(t) as SessionLine;
			} catch {
				continue;
			}
			const u = o.message?.usage;
			if (o.message?.role === "assistant" && u) last = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		}
	} catch {
		return null;
	}
	return last;
}

/**
 * Folda o usage de um transcript de sessão do pi (jsonl; uma entry por linha, mensagem em
 * `.message`). Tolerante: linhas parciais/não-JSON são puladas (o ficheiro pode estar a ser
 * escrito por um worker vivo — leitura read-only, mesmo contrato do session-read).
 */
export function parseSessionUsage(content: string): SessionUsage {
	const out: SessionUsage = { ...emptyUsage(), models: [] };
	const models = new Set<string>();
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let o: SessionLine;
		try {
			o = JSON.parse(t) as SessionLine;
		} catch {
			continue; // linha parcial (ficheiro em escrita)
		}
		const m = o.message;
		if (!m || m.role !== "assistant" || typeof m.usage !== "object" || m.usage === null) continue;
		const u = m.usage;
		out.turns++;
		out.input += u.input ?? 0;
		out.output += u.output ?? 0;
		out.cacheRead += u.cacheRead ?? 0;
		out.cacheWrite += u.cacheWrite ?? 0;
		out.cost += u.cost?.total ?? 0;
		if (m.model) models.add(m.model);
	}
	out.models = [...models];
	return out;
}

export interface StepUsage {
	stepId: string;
	kind: string;
	role: HarnessRole;
	/** wsids com session file encontrado / total de wsids do step. */
	sessionsRead: number;
	sessionsTotal: number;
	models: string[];
	usage: UsageTotals;
}

export interface FeatureUsage {
	featureId: string;
	steps: StepUsage[];
	byRole: Partial<Record<HarnessRole, UsageTotals>>;
	total: UsageTotals;
	/** sessões referenciadas no run sem ficheiro legível (crash cedo, dir apagado). */
	missingSessions: number;
}

/**
 * Agrega o usage de um FeatureRun já carregado (puro dado o leitor de ficheiros — testável).
 * `readFile` injetável nos testes; default lê o session file real via findWorkerSessionFile.
 */
export function featureUsageFromRun(cwd: string, run: FeatureRun, readSession: (wsid: string) => string | null = (wsid) => defaultReadSession(cwd, run.featureId, wsid)): FeatureUsage {
	const steps: StepUsage[] = [];
	const byRole: Partial<Record<HarnessRole, UsageTotals>> = {};
	const total = emptyUsage();
	let missing = 0;
	for (const s of run.steps) {
		const wsids = s.workerSessionIds ?? [];
		const role = roleForStep(s);
		const agg = emptyUsage();
		const models = new Set<string>();
		let read = 0;
		for (const wsid of wsids) {
			const content = readSession(wsid);
			if (content == null) {
				missing++;
				continue;
			}
			read++;
			const u = parseSessionUsage(content);
			addUsage(agg, u);
			for (const m of u.models) models.add(m);
		}
		steps.push({ stepId: s.id, kind: s.kind, role, sessionsRead: read, sessionsTotal: wsids.length, models: [...models], usage: agg });
		const r = (byRole[role] ??= emptyUsage());
		addUsage(r, agg);
		addUsage(total, agg);
	}
	return { featureId: run.featureId, steps, byRole, total, missingSessions: missing };
}

function defaultReadSession(cwd: string, featureId: string, wsid: string): string | null {
	const file = findWorkerSessionFile(cwd, featureId, wsid);
	if (!file) return null;
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * Usage da SESSÃO DO ORCHESTRATOR VIVO (o chat) — o session file da própria sessão pi
 * (ctx.sessionManager.getSessionFile()). CUMULATIVO da sessão (inclui converge, análise de
 * handoffs e conversa fora do run — o custo de julgamento do líder não é janelável com precisão
 * porque o run bloqueia o turno). Fecha o confound #1 do docs/06 §2. null sem ficheiro legível.
 */
export function sessionUsageFromFile(file: string | undefined): SessionUsage | null {
	if (!file) return null;
	try {
		return parseSessionUsage(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** Linha do líder vivo pro run report (rotulada como cumulativa — não soma no TOTAL dos children). */
export function leadUsageLine(u: SessionUsage): string {
	const mdl = u.models.length ? ` · ${u.models.join(",")}` : "";
	return `  orchestrator [live chat, session-cumulative] turns=${u.turns} out=${fmtTokens(u.output)} cacheRead=${fmtTokens(u.cacheRead)} cost=${fmtCost(u.cost)}${mdl}`;
}

/** Agrega o usage da feature lendo feature-run.json + sessions/ do disco. null sem run. */
export function featureUsage(cwd: string, featureId: string): FeatureUsage | null {
	const run = readFeatureRun(cwd, featureId);
	if (!run) return null;
	return featureUsageFromRun(cwd, run);
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}
function fmtCost(c: number): string {
	return `$${c.toFixed(2)}`;
}

/**
 * Render plano (sem ANSI) do agregado — pro run report / `/harness status`. Omite steps sem
 * nenhuma sessão lida (nada a reportar). Vazio (só header) quando não há dados.
 */
export function usageReportLines(u: FeatureUsage, lead?: SessionUsage | null): string[] {
	const lines: string[] = [];
	const withData = u.steps.filter((s) => s.sessionsRead > 0);
	if (withData.length === 0 && !lead) return lines;
	lines.push("Usage (nested subagents not included):");
	if (lead && lead.turns > 0) lines.push(leadUsageLine(lead));
	if (withData.length === 0) return lines;
	for (const s of withData) {
		const mdl = s.models.length ? ` · ${s.models.join(",")}` : "";
		lines.push(`  ${s.stepId} [${s.role}] turns=${s.usage.turns} out=${fmtTokens(s.usage.output)} cacheRead=${fmtTokens(s.usage.cacheRead)} cost=${fmtCost(s.usage.cost)}${mdl}`);
	}
	const roles = Object.entries(u.byRole).filter(([, v]) => v && v.turns > 0) as [string, UsageTotals][];
	for (const [role, v] of roles) lines.push(`  ${role} total: turns=${v.turns} out=${fmtTokens(v.output)} cost=${fmtCost(v.cost)}`);
	lines.push(`  TOTAL (children): ${fmtCost(u.total.cost)}${u.missingSessions > 0 ? ` (${u.missingSessions} session(s) unreadable — undercount)` : ""}`);
	return lines;
}
