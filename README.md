# pi-harness

Um harness **spec-driven, feature-scoped** para o [Pi](https://pi.dev). Converte um
pedido num **contrato de aceite congelado** (com convergência opinada por risco),
implementa e verifica — **uma feature por vez, sequencial**, reusando um **perfil
de repo cacheado** entre features.

Sucessor do harness anterior. Compõe o ecossistema Pi maduro + um runner
determinístico fino.

---

## A tese

> Harness = a camada em volta do modelo: quem manda tarefa, confere, decide gasto,
> decide o que fazer quando dá errado. Comparar dois agentes = comparar dois harness.

Duas correções centrais:

1. **Harness de missão tendem ao macro/projeto** (dias, milestones, fila de N
   features) e **regeneram tudo do zero** a cada execução. Nós rescopiamos pra
   **feature** e **cacheamos o setup**.
2. **Discovery genérico é fraco** (ASK solto, sem tiering, sem rótulo, persiste em
   prosa). Trocamos pela **gray-area-policy** (PUSH + ASK risk-tiered +
   `[assumido]`/`[confirmado]` + persistência auditável) — a peça original.

---

## A arquitetura — dois tiers

```
TIER 1 — REPO PROFILE   (gera 1x, refresh sob demanda, COMMITADO)   .harness/profile/
   architecture.md · services.yaml · init.sh · skills/<worker>/ · library/
   harness.md          ← OVERLAY operacional (defere ao AGENTS.md do repo p/ código)
   profile.json        ← fingerprint, sourceCommit, generatedAt, version
        │  (input read-only de TODA feature)
        ▼
TIER 2 — FEATURE RUN    (por feature, SEQUENCIAL, GITIGNORED)        .harness/runs/<id>/
   feature.md (intent + decisões gray-area) · contract.md (FROZEN) · plan.md (tasks)
   state.json · progress_log.jsonl · handoffs/ · validation/ · evidence/
        │  archive → merge conhecimento novo no profile/library/  (Tier 1 acumula)
        ▼
   próxima feature na fila incremental (reusa o mesmo Tier 1)
```

### As 3 camadas de regra (precedência por DOMÍNIO)

| Domínio | Quem governa |
|---|---|
| Código, estilo, dev flow, DoD | **AGENTS.md do repo** + `.agents/rules/` + `docs/adr/` (lido, nunca reescrito) |
| Operacional: boundaries, portas, tools/skills, cadência | **`profile/harness.md`** (overlay; defere ao repo p/ código) |
| Testing/validation guidance | **`profile/harness.md §Testing`** — autoritativo pros validators |
| Exceção desta feature / pré-existentes | **`runs/<id>/feature.md`** (override no run) |

---

## O ciclo de uma feature

```
1. ensureProfile()    # existe? skip. drift de fingerprint / --refresh? re-deriva (merge, não clobber)
2. CONVERGE           # gray-area-policy: intent → contract FROZEN; lê o profile como EVIDÊNCIA
3. DECOMPOSE → plan.md  # tasks ordenadas (thin/fat), cada task → assertion
4. RUN                # runner determinístico fino, worker sequencial, verified gate
5. SHIP GATE          # thermos (3 eixos) + qa-validator (se user-facing) vs contract
6. ARCHIVE            # decisões/conhecimento → profile/library/ (acumula)
```

**Sinergia:** quanto mais features rodam, mais o profile vira evidência → mais
gray-areas resolvem como LOW (silenciosas) → **menos ASK**. O harness aprende o repo.

---

## Composição (reuso vs porte vs original)

| Camada | Origem |
|---|---|
| Convergência + contrato + teste thin/fat | reuso do harness anterior (gray-area-policy, generate-tests) |
| Ship gate (thermos 3 eixos, qa-validator, driveability, fix-agent) | reuso do harness anterior |
| Runner determinístico + state machine + handoff + persistência | porte de especificação de referência |
| Setup skill (gera o profile) | recorte das seções de autoria de artefatos, postura brownfield |
| Gray-area-policy risk-tiered + dois tiers + profile cacheado | **original** |

---

## Estado

Em construção. Ver `docs/00-design.md` para o design travado e o roadmap.
