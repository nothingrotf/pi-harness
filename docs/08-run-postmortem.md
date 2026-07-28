# 08 — Postmortem das runs reais (sotaq + hibou)

Base de evidência: 26 feature runs, 418 sessões de worker, 131 MB de transcripts,
206 h de wall-clock, **$1.263,03** de custo real, 22 PRs merged.

Fonte: `~/Workspaces/sotaq/.harness/runs/`, `~/Workspaces/hibou/.harness/runs/`.

## 0. O harness funciona

22 de 23 deliveries chegaram a `merged`. CI passou com 0 iterações de fix-loop em 19
de 23. O problema não é qualidade de saída — é **economia**.

| | |
|---|---|
| tasks planejadas | 186 |
| tasks FIX (retrabalho) | 144 (ratio 0.77) |
| rounds de code-review | 100 (4.0 por feature) |
| custo primeira-passada | $556 (44%) |
| custo retrabalho + verificação | $706 (56%) |

## 1. Espiral do ship gate — o custo dominante

**83% dos blocking findings depois do round 1 foram introduzidos pelo fix do round anterior.**
Classificação manual de 64 findings em 2 features:

| origem | feat-model-policy | billing-f3b | total |
|---|---|---|---|
| pré-existente | 3 | 0 | 3 |
| defeito original da feature | 2 | 6 | 8 |
| **introduzido por fix anterior** | **28** | **25** | **53 (83%)** |

Casos extremos: `feat-model-policy` = 18 rounds / 22 FIX / 20,6 h.
`billing-f3b-bill-run` = 12 rounds / 25 FIX / 13,4 h.

### Mecanismo

1. **`insertFixTask` re-arma o gate com budget zerado** — `src/feature-runner.ts:316-320`:
   ```ts
   if (s.kind === "ship-gate" && s.status === "completed") { s.status = "pending"; s.attempts = 0; }
   ```
   `STEP_ATTEMPT_BUDGET = 5` (`src/feature-runner.ts:37`) nunca chega a morder.
   O loop é **ilimitado por construção**.

2. **Scope fix-delta transforma cada fix em superfície nova não revisada.** §0.5 do skill é
   obedecido (todo round reporta `scope: "fix-delta"`), e é exatamente isso que garante
   ≥1 finding por round: o round N revisa código que só existe porque o round N-1 pediu.

3. **Sem piso de severidade.** §3 promove contradição de prosa de ADR a `status: "fail"`.
   Nos rounds 9–13 de `feat-model-policy`, 7 de 7 blockers eram texto em
   `docs/adr/027-*.md` / `docs/runbooks/*`. O próprio reviewer escreveu no round 8:

   > "The correctness axis returned ZERO blocking findings for the first time in this
   > feature's life — the code is correct on every reachable path. **Do NOT rewrite the
   > seam a fifth time.**"

   Rodou mais 10 rounds depois disso.

4. **Sensor de discriminação fabrica blockers.** §1.5 torna qualquer mutante sobrevivente
   blocking. Linhas novas de fix nunca têm cobertura de mutação → survivor garantido.
   R5, R7, R8, R17 todos com survivor.

5. **Amnésia.** `validation/harness-code-review/synthesis.json` é **um caminho sobrescrito**;
   só o último round sobrevive, e `previousRound` referencia só o anterior. Um round de
   memória → o wording oscila (R11→R12 desfez o que R10 pediu).

6. **Gate vermelho por flake já dismissado.** Rounds 14–16 queimaram ~2 h num full-suite
   vermelho por flakes que já estavam em `dismissed.json`.

### Ping-pong verbatim (billing-f3b R6→R7→R8)

- R6: *"expireCheckoutSession mutates provider state without an ADR-019 idempotency key"*
- fix adiciona a key
- R7: *"Expiry idempotency keys include claim generation and therefore change when retrying"*
- fix estabiliza a key
- R8: *"sweeps repeat refunds.create with the same idempotency key and discard the nonterminal refund reference"*

Três rounds, dois veredictos opostos sobre a mesma linha.

## 2. FIX tasks não existem no plan.json → 144 commits sem gate

`insertFixTasks` (`src/run-control.ts:63`) escreve só em `feature-run.json`.
`next_task` (`src/next-task-tool.ts:77-78`) lê só `plan.json`:

```ts
const task = plan.tasks.find((t) => t.id === d.taskId);
if (!task) return { ... text: `Task ${d.taskId} not found in plan.` ... };
```

Consequência: **todo worker de FIX recebe erro e nunca entra no loop `next_task`** — logo
o `commitGate` (`bun typecheck`) **não roda** para 144 de 330 tasks (44%). Um fix pode
commitar árvore vermelha, e o round seguinte de review descobre. É o combustível da espiral.

Reportado espontaneamente em 12 features distintas. Amostra:

> "next_task returned 'Task FIX10 not found in plan' because plan.json only lists T1-T5"
> — hibou/billing-f3a-payment-port

**Fix:** `insertFixTasks` deve fazer append da task em `plan.json` (via `storePlan`, que já
faz merge não-destrutivo do status — `src/plan.ts:117-122`).

## 3. Branch-per-feature falha em 71% dos casos → PR base-to-base

`branch_ready`: **29 skip / 11 create / 1 noop**.

| razão do skip | n |
|---|---|
| working tree dirty | 19 |
| já em outra branch (não a base) | 10 |

`planBranchAction` (`src/branch.ts:160`) faz skip silencioso e o run inteiro cai na base
branch. Só o `harness-deliver`, horas depois, descobre:

> "HEAD is master, which is also the configured PR base; opening a base-to-base PR is impossible."

41 menções em handoffs. Um worker resolveu à mão (carve dos 7 commits para uma branch nova
+ reset do master local) — trabalho manual que o harness deveria ter feito no minuto zero.

**Fix:** skip por dirt/branch-errada deve ser **fatal no run-start** com mensagem acionável,
ou o harness deve auto-carve antes do deliver. Nunca silencioso.

## 4. Lessons é write-only e nunca promove

37 lessons gravadas (6 sotaq + 31 hibou). **Todas `candidate`, todas `recurrence: 1`.**
Zero promovidas a `confirmed`. Duas causas:

1. **Dedup exato após normalização** (`normalizeLessonText`, `src/lessons.ts:82-89`) — duas
   lições sobre a mesma coisa nunca ficam byte-idênticas, então nunca fazem merge, então
   `recurrence` nunca chega a `promoteThreshold: 2`.
2. **Ninguém lê.** `rg lessons src/worker-bootstrap.ts` → 0 hits. `LESSONS.md` nunca é
   injetado em prompt de worker nem de review.

Duas lições em sotaq (L-003 e L-004) são literalmente o mesmo texto com pontuação diferente
e ficaram separadas.

## 5. Onde o dinheiro vai

| escopo | sessões | total tok | custo | % |
|---|---|---|---|---|
| **TUDO** | 418 | 1,91 B | **$1.263,03** | |
| api-worker (impl) | 166 | 1,30 B | $747,87 | 59,2% |
| harness-code-review | 124 | 154,2 M | $186,08 | 14,7% |
| web-worker (impl) | 37 | 243,4 M | $149,59 | 11,8% |
| harness-qa-validator | 43 | 95,2 M | $121,06 | 9,6% |
| harness-deliver | 40 | 24,9 M | $34,38 | 2,7% |

**`cacheRead` = 96,9% de todos os tokens (1,85 B).** A conta é quase toda re-leitura do
próprio histórico. Mediana de 58k prompt tokens/turn; pior caso 270k/turn
(`sotaq/linear-sot-38`, 385 turns, $23,77 numa sessão).

Re-derivação a frio: 1.557 leituras dos mesmos 7 docs do harness (11,0 M chars).
`services.yaml` lido em 268 de 418 sessões; `harness.md` em 221; `contract.md` em 181.
Nada é carregado adiante entre sessões.

Erros de tool: 504 de 21.935 (2,3%), incl. 36 falhas de schema no `edit`
(`edits.0.oldText: must have required properties`) e 43 ENOENT em caminhos chutados.

## 6. Fricção recorrente (contagem em handoffs)

| n | padrão |
|---|---|
| 41 | commits na base branch |
| 25 | FIX task ausente do plan.json |
| 25 | serviços não subiram antes do gate → falso vermelho |
| 21 | drift doc/ADR vs código |
| 20 | mutante sobreviveu ao sensor |
| 19 | contrato congelado vs realidade (precondição inexistente) |
| 19 | browser tool indisponível no worker |
| 14 | teardown de servidor compartilhado quebrou peer |
| 14 | colisão de porta entre projetos da mesma máquina |
| 14 | árvore suja em `.harness/profile` no delivery |
| 7 | `suggestedGuidanceUpdates` evaporaram |
| 6 | comando de teste coletou 0 testes (falso verde) |

## 7. Ações propostas, por retorno

### P0 — cortam a espiral (alvo: −$350/26 features, −40% de wall-clock)

1. **Cap de rounds de review.** Contar rounds no step do gate; após N (sugestão 3),
   findings não-correctness viram backlog em vez de blocker. Remover o `attempts = 0`
   de `src/feature-runner.ts:319` — usar `retryBudgetBonus` explícito.
2. **Piso de severidade.** `blocking` = correctness/security/quebra de contrato **apenas**.
   Prosa de ADR/runbook/comentário → `non_blocking` sempre. Alterar §3 do skill.
3. **FIX tasks no plan.json.** `insertFixTasks` faz append + `storePlan`. Ativa o
   commitGate para os 44% de tasks hoje sem gate.
4. **Ledger cumulativo de findings.** `synthesis-r<N>.json` versionado + um
   `litigated.json` com todo finding já julgado e seu veredicto. Impede re-litigar.

### P1 — cortam custo de contexto (alvo: −$200)

5. **Bootstrap pré-digerido.** O harness monta um bloco único com o essencial de
   `services.yaml` + `harness.md` + `contract.md` + a task, em vez de o worker ler 7
   arquivos. Ataca 96,9% da conta.
6. **Sessões mais curtas.** Baixar `HARNESS_TASK_BUDGET` (hoje 7) e forçar seam por batch.
   Sessões de 385–479 turns são a cauda cara.

### P2 — tiram fricção operacional

7. **Branch-per-feature fatal.** Skip vira erro acionável no run-start.
8. **Preflight de serviços/portas** antes do §0 do code-review (25 falsos vermelhos).
9. **Lessons legível.** Injetar `LESSONS.md` (confirmed + candidates de scope relevante)
   no bootstrap do worker e do reviewer; trocar dedup exato por similaridade (trigram/
   Jaccard ≥0.6) para recurrence funcionar.
10. **Validar comandos de teste no setup** — `services.yaml` deve provar que cada comando
    coleta >0 testes (6 falsos verdes por `--project` mal-ordenado).

## 8. Estado da implementação

| # | Ação | Estado | Commit |
|---|---|---|---|
| 1 | Cap de rodadas de review (`gateRounds` + `GATE_ROUND_CAP`, `grantGateRound` explícito) | feito | `7f3e12d` |
| 2 | Piso de severidade + postura por rodada + não-bloqueante nunca vira fix task | feito | `7f3e12d` |
| 3 | FIX tasks registradas no `plan.json` (`appendFixTasksToPlan`) | feito | `7f3e12d` |
| 4 | Ledger `litigatedFindings` + `synthesis-r<N>.json` + `reviewedHead` | feito | `7f3e12d` |
| 9 | Lessons injetadas no worker + dedup por similaridade | feito | `7f3e12d` |
| — | **Fase de design (shared derivations)** — a causa-raiz, não listada acima | feito | `3cef90d` |
| 7 | Branch: tree suja não abandona mais a feature na base | feito | `e18a0ef` |
| 8 | Preflight de portas no run-start (`ports_preflight`) | feito | `4898144` |
| 10 | Sentinela de coleta vazia (falso verde) no commit gate + skills | feito | `4898144` |
| 5 | Dieta de leitura (worker não lê plan.json/contract.md; diff escrito 1x) | feito | `9b5737b` |
| 6 | Re-costura por contexto — **MODO SOMBRA** (mede, nunca corta; `HARNESS_CONTEXT_RESEAM` default 200k) | sombra | `9b5737b` |
| 11 | **Fold da cauda empilhava em batch já estourado** — a causa raiz do contexto gigante | feito | `c5f944a` |
| 12 | Loop do fato externo não-verificável (worker → review → brief) | feito | `912926e` |

## 9. A/B de model-config (sotaq, feature PR C) — o que a sombra revelou

Mesma feature, mesmo contrato congelado (21 assertions), mesmo commit base, plano idêntico.
Protocolo e ferramentas: `scripts/eval-ab.sh` + `scripts/run-metrics.py`.

| | baseline (opus/medium) | sonnet-5/high |
|---|---|---|
| contrato | 21/21 | 21/21 |
| custo | **$43,28** | $52,39 |
| tokens | **60,7M** | 175,7M |
| turnos | **500** | 879 |
| wall clock | **2,76h** | 3,55h |
| pico de contexto | 301k | 570k |

O modelo mais barato por token custou **mais** na run: 75% mais turnos e 3x mais tokens
(quase tudo `cacheRead` de sessão longa). Confound registrado: o braço B rodou `thinking: high`,
não `medium` — modelo E esforço mudaram juntos.

**A descoberta que importava não era sobre modelos.** A série da sombra mostrou crescimento
monotônico numa ÚNICA sessão, nas duas runs:

```
opus    60k 87k 113k 116k 161k 168k 181k 263k 276k 293k 301k | 34k 58k …
sonnet  61k 108k 140k 152k 225k 245k 270k 452k 466k 555k 570k | 51k 103k …
```

Mediana do resto da feature: ~90k. A causa era o batcher, não o modelo: `foldShortTail` recebia
`_budget` e nunca usava — fundia a cauda de 1-2 tasks no batch anterior mesmo quando esse batch
já estava acima do budget. Plano de 10 tasks, budget 7, peso 11 → **um batch só, 157% do budget**.

Depois do fix (`c5f944a`), o mesmo plano roda em 2 batches (T1-T8, T9-T10):

| braço | pico antes | pico depois | fronteiras >200k antes → depois |
|---|---|---|---|
| opus | 301k | 263k | 4 → 1 |
| sonnet | 570k | 452k | 7 → 4 |

**Decisão sobre a costura:** continua em sombra. O fix do batcher resolveu a causa dominante mas
não zera o problema — o sonnet ainda cruzaria 200k quatro vezes dentro de um batch de 8 tasks
legítimo. Isso sugere que o budget útil é **dependente de modelo** (um modelo mais verboso enche a
janela com menos tasks), o que a contagem de tasks não captura. Próximo passo honesto: rodar a
próxima feature real com o batcher corrigido e medir de novo antes de escolher entre baixar o
`HARNESS_TASK_BUDGET`, torná-lo por-role, ou ligar o corte.

Nada disto foi exercitado numa feature real ainda — só 499 testes unitários + verificação
dos parsers contra os artefatos reais de sotaq e hibou. A próxima validação honesta é uma
feature de ponta a ponta observando `gateRounds` segurar.
