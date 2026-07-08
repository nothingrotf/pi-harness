# 05 — Batches por budget de contexto (task-budgeted batches)

Fecha o débito de **granularidade de worker**: hoje 1 worker = feature inteira, o que
é ótimo pra Small/Medium mas **garante compaction em features Large** (a janela estoura,
o auto-compact resume o transcript, e as tasks finais rodam contra um contexto lossy →
qualidade cai). Adotamos o conceito que o **tlc-spec-driven v3.2.0** validou — o
**task-budgeted batch** — mas adaptado ao nosso motor determinístico (runner + `next_task`)
e ao nosso `plan.json` **flat (sem phases)**.

> Postura: **batch = unidade de EXECUÇÃO/logística dirigida por BUDGET de contexto**, NÃO
> por milestone/phase (agrupamento lógico). Milestone agrupa por *separação de responsabilidade*;
> batch agrupa por *quanto contexto cabe numa sessão sã*. Essa é a distinção central.

---

## 1. O eixo do problema: granularidade de worker

Tudo vive num eixo — **quantas tasks uma sessão de worker possui**:

```
1 task / worker  ────────────────────────  feature inteira / worker
   (fino demais)                                 (grosso demais)
        ▲                                              ▲
 perde contexto entre tasks;                   contexto rico, MAS em features
 startup do worker-base (~12                    Large a janela estoura → auto-
 arquivos + init + serviços)                    compact → tasks finais rodam
 pago N×; blowup de token/tempo                 contra um resumo lossy → qualidade cai
```

Já vivemos o polo esquerdo e migramos pro direito — documentado no próprio código
(`src/feature-runner.ts` header: *"spawnar um worker por task perdia o contexto entre
tasks... repetia o startup do worker-base N vezes"*; `harness-worker-base`: *"You own the
WHOLE feature"*). O polo direito **não está errado — está *ilimitado***. `planFeatureRun()`
crava um único step com TODAS as tasks:

```ts
// src/feature-runner.ts — planFeatureRun()
tasks.length === 0 ? [] : [{ id: IMPL_STEP_ID /* "implement" */, kind: "task",
    tasks: tasks.map(t => ({...t})), /* TODAS as tasks, 1 step, 1 worker */ ... }]
```

O **batch** é o ponto do meio: janela fresca por batch (sem compaction), startup
amortizado sobre ~7 tasks (não N), continuidade entre batches carregada por **artefatos
duráveis** (feature.md, contract.md, architecture.md, plan.json, commits) + um **handoff
compacto** — não por uma sessão viva gigante.

## 2. Phase × Batch — a distinção que importa [travado]

| | **Phase / milestone** | **Batch (nossa unidade)** |
|---|---|---|
| Definido por | semântica / camada de dependência | **budget de contexto** (~7 tasks ≈ ~40k tokens) |
| Tamanho | arbitrário vs contexto | fixo pelo budget |
| Papel | *onde é seguro cortar* (não rachar) | *unidade de execução/spawn* |

O tlc diz explícito (`references/sub-agents.md`): *"a feature's dependency-layer count has
nothing to do with the ideal per-worker workload. Batching by task budget separates the two
concerns."* No tlc um batch é *"one or more **consecutive whole phases** packed to ~7 tasks"* —
a phase só decide **onde cortar**, o budget decide **o tamanho do corte**.

**Nosso twist:** nosso `plan.json` é uma lista **flat ordenada** (`harness-feature-converge`
Fase 5 — sem phases). Então não temos "phase boundary" pra cortar. Resolvemos com o
**cohesion guard** (§4): o budget dirige o tamanho; uma marca leve de coesão só restringe
*onde* o corte cai. Grupo por budget; coesão é só um trilho de segurança na emenda.

## 3. Onde já estamos prontos (o motor é step-genérico)

Realização central: **o harness já está ~90% arquitetado pra isso.** O `FeatureStep` de
`feature-runner.ts` é genérico — `runLoop`, `nextPending`, `cleanupOrphan`,
`reconcileCompleted`, `injectShipGate`, resume/orphan/budget **iteram sobre `run.steps` sem
se importar com quantos task-steps existem**. Prova viva: `insertFixTask()` já insere
task-steps ADICIONAIS mid-run e a máquina inteira lida com eles (sequencial, session id por
step, resume por step, attempt budget por step).

> **Um "batch" NÃO é um conceito novo — é o mesmo mecanismo que `insertFixTask` já usa, aplicado
> em plan-time.** Hoje `planFeatureRun` emite `[1 step]`; batching emite `[batch-1, …, batch-K]`.
> Tudo a jusante já funciona.

## 4. Política de corte: budget + cohesion guard (Option B) [travado]

O corte é **dirigido por budget**, com um trilho de coesão opcional que só afeta *a
localização* da emenda:

- **Driver — budget.** `BATCH_BUDGET ≈ 7` tasks (env `HARNESS_TASK_BUDGET`). Caminha a lista
  ordenada acumulando tasks; ao atingir o budget **e** havendo tasks restantes, fecha o batch.
- **Trilho — coesão.** Campo opcional por task (author = `harness-feature-converge`):
  - `cohesion: "<tag>"` — tasks consecutivas com a mesma tag *preferem* ficar no mesmo batch
    (não racha um cluster coeso: auth-core, migration-seq, etc.), ou
  - `batchBreakBefore: true` — força uma emenda antes desta task (raro; use em fronteira dura).
- **Sinal implícito — `skillName` (worker type).** Uma mudança de `skillName` entre tasks
  consecutivas é uma **emenda barata e natural** (o batch passa a carregar 1 procedimento in-head
  em vez de 2). O `batchTasks` trata a troca de `skillName` como *ponto de corte preferido* — sem
  fazer do worker type o eixo de agrupamento (budget continua o driver; §5.3).
- **Cauda curta (regra tlc).** Se o último batch for 1–2 tasks soltas, funde no anterior.
- **`T ≤ BATCH_BUDGET` ⇒ 1 batch** = comportamento IDÊNTICO ao de hoje (sem regressão pro
  caminho feliz Small/Medium). Só Large/Complex racha. É auto-sizing, mirado exatamente na dor.
- **Caveat de phase grossa (tlc):** se um cluster de coesão sozinho > ~1.5× budget (~10+ tasks),
  é *smell de decomposição* — o converge deveria ter quebrado em sub-tasks reais, não o dispatch.

`batchTasks(tasks, budget, cohesion)` retorna `PlanTaskRef[][]` (greedy, respeitando ordem +
coesão + cauda). Puro e testável isolado (espelha o estilo de `planNextTask`/`planFeatureRun`).

## 5. Superfície de mudança (mapeada, com grounding)

| Peça | Hoje | Mudança pro batching | Onde |
|---|---|---|---|
| `planFeatureRun` | 1 step, todas as tasks | K steps `implement-1..K`, cada um com sua fatia via `batchTasks` | `feature-runner.ts` |
| `IMPL_STEP_ID` | const única `"implement"` | ids `implement-1..K` (reconcile + `task_completed` já iteram `step.tasks`) | `feature-runner.ts` |
| **`next_task` escopo** | universo = **plano inteiro** (`plan.tasks.map`) | universo = **fatia do step in_progress**; "done" no fim do batch | `next-task-tool.ts` / `next-task.ts` |
| bootstrap multi-task | "a feature INTEIRA (N tasks)" | "batch k/K (tasks X–Y); batches anteriores commitados — leia `git log`/diffs" | `worker-bootstrap.ts` |
| converge `plan.json` | lista flat, sem coesão | + campo opcional `cohesion`/`batchBreakBefore`; grava contagem de tasks | `skills/harness-feature-converge` |
| (opc.) budget signal | ~7 fixo | budget token-aware: converge encolhe quando tasks são pesadas (tlc >40k) | `feature-runner.ts` + env |

**Elegância:** itens são majoritariamente **plan-time + uma mudança de escopo de tool.** O
runLoop, resume, orphan cleanup, injeção de ship gate e completion gate ficam **intocados** —
porque um batch *é* só um task-step e o runner já é step-genérico.

### 5.1 A única mudança delicada — escopo do `next_task` [travado]

`next-task-tool.ts` hoje monta o universo do **plano inteiro**:

```ts
const taskIds = plan.tasks.map((t) => t.id);        // universo = FEATURE toda
const completed = completedTaskIds(readProgressEvents(...)); // GLOBAL (cumulativo)
```

`completedTaskIds` é **global**, então um worker de batch-2 fresco corretamente *pula*
batch-1 (`firstUncompleted`). MAS com universo = plano inteiro ele **continuaria direto pro
batch-3**. Portanto `next_task` precisa **escopar o universo à fatia do step in_progress**:

- Lê o step `in_progress` de `feature-run.json` e usa **`step.tasks[]`** como universo, OU
- o worker passa seu `batchId` (o step id) e o tool filtra `plan.tasks` por essa fatia.

Preferência: **ler o step in_progress do run record** (o tool já tem `ctx.cwd` + `featureId`;
zero mudança na assinatura da tool, o worker não precisa saber que é um batch). O `completed`
global continua fazendo o resume pular batches anteriores de graça. "Done" dispara na última
task **do batch**, não da feature → o worker chama `EndFeatureRun(taskId="implement-k")` e o
runner avança pro próximo batch step (sequencial, como já faz entre steps).

### 5.3 Comunicação com o sistema de workers (setup → skills → batch)

O **setup** (`harness-setup` Fase 6) autora os **tipos** de worker
(`.harness/profile/skills/<worker-type>/`) — feature-agnósticos, cacheados, um por
camada/domínio. A **converge** dá a cada task um `skillName` apontando pra um desses tipos. O
**spawn** (`feature-spawn.ts` `buildWorkerSystemPrompt`) inlina, **por STEP**, `harness-worker-base`
+ cada skill *distinta* que as tasks do step referenciam (`distinctTaskSkills(step)`).

**Fato central: o tipo de worker NÃO é a fronteira de spawn.** O worker de hoje já é
**polimórfico** — uma sessão inlina TODAS as skills que a feature usa, e o `next_task` entrega uma
task por vez; o worker "veste o chapéu" do `skillName` daquela task. `skillName` é um **seletor de
procedimento por-task, não uma fronteira de sessão**. Por isso batching é **transparente** ao
modelo de geração de workers — e o melhora:

```
Hoje (1 worker/feature):  buildWorkerSystemPrompt(implement)   → inlina TODAS as skills da feature
Batch (K workers):        buildWorkerSystemPrompt(implement-k) → inlina SÓ as skills da fatia k
```

`distinctTaskSkills` já opera **por step** → cada batch worker recebe um system prompt **mais
enxuto** (só as skills das suas ~7 tasks). batch tasks → batch skillNames → skills inlinadas →
universo do `next_task` (escopado, §5.1): **tudo consistente, zero plumbing novo.**

**As premissas do setup já casam:**
- `init.sh` é *"run at the start of every worker session"* (idempotente) — K startups já é o
  contrato desenhado, não um custo novo.
- A **Example Handoff** de cada skill (Fase 6.4) é um agregado *por-sessão* — batching só muda a
  cardinalidade do handoff de **1/feature → K/feature** (cada um = o "compact summary" entre
  batches). Sem reescrever skill.
- Tipos de worker seguem feature-agnósticos e estáveis → **o setup não autora nada novo pra batching.**

### 5.2 Continuidade entre batches (o handoff compacto)

Entre batches o contexto vivo é **intencionalmente descartado** (é o ponto — janela fresca) e
reconstruído de artefatos duráveis + `git log`/diffs dos commits anteriores. Nossa vantagem
sobre o tlc: eles apoiam em `spec.md`/`design.md`/`STATE.md`; nós temos `feature.md` +
`contract.md` FROZEN + `architecture.md` autoritativo + `plan.json` + `library/` + os commits.
O worker de batch k+1 reconstrói contexto de artefatos **mais fortes** → o custo de "perda de
contexto entre batches" é menor aqui. O `EndFeatureRun` de cada batch já é o "compact summary"
do tlc (tasks done, commit ids, testes, deviations) — o runner já expõe `workerHandoffs` ao
orchestrator por retorno. Batching vira a review única de fim-de-feature em **K checkpoints
baratos**.

## 6. Ganhos colaterais (por que casa melhor aqui que no tlc)

- **Blast radius menor.** Hoje um crash 40 tasks adentro de uma sessão gigante perde todo o
  contexto in-head e o resume re-attacha um transcript possivelmente enorme. Batching limita
  cada sessão; batches 1–2 estão commitados + handed off antes do batch 3 começar.
- **K handoffs compactos** em vez de 1 mega-handoff → orchestrator com janela mais limpa,
  espelhando o loop de compact-summary do tlc com máquina que já temos.
- **Sem regressão no caminho feliz.** Small/Medium (≤~7–8 tasks) → 1 batch → **idêntico a hoje**.
- **Resume por batch** já sai de graça — cada batch é um step com seus `workerSessionIds`; o
  re-attach/orphan/budget do runLoop opera por step sem mudança.

## 7. Mapa tlc-spec-driven v3.2.0 → pi-harness

| Conceito tlc | Constante/local tlc | Adoção pi-harness | Onde |
|---|---|---|---|
| Task-budgeted batch (~7 tasks) | `sub-agents.md` | K `implement-k` steps via `batchTasks` (budget) | `feature-runner.ts` |
| Nunca rachar uma phase | phase boundary cut | **cohesion guard** (flat plan; corte só em emenda segura) | converge + `batchTasks` |
| Batches sequenciais | "batch never starts until prev complete" | já é sequencial (steps em ordem no runLoop) | `feature-runner.ts` runLoop |
| Compact summary entre batches | tasks/commits/tests/deviations | `EndFeatureRun` por batch (já expõe `workerHandoffs`) | `handoff.ts` / runner |
| Offer-then-confirm sub-agents | "want sub-agents? y/n" | **NÃO portado** — batching é decisão automática de sizing (somos runner determinístico) | — |
| Context budget (<40k / monitor) | Context Loading Strategy | budget token-aware via **peso por task** (`weight`, author-supplied) | `batch.ts` `weightOf`/`sumWeight` |
| Verifier (author ≠ verifier) | `sub-agents.md` Verifier | JÁ TEMOS: ship gate injetado (code-review → qa-validator → deliver) | runner (`SHIP_GATE`) |
| Discrimination/mutation sensor | Verifier step 2 | **ADICIONADO**: sensor scratch-state bounded no code-review (§1.5) | `skills/harness-code-review` §1.5 |

## 8. O que NÃO portamos (e por quê)

- **Offer-then-confirm ("quer sub-agents?").** O tlc pergunta porque é um agente único no chat.
  Somos **runner determinístico** — batching é decisão **automática** de sizing (como o
  `harness-feature-converge` Fase 0 já dimensiona Small→Complex). Sem prompt.
- **Milestone/phase como eixo de batching.** Rejeitado pela premissa central (§2): budget é o
  driver, coesão é só trilho.
- **O Verifier do tlc inteiro.** Já temos o analog mais forte (ship gate = author≠verifier por
  construção). Roubamos só o **sensor de mutação em scratch-state** pro `harness-qa-validator`.

## 9. Rollout / migração

1. **`batchTasks` + testes** (puro, isolado) — greedy budget + coesão + cauda. Sem tocar o runner.
2. **`planFeatureRun` emite K steps** atrás do budget (default 7). `T ≤ 7` ⇒ 1 step ⇒ byte-idêntico
   a hoje. Guardado por env `HARNESS_TASK_BUDGET` (0/∞ desliga → 1 batch legado).
3. **`next_task` escopa ao step in_progress** (§5.1) — a mudança delicada; testar resume
   cross-batch (batch-2 fresco pula batch-1, para no fim do batch-2).
4. **bootstrap batch copy** — "batch k/K, leia commits anteriores".
5. **converge: campo `cohesion`** opcional + doc na Fase 5.
6. **(depois) sensor de mutação** no qa-validator.

Cada passo é independentemente entregável e reversível; 1–2 já provam o modelo numa feature Large.

## 10. Pontos abertos [aberto]

- **Budget token-aware** [RESOLVIDO phase 7] — realizado como **peso por task** (`weight`,
  default 1 = contagem). O author (converge) marca uma task pesada com `weight>1` → ela consome mais
  budget → batches menores ao redor, SEM inventar um estimador de tokens. Um estimador automático
  (peso derivado de diff/descrição) continua aberto se algum dia valer a pena.
- **`cohesion` no schema do `store_plan`.** Campo opcional novo em `plan.json` — validar que
  `store_plan` aceita e o coverage invariant ignora. Definir se `batchBreakBefore` também entra.
- **Contagem de startup.** worker-base roda 1× **por batch**. Confirmar que o custo de startup ×K
  (K pequeno) « custo de compaction que evitamos. Medir numa feature Large real.
- **Interação com fix tasks.** `insertFixTask` insere acima do ship gate; com K batches, decidir
  se a fix vira seu próprio step (hoje sim) ou entra num batch — hoje: próprio step, mantém.
- **`skillName` como peso do corte.** Definir se a troca de `skillName` é *preferência* (budget
  ainda pode cortar antes) ou *emenda dura*. Default proposto: preferência — budget manda, troca
  de skill é só um bônus de localização (§5.3).
