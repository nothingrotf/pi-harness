# 02 — Readiness (modelo, ciclo de criação, e gate UX)

Como o readiness é **criado, garantido e validado**, e como aparece pro usuário.
Port **1:1** do "Agent Readiness Model" do harness de referência, com pequenas
mudanças locais documentadas aqui. Empresta o modelo staged do `rpiv-workflow`
(estado JSONL auditado + validação de output por estágio) e o idioma de painel do
`rpiv-advisor`.

---

## 1. O reframe central (o que muda vs o referência)

O referência **junta** gate + criação, e os warnings dele são **cloud-centric**:
`isGitRepo`/`hasRemote`/`remoteUrl` só existem porque o report é chaveado por
git-remote no Firestore. pi-harness é **local** — readiness mora em
`.harness/profile/readiness.json`. Então:

1. **Readiness é artefato de primeira classe do profile**, com ciclo de vida
   explícito (create · ensure · validate · store).
2. **O gate** = projeção pura do estado desse artefato num único *stance* + ação.

**As "small changes" (deviações locais documentadas):**

| Referência (referência) | pi-harness (local) |
|---|---|
| store no Firestore | **mesma tool** `store_agent_readiness_report`, mas grava `.harness/profile/readiness.json` |
| gate por git-remote → 4 warnings (no-git/no-remote/no-report/low-score) | 4 **stances** (unknown/stale/weak/ready) por estado do snapshot local |
| score por todos os 82 | **82 critérios 1:1** + overlay `cloudOnly` (20) → `num=null` local (sob "Additional Instructions from User") |
| dashboard URL dashboard remoto | sem dashboard — report é local |

Tudo o mais é **1:1 verbatim**: o prompt do auditor (`SKILL.md` = texto verbatim do
a referência), as 5 fases, scoring, scope repo/app, skippable, bandas de
nível, schema estrito, e o `/readiness-fix` (a referência, ver §7).

---

## 2. Ciclo de vida do snapshot (create · ensure · validate · store)

Pipeline de 4 estágios (modelo `rpiv-workflow`), com validação por estágio e
trilha JSONL auditável. **Tudo abaixo está construído** (Fatia 1).

| Estágio | Onde | Faz | Gate |
|---|---|---|---|
| **ensure** | `readiness-pipeline.ts::ensureReadinessInputs` | preflight: é repo git? `.harness/profile` criável? | bloqueia com motivo |
| **create** | `skills/harness-readiness-audit/SKILL.md` (auditor LLM, 5 fases) | escaneia repo, descobre apps, avalia 82 critérios | — |
| **validate** | `readiness.ts::validateReport` (chamado pelo store tool) | 82 ids exatos · den por scope · `num=null` só skippable/cloudOnly · rationale ≤500 | rejeita → modelo corrige |
| **store** | `readiness-store-tool.ts` → `readiness-pipeline.ts::storeReport` | computa level/passRate, grava `readiness.json` + append `readiness.jsonl` | recusa report inválido |

State machine do `status` que o gate lê:

```
        ┌────────┐  create(audit)   ┌────────┐  validate ✓   ┌────────┐  level≥target
        │ absent ├─────────────────▶│ draft  ├──────┬───────▶│ ready  │
        └────────┘                  └────────┘      │        └───┬────┘
                                      validate ✗    │ level<target   │ drift
                                   (modelo corrige)  ▼            ▼   │ (fingerprint Δ)
                                                 ┌────────┐  ┌────────┐
                                                 │ weak   │  │ stale  │◀┘
                                                 └────────┘  └────────┘
```

Como o **create** dispara: o comando `/readiness-report` (ou o gate `reaudit`) chama
`runAudit` → `ensureReadinessInputs` → `pi.sendUserMessage(...)` instruindo o
modelo a invocar a skill `harness-readiness-audit`; a skill termina chamando a tool
`store_agent_readiness_report` (validate+store em TS confiável).

Trilha auditável (`.harness/profile/readiness.jsonl`):

```jsonl
{"ts":…,"ev":"audit_dispatched","via":"/harness"}
{"ts":…,"ev":"snapshot_stored","level":2,"passRate":0.34,"fingerprint":"a1b2c3d4e5f6"}
{"ts":…,"ev":"report_rejected","issueCount":3,"issues":[…]}   // quando inválido
```

---

## 3. Warnings → stances

Um painel, um campo `stance`, uma ação primária + medidor visual:

| Stance | Quando | Chip | Ação primária |
|---|---|---|---|
| `unknown` | sem snapshot (`absent`) | `◆ NÃO AVALIADO` | Rodar auditoria |
| `stale` | drift de fingerprint | `↻ PODE ESTAR STALE` | Re-auditar |
| `weak` | `level < target` | `▲ ABAIXO DA BARRA` | Corrigir sinais |
| `ready` | `level ≥ target`, fresco | `✓ PRONTO` | auto-prosseguir |

`deriveStance` em `readiness.ts`; `target` default = **L4**.

---

## 4. O painel (estilo `rpiv-advisor`, "stance banner + actions")

```
╭──────────────────────────────────────────────────────────────╮
  ⬢ pi-harness · readiness gate

  ▲ ABAIXO DA BARRA     L2 / L5  ▰▰▱▱▱  34%      target ≥ L4

  Áreas mais fracas
    security   ▰▱▱▱▱▱  1/12
    testing    ▰▰▱▱▱▱  2/8

  →  Corrigir sinais de readiness   remediação guiada
     Ver relatório completo         critérios por categoria
     Prosseguir mesmo assim         roda a feature do mesmo jeito
     Cancelar

  enter selecionar · ↑↓ mover · r re-auditar · esc cancelar
╰──────────────────────────────────────────────────────────────╯
```

`Container`+`DynamicBorder`+`Text`+`SelectList` (`readiness-gate.ts`). View model
puro (`buildGateModel`) e testado; o gate só renderiza.

---

## 5. O modelo de critérios (82, 1:1 + overlay cloudOnly)

Catálogo **1:1** do referência: 82 critérios, 9 categorias, 5 níveis, scope
`repository` (den=1) vs `application` (den=N), `skippable`. Em
`src/readiness-criteria.ts` (estrutura) + `skills/harness-readiness-audit/criteria.json`
(as `instructions` de verificação, cópia verbatim do referência).

**Overlay local `cloudOnly` (20 critérios):** os que só são verificáveis numa
plataforma hospedada / API / runtime (DAST, PagerDuty/alerting, dashboards,
GitHub API, telemetria de deploy/observabilidade, analytics SaaS). Localmente o
auditor emite `num=null` pra eles → saem do score. Lista canônica no SKILL e em
`CLOUD_ONLY_IDS`.

Scoring (mantido 1:1): pass-rate = média de `num/den` sobre não-skipados, **peso
igual** por critério; bandas L1 0-20 · L2 20-40 · L3 40-60 · L4 60-80 · L5 80-100.

---

## 6. Onde mora no código

| Arquivo | Papel |
|---|---|
| `src/readiness-criteria.ts` | Registry dos 82 (id/name/cat/level/scope/skippable/**cloudOnly**), `CLOUD_ONLY_IDS`, `isLocallySkippable`. |
| `src/readiness.ts` | Scoring, `validateReport` (contrato estrito), `buildSnapshot`, `deriveStance`, `buildGateModel`, `summarizeSnapshot`, barras. Sem dep do Pi. |
| `src/readiness-pipeline.ts` | `ensureReadinessInputs` (ensure), `storeReport` (store), `readSnapshot`, `appendAudit`, `repoFingerprint`. fs puro. |
| `src/readiness-store-tool.ts` | Tool `store_agent_readiness_report` (nome 1:1; validate+store local; **lança** em report inválido — convenção do runtime). |
| `src/readiness-fix-prompt.ts` | Port 1:1 do `/readiness-fix` (a referência): `failingSignals` + `buildFixPlan` (3 variantes, anti-gaming verbatim). |
| `src/readiness-gate.ts` | Painel TUI (`showReadinessGate`). |
| `src/extension/index.ts` | Registra a tool; comandos `/readiness-report` e `/readiness-fix`; gate lê snapshot → model → ação (`reaudit`→report flow, `fix`→fix flow). |
| `skills/harness-readiness-audit/` | `SKILL.md` (prompt do auditor **verbatim** do a referência) + `criteria.json` (82 com instructions, 1:1). |
| `test/readiness*.test.ts` | 26 testes: scoring, validate, buildSnapshot, stances, ensure/store/round-trip, failingSignals + 3 variantes do fix. |

---

## 7. Flows (comandos) + coordenação (sessões isoladas)

Dois slash-commands portados como comandos próprios, agora com **sessões
isoladas** (via `pi-subagents`) pra alinhar a coordenação com o referência:

- **`/readiness-report`** (estágio create) — dispara o **agente dedicado
  `harness-readiness-auditor`** numa sessão isolada fresh-context, espelhando a sessão
  dedicada `readiness-evaluation` (auditor de referência) do referência:
  `subagent({ agent: "harness-readiness-auditor", async: false, task: … })` que termina
  chamando `store_agent_readiness_report`. (gate `reaudit` = mesmo caminho.)
- **`/readiness-fix [args]`** — port 1:1 do a referência (3 variantes: sem report →
  audit; report+args → match semântico; report+sem args → AskUser categoria/sinal).
  Texto verbatim. **+ camada de orquestração** (nossa): cada fix roda no **agente
  dedicado `harness-readiness-remediator` por critério, em sequência**, espelhando as
  sessões `readiness-remediation` (um subagent
  por critério). (gate `fix` = mesmo caminho, args vazio.)

### Agentes dedicados (analog do auditor de referência / readiness-remediation)

Em vez dos builtins genéricos `delegate`/`worker`, pi-harness traz dois agentes
dedicados (em `agents/`, contribuídos pro pi-subagents — via manifest do pacote (package.json → pi.subagents.agents), sem espelho no dir
global de agents via symlink, sem escrever no repo do usuário):

| Agente | Tools | Contexto | Papel |
|---|---|---|---|
| `harness-readiness-auditor` | read/grep/find/ls/bash **+ store_agent_readiness_report** (sem edit/write) | fresh | roda a skill harness-readiness-audit, grava o snapshot; **não modifica o repo** |
| `harness-readiness-remediator` | read/grep/find/ls/bash **+ edit/write** | fresh | corrige **um** sinal falhando por sessão |

### Coordenação: ReadinessRunner = runner de referência 1:1 (code-initiated)

O motor agora é o **ReadinessRunner** (`src/readiness-runner.ts`): código
determinístico que **ele mesmo spawna** as sessões isoladas (`pi --print`), igual
ao `runner de referência`. Sem depender do modelo chamar a tool `subagent`.

| runner de referência (referência) | ReadinessRunner (pi-harness) |
|---|---|
| engine = código in-process (não LLM) | `runLoop` (código, não LLM) |
| spawnWorker spawna sessão | `makeRealSpawn` spawna `pi --print` (sessão nova = fresh) |
| quem inicia: o código | o código (runAudit/runFix → runLoop) |
| EndFeatureRun (handoff) | exit code do child + (audit) snapshot válido |
| `_9H = 5` attempt budget | `STEP_ATTEMPT_BUDGET = 5` |
| pause (SIGINT/402/budget) | `status="paused"` (aborted / step_retry_limit_exceeded) |
| resume | readRun(paused) → runLoop continua os pendentes |
| cleanupOrphanedWorker | `cleanupOrphan` (in_progress → pending) |
| state.json / progress_log.jsonl | readiness-run.json / readiness.jsonl |
| sequencial, 1 worker por vez | sequencial, 1 child por vez |

O child `pi --print` usa **o mesmo modelo do parent** (`ctx.model.id`), carrega a
extensão pi-harness (→ store tool + skill), recebe o prompt do auditor verbatim via
`--append-system-prompt`, e o tools allowlist (`--tools`) replica os agentes
dedicados (auditor read-only+store; remediator edit/write).

### Default: dispatch NATIVO (in-session, ao vivo)

O **default é model-driven nativo** — é o que o modelo de referência mostra no terminal: os tool
calls streamam ao vivo na própria sessão. `src/readiness-dispatch.ts` monta a mensagem
(`pi.sendUserMessage`) que manda o modelo: (1) rodar a skill `harness-readiness-audit`
pelas 5 fases em ordem, (2) chamar `store_agent_readiness_report` (valida + grava). Zero
widget custom, zero subprocesso — só compor pi-subagents + a skill + a store tool.

```
●  📊 Starting agent readiness evaluation
⛬  Read package.json, nx.json · List app/ … (tool calls ao vivo)
Plan · 1/5
┃ ● Phase 1: Detect language & explore
┃ ○ Phase 2: Application discovery …
```

O fix (`/readiness-fix`) idem: uma todo por sinal falhando, cada fix opcionalmente
isolado num `subagent` (agent `harness-readiness-remediator`).

### Alternativa headless: ReadinessRunner (code-initiated, runner de referência 1:1)

Pra CI / headless / quando se quer o **engine determinístico** que spawna as
sessões ele mesmo (`pi --print --mode json`), `src/readiness-runner.ts` +
`readiness-spawn.ts` + `readiness-progress.ts` continuam (testados; validados com
uma auditoria real — 697 eventos → snapshot válido). Não é o default porque um
handler bloqueante congela o TUI; o nativo dá o streaming de graça.

### Plugins companheiros (requeridos pra coordenação)

- **`pi-subagents`** — spawna as sessões isoladas (audit + fix por critério) e
  descobre os agentes dedicados no dir global de agents (espelho via symlink).
- (removido) **rpiv-todo** — o harness não instrui mais o Plan de todos; se o usuário
  tiver o rpiv-todo instalado, ele continua disponível para uso pessoal, mas os
  dispatches do harness não o mencionam.

NÃO reimplementamos as utilidades do pi-subagents (worktrees, async tracking,
chains, acceptance, intercom — ~31k LOC): ele já está instalado e o design é
**compor**, não forkar. Só adotamos o que casa 1:1 com o referência: agentes
dedicados isolados + um overlay de todo.

### Estado de implementação

- **Construído (Fatias 1 + 4):** ciclo create→ensure→validate→store + os dois flows,
  agora com o **ReadinessRunner code-initiated** (runner de referência 1:1):
  `src/readiness-runner.ts` (engine), `src/readiness-spawn.ts` (spawn real de
  `pi --print`). Auditor = prompt **verbatim**; tool nome 1:1; `/readiness-fix`
  texto 1:1 do a referência.
- **VALIDADO com evidência real:** 49 testes (engine, validate, store, scoring,
  stances, fix, agents, spawn-args, pipeline) + e2e com subprocesso real (fake pi)
  + smoke de `pi --print` real usando tools + probe do store tool num child real
  + **uma auditoria REAL completa** (sonnet-4-5) que escreveu um snapshot válido
  de 82 critérios (L2, 23%, CONTRACT_VALID).
- **Fatia 2 (feita):** `drift`/stance `stale` agora é REAL — `repoFingerprint` =
  hash de conteúdo determinístico (lockfiles/rules/toolcfg, `src/fingerprint.ts`);
  o gate compara o fingerprint do snapshot com o atual. `profile.json` é gerado
  deterministicamente por `ensureProfile` (`src/profile.ts`): created/ok/drift/
  refreshed; `/harness setup` faz refresh. (Validado: drift detectado no snapshot
  real do fakeflix → stance `stale`.)
- **Stub (ponytail):** `report` mostra resumo de uma linha (relatório navegável é
  futuro). O CONTEÚDO do profile (architecture.md/services.yaml/skills/library) é a
  setup skill (Fatia 1, LLM) — `profile.json` hoje guarda só o metadata/fingerprint.
- **Limites conhecidos:** o runner é bloqueante (como `start_mission_run`); SIGINT
  → pause depende de um AbortSignal (Pi detém o SIGINT global); o smoke do gate TUI
  (`ui.custom`) ainda precisa de uma sessão Pi ao vivo.

### Mapa de código do runner

| Arquivo | Papel |
|---|---|
| `src/readiness-runner.ts` | engine puro (runLoop, planAuditRun/planFixRun, budget, pause/resume, orphan). Testado com SpawnFn injetado. |
| `src/readiness-spawn.ts` | `makeRealSpawn` (spawn real de `pi --print`), `piArgs` (puro), `auditSystemPrompt`. |
| `src/readiness-pipeline.ts` | `readRun`/`writeRun` (state.json analog) além de ensure/store/snapshot. |
| `src/extension/index.ts` | runAudit/runFix → plan + runLoop (code-initiated); resume; modelo do parent. |
