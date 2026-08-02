# 09 — V2: o padrão OMP portado nativo

Remodelagem do harness em cima das primitivas que o **oh-my-pi** (omp) provou em produção,
**sem trocar de host e sem dependência externa**. O pi 0.80.3 já exporta toda a superfície
necessária; o que falta é a *maquinaria* — e é ela que este doc especifica.

Decisões marcadas **[travado]**; abertas em §Pontos abertos.

---

## 0. As 3 decisões de fundação [travado]

1. **Host continua o pi** (`@earendil-works/pi-coding-agent` 0.80.3). Não migramos pro omp.
   O omp é a **referência de desenho**, não a dependência — a mesma postura que o doc 04
   tomou com o daemon do droid ("adotamos as semânticas, não o daemon").
2. **Zero dependências externas [travado].** As 4 deps opcionais de hoje (`Agent` do
   `@tintinweb/pi-subagents`, `advisor`/`todo`/`ask_user_question` do rpiv) saem. O harness
   passa a **registrar as suas próprias**. `DispatchTools` (o probe adaptativo em
   `readiness-dispatch.ts`) morre junto: sem probe, tudo é nosso e sempre está lá.
3. **Portamos o padrão OMP COMPLETO**, não uma peça. Meia-adoção é o pior dos mundos:
   o advisor sem reinjeção de contexto vira ruído; a reinjeção sem guard vira prosa
   ignorável; o worker in-process sem registry vira órfão silencioso.

### O que "padrão OMP" quer dizer, em uma frase

> O agente é **dirigido por mecanismo, não por markdown**: a regra é reinjetada a cada turno,
> o proibido é bloqueado em código, o revisor roda **junto** e interrompe, e o "pronto" é
> auditado contra o repo antes de ser aceito.

---

## 1. Diagnóstico — por que V2 [travado]

Os três números que justificam a remodelagem, todos medidos no nosso próprio código:

| Sintoma | Onde está escrito | Causa raiz |
|---|---|---|
| 83% dos blocking findings eram ruído (100 rodadas) | `skills/harness-code-review/SKILL.md:165` | Revisão só no FIM: o revisor julga um lote gigante, sem o autor por perto pra refutar |
| 18 rodadas de gate / 22 fix tasks / 20,6 h numa run | `src/feature-runner.ts` (racional do `GATE_ROUND_CAP`) | Erro nasce na task 2 e só é visto na task 9 |
| Worker deriva do contrato ao longo das tasks | — | `contract.md` é lido **1×** no startup (`harness-worker-base`) e depois é memória |

Todas as três têm o mesmo formato: **o feedback chega tarde demais e a regra envelhece**.
O omp resolve exatamente esse formato, e resolve com mecanismo.

---

## 2. A superfície do pi 0.80.3 que sustenta tudo [travado]

Esta é a tabela que torna a decisão 0.1 defensável. Cada mecanismo do omp tem um ponto de
apoio **já exportado** por `@earendil-works/pi-coding-agent` — nada aqui depende de fork.

| Mecanismo do omp | Ponto de apoio no pi 0.80.3 | Verificado em |
|---|---|---|
| Reinjeção de contexto por turno (`#buildGoalModeMessage`) | evento `before_agent_start` → `BeforeAgentStartEventResult.message` (`customType`, `content`, `display:false`, `details`) + `.systemPrompt` | `dist/core/extensions/types.d.ts:774` |
| Guard programático (`enforcePlanModeWrite`) | evento `tool_call` → `ToolCallEventResult { block, reason }` | `types.d.ts:753` |
| Reescrita de contexto por chamada | evento `context` → `ContextEventResult { messages }` | `types.d.ts:749` |
| Subagente **in-process** (`runSubprocess`) | `createAgentSession(...)` / `createAgentSessionFromServices` (cwd, model, thinkingLevel, `tools` allowlist, `customTools`, `sessionManager`) | `dist/core/sdk.d.ts:11` |
| Steering (`AgentSession.steer`) | `session.steer(text)` + `prompt(text, { streamingBehavior: "steer" \| "followUp" })` | `dist/core/agent-session.d.ts:346,125` |
| Delta do transcript pro advisor | getter `session.messages` + `session.subscribe(listener)` | `agent-session.d.ts:293,244` |
| Abort cooperativo | `session.abort()` | `agent-session.d.ts:406` |
| Compaction incremental (`snapcompact`) | `compact`, `shouldCompact`, `findCutPoint`, `calculateContextTokens`, `estimateTokens`, `generateSummary` | `dist/index.d.ts:5` |
| Skills como system prompt do agente | `loadSkills`, `formatSkillsForPrompt`, `parseFrontmatter` | `dist/index.d.ts:19,29` |
| Guard-rail de compactação | `session_before_compact` → `SessionBeforeCompactResult { cancel, compaction }` | `types.d.ts:786` |

**Conclusão travada:** o custo do V2 é escrever a maquinaria (~2,5k linhas), não trocar de
plataforma. E a maquinaria substitui ~1,4k linhas que já mantemos.

---

## 3. Os 7 mecanismos portados

Ordem = ordem de implementação. Cada um é provável sozinho (doc 00: "não automatiza loop
sobre peça não-provada").

### 3.1 Reinjeção de contexto por turno — `src/omp/context-inject.ts` [travado]

**O que o omp faz:** `AgentSession#buildPlanModeMessage()` (`agent-session.ts:4577`) e
`#buildGoalModeMessage()` (`:4612`) montam uma `CustomMessage` **oculta** (`display:false`),
**reconstruída do zero a cada turno**. Nunca fica presa no histórico, nunca envelhece,
nunca é soterrada por 40 tool calls.

**Nosso port.** Um builder puro por papel, ligado ao `before_agent_start` do worker:

```ts
export interface TurnContext {
  featureId: string;
  taskId: string | null;
  assertions: { id: string; status: AssertionStatus; text: string }[];
  frozen: string[];
  lessons: string[];
  gateRound: number;
}

export function buildWorkerTurnMessage(ctx: TurnContext): CustomMessageInit;
export function buildOrchestratorTurnMessage(goal: GoalState): CustomMessageInit;
```

Conteúdo reinjetado a cada turno do worker, sempre reconstruído do disco:

- a **task corrente** (id, description, `fulfills`) — não a lista inteira;
- as **assertions do `fulfills` da task** com o status vivo de `status.json`;
- o lembrete FROZEN: quais arquivos são imutáveis nesta run;
- as **lições** aplicáveis ao escopo (hoje `lessonsBriefing` entra 1× no system prompt);
- na rodada de fix: o **finding que originou a fix task**, verbatim.

**Invariante:** é **derivado**, nunca acumulado. Se `status.json` muda, o próximo turno já
enxerga. Dedupe no estilo omp: conteúdo byte-idêntico ao turno anterior colapsa pra
`(unchanged — still in effect)`, o corpo reexpande quando muda.

**Mata:** a deriva do worker (§1, linha 3). É o transplante mais barato do doc.

### 3.2 Guards programáticos — `src/omp/guards.ts` [travado]

**O que o omp faz:** `tools/plan-mode-guard.ts::enforcePlanModeWrite` é chamado por
`write.ts:1121/1212/1239/1256` **antes de qualquer escrita** e lança `ToolError`. O modelo
não contorna. Rename/delete são banidos sempre.

**Nosso port.** Um handler de `tool_call` que devolve `{ block: true, reason }`. As regras
que hoje são prosa em SKILL.md e o modelo viola:

| Regra hoje (prosa) | Guard V2 |
|---|---|
| "`contract.md` é FROZEN" | bloqueia `write`/`edit` em `runs/<id>/contract.md` depois do `store_plan` |
| "nunca edite `plan.json`/`status.json` à mão" | bloqueia — só os tools (`store_plan`, `next_task`) escrevem |
| "o worker NUNCA faz merge" | bloqueia `bash` com `git merge`/`gh pr merge` fora do `harness-deliver` |
| "sugestões de guidance miram `harness.md`, NUNCA o AGENTS.md do repo" (doc 00 §3) | bloqueia escrita no `AGENTS.md` do repo por worker |
| "o orchestrator NUNCA implementa" | bloqueia `edit`/`write` em código-fonte na sessão do orchestrator |

**Regra de ouro:** todo guard devolve `reason` acionável (o que fazer em vez disso). Guard
que só nega ensina o modelo a brigar; guard que redireciona ensina o caminho.

### 3.3 Worker in-process — `src/omp/worker-session.ts` [travado]

**O que o omp faz:** apesar do nome, `runSubprocess()` (`task/executor.ts:2392`) é
**in-process** — cria outra `AgentSession` no mesmo processo. Sem PID, sem IPC, sem RPC.
Chamadas de LLM são I/O-bound: concorrência é `async/await` + semáforo, não multiprocesso.

**Nosso port.** `createAgentSession({ cwd, model, thinkingLevel, tools, customTools,
sessionManager })` no lugar de `pi --mode rpc`.

O que isso apaga de uma vez:

- o `RpcClient` lazy/guarded + o fallback `cliPathFromArgv` (`rpc-worker.ts:88`, existe só
  porque o child podia nascer morto);
- o watchdog de inatividade por evento (a sessão é nossa: sabemos se está viva);
- o orphan cleanup por crash de processo (não há processo);
- o `--tools` como allow-list de string (doc `feature-spawn.ts:30`: o bug em que `subagent`
  era silenciosamente filtrado e reviewers não spawnavam). Vira `tools: string[]` tipado.

**O que NÃO muda [travado]:** o worker continua **session-backed** (`SessionManager`,
transcript em `runs/<id>/sessions/`), continua puxando task por `next_task`, continua
commitando por task, continua terminando com um handoff. A paridade de resiliência do doc
04 é **preservada em outra base** — os estados de pausa (`aborted`/`usage_limit`/
`step_retry_limit_exceeded`) continuam idênticos.

**Subagentes do worker:** o `Agent` do rpiv some; o worker ganha o **nosso** tool `spawn`
(mesmo runtime, um nível abaixo), com `maxRecursionDepth` e semáforo de concorrência.

### 3.4 Registry + lifecycle — `src/omp/registry.ts` · `src/omp/lifecycle.ts` [travado]

**O que o omp faz:** `AgentRegistry` (`registry/agent-registry.ts`) é um diretório global
com registro **CAS-guarded** (`registerIfAvailable`/`attachSession`/`setStatus` com ref
`expected`) — dois workers não colidem no mesmo id. `AgentLifecycleManager`
(`registry/agent-lifecycle.ts:229`) faz `idle → parked → revive` com TTL de 7 min
(`setTimeout(...).unref()`, não segura o processo).

**Nosso port.** Substitui `run-registry.ts` (155 ln) + `live-agents.ts` (208 ln):

| Estado | Significado | Custo |
|---|---|---|
| `running` | turno em andamento | contexto vivo |
| `idle` | terminou o turno, contexto quente | memória |
| `parked` | TTL estourou, contexto no `.jsonl` | zero |
| `revived` | mensagem chegou pra um `parked` → reabre do disco | re-leitura |

**Por que importa:** hoje a resposta a "worker parado" é **matar e recriar** (perde contexto)
ou manter processo vivo (caro). `parked/revive` dá o meio-termo — e é exatamente o que o
**batching** (`batch.ts`, 165 ln) tenta emular hoje com serra elétrica.

### 3.5 Advisor runtime — `src/omp/advisor-runtime.ts` · `src/omp/emission-guard.ts` [travado]

**O maior item do doc.** É o que ataca os 83% e as 18 rodadas.

**O que o omp faz** (`docs/advisor-watchdog.md`, `advisor/runtime.ts`, 1358 ln):
um segundo modelo recebe **só o delta** do transcript a cada fim de turno, tem tools
read-only próprios, e fala por **um único tool** (`advise`) com 3 severidades.

**Nosso port, peça a peça:**

| Peça | Origem (omp) | Nosso arquivo | Comportamento |
|---|---|---|---|
| Feed de delta | `AdvisorRuntime` cursor sobre `snapshotMessages()` | `advisor-runtime.ts` | cursor sobre `session.messages`; advice já injetada é filtrada (não revisa a si mesma) |
| Severidade | `nit`/`concern`/`blocker` | idem | `nit` → `followUp`; `concern` → `steer`; `blocker` → `steer` + marca o step |
| Entrega | steering channel | `session.steer()` / `prompt(..., {streamingBehavior})` | usa a API nativa do pi, sem canal próprio |
| Anti-spam | `advisor.immuneTurns` (default 3) | idem | após um steer aceito, 3 turnos só de aside |
| Anti-ruído | `AdvisorEmissionGuard` (172 ln) | `emission-guard.ts` | normaliza (NFKC+lower+collapse) → filtra frase vazia (`lgtm`, `done`, `no issues`) → dedupe FIFO 4096 → **1 nota por ciclo** |
| Contrapressão | `advisor.syncBacklog` | idem | worker espera até 30 s se o advisor atrasa ≥ N deltas |
| Roster | `WATCHDOG.yml` | `.harness/profile/watchdog.yml` | **gerado pelo `harness-setup`** por repo |
| Custo/observabilidade | `<session>/__advisor.jsonl` | `runs/<id>/sessions/__advisor-<name>.jsonl` | transcript próprio, custo atribuído |
| Não é peer | `AgentRegistry.listVisibleTo` exclui `kind:"advisor"` | idem | advisor não recebe mensagem, não é steerable, não aparece como worker |

**O roster é a jogada [travado].** `.harness/profile/watchdog.yml` é Tier-1 (commitado,
versionado, refreshável) e **reusa os 3 eixos que já temos**:

```yaml
instructions: |
  Fale só com evidência do transcript ou de tool que você mesmo rodou.
advisors:
  - name: correctness
    model: <role:validator>
    tools: [read, grep, find]
    instructions: "@.harness/profile/library/coding-principles.md"
  - name: conventions
    model: <role:validator>
    tools: [read, grep, find]
    instructions: "@.harness/profile/library/conventions-map.md"
```

Isso **move o ship gate pra esquerda**: `harness-code-review` deixa de ser o lugar onde os
defeitos são *descobertos* e vira o lugar onde a ausência deles é *confirmada*.

**O prompt do advisor é metade do valor [travado].** Portamos verbatim as regras de
`prompts/advisor/system.md` que o nosso review não tem:

- "Prefira o silêncio quando o agente está no caminho."
- "NUNCA repita informação que o agente já tem (erro de tipo, teste falhando, lint)."
- "NUNCA policie escopo: diff grande não é problema — só objete citando instrução explícita do usuário."
- "Argumentos ausentes do transcript são DESCONHECIDOS — não afirme valores que você não viu."
- "NUNCA levante compat retroativa sem regra explícita; cutover limpo é o default correto."
- "Quando o cabeçalho diz `[in progress — more steps follow]`, segure a crítica."

### 3.6 Pause gate + steering boundaries — `src/omp/pause-gate.ts` [travado]

**O que o omp faz:** `AgentPauseGate` (`packages/agent/src/pause.ts`) é um gate de processo
consultado em **dois pontos** de todo loop — antes de cada model call e antes de cada tool
call (`agent-loop.ts:1042,2405`). Trabalho em curso **termina**; nada é abortado no meio.

**Nosso port.** Como não controlamos o loop do pi, o gate vive na borda que controlamos:
`tool_call` (bloqueia com espera) + o boundary natural de fim de turno. Consequência
prática: `run_feature` **deixa de ser 100% bloqueante**. O orchestrator ganha:

- `pause` real (o worker para no próximo boundary seguro, sem perder trabalho);
- `steer` mid-feature (hoje só dá pra falar com o worker **entre rounds**, via `fixTasks`);
- resume que continua o turno em vez de reiniciar o step.

### 3.7 Handoff com yield forçado — `src/omp/output.ts` [travado]

**O que o omp faz:** `finalizeSubprocessOutput` (`executor.ts:564`) reconcilia texto/`yield`/
schema; se o subagente não chamou `yield`, até **3 lembretes** forçam `toolChoice="yield"`.
`AgentOutputManager` aloca nome único (`-2`, `-3`, aninha `Pai.Filho`), semeia do disco pra
não colidir em sessão retomada, e persiste `<id>.jsonl` + `<id>.md`.

**Nosso port.** Hoje, se o worker termina o turno sem `EndFeatureRun`, o runner lê o disco e
não acha nada → `SpawnOutcome` degradado, tentativa queimada. V2: **3 lembretes forçados**
antes de declarar falha. Handoff estruturado deixa de ser boa-vontade do modelo.

---

## 4. Goal mode: o orchestrator vira mecânico [travado]

Hoje o orchestrator é `skills/harness-orchestrator/SKILL.md` (246 ln de markdown) + um runner
que para quando algo falha. O omp mostra o que falta: **estado**.

**`GoalState`** (`src/omp/goal.ts`), espelhando `goals/state.ts`:

```ts
interface FeatureGoal {
  featureId: string;
  tokenBudget?: number;
  tokensUsed: number;
  status: "active" | "paused" | "budget-limited" | "complete";
  assertionsPassed: number;
  assertionsTotal: number;
}
```

Três comportamentos herdados:

1. **Contabilidade real.** `goalTokenDelta()` = input + cacheWrite + output desde o baseline
   do turno; **cacheRead é excluído** (reuso não é trabalho novo). Ligamos no `usage.ts`.
2. **Steer de budget.** Ao cruzar o teto → status `budget-limited` + steer oculto:
   *"Budget exhaustion is not completion."* Hoje o equivalente é o `GATE_ROUND_CAP` devolver
   ao orchestrator sem contexto do porquê.
3. **Auditoria de conclusão de 6 passos [travado].** O omp exige auditar contra o estado
   **real** do repo antes de aceitar `complete`. Nós já temos o `completionGate` determinístico
   (todas as assertions `passed`); o V2 acrescenta a auditoria **por assertion**: evidência
   `file:line` ou comando com exit 0. Sem evidência → não passa. É o `evidence-or-zero`
   aplicado ao nosso próprio critério de "done".

---

## 5. Contabilidade: o que morre, o que nasce, o que fica

### Morre

| Arquivo | Linhas | Substituto |
|---|---:|---|
| `src/rpc-worker.ts` | 246 | `omp/worker-session.ts` (in-process) |
| `src/run-registry.ts` | 155 | `omp/registry.ts` |
| `src/live-agents.ts` | 208 | `omp/registry.ts` (mesma fonte de verdade) |
| `src/session-read.ts` | 232 | `session.messages` direto |
| `src/batch.ts` | 165 | `lifecycle.ts` (parked/revive) + compaction |
| `DispatchTools` (probe adaptativo) | ~60 | nada — tudo é nosso |
| parte de `feature-spawn.ts` (args/`--tools`/inactivity) | ~120 | opções tipadas do `createAgentSession` |
| **Total** | **~1.186** | |

### Nasce — `src/omp/`

| Arquivo | Est. | Papel |
|---|---:|---|
| `context-inject.ts` | 200 | reinjeção por turno (§3.1) |
| `guards.ts` | 150 | bloqueio programático (§3.2) |
| `worker-session.ts` | 500 | worker in-process (§3.3) |
| `registry.ts` | 250 | diretório CAS-guarded (§3.4) |
| `lifecycle.ts` | 200 | idle/parked/revive (§3.4) |
| `advisor-runtime.ts` | 600 | feed de delta + entrega (§3.5) |
| `emission-guard.ts` | 170 | dedupe/ruído/rate-limit (§3.5) |
| `watchdog-config.ts` | 150 | parser do `watchdog.yml` (§3.5) |
| `pause-gate.ts` | 150 | pause/steer boundaries (§3.6) |
| `output.ts` | 200 | handoff + yield forçado (§3.7) |
| `goal.ts` | 200 | budget + auditoria (§4) |
| **Total** | **~2.770** | |

**Saldo: +1.584 linhas.** Não é uma economia de código — é uma **troca de encanamento por
mecanismo**. O que sai é cola de subprocesso; o que entra é controle de agente. E some a
superfície externa inteira (4 pacotes).

### Fica intocado — o domínio [travado]

O ponto do V2 é **liberar** esta camada, não mexer nela:

- `.harness/profile/` (Tier-1 versionado) · `fingerprint.ts` · `profile.ts` · `reconcile.ts`
- readiness: 82 critérios, auditor, runner, relatório, hints
- `contract.md` FROZEN + invariante de cobertura (`plan.ts`, `store_plan`)
- delivery: PR + CI + fix-loop + merge gate humano (`delivery.ts`, `linear-link.ts`)
- lições (`lessons.ts`) — e agora com um sinal **muito** melhor: advice de advisor
- a TUI de cockpit (`control-*`, `*-view`) — ganha uma aba de advisors

---

## 6. Fatias verticais [travado]

Cada fatia se prova sozinha e é útil sozinha. Ordem escolhida por **retorno / risco**.

```
[ ] F1 · Reinjeção de contexto por turno (§3.1)
      before_agent_start no worker + builder puro + dedupe.
      Prova: run real onde o worker cita a assertion correta na task 7.
      Risco: baixo. Não toca o runner. Reversível por flag.

[ ] F2 · Guards programáticos (§3.2)
      tool_call → block. Começa por contract.md FROZEN e plan.json/status.json.
      Prova: teste que tenta escrever no contract e recebe block + reason.
      Risco: baixo. Puramente aditivo.

[ ] F3 · Emission guard + roster no profile (§3.5, metade)
      emission-guard.ts isolado e testado + watchdog.yml gerado pelo harness-setup
      + as regras de prompt do advisor portadas pros 3 eixos do code-review.
      Prova: os 3 eixos passam a devolver row-only com silêncio por default.
      Risco: baixo. Ganho imediato no ruído, ANTES do advisor existir.

[ ] F4 · Worker in-process (§3.3)
      createAgentSession no lugar do RpcClient. SpawnFn mantém a MESMA assinatura
      (o runner não sabe da diferença — doc 04 já provou esse seam).
      Prova: a suíte inteira do feature-runner verde sem tocar em feature-runner.ts.
      Risco: MÉDIO. É a troca de motor. Mantém rpc-worker.ts atrás de env por 1 release.

[ ] F5 · Registry + lifecycle (§3.4)
      Substitui run-registry/live-agents; batch.ts sai.
      Prova: worker parked por TTL e revivido mantém o contexto (sem re-startup).
      Risco: médio. Depende de F4.

[ ] F6 · Advisor runtime (§3.5, resto)
      Feed de delta + severidade + immuneTurns + syncBacklog + __advisor.jsonl.
      Prova: run onde um concern chega no turno em que o defeito nasce.
      Risco: médio-alto. É onde está o valor. Só depois de F1+F3+F4.

[ ] F7 · Pause gate + steer mid-feature (§3.6)
      run_feature deixa de ser bloqueante. Tecla S do cockpit passa a valer durante o turno.
      Risco: médio. Depende de F4.

[ ] F8 · Handoff com yield forçado (§3.7) + goal mode (§4)
      3 lembretes; budget contado; auditoria por assertion com evidência.
      Risco: baixo. Fecha o ciclo.
```

**Regra de corte [travado]:** F1–F3 são independentes de F4. Se o worker in-process der
errado, F1/F2/F3 continuam de pé e já pagam o doc — elas atacam ruído e deriva sem tocar no
motor.

---

## 7. Riscos e não-objetivos

### Riscos

| Risco | Mitigação |
|---|---|
| Worker in-process compartilha processo com o TUI: um crash derruba tudo | `AbortController` por worker + try/catch na borda do `subscribe`; o registry marca `error` sem propagar. O modo headless continua isolado. |
| Advisor duplica custo de tokens | `syncBacklog` + `immuneTurns` + o guard de 1-nota-por-ciclo. Custo medido em `usage.ts` por role, com o advisor separado. |
| Advisor vira o novo gerador de ruído | O emission guard é **código**, não prompt. E F3 vem **antes** de F6, então o ruído é medido no gate atual antes de ligar o advisor. |
| Guards bloqueando o legítimo | Todo `block` grava linha no `progress_log.jsonl`. Se um guard dispara demais, aparece. |
| Deriva da API do pi entre versões | O `peerDependency` já é `*`; o seam é `src/omp/` inteiro. Uma quebra é localizada. |

### Não-objetivos [travado]

- **Não** migramos pro omp como host.
- **Não** portamos hub/IRC entre agentes. Nossos workers não conversam entre si — o
  `contract.md` e o disco são o canal, e isso é uma feature (doc 00 §3).
- **Não** portamos DAG/waves (swarm-extension). Nosso runner é sequencial de propósito;
  paralelismo real vive dentro dos subagentes de análise, e lá o semáforo basta.
- **Não** portamos snapcompact (PNG). Usamos a compaction nativa do pi.
- **Não** reescrevemos a TUI.

---

## 8. Invariantes preservadas [travado]

O V2 é uma troca de maquinaria. Nada disto pode mudar:

1. `contract.md` é **FROZEN** — e agora por guard, não por prosa.
2. Cobertura: toda assertion reivindicada por **exatamente uma** task (`store_plan`).
3. **1 worker por feature**, não por task (doc 00 §4.1).
4. Ship gate roda **1×** por rodada; `GATE_ROUND_CAP` continua o freio.
5. Fix task só para finding **blocking** (`harness-code-review` §3).
6. Merge é **humano** — o agente nunca faz merge sozinho.
7. `harness.md` defere ao `AGENTS.md` do repo para convenção de código.
8. Profile é Tier-1 commitado; runs são Tier-2 gitignored.

---

## Pontos abertos

1. **Onde mora o pause gate.** Não controlamos o `agent-loop` do pi, então o gate vive em
   `tool_call` + fim de turno. Se isso se mostrar granular demais, a alternativa é um
   `customTool` sentinela que o worker é instruído a chamar entre tasks. `// ponytail`
2. **Advisor por task vs por feature.** Um advisor para a feature inteira é mais barato; um
   por task tem contexto mais nítido. Começa com um por feature, mede.
3. **Modelo do advisor.** Reusa o role `validator` do `model-config.ts` ou ganha role
   próprio (`advisor`)? Inclina pra role próprio — o trade-off custo/qualidade é diferente
   do validator de ship gate.
