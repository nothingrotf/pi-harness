import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cleanupOrphan,
	type FeatureRun,
	type FeatureRunLoopDeps,
	gateRoundCapReached,
	grantGateRound,
	grantRetryBudget,
	IMPL_STEP_ID,
	injectShipGate,
	insertFixTask,
	nextPending,
	planFeatureRun,
	runLoop,
	type SpawnFn,
	type SpawnOutcome,
} from "../src/feature-runner.ts";

const NOW = () => "2026-06-29T00:00:00.000Z";

function tasks(...ids: string[]) {
	return ids.map((id) => ({ id, skillName: "backend-worker", fulfills: [`A-${id}`] }));
}

/** spawn que reporta success por step.id via um mapa; default success. */
function spawnFrom(outcomes: Record<string, SpawnOutcome>): SpawnFn {
	return async (step) => outcomes[step.id] ?? { code: 0, success: true };
}

function deps(spawn: SpawnFn, extra: Partial<FeatureRunLoopDeps> = {}): FeatureRunLoopDeps {
	return { spawn, now: NOW, ...extra };
}

test("planFeatureRun: N tasks viram UM impl step (1 worker por feature), sem gate ainda", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	assert.equal(run.featureId, "feat-x");
	assert.equal(run.steps.length, 1, "um único impl step carrega as N tasks (não N steps)");
	assert.equal(run.steps[0].id, IMPL_STEP_ID);
	assert.equal(run.steps[0].kind, "task");
	assert.equal(run.steps[0].status, "pending");
	assert.deepEqual(run.steps[0].tasks?.map((t) => t.id), ["T1", "T2"], "a lista de tasks vira o TODO interno do worker");
	assert.deepEqual(run.steps[0].fulfills, ["A-T1", "A-T2"], "fulfills = união das tasks");
	assert.equal(run.gateInjected, false);
});

test("planFeatureRun: T > budget → K batch steps implement-1..K (fatias por budget)", () => {
	const t = tasks("T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10");
	// budget 4 → [4,4,2]. A cauda 2 NÃO funde: 4+2=6 > teto(5) — fundir daria um batch de 150% do
	// budget, a forma exata que produziu 570k tok/turno numa run real (ver batch.ts foldCeiling).
	const run = planFeatureRun("feat-x", t, NOW, 4);
	assert.equal(run.steps.length, 3, "3 batch steps");
	assert.deepEqual(run.steps.map((s) => s.id), ["implement-1", "implement-2", "implement-3"]);
	assert.deepEqual(run.steps[0].tasks?.map((x) => x.id), ["T1", "T2", "T3", "T4"]);
	assert.deepEqual(run.steps[1].tasks?.map((x) => x.id), ["T5", "T6", "T7", "T8"]);
	assert.deepEqual(run.steps[2].tasks?.map((x) => x.id), ["T9", "T10"]);
	assert.deepEqual(run.steps[0].fulfills, ["A-T1", "A-T2", "A-T3", "A-T4"], "fulfills escopado ao batch");
	assert.deepEqual(run.steps[1].fulfills, ["A-T5", "A-T6", "A-T7", "A-T8"]);
	assert.deepEqual(run.steps[2].fulfills, ["A-T9", "A-T10"]);
	assert.ok(run.steps.every((s) => s.kind === "task" && s.status === "pending"));
});

test("planFeatureRun: budget 0 (desligado) → um único impl step legado, mesmo com T grande", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"), NOW, 0);
	assert.equal(run.steps.length, 1);
	assert.equal(run.steps[0].id, IMPL_STEP_ID);
});

test("runLoop: K batches rodam sequencialmente, DEPOIS o ship gate 1x, e completam", async () => {
	const t = tasks("T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10");
	const run = planFeatureRun("feat-x", t, NOW, 4); // [implement-1, implement-2, implement-3]
	const order: string[] = [];
	const doneTasks: string[] = [];
	await runLoop("/repo", run, deps(
		async (step) => { order.push(step.id); return { code: 0, success: true }; },
		{ log: (ev, extra) => { if (ev === "task_completed") doneTasks.push(String(extra?.taskId)); } },
	));
	assert.equal(run.status, "completed");
	assert.deepEqual(order, ["implement-1", "implement-2", "implement-3", "ship-gate-code-review", "ship-gate-qa-validator", "ship-gate-deliver"]);
	// task_completed emitido por sub-task ao completar CADA batch (TUI por-task correta em todos).
	assert.deepEqual(doneTasks, ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"]);
	assert.equal(run.gateInjected, true);
});

test("runLoop: describeStepModel grava model+thinking EFETIVOS no step_started (source-of-truth)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const started: Record<string, unknown>[] = [];
	// spawn all-success → impl completa, ship gate injeta e roda (emite step_started de gate).
	await runLoop("/repo", run, deps(spawnFrom({}), {
		log: (ev, extra) => { if (ev === "step_started") started.push(extra ?? {}); },
		// worker role resolve pra opus/xhigh; validator (ship-gate) herda (sem model) → não loga campo.
		describeStepModel: (step) => (step.kind === "task" ? { model: "anthropic/claude-opus-4", thinking: "xhigh" } : {}),
	}));
	const impl = started.find((s) => s.id === IMPL_STEP_ID);
	assert.equal(impl?.model, "anthropic/claude-opus-4");
	assert.equal(impl?.thinking, "xhigh");
	const gate = started.find((s) => s.kind === "ship-gate");
	assert.ok(gate && !("model" in gate), "role que herda (sem model resolvido) NÃO grava o campo");
});

test("runLoop: UM worker entrega todas as tasks, injeta ship gate 1x, completa", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	const order: string[] = [];
	const doneTasks: string[] = [];
	const spawn: SpawnFn = async (step) => {
		order.push(step.id);
		return { code: 0, success: true };
	};
	await runLoop("/repo", run, deps(spawn, { log: (ev, extra) => { if (ev === "task_completed") doneTasks.push(String(extra?.taskId)); } }));
	assert.equal(run.status, "completed");
	// 1 impl spawn (todas as tasks numa sessão) + os 3 passos do ship gate
	assert.deepEqual(order, [IMPL_STEP_ID, "ship-gate-code-review", "ship-gate-qa-validator", "ship-gate-deliver"]);
	// o runner emite task_completed por sub-task ao completar o impl step (TUI por-task fica correta)
	assert.deepEqual(doneTasks, ["T1", "T2"]);
	assert.equal(run.gateInjected, true);
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("runLoop: impl falha → orchestrator_turn (step volta a pending)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 0, success: false } })));
	assert.equal(run.status, "orchestrator_turn");
	const impl = run.steps.find((s) => s.id === IMPL_STEP_ID);
	assert.equal(impl?.status, "pending", "falha reseta pra pending (re-tenta no resume)");
	assert.equal(impl?.attempts, 1);
	assert.equal(run.gateInjected, false, "não injeta o gate enquanto a implementação não terminou");
});

test("runLoop: returnToOrchestrator também devolve controle", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 0, success: true, returnToOrchestrator: true } })));
	assert.equal(run.status, "orchestrator_turn");
});

test("runLoop: success + returnToOrchestrator COMPLETA o step (regressão: gate verde re-corria até estourar o budget)", async () => {
	// Ship gates reportam SEMPRE returnToOrchestrator:true — conclusão e controlo são ortogonais.
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const gateOutcome: SpawnOutcome = { code: 0, success: true, returnToOrchestrator: true };
	// passada 1: impl completa, code-review corre e devolve (verde)
	await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": gateOutcome, "ship-gate-qa-validator": gateOutcome, "ship-gate-deliver": gateOutcome })));
	assert.equal(run.status, "orchestrator_turn");
	const review = run.steps.find((s) => s.id === "ship-gate-code-review");
	assert.equal(review?.status, "completed", "gate verde NÃO regride a pending");
	assert.equal(review?.attempts, 1, "uma tentativa basta");
	// resumes seguintes avançam pelos gates restantes sem re-correr os concluídos
	const order: string[] = [];
	const spawn: SpawnFn = async (step) => {
		order.push(step.id);
		return gateOutcome;
	};
	await runLoop("/repo", run, deps(spawn));
	await runLoop("/repo", run, deps(spawn));
	assert.deepEqual(order, ["ship-gate-qa-validator", "ship-gate-deliver"], "cada resume corre SÓ o próximo gate pendente");
	assert.ok(run.steps.every((s) => s.status === "completed"));
});

test("insertFixTask: re-arma ship gates completed (regressão: assertions da fix nunca viravam passed → deadlock)", () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	injectShipGate(run);
	for (const s of run.steps) {
		s.status = "completed";
		s.attempts = 3;
	}
	insertFixTask(run, { id: "FIX1", skillName: "backend-worker", fulfills: ["A-NEW"] });
	const gates = run.steps.filter((s) => s.kind === "ship-gate");
	assert.ok(gates.length > 0);
	for (const g of gates) {
		assert.equal(g.status, "pending", `${g.id} re-armado para re-validar a fix`);
		assert.equal(g.attempts, 0, `${g.id} ganha ciclo de validação fresco`);
	}
	assert.equal(run.gateRounds ?? 0, 0, "re-arme NÃO conta rodada — só um julgamento reprovado conta (runLoop)");
	const impl = run.steps.find((s) => s.id === IMPL_STEP_ID);
	assert.equal(impl?.status, "completed", "steps de task concluídos NÃO regridem");
});

test("gateRounds: julgamento REPROVADO consome rodada; crash sem handoff só queima attempt (regressão real: 8 attempts / 3 rodadas / gateRounds=0)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const events: string[] = [];
	// rodada 1: gate reprova COM handoff (reported) → conta.
	await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": { code: 0, success: false, reported: true } }), { log: (ev) => events.push(ev) }));
	assert.equal(run.status, "orchestrator_turn");
	assert.equal(run.gateRounds, 1, "reprovação julgada = 1 rodada");
	assert.ok(events.includes("gate_round_consumed"));

	// crash de provider (sem handoff): attempt queimado, rodada NÃO.
	run.status = "running";
	await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": { code: 0, success: false, reported: false } })));
	assert.equal(run.gateRounds, 1, "fizzle sem julgamento não consome rodada");

	// gate passa → não consome; fix re-arma sem contar; próxima reprovação conta.
	run.status = "running";
	await runLoop("/repo", run, deps(spawnFrom({})));
	assert.equal(run.status, "completed");
	assert.equal(run.gateRounds, 1, "pass não consome rodada");
	insertFixTask(run, { id: "FIX1", skillName: "backend-worker" });
	assert.equal(run.gateRounds, 1, "re-arme não conta");
	run.status = "running";
	await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": { code: 0, success: false, reported: true } })));
	assert.equal(run.gateRounds, 2, "nova reprovação julgada conta");

	assert.equal(gateRoundCapReached(run, 2), true, "bateu o teto");
	grantGateRound(run);
	assert.equal(gateRoundCapReached(run, 2), false, "rodada concedida explicitamente destrava");
});

test("runLoop: teto de rodadas do ship gate → orchestrator_turn (gate_round_cap), não mais uma rodada", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({}), { roundCap: 2 }));
	assert.equal(run.status, "completed");

	// Duas rodadas REPROVADAS consomem o teto (cap 2). FIX0 re-arma o gate completado do pass acima.
	insertFixTask(run, { id: "FIX0", skillName: "backend-worker" });
	for (let i = 1; i <= 2; i++) {
		run.status = "running";
		await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": { code: 0, success: false, reported: true } }), { roundCap: 2 }));
		assert.equal(run.gateRounds, i);
	}

	const events: string[] = [];
	const ran: string[] = [];
	insertFixTask(run, { id: "FIX1", skillName: "backend-worker" });
	run.status = "running";
	await runLoop(
		"/repo",
		run,
		deps(
			async (s) => {
				ran.push(s.id);
				return { code: 0, success: true, reported: true };
			},
			{ roundCap: 2, log: (ev) => events.push(ev) },
		),
	);
	assert.equal(run.status, "orchestrator_turn");
	assert.equal(run.turnReason, "gate_round_cap");
	assert.ok(events.includes("gate_round_cap"), "evento registado na trilha");
	assert.deepEqual(ran, ["FIX1"], "a fix corre; o gate NÃO re-roda uma 3ª vez sozinho");

	// (b) o orchestrator concede explicitamente mais uma rodada → destrava.
	run.status = "running";
	grantGateRound(run);
	await runLoop("/repo", run, deps(spawnFrom({}), { roundCap: 2 }));
	assert.equal(run.status, "completed", "grantGateRound destrava e o gate re-valida");
});

test("runLoop: ship gate falha (harness-code-review) → orchestrator_turn; fix task corre antes do gate no resume", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	// 1ª passada: T1 ok, harness-code-review falha
	await runLoop("/repo", run, deps(spawnFrom({ "ship-gate-code-review": { code: 0, success: false } })));
	assert.equal(run.status, "orchestrator_turn");
	assert.equal(run.gateInjected, true);
	// orchestrator insere fix task antes do gate, resume
	insertFixTask(run, { id: "FIX1", skillName: "backend-worker" });
	const idxFix = run.steps.findIndex((s) => s.id === "FIX1");
	const idxGate = run.steps.findIndex((s) => s.kind === "ship-gate");
	assert.ok(idxFix < idxGate, "fix task fica antes do ship gate");
	const order: string[] = [];
	await runLoop("/repo", run, deps(async (s) => {
		order.push(s.id);
		return { code: 0, success: true };
	}));
	assert.equal(run.status, "completed");
	// no resume corre a fix, depois harness-code-review (que estava pending), harness-qa-validator e harness-deliver
	assert.deepEqual(order, ["FIX1", "ship-gate-code-review", "ship-gate-qa-validator", "ship-gate-deliver"]);
});

test("runLoop: budget esgotado → paused (step_retry_limit_exceeded)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	// sempre falha; cada runLoop gasta 1 tentativa e para em orchestrator_turn → resume
	for (let i = 0; i < 5; i++) await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	const last = await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	assert.equal(last.status, "paused");
	assert.equal(last.pauseReason, "step_retry_limit_exceeded");
	assert.equal(run.steps[0].attempts, 5, "não passa do budget");
});

test("runLoop: abort (graceful) → paused, step fica in_progress (resumível) + registra a sessão", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	const spawn: SpawnFn = async () => {
		ac.abort();
		return { code: 0, aborted: true };
	};
	await runLoop("/repo", run, deps(spawn), ac.signal);
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "aborted");
	assert.equal(run.steps[0].status, "in_progress", "graceful → mantém in_progress p/ re-attach");
	assert.equal(run.steps[0].workerSessionIds.length, 1);
	assert.equal(run.steps[0].attempts, 1);
});

test("runLoop: resume re-attacha a MESMA sessão (sem nova tentativa) e continua", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	await runLoop("/repo", run, deps(async () => {
		ac.abort();
		return { code: 0, aborted: true };
	}), ac.signal);
	const wsid = run.steps[0].workerSessionIds.at(-1);
	const seen: { resume?: boolean; wsid?: string }[] = [];
	await runLoop("/repo", run, deps(async (_s, ctx) => {
		seen.push({ resume: ctx.resume, wsid: ctx.workerSessionId });
		return { code: 0, success: true };
	}), undefined, { resume: true });
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].attempts, 1, "re-attach NÃO consome nova tentativa");
	assert.equal(seen[0]?.resume, true);
	assert.equal(seen[0]?.wsid, wsid, "re-attacha a mesma sessão do worker");
});

test("runLoop: 402/usage-limit → paused (usage_limit), step resumível", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: null, usageLimit: true } })));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "usage_limit");
	assert.equal(run.steps[0].status, "in_progress");
});

test("runLoop: inactivity → requeue (step pending, tentativa contada) e segue até completar", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	let n = 0;
	await runLoop("/repo", run, deps(async () => {
		n++;
		return n === 1 ? { code: null, inactivity: true } : { code: 0, success: true };
	}));
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].attempts, 2, "inactivity contou 1 tentativa; a 2ª teve sucesso");
});

test("runLoop: retry-budget bonus permite re-rodar um step esgotado", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	for (let i = 0; i < 5; i++) await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 1, success: false } })));
	assert.equal(run.status, "paused");
	assert.equal(run.pauseReason, "step_retry_limit_exceeded");
	grantRetryBudget(run, IMPL_STEP_ID);
	await runLoop("/repo", run, deps(spawnFrom({ [IMPL_STEP_ID]: { code: 0, success: true } })), undefined, { resume: true });
	assert.equal(run.status, "completed");
	assert.equal(run.steps[0].attempts, 6, "consumiu 1 do budget bônus");
});

test("runLoop: preempção no resume — pending acima do in_progress roda primeiro", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	const ac = new AbortController();
	await runLoop("/repo", run, deps(async () => {
		ac.abort();
		return { code: 0, aborted: true };
	}), ac.signal);
	assert.equal(run.steps[0].status, "in_progress");
	run.steps.unshift({ id: "PRE", kind: "task", skillName: "w", tasks: [{ id: "PRE", skillName: "w" }], status: "pending", attempts: 0, workerSessionIds: [] });
	const order: string[] = [];
	await runLoop("/repo", run, deps(async (s) => {
		order.push(s.id);
		return { code: 0, success: true };
	}), undefined, { resume: true });
	assert.equal(run.status, "completed");
	assert.equal(order[0], "PRE", "a task preemptora corre primeiro");
	assert.ok(order.includes(IMPL_STEP_ID), "o impl step preemptado re-roda depois");
});

test("runLoop: heartbeat toca durante um spawn longo", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	let beats = 0;
	const slow: SpawnFn = () => new Promise((res) => setTimeout(() => res({ code: 0, success: true }), 40));
	await runLoop("/repo", run, deps(slow, { heartbeatMs: 8, log: (ev) => { if (ev === "heartbeat") beats++; } }));
	assert.ok(beats >= 1, `esperava >=1 heartbeat, teve ${beats}`);
	assert.equal(run.status, "completed");
});

test("cleanupOrphan: in_progress órfão volta a pending (+ log de auditoria)", () => {
	const run: FeatureRun = planFeatureRun("feat-x", tasks("T1"), NOW);
	run.steps[0].status = "in_progress";
	const evs: string[] = [];
	cleanupOrphan(run, { log: (ev) => evs.push(ev) });
	assert.equal(run.steps[0].status, "pending");
	assert.ok(evs.includes("step_orphan_requeued"), "requeue deixa rasto no log");
});

test("cleanupOrphan: reconcileCompleted marca completed (não re-roda step com success em disco)", () => {
	const run: FeatureRun = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	run.steps[0].status = "in_progress";
	run.steps[0].workerSessionIds = ["ws_1"];
	const evs: { ev: string; extra?: Record<string, unknown> }[] = [];
	// a última sessão (ws_1) do impl step já tem success em disco → reconcilia pra completed
	cleanupOrphan(run, { reconcileCompleted: (s) => s.workerSessionIds?.at(-1) === "ws_1", log: (ev, extra) => evs.push({ ev, extra }) });
	assert.equal(run.steps[0].status, "completed", "HARD kill pós-success NÃO re-roda");
	assert.ok(evs.some((e) => e.ev === "step_reconciled"), "reconciliação logada");
	assert.deepEqual(evs.filter((e) => e.ev === "task_completed").map((e) => e.extra?.taskId), ["T1", "T2"], "tasks cobertas viram completed");
});

test("runLoop: crashed → requeue rápido (step_failed worker_crashed), NÃO orchestrator_turn", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	let n = 0;
	const evs: string[] = [];
	// 1ª tentativa crasha; 2ª completa — o crash requeue sem devolver ao orchestrator.
	await runLoop("/repo", run, deps(async () => (++n === 1 ? { code: 1, crashed: true } : { code: 0, success: true, returnToOrchestrator: true }), { log: (ev) => evs.push(ev) }));
	assert.ok(evs.includes("step_failed"), "crash é step_failed");
	assert.equal(run.status, "orchestrator_turn", "2ª tentativa (success+return) devolve controle");
	assert.equal(n, 2, "crash re-tentou automaticamente sem parar no orchestrator");
});

test("cleanupOrphan: ship-gate NÃO reconcilia (re-roda — preserva o orchestrator turn do gate)", () => {
	const run: FeatureRun = planFeatureRun("feat-x", tasks("T1"), NOW);
	injectShipGate(run);
	const gate = run.steps.find((s) => s.kind === "ship-gate") as FeatureRun["steps"][0];
	gate.status = "in_progress";
	gate.workerSessionIds = ["ws_g"];
	cleanupOrphan(run, { reconcileCompleted: () => true }); // reconciler diz "success em disco"…
	assert.equal(gate.status, "pending", "…mas ship-gate requeue mesmo assim (returnToOrchestrator não pode ser engolido)");
});

test("runLoop: falha REPORTADA num resume (handoff em disco) vai pro orchestrator, NÃO degrada", async () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	run.steps[0].status = "in_progress";
	run.steps[0].workerSessionIds = ["ws_old"];
	const evs: string[] = [];
	// worker resumido TERMINOU e reportou failure via EndFeatureRun (reported:true)
	await runLoop("/repo", run, deps(async () => ({ code: 0, success: false, returnToOrchestrator: true, reported: true }), { log: (ev) => evs.push(ev) }), undefined, { resume: true });
	assert.equal(run.status, "orchestrator_turn", "falha reportada → orchestrator (não re-roda às cegas)");
	assert.ok(!evs.includes("step_resume_degraded"), "degrade só pra wedge MECÂNICO (sem handoff)");
});

test("runLoop: resume falho degrada a restart FRESH (step_resume_degraded), não wedge", async () => {
	// step in_progress (paused/resume) cuja 1ª reattach falha (sem handoff) → requeue fresh, retenta.
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	run.steps[0].status = "in_progress";
	run.steps[0].workerSessionIds = ["ws_old"];
	const evs: string[] = [];
	const seen: boolean[] = [];
	let n = 0;
	await runLoop("/repo", run, deps(async (_s, c) => {
		seen.push(!!c.resume);
		return ++n === 1 ? { code: 1, success: false } : { code: 0, success: true, returnToOrchestrator: true };
	}, { log: (ev) => evs.push(ev) }), undefined, { resume: true });
	assert.equal(seen[0], true, "1ª é um reattach (resume)");
	assert.equal(seen[1], false, "2ª é uma sessão FRESH (não resume)");
	assert.ok(evs.includes("step_resume_degraded"), "resume falho degrada em vez de wedge");
	assert.equal(run.status, "orchestrator_turn");
});

test("injectShipGate: idempotente", () => {
	const run = planFeatureRun("feat-x", tasks("T1"), NOW);
	injectShipGate(run);
	injectShipGate(run);
	assert.equal(run.steps.filter((s) => s.kind === "ship-gate").length, 3);
});

test("nextPending: ordem do array (impl step → ship gate)", () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	assert.equal(nextPending(run)?.id, IMPL_STEP_ID, "o impl step roda primeiro");
	run.steps[0].status = "completed";
	injectShipGate(run);
	assert.equal(nextPending(run)?.id, "ship-gate-code-review", "depois do impl, o 1º passo do ship gate");
});

test("injectShipGate: honra o skip set (skipScrutiny/skipUserTesting)", () => {
	const r1 = planFeatureRun("f", [{ id: "T1", skillName: "w" }]);
	injectShipGate(r1, new Set(["harness-code-review"]));
	assert.deepEqual(
		r1.steps.filter((s) => s.kind === "ship-gate").map((s) => s.skillName),
		["harness-qa-validator", "harness-deliver"],
	);
	const r2 = planFeatureRun("f", [{ id: "T1", skillName: "w" }]);
	injectShipGate(r2, new Set(["harness-code-review", "harness-qa-validator", "harness-deliver"]));
	assert.equal(r2.steps.filter((s) => s.kind === "ship-gate").length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// completionGate dep (droid: end-of-mission gate — nunca completed com assertion pendente)

test("runLoop: completionGate ok:false → orchestrator_turn + completion_gate_failed (nunca completed)", async () => {
	const run = planFeatureRun("f", [{ id: "T1", skillName: "w" }], () => "t");
	const events: string[] = [];
	const final = await runLoop("/x", run, {
		spawn: async () => ({ code: 0, success: true }),
		log: (ev) => events.push(ev),
		completionGate: () => ({ ok: false, failing: ["A1"] }),
	});
	assert.equal(final.status, "orchestrator_turn");
	assert.ok(events.includes("completion_gate_failed"));
});

test("runLoop: completionGate ok:true (ou ausente) → completed", async () => {
	const r1 = planFeatureRun("f", [{ id: "T1", skillName: "w" }], () => "t");
	const f1 = await runLoop("/x", r1, { spawn: async () => ({ code: 0, success: true }), completionGate: () => ({ ok: true, failing: [] }) });
	assert.equal(f1.status, "completed");
	const r2 = planFeatureRun("f", [{ id: "T1", skillName: "w" }], () => "t");
	const f2 = await runLoop("/x", r2, { spawn: async () => ({ code: 0, success: true }) });
	assert.equal(f2.status, "completed", "sem gate injetado → compat (completa)");
});

test("batch cortado cedo: tasks restantes viram step de continuação e NÃO são marcadas como feitas", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2", "T3", "T4", "T5", "T6"), NOW);
	const done: string[] = [];
	const events: string[] = [];
	// o worker entregou T1–T3 e a re-costura fechou o batch (só T1–T3 no progress log)
	await runLoop("/repo", run, deps(spawnFrom({}), {
		completedTasks: () => new Set(["T1", "T2", "T3"]),
		log: (ev, extra) => { events.push(ev); if (ev === "task_completed") done.push(String(extra?.taskId)); },
	}));
	const cont = run.steps.find((s) => s.id === `${IMPL_STEP_ID}-cont`);
	assert.ok(cont, "abriu o step de continuação");
	assert.deepEqual(cont?.tasks?.map((t) => t.id), ["T4", "T5", "T6"], "carrega exatamente o que faltou");
	assert.deepEqual(cont?.fulfills, ["A-T4", "A-T5", "A-T6"], "fulfills escopado ao que resta");
	assert.equal(cont?.status !== "pending" || cont?.attempts === 0, true);
	assert.ok(events.includes("batch_continued"));
	assert.ok(!done.includes("T4"), "task não entregue NUNCA é marcada como concluída");
	assert.ok(run.steps.indexOf(cont as FeatureRun["steps"][0]) === run.steps.findIndex((s) => s.id === IMPL_STEP_ID) + 1, "entra logo após o batch de origem");
});

test("batch completo: sem completedTasks (ou tudo feito) marca todas e NÃO cria continuação", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	const done: string[] = [];
	await runLoop("/repo", run, deps(spawnFrom({}), {
		completedTasks: () => new Set(["T1", "T2"]),
		log: (ev, extra) => { if (ev === "task_completed") done.push(String(extra?.taskId)); },
	}));
	assert.deepEqual(done, ["T1", "T2"]);
	assert.equal(run.steps.some((s) => s.id.includes("-cont")), false);
	assert.equal(run.status, "completed");
});

test("continuação exige PROGRESSO: worker que não entregou nada não gera step infinito", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2", "T3"), NOW);
	const events: string[] = [];
	await runLoop("/repo", run, deps(spawnFrom({}), {
		completedTasks: () => new Set<string>(), // zero entregue
		log: (ev) => events.push(ev),
	}));
	assert.equal(run.steps.filter((s) => s.id.includes("-cont")).length, 0, "nenhuma continuação");
	assert.ok(!events.includes("batch_continued"));
});

test("runLoop carimba a capacidade de continuação (fail-safe: worker novo + runner velho descartava tasks)", async () => {
	const run = planFeatureRun("feat-x", tasks("T1", "T2"), NOW);
	assert.equal(run.capabilities?.batchContinuation, undefined, "record novo não nasce carimbado");
	await runLoop("/repo", run, deps(spawnFrom({})));
	assert.equal(run.capabilities?.batchContinuation, true, "o runner que sabe continuar se identifica no record");
});
