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
| fila de N features + milestones | **SAI** → `plan.md` (tasks da feature) |
| feature→assertion | task→assertion |
| milestones (cadência) | **colapsa**: 1 feature = 1 ship gate |

```
runs/<feature-id>/
├── feature.md      # intenção + escopo + (decisões gray-area? ver §aberto)
├── contract.md     # acceptance assertions FROZEN = "done" (black-box, testável)
├── plan.md         # tasks ordenadas (thin/fat), cada task → assertion
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
[ ] Fatia 0: scaffolding do repo (README, docs, .gitignore, estrutura)   ← em andamento
[ ] Fatia 1: setup skill + harness.md template + profile-template
[ ] Fatia 2: gate de setup + profile.json/fingerprint + refresh reconciler (o código novo fino)
[ ] Fatia 3: Tier 2 — converge (gray-area-policy) → contract → plan
[ ] Fatia 4: runner determinístico + state machine + handoff
[ ] Fatia 5: ship gate (thermos + qa-validator) — reuso direto
```

Cada fatia prova-se sozinha. Não automatiza loop sobre peça não-provada.
