# 06 — Model routing por role + telemetria de custo

Fecha os gaps apontados pela research `2026-07-13_22-12-20_harness-fusion-methodology.md`
(a aplicabilidade da metodologia Fusion — "Making Fable Cheaper Than Opus"): (1) guidance de
QUAL modelo em QUAL role, (2) telemetria de custo por resultado aceito, (3) brief autocontido.
Postura: **recomendação orientada por dados locais, nunca coerção** — o artigo é evidência de
vendor; nossos session files são a evidência que vale.

---

## 1. A tese (por que roteamos por role)

O custo de um sistema agêntico é dominado por **turnos × contexto arrastado × o que o líder
decide NÃO fazer** — não pelo preço-por-token do modelo. O pi-harness já codifica os "hábitos de
bom gerente" como invariantes estruturais (orchestrator sem canal de implementação, contract
FROZEN, fix = re-delegação, review por diff), então o roteamento de modelo é o último dial:

| Role | O que faz | Recomendação | Por quê |
|---|---|---|---|
| **orchestrator** (sessão viva + converge headless) | julgamento: requisitos, contrato, decomposição, gray-areas | **frontier**, effort moderado | é onde 1 erro de julgamento custa a feature inteira; o volume de tokens é baixo (delega) |
| **worker** (task steps) | implementação dirigida por brief | **tier barato/médio** | com contrato + assertions inlinadas no spec, o trabalho é execução de spec — o run real do afresp entregou com `gpt-5.6-luna` nos workers |
| **validator** (ship gate: code-review, qa, deliver) | verificação independente | **frontier ou médio+** — medir | no afresp os validators custaram MAIS que os workers ($14.28 vs $12.69); é o candidato nº 1 a otimização orientada por dados |

Config: `/harness models` (global, `~/.pi/agent/pi-harness/models.json`; src/model-config.ts).
`undefined` = herda o modelo da sessão.

## 2. Telemetria post-hoc (src/usage.ts) — a unidade é custo por feature ACEITA

**Nenhuma captura no RPC**: os session files que os workers já gravam
(`.harness/runs/<id>/sessions/<ts>_<wsid>.jsonl`) persistem por mensagem assistant
`usage.{input,output,cacheRead,cacheWrite}` + `cost.total` ($, calculado pelo pi) + `model`.
O join é determinístico: `feature-run.json.steps[].workerSessionIds` → session file.

`featureUsage(cwd, featureId)` agrega por step → role → total; `usageReportLines` renderiza; o
run report do `run_feature` inclui a seção automaticamente. Exemplo real (afresp,
implement-fullfacial-recognition-indexin):

```
implement-1 [worker] turns=328 out=101k cacheRead=60.7M cost=$9.84 · gpt-5.6-luna
…
ship-gate-qa-validator [validator] turns=61 out=89k cost=$7.47 · claude-opus-4-8
worker total: $12.69 · validator total: $14.28 · TOTAL: $26.97
```

**Limitações conhecidas (confounds da research §7) e mitigações:**
1. **o orchestrator VIVO usa o modelo da sessão** (não congelado pelo config — o role
   `orchestrator` só governa o converge headless). Mitigado em duas frentes:
   - **nudge**: ao disparar converge/run no TUI, a extensão compara `ctx.model` com o role
     configurado (`orchestratorModelNudge`, src/model-config.ts) e avisa no chat quando divergem;
   - **telemetria**: o `run_feature` passa o session file da própria sessão
     (`ctx.sessionManager.getSessionFile()`) e o report inclui a linha
     `orchestrator [live chat, session-cumulative]` — rotulada como cumulativa (converge +
     análise + conversa; não é janelável ao run porque o run bloqueia o turno) e fora do
     `TOTAL (children)`.
2. subagents nested (@tintinweb `.output`) ficam fora do agregado;
3. code-review/qa/deliver compartilham o role `validator` (sem split por gate no config);
4. gate workers fazem fixes não-comportamentais (política de skill, não sandbox).

O **auto-switch** do modelo da sessão (a extensão chamar `setModel` ao entrar no fluxo /harness)
foi considerado e adiado: mexe num domínio do usuário; só entra com opt-in explícito se o nudge
se provar insuficiente.

Um experimento limpo hoje: **variar só o worker model**, líder/validators/gates constantes.

## 3. O que os dados já mostram (primeiros datapoints)

- **Validators > workers em custo** no primeiro run medido — a intuição "implementação domina"
  estava errada; sizing/modelo do ship gate é a alavanca mais promissora.
- `implement-1` com 328 turns / 60.7M cacheRead é o perfil de compaction que o doc 05 previu —
  o budget de batch (~7) agora é calibrável contra números, não precedente do tlc.
- Cache read domina o volume (>90% dos tokens) — mudanças que quebram cache (system prompt por
  batch, por exemplo) têm custo real mensurável.

## 4. Brief autocontido (o corolário do routing)

Workers baratos só mantêm qualidade se o brief carregar as decisões. Dois mecanismos:
- **`next_task` resolve `fulfills` → texto das assertions** (src/contract.ts, parser
  determinístico do contract.md FROZEN — sem paráfrase de LLM, sem bloat no plan.json): o spec
  entregue ao worker inclui `contractAssertions: [{id, text}]`.
- **Constraints duras não capturadas em assertions** vão inlinadas no `expectedBehavior` da task
  (harness-feature-converge Phase 5) — constraint por referência é constraint esquecida.

## 5. Decisões fechadas (gray areas da research → resolvidas)

| Questão | Decisão |
|---|---|
| OQ2 — usage no RPC? | Resolvido: post-hoc dos session files; custo já calculado pelo pi |
| OQ1 — formato do brief? | Parser TS no `next_task` (contract FROZEN → estável); constraints extras no `expectedBehavior` |
| OQ3 — budget 7 ótimo? | Manter 7; calibrar com telemetria observacional (dados já fluem) |
| OQ4 — modelo p/ nested agents? | Não agora; confound documentado (§2) |
| OQ5 — corpus de experimento? | Adiar; cada feature real é datapoint (observacional primeiro) |
| Fast lane p/ features pequenas? | **NÃO** (decisão do dev): invariantes (contrato/cobertura/gates) preservadas sempre |
| Debugging serial | `cohesion` obrigatória em chains de diagnóstico (converge Phase 5) |
