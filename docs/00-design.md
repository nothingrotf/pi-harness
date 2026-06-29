# 00 — Design travado

Síntese das decisões da sessão de design. Fonte de verdade pro que estamos
construindo e por quê. Decisões marcadas **[travado]**; abertas em §Pontos abertos.

---

## 1. Escopo: sempre FEATURE [travado]

Sem flag `project|feature`. Project-scale (milestones, fila de N features, cadência de
validação por milestone) só existe pra coordenar entregas de dias — peso morto no modo
feature. Premissa única: **feature, sequencial**.

Multi-feature = **fila incremental no nível repo** (feature 1 hoje, feature 2 depois),
não sub-features dentro de um run. Cada run reusa o profile cacheado.

## 2. Dois tiers [travado]

- **Tier 1 — Repo Profile** (`.harness/profile/`, **commitado**): o "setup" caro,
  gerado 1x, refreshável. Estável entre features. Time compartilha, versiona, revisa.
- **Tier 2 — Feature Run** (`.harness/runs/<id>/`, **gitignored**): o trabalho leve
  e repetível por feature. Runtime descartável.

`.gitignore` do repo-alvo += `.harness/runs/`.

Por quê o split: a fase cara de planning produz quase tudo "estável entre features"
(arquitetura, serviços, boundaries, sistema de workers, library). Sistemas de
referência já cacheiam parte disso (um audit de readiness por repo). Estendemos:
cacheamos o setup operacional inteiro, não só o score.

## 3. As 3 camadas de regra — precedência por DOMÍNIO [travado]

Divide por assunto, não precedência linear:

| Domínio | Governa |
|---|---|
| Código, estilo, dev flow, DoD | AGENTS.md do repo + `.agents/rules/` + `docs/adr/` — **lido, nunca reescrito** |
| Operacional (boundaries, portas, tools/skills, cadência) | `profile/harness.md` |
| Testing/validation guidance | `profile/harness.md §Testing` — autoritativo pros validators |
| Exceção desta feature / pré-existentes | `runs/<id>/feature.md` (override no run) |

### `harness.md` — o overlay operacional [travado]

A camada de sobreposição (regras operacionais por cima das convenções do repo) tem
valor, mas:
- não pode chamar `AGENTS.md` (colide com o do repo; o loader base do Pi pegaria);
- a parte **estável** vai pro profile (`profile/harness.md`), a **efêmera** pro `feature.md`.

`harness.md` **defere** ao AGENTS.md do repo pra convenção de código, e é
**autoritativo** pra operacional/testing. Enforcement:
1. **Startup do worker**: lê os 3 (AGENTS.md do repo + harness.md + feature.md) em paralelo.
2. **Validators**: `harness.md §Testing` = precedência máxima; `contract.md` = o-que-testar.
3. **Scrutiny → loop de aprendizado**: sugestões de guidance miram `harness.md`
   (NUNCA o AGENTS.md do repo). O overlay acumula regra operacional aprendida entre
   features — ponte pro "promovível → rules" / cognition-lessons.

## 4. Artefatos por feature [travado] — fila de N features MORRE

A fila de N features + milestones existe pra coordenar muitas features sequenciais. Em
escopo feature é sub-estrutura inútil. Mapeamento referência → nosso:

| Conceito de referência (per-execução) | Nosso (per-feature) |
|---|---|
| documento de proposta/intent | `feature.md` (intenção + escopo) |
| discovery (prosa/mental) | decisões gray-area (gray-area-policy) |
| contrato de validação + estado | `contract.md` **FROZEN** + status — **MANTÉM (a joia)** |
| fila de N features + milestones | **SAI** → `plan.json` (tasks da feature, = features.json) |
| feature→assertion | task→assertion |
| milestones (cadência) | **colapsa**: 1 feature = 1 ship gate |

```
runs/<feature-id>/
├── feature.md      # intenção + escopo + (decisões gray-area? ver §aberto)
├── contract.md     # acceptance assertions FROZEN = "done" (black-box, testável)
├── plan.json       # tasks ordenadas (estruturado, = features.json), cada task → assertion
├── state.json · progress_log.jsonl
└── handoffs/ · validation/ · evidence/
```

## 5. Setup skill = recorte de spec, postura brownfield [travado]

O gerador do profile **já existe** como spec de autoria de artefatos. Não se escreve do
zero — recorta, **poda o escopo de execução macro**, **repointa** pro `profile/`:

| Seção de autoria | Gera |
|---|---|
| autoria do overlay (Boundaries/Directives/Testing + exemplos) | `harness.md` |
| autoria de services / architecture / init / library | idem no profile |
| design do sistema de workers | `skills/<worker-type>/` |
| arquitetura, infra/boundaries, validation plan, readiness+concurrency | preenche services.yaml + harness.md §Testing + library/user-testing.md |
| "encode findings" | diz qual finding vai pra qual arquivo |

**Poda:** entender o escopo da feature (→ vira convergência per-feature), milestones
(morre), proposta/intent (→ `feature.md`), contrato authoring + fila de features.

**Adiciona (inversão brownfield):** specs de referência assumem quase-greenfield
("design do zero"). Nós **extraímos + sintetizamos do que o repo já declara**
(AGENTS.md, `.agents/rules/`, scripts, portas) antes de derivar. Critérios de readiness
(`agents_md`, `single_command_setup`, `env_template`, comandos test/lint/typecheck) são
o **mapa de onde olhar**.

## 6. Gate de setup + fingerprint/refresh [travado]

Camada determinística fina (código, não LLM):

```
ensureProfile(repo, opts):
  p = read(.harness/profile/profile.json)
  if !p              → SETUP(fresh)     # análise do zero, paga 1x
  elif opts.refresh  → SETUP(refresh)   # re-deriva + reconcilia
  else:
     if drift(fingerprint(repo), p.fingerprint) > threshold: WARN + oferece refresh  # advisory
     # segue com o profile existente   ← o SKIP da feature 2
```

`profile.json`: `{ version, generatedAt, sourceCommit, fingerprint:{lockfiles, rules,
toolcfg, commitsSince} }`. Fingerprint = hash determinístico de lockfiles +
`.agents/rules/`+AGENTS.md+`docs/adr/` + configs de tooling.

**Refresh NÃO clobbera:** `library/` append/merge; `services.yaml` merge aditivo (diffa
remoções pra aprovação); `architecture.md`/`harness.md` propõe diff em regiões
geradas-por-máquina, humano aprova; bump `version`/`sourceCommit`. Estável e diffável.

---

## Pontos abertos

1. **Decisões gray-area: arquivo separado (`context.md`) ou seção em `feature.md`?**
   (auditoria isolada vs menos arquivos)
2. **Status das assertions: inline no `contract.md` (checkbox) ou `validation-state.json`
   minúsculo** que o runner/validators escrevem? (contract deve ficar FROZEN — misturar
   status mutável é smell; tender pro json pequeno separado.)
3. **Monorepo:** 1 profile na raiz por enquanto; `profile/<app>/` depois se precisar.
   `// ponytail: deferido`.

## Roadmap (fatias verticais)

```
[x] Fatia 0: scaffolding do repo (README, docs, .gitignore, estrutura)
[~] Fatia 0.5: extensão (chrome do modo: comando /harness + badge aboveEditor + input recolorido + status) — shell pronto, dispatch stub (ver docs/01)
[~] Fatia 0.6: readiness gate UX — modelo puro (scoring, stances) + painel stance-banner real (ver docs/02)
[~] Fatia 1: readiness setup (PORT 1:1 do referência: catálogo 82 + auditor verbatim + store_agent_readiness_report + flows /readiness-report e /readiness-fix) + **profile setup** (skills/harness-setup): agora uma autoria fiel (não-rasa) das fases de planejamento + design de workers + autoria de artefatos, brownfield-first — com delegação, loop iterativo, **verify-by-execution** (profile readiness check), resource classification, worker-skills c/ Example Handoff, encode-findings. Gera architecture.md + services.yaml + init.sh + harness.md + skills/<worker>/ + library/. **store_profile** (src/profile-store-tool.ts) acopla profile.json ao conteúdo autorado (bug do baseline prematuro corrigido: ensureProfile virou gate READ-ONLY absent/ok/drift; o stamp só ocorre via tool, depois do conteúdo existir). FEITO: refresh reconciler (src/reconcile.ts) — plano de refresh por drift (parte→artefatos+estratégia), clobber guard (listProfileContent/detectClobber), buildRefreshDispatch (merge não-clobber) + storeProfile preserva a proveniência (firstGeneratedAt, refreshCount). Smoke ao vivo no TUI validado. **Relatório navegável FEITO:** `renderReadinessReport` (puro, testado — medidor de nível + contagem + seções por categoria mais-fraca-primeiro, cada critério ✓/✗/◐/⊘ + nível + ratio app-scope + motivo do skip + rationale) + painel `showReadinessReport` (overlay navegável) fiado na ação "View full report" do gate.
[x] Fatia 2: gate de setup determinístico — profile.json + fingerprint de conteúdo (lockfiles/rules/toolcfg) + ensureProfile (absent/ok/drift/**refresh**) + drift ligado ao stance `stale` do readiness (src/fingerprint.ts, src/profile.ts). Reconciler de merge FEITO (src/reconcile.ts + storeProfile não-clobber); fiado no /harness setup (profile existente → refresh, ausente → fresh).
[~] Fatia 3: Tier 2 — converge (gray-area-policy) → contract → plan. FEITO: a fase GERA está fiada. `/harness "<feature>"` passo 3 dispara `buildConvergeDispatch` (nativo, Plan via todo) → a skill `feature-converge` autora feature.md + contract.md (frozen), decompõe em tasks e chama **`store_plan`** (src/plan-store-tool.ts), que valida a INVARIANTE DE COBERTURA (cada assertion reivindicada por 1 task) e grava plan.json + status.json (src/plan.ts). Ponte converge→runner: `buildFeatureRun(cwd, featureId)` lê plan.json → planFeatureRun (9 testes). EXECUÇÃO FIADA no padrão nativo TUI: `/harness run` → `buildRunDispatch` (src/run-dispatch.ts) — o modelo, como harness-orchestrator, lê plan.json, cria o **Plan via `todo`** (um por task + 2 ship-gate), spawna um worker por task via **`subagent`** (worker-base → skill → EndFeatureRun), reage aos handoffs, e roda o ship gate (code-review → qa-validator), com **`advisor`** (escalação de verificação) e **`ask_user_question`** (blockers). Adaptativo nos utilitários ativos (DispatchTools). O FeatureRunner code-initiated continua como alternativa headless (bloqueante no TUI). **gray-area-policy explícito FEITO** (feature-converge): dimensions sweep (rubrica de requisitos implícitos) + `N/A because` escape obrigatório + surface scan; risk-tier LOW (PUSH + `[assumido]` silencioso por evidência) / HIGH (`ask_user_question` → `[confirmado]`, com "you decide" → discretion); scope guardrail HOW-not-WHETHER + Deferred Ideas; closure gate (zero gray-area sem marca); persistência auditável (tabela tagueada em feature.md). Funde a detecção sistemática do spec-driven com o nosso risk-tiering. **Elo headless FEITO:** `/harness "<feature>" --headless` → `runHeadlessFeature` (src/headless.ts: converge code-initiated com gray-areas `[assumido]` → FeatureRunner; ConvergeFn/SpawnFn injetáveis, 6 testes). **Smoke e2e do ship gate validado** (pi --print real, ver Fatia 5).
[x] Fatia 4: runner determinístico (ReadinessRunner) — loop sequencial code-initiated, spawn de `pi --print` por passo, state.json/jsonl, attempt budget 5, pause/resume, orphan cleanup; validado com auditoria real (ver docs/02)
[~] Fatia 5: ship gate (2 steps) — **code-review** + **qa-validator**.
  - **code-review** (skills/code-review) = review HOLÍSTICO no fim da feature (3 eixos), NÃO per-task: step 0 = gate determinístico (services.yaml test/typecheck/lint, 1x, pega quebra A+B); depois 3 axes em paralelo sobre o diff acumulado — agents/correctness-review + quality-review (genéricos) + conventions-review (lê o **conventions-map** cacheado). Sem per-task LLM (custo: 3 reviewers 1x).
  - **conventions-map** (Tier-1): nova fase do harness-setup (Phase 9) faz o mapeamento profundo de ADRs/rules/patterns → library/conventions-map.md; refresh no drift (fingerprint `rules`). O conventions-review consome (rápido + profundo).
  - **qa-validator** (skills/qa-validator) + agents/qa-flow-validator — verificação na superfície real.
  - CÓDIGO DO RUNNER FEITO (#6b, espelha readiness-runner/spawn, 23 testes): src/feature-runner.ts (engine: planFeatureRun + runLoop + injeção do ship gate code-review→qa-validator 1x + failure→orchestrator_turn + budget 5 + pause/resume + orphan + insertFixTask), src/worker-bootstrap.ts (o `Man`), src/handoff.ts (recordHandoff/handoffOutcome), src/endfeaturerun-tool.ts (tool EndFeatureRun), src/feature-spawn.ts (makeRealSpawn de `pi --print`).
  - **Phase 9 conventions-map FEITO + validado num run real:** `buildConventionsMapDispatch` (dispatch focado da Phase 9, reusável no refresh de `rules`) + `pi --print` produziu um `conventions-map.md` real indexando ADRs (status/file:line)/rules/house-patterns + split gate-vs-review. Fingerprint de `rules` agora cobre ADRs/decisões fora de `docs/adr` (docs/decisions, adr/, …) — não supõe o local.
  - **Elo converge→runner headless FEITO** (src/headless.ts + makeRealConvergeFn): converge (pi --print, gray-areas `[assumido]`) → runner, bloqueante, fiado em `/harness "<feature>" --headless`.
  - **Smoke e2e do ship gate VALIDADO** (pi --print real): runLoop injetou o gate → spawnou `code-review` → gate programático rodou (npm test/typecheck/lint, exit 0) + 3 eixos consumindo o **conventions-map** cacheado → `synthesis.json` `status:"pass"` → `EndFeatureRun` (success, returnToOrchestrator) → runner processou (orchestrator_turn, por design). qa-validator usa o mesmo mecanismo de spawn (path coberto).

[note] Cérebro do orchestrator: skills/harness-orchestrator, skills/feature-converge (contract authoring), skills/worker-base.
```

Cada fatia prova-se sozinha. Não automatiza loop sobre peça não-provada.
