# 03 — TUI (Feature Control)

A camada **visual** do harness: como o usuário *vê e toca* um feature run. Estudamos
a DX do **Droid `/missions`** (Mission Control) como referência — não pra clonar, mas
pra **portar as leis de DX** e rebrandear pro nosso domínio. Decisões **[travado]**;
abertas em §Pontos abertos.

> Referência (read-only, externa): `~/workspaces/droid-missions-reverse-engineered/docs/ui/`
> (cap. 04 deep-dive, 06 mockups de missions — traced do JSX real). Lê os mockups
> `[traced: …@offset]` antes de mexer em layout.

---

## 1. Tese: portar princípios, não chrome [travado]

O motivo de olharmos o Droid é a **DX impecável** — mas DX impecável ≠ aquele chrome
específico. O chrome dele codifica um modelo **macro/projeto** que a nossa tese rejeita
(ver `00-design §1`). Então: **rebrand orientado a princípios**, não 1:1.

**Por que NÃO 1:1** (riscos concretos):
- Importa conceitos que rejeitamos (Mission, milestones, fila de N, "Begin/Exit current mission", concurrency guard).
- Mostra dados que não temos (Credits, USAGE %, Factory Standard Credits, saúde do factoryd).
- O segmento `[+estimated]` da barra não faz sentido: nosso `plan.json` é **frozen** com **coverage invariant** — total exato é conhecido.
- Duplica o que o Pi já dá nativo (stream de subagents, `todo` Plan, badge de modo).
- Manutenção (perseguir JSX deles) + marca (clonar strings/wordmark).

### Mapa keep / rebrand / drop [travado]

| Lei de DX (PORTA) | Vira nosso |
|---|---|
| 1 frame consistente (`In`/`KcT`) | primitiva de frame única — título-dentro, tabs inline, help-abaixo |
| 1 sinal de progresso no topo, sem números espalhados | barra mapeada ao **nosso "done": assertions passed/total** |
| Densidade 2-painéis (estado · log) | Tasks/coverage (esq) · Progress Log (dir) |
| Nav teclado-first (↑↓/Enter/Tab/Esc/T) | idêntico |
| Drilldown até a unidade + handoff estruturado | Task → `EndFeatureRun` handoff (já é nosso) |
| Status = cor+ícone, não prosa | idêntico |

| DROP / REBRAND | Decisão |
|---|---|
| `Mission Control` | → **Feature Control** |
| `Missions picker` | → **Runs** |
| Credits, USAGE, factoryd, Milestones, `[+estimated]` | **drop** |
| Pause/Resume "mission" | rebrand → pause/resume do **run** (existe no runner) |

### Onde superamos a deles [travado]

A UI deve brilhar no que o Droid **não tem como mostrar** (nosso diferencial):
- **Coverage view** — assertions ↔ tasks 1:1 (a invariante de `plan.json`).
- **Gray-area decisions** — `[assumido]`/`[confirmado]`, auditável (de `feature.md`).
- **Ship gate** — code-review (3 eixos) + qa-validator, status **por assertion** (`status.json`).
- **Lessons** + **profile freshness/drift** (dois tiers).

E **complementa** o stream nativo de subagents do Pi — não reimplementa transcript de
worker / "stop worker" / "send message" (isso depende do daemon do Droid). Pros logs
ao vivo, aponta pro subagent nativo.

---

## 2. Superfície: híbrido (status + transcript card + overlay full-screen) [revisado 2026-06]

> **Revisão.** A v1 deste doc portava só os *princípios* e renderizava o Feature Control
> como uma **frame `round` inline** (control-frame) + um **`setStatus` de 1 linha** — o que,
> na prática, parecia uma "extensão de chat", não um TUI. **Decisão revista:** recriamos
> fielmente os caps. **08** (Mission Control full-screen) e **09** (in-chat runtime UX) dos
> docs de referência. O glossário/rebrand (§7), os dados (§3) e o diferencial Coverage
> continuam; o que muda é o **chrome do overlay** (agora hand-drawn full-screen) e o
> **sinal in-chat** (agora um cartão auto-atualizável no transcript). A frame `round`
> compartilhada **continua** nos *pickers* (Runs, proposal) — fiel ao missions-picker do
> Droid, que também é um picker `round`.

No host do Pi a superfície tem **três** canais:

1. **Sinal compacto sempre-visível** (não-modal): `ctx.ui.setStatus` — o modo
   (`◆ converge`/`◆ run`) + resumo (`██▒▒ 6/12 · T2`). A statusline compõe (pi-fusiontui
   lê `getExtensionStatuses()`; o core também). Atualiza ao vivo via watcher.
2. **Run card no transcript (cap. 09)** — ao iniciar um run, um **cartão custom** é inserido
   no transcript (`registerMessageRenderer` + `sendMessage`, customType `harness-run`) e se
   **auto-atualiza** (Preparing → live State/Progress/Current Task/Worker/Tasks → Done). O
   render lê um *live store* (`run-store.ts`) a cada ciclo do TUI; o watcher atualiza o store
   + dispara render. É o análogo do tool-card `start_mission_run` do Droid — fica no chat, a
   composição segue *steerable*, e `alt+t` é o atalho "abrir o cockpit".
3. **Overlay denso full-screen sob demanda** (`Alt+T` / `/harness control`): o dashboard
   completo **hand-drawn** que cobre a tela inteira (cap. 08) — cantos quadrados `┌┐└┘`,
   header band, barra, 2 colunas com divisor `┬…┴`, **banda Active Worker**, footer bar,
   sub-views (Tasks/Workers/Coverage) e drilldowns. `ctx.ui.custom(factory, {overlay:true,

   > **Banda Active Worker (cap. 08a, 1:1).** NÃO é uma linha — é um **mini-transcript ao vivo**
   > do único worker running/paused (o `KG0`), ocupando ~35% do corpo (mín 4 linhas, escondida
   > em telas minúsculas; geometria `mainLayout` = `ET`/`BT`/`oT`). Título `Active Worker  #N  <id>
   > … Duration <d>` + linha em branco + entries (mensagem/tool, 2 linhas cada, `floor(sA/2)` no
   > tail), flanqueadas só por colunas `│` (sem caixa). **Fonte do transcript:** o caminho NATIVO lê
   > a transcript REAL — no worker **headless** a sessão `--session-id` (`runs/<id>/sessions/*.jsonl`,
   > via `parseSessionEntries` pi 0.80.3, `src/session-read.ts`); no subagent **in-session**
   > (@tintinweb) o `.output` JSONL que ele streama (`…/{sessionId}/tasks/{agentId}.output`,
   > `readAgentOutputEntries`, localizado por `agentId` + a sessão-pai) — ambos read-only/cacheados e
   > foldados pelo `foldTranscript` (= o `g2H`). **Fallback** (1º frame, antes do ficheiro existir) = o
   > buffer rolante de `recentActivity` (a string `activity` do @tintinweb acumulada por `mergeActivity`).
   > O `entriesFromSessionEntries` ignora entries não-message (compaction/branch/model_change/custom).
   > O evento nativo `session_tree` (+ o watcher de fs) re-tica o cockpit ao vivo.
   overlayOptions:{width:"100%",maxHeight:"100%",anchor:"top-left",margin:0}})`; o render lê
   `tui.terminal.rows/columns` e emite EXATAMENTE `rows` linhas opacas.

> **Compatibilidade [travado].** O pi-harness **NUNCA** chama `setEditorComponent` nem usa
> widgets `aboveEditor`/`belowEditor` pro chrome de modo/progresso: extensões de UI como o
> **pi-fusiontui** são donas do **editor** (Droid-style) e do **footer**, e clobberá-los quebra
> a UI delas. Os nossos canais são compatíveis: `setStatus` (statuslines compõem), o **run card**
> é uma mensagem no **transcript** (não um widget — não toca editor/footer), e o overlay `Alt+T`
> é modal (ctx.ui.custom `overlay:true`) e não conflita.

Entrada [travado]:
- `pi.registerCommand("harness control")` → abre o overlay (ou o Runs picker se não há run ativo).
- `pi.registerShortcut("alt+t", …)` → toggle do overlay quando o modo harness está ativo.
  - **Por que Alt+T (não Ctrl+T):** o Pi RESERVA `ctrl+t` (`app.thinking.toggle`, `restrictOverride`)
    e bloqueia extensões que o reivindiquem ("conflicts with built-in shortcut. Skipping."); os
    demais `ctrl+<letra>` são bindings do editor TUI (hijack global quebraria a edição). `alt+t`
    é livre, seguro no terminal e mantém o mnemônico “T”. O comando `/harness control` é o fallback.

API confirmada: `ctx.ui.custom<T>()` (render/`handleInput`/`invalidate`) + `ctx.ui.requestRender()`
(live) + `ctx.ui.setWidget(key, lines, {placement:"aboveEditor"})` (faixa) +
`pi.registerShortcut(keyId,{handler})` (Alt+T). Padrão de view: **render puro testável
+ view fina** (igual `readiness-report-view.ts`).

---

## 3. Fontes de dados [travado]

Tudo em disco, sob `.harness/runs/<featureId>/` (lido, nunca escrito pela TUI):

| Ficheiro | Schema (src) | Alimenta |
|---|---|---|
| `plan.json` | `Plan {tasks[], assertions[], createdAt}` (`plan.ts`) | Tasks list, coverage, total da barra |
| `status.json` | `PlanStatus {assertions: Record<id, pending\|passed\|failed>}` | barra (passed/total), coverage, ship-gate |
| `feature-run.json` | `FeatureRun {status, steps[], gateInjected}` (`feature-runner.ts`) | estado do run, task ativa, Workers |
| `progress_log.jsonl` | `{ts, event, ...}` (`handoff.ts`) | Progress Log |
| `handoffs/<taskId>__<wsid>.json` | `PersistedHandoff` (`handoff.ts`) | Workers, Handoff viewer |
| `feature.md` / `contract.md` | markdown | Task detail, gray-areas, contrato |

O **picker (Runs)** enumera os diretórios de `.harness/runs/*`.

### Live [travado]
Watcher por run (`fs.watch` no dir do run + debounce ~150ms; fallback poll ~1s).
Em mudança: relê o view-model e chama `requestRender()` (overlay) / `setWidget()` (faixa).
Indicador `● Live` quando o watcher está ativo.

---

## 4. Primitiva de frame (`In`/`KcT` analog) [travado]

Toda lista/overlay passa por ela (consistência = a lei de DX nº1):
- caixa `borderStyle:"round"`, accent do tema, `paddingX:1`, `minWidth:78`
- **título = 1ª linha bold DENTRO da caixa** (não caption na borda)
- **tab-row inline opcional**: `Ativo │ Outro │ Outro` — ativo em **bold/accent, sem `[ ]`**
- **description** muted + **search** opcionais
- **help/paginação ABAIXO da caixa** (fora), `space-between`, range (`1-4 of 4`) à direita

Sub-views (Tasks/Workers) renderizam **dentro** da frame do Feature Control — **sem
borda própria** — substituindo só a área de conteúdo.

---

## 5. Barra de progresso [travado]

Reconstruída do render do Droid, mapeada pro nosso "done":

```
 ●  Running  ████████████▒▒▒▒▒░░░░░░  3/8
 └icon└state └─█ passed └▒ pending └(sem ░ estimado)  count
```

- **Métrica**: `passed / total` de **assertions** (`status.json`) — a definição
  contratual de "done". (Tasks completas dão os **ícones** da lista, não o número grande.)
- 2 segmentos: `█` = assertions `passed` (accent/verde; amarelo se run `paused`);
  `▒` = restantes conhecidas (`pending`+`failed`, com `failed` marcável em vermelho).
- **Sem segmento `░` estimado** (plano frozen) e **sem `%` numérico** — a proporção
  preenchida É o progresso.
- Largura auto-ajusta: `max(10, width − labels)`.
- Ícone de estado: `●` running · `⏸` paused · `✓` completed · `◑` orchestrator_turn · spinner.

---

## 6. Telas

### 6.1 Runs picker — `Runs`
Frame compartilhada. Linha especial no topo (`+ New feature` quando aplicável),
`●` marca o run atual, **selecionado = bold**, help abaixo com range à direita.
Colunas: `State · Updated · Progress(passed/total) · Feature`.

### 6.2 Feature Control — overlay FULL-SCREEN hand-drawn (`Alt+T`)  [cap. 08]
Tela inteira, desenhada glifo-a-glifo (cantos **quadrados** — assinatura do cap. 08), via as
primitivas `control-draw.ts` (`rule`/`fullRow`/`twoRow` ≈ `aAT`/`FST`/`ynu`). Cores mapeadas ao
tema (accent = laranja-análogo; **moldura = `muted`** = cinza neutro visível — `borderMuted`/
`darkGray` some no fundo escuro). Emite EXATAMENTE `rows` linhas opacas.
```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ⛬ Feature Control   ~/dev/acme                                                    ● Live    │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ ●  Running   ████████████▒▒▒▒▒░░░░░░  6/12 assertions                                       │
├─────────────────────────────────────────────┬────────────────────────────────────────────┤
│ Active Task                                 │ Progress Log   (6-10 of 10)                  │
│   [T2] add token-bucket middleware…         │  2m  Worker #1 completed [T1] ✓              │
│   skill worker · fulfills A3, A4            │  2m  Worker #2 started [T2]                  │
│                                             │  1m  plan stored: 3 tasks / 12 assertions    │
│ Tasks (1/3)                                 │                                              │
│  ✓ T1  bootstrap rate-limit module          │                                              │
│  ● T2  add token-bucket middleware  (inverse)│                                             │
│  ○ T3  wire routes + config                 │                                              │
├─────────────────────────────────────────────┴────────────────────────────────────────────┤
│ Active Worker  ·  #T2  ·  9f3a4b2c  ·  running  (live logs in the native subagent stream)  │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ F Tasks   W Workers   C Coverage   M Models   Tab Next   Alt+T Close                       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
Ícones de task: `✓` completed · `●` in progress · `○` pending · `✘` failed/cancelled. A linha da
task in-progress é **vídeo-invertido** (`theme.inverse`). Sub-views (Tasks/Workers/Coverage)
renderizam **dentro** da moldura (laterais `│ … │`, look "inset" do cap. 08 §6), embrulhando uma
SelectList. Pause/Resume seguem adiados (read-only) — ver §Pontos abertos.

### 6.2.1 Run card no transcript (`harness-run`)  [cap. 09]
Inserido ao iniciar um run; auto-atualiza no chat (não navega — `alt+t` é opt-in):
```
 ⛬ harness run · Run in progress…
   State: Running
   Progress: 6/12 assertions  ████████▒▒▒▒
   Current Task: T2
   Worker: 9f3a4b2c · #T2 · running
   Tasks: ✓T1 ●T2 ○T3
   alt+t to enter Feature Control
```

### 6.3 Sub-views (sem borda própria, dentro da frame)
- **Tasks (`F`)** — `Tasks (N)`, filtro inline `All │ Pending │ In Progress │ Completed │ Cancelled` (`T`). Colunas `Status · ID · fulfills · descrição`.
- **Workers (`W`)** — `Workers (N)`, filtro `All │ Active │ Completed │ Failed`. Colunas `# · Session · Status · Attempts · Feature` (sem Credits/Duration que não temos confiáveis). Origem: `feature-run.json` steps + `handoffs/`.
- **Coverage (`C`)** — *nosso diferencial*: cada assertion → task que a `fulfills` → status (`status.json`). Mostra a invariante 1:1.

### 6.4 Drilldowns
- **Task detail** (Enter numa task): description/preconditions/expectedBehavior/fulfills (de `plan.json` + `contract.md`), worker sessions da task.
- **Handoff viewer** (`h` num worker): renderiza `PersistedHandoff` — Summary / What Was Left Undone / Discovered Issues (+ Suggested fix) / verification / tests. (Já é o `EndFeatureRun`.)
- **Models (`M`)** — reusa `model-config-view.ts` (orchestrator/worker/validator, já existe).

---

## 7. Rebrand glossary [travado]

| Droid | pi-harness |
|---|---|
| Mission Control | Feature Control |
| Missions picker | Runs |
| Mission | Feature run |
| Features view | Tasks |
| Worker handoff | Handoff (EndFeatureRun) |
| Credits / USAGE | — (drop) |
| Milestones | — (drop) |
| factoryd health | runner status |

---

## 8. Plano de módulos & fatias  —  **IMPLEMENTADO**

| Fatia | O quê | Ficheiros | Teste |
|---|---|---|---|
| 0 | este doc | `docs/03-tui.md` | revisão |
| 1 | leitor de estado + view-model puro | `src/control-model.ts`, `src/runs.ts` | `test/control-model.test.ts`, `test/runs.test.ts` |
| 2 | frame `round` compartilhada (pickers) + Runs picker | `src/control-render.ts` (puro), `src/control-frame.ts`, `src/runs-view.ts` | `test/control-frame.test.ts` |
| 3 | sinal compacto (`setStatus`) + watcher | `src/control-strip.ts`, `src/control-watch.ts` | `stripParts` em `test/control-model.test.ts` |
| 4 | overlay Feature Control + sub-views + drilldowns | `src/control-rows.ts` (puro), `src/control-view.ts` | `test/control-rows.test.ts` |
| 6 | **[cap. 08]** primitivas hand-drawn full-screen + layout do overlay | `src/control-draw.ts` (puro), `src/control-screen.ts` (puro), `src/control-view.ts` (reescrito p/ overlay full-screen) | `test/control-draw.test.ts`, `test/control-screen.test.ts` |
| 7 | **[cap. 09]** run card auto-atualizável no transcript | `src/run-card.ts` (puro), `src/run-store.ts`, `src/run-card-view.ts` (registerMessageRenderer) | `test/run-card.test.ts` |
| 5 | wire-up `/harness control` + `registerShortcut("alt+t")` + envio do run card | `src/extension/index.ts` | smoke ao vivo |

**Estratégia de teste**: o TUI do Pi não roda headless — então **todo** render/view-model/nav
vive em módulos **pi-free, testados** (`control-model`, `control-render`, `control-rows`, `runs`);
as views (`*-view`/`*-frame`/`*-strip`) só fazem value-import de pi e exigem smoke ao vivo
(`/harness control`). Regra herdada do repo: módulo testado nunca faz value-import de pi.

### Smoke ao vivo (manual)
1. `/harness "<feature>"` → converge (gera `plan.json`) — o **sinal compacto** aparece na statusline.
2. `/harness run` → o **run card** (cap. 09) cai no transcript e tica ao vivo (Preparing → live → Done).
3. `Alt+T` (ou `/harness control`) → **overlay full-screen hand-drawn** (cap. 08), cobrindo a tela;
   `F/W/C` sub-views, `T` filtro, `Enter` drilldown, `h` handoff, `M` models, `Tab` cicla, `Esc`/`Alt+T` fecha.
4. Sem run ativo → abre o **Runs picker** (frame `round`) primeiro.
5. Conferir: cantos **quadrados** `┌┐└┘`, barra `█▒`, divisor `┬…┴` alinhado, linha ativa invertida, footer `KEY LABEL`.

---

## 9. Fluxo de gerar-feature (rebrand do mission-generation)

O Droid gera uma mission assim: *Begin new mission → onboarding card → readiness gate →
(orquestrador planeja) → **proposal confirmation** (`propose_mission`)*. Adaptamos o nosso
fluxo de **convergence** pra espelhar isso — sem o vocabulário macro:

```
/harness "<feature>"
   → onboarding card        (proposal-view.showFeatureOnboarding — Enter/Esc)
   → readiness gate         (já existia)
   → converge dispatch      (5-phase todo Plan → store_plan persiste)
   → PROPOSAL CONFIRMATION  (proposal-view.showPlanProposal, no agent_end)
        │ Proceed with the plan      → "run /harness run"
        │ Proceed with comment       → sendUserMessage(guidance) — aprovado
        │ Manually edit plan          → ctx.ui.editor(plan.json) + re-valida cobertura
        └ No, and explain why         → sendUserMessage(reason) → o modelo revisa e chama store_plan de novo
```

**Integração (sem UI dentro de tool):** o `store_plan` continua persistindo em silêncio
(tool puro/testável). O index.ts escuta `tool_execution_end` de `store_plan` → marca
`pendingProposal` → no `agent_end` (agente idle = seguro, igual a um command handler)
abre o overlay. A rejeição re-dispara a convergência via `sendUserMessage` — o loop
propose→aprovar→(revisar) do Droid.

**Rebrand da copy:** o card dropa "Milestones" e o aviso de *credit usage*; fala de
**Orchestrator/Workers/Contract** (o contrato congelado = "done"), feature-scoped & sequencial.
Módulo puro: `src/proposal.ts` (copy + `proposalSummaryLines` + mensagens reject/comment),
testado em `test/proposal.test.ts`. View: `src/proposal-view.ts`.

---

## 10. Resume & persistência (sobreviver a /reload)

O Droid faz missions **persistentes e resumíveis**: o estado vive no disco (`state.json`),
o runtime resume a partir dele, e o picker lista "Select a mission to resume" (docs
`02-runtime` §"persistence guarantees" + `04-missions-ui` §1). O nosso run **já** vivia no
disco (`.harness/runs/<id>/`), mas o **ponteiro de "feature ativa" era só memória** — um
`/reload` o perdia (`/harness run` → "no active feature").

Correção (dois mecanismos):

1. **Ponteiro persistido** (`src/mode-store.ts`): `saveMode` grava `.harness/runs/.session.json`
   `{active, featureId, phase}` em cada mudança de modo (converge/run/headless), `clearMode` no
   exit. No `session_start` (reason `reload`/`startup`) o `loadMode` restaura o ponteiro **se o
   `plan.json` ainda existe** (senão limpa o órfão) e re-publica o status. → reload fica seamless.
2. **`/harness run` resume via picker**: sem ponteiro ativo, lista os runs do disco e abre o
   **Runs picker** (o "resume an existing mission" do Droid); a escolha vira a feature ativa e
   roda. Headless → o run mais recente.

**Pausa / retorno (mapeamento):** o `FeatureRunner` (headless) já tem os estados `paused`
(abort/SIGINT ou budget de 5 esgotado) e `orchestrator_turn` (falha/`returnToOrchestrator`),
mais `cleanupOrphan()` (recupera worker órfão no start) — os análogos de `pause()`/
`cleanupOrphanedWorker` do Droid. No caminho **nativo**, parar = `Esc` (interrompe o agente) e
retomar = `/harness run` (re-resume do disco). Botões `P`/`R` no overlay ficam adiados até haver
controlo de run via ficheiro (ver §Pontos abertos).

---

## Pontos abertos (decididos)

- **Barra: assertions vs tasks** — **travado em assertions** (com fallback a tasks quando `total=0`). Sem toggle por ora.
- **Workers** — colunas **`# (task) · session · status`** (sem Duration/Credits, que não temos confiáveis). `Enter`/`h` abrem o handoff.
- **Pause/Resume (`P`/`R`)** — **adiado** (não exposto): pausar o runner nativo é não-trivial; o overlay é read-only por ora. Reabrir quando houver controlo de run via ficheiro.
- **Active Worker preview** — mini-linha do worker em running + Progress Log; logs ao vivo ficam no **stream nativo de subagents** (não duplicamos transcript).
- **Coverage view (`C`)** — adicionada como diferencial nosso (assertion → task → status).

## Revisão 2 — modelo de estado coerente + paridade com os docs 07/10 [implementado]

Resposta à screenshot incoerente (estado `Orch. Turn` + barra `0/11` + `4/6` tasks + "Waiting")
e ao deep-dive de dados (doc UI 10) + persistência (doc 07):

- **Status `returned` (`↩`)** — uma task que voltou ao orquestrador deixa de ser o falso `●`
  in_progress; `deriveTaskStatuses`/`handoffToTaskStatus` mapeiam returnToOrchestrator/partial →
  `returned`. Coerente com o painel Active Task.
- **Métrica da barra** — `stripParts` (e o run card) seguem **tasks** enquanto o ship gate não
  decidiu nenhuma assertion (`passed+failed=0`), depois passam a **assertions**. Acaba o "0/N
  assertions" enquanto tasks completam.
- **Active Task edge state-aware** — `orchestrator_turn` → "Awaiting orchestrator — N task(s)
  returned", `paused`/`ready`/`completed` etc. (em vez do genérico "Waiting to start").
- **Durable handshake (doc 07 §3)** — `task_started` (= `worker_started`) é escrito EM DISCO no
  início de cada subagent worker, antes de bloquear. Faz estado/in_progress/duração/#n/orphan
  derivarem do disco e sobreviverem a `/reload`/kill (orphan = `task_started` sem terminal).
- **Worker #n + duração** (doc 10 `mnR`) — derivados (não armazenados): #n por ordem de início,
  duração = `task_started`→handoff (ou now p/ o running). Visíveis na view Workers.
- **Worker Activity** (doc 10 `recentActivity`) — `live-agents` acumula a string `activity` do
  `AgentDetails` (@tintinweb) num buffer rolante (`mergeActivity`); o run card mostra o bloco "Worker Activity".
- **Header `Time <elapsed>`** — do `startedAt` (primeiro `run_started`).
- **Models: skip-scrutiny / skip-user-testing** (doc UI §8) — toggles no `model-config`; honrados
  pelo `injectShipGate` (headless) e pelo `buildRunDispatch` (nativo).
- **NÃO portável** (arquitetura): worker-transcript `loadSession`-resume (doc 07 §6) — os nossos
  workers são subagents efêmeros, não sessões Droid resumíveis; o resume é feature-level (o
  orquestrador re-despacha do disco), o análogo do "restart feature", não do "continue worker".

## Revisão 3 — barra de progresso 1:1 com o Droid (doc UI 11) [implementado]

A barra (`stripParts`/`progressBar` em `control-model.ts`) agora é **3 segmentos** e
**monotônica**, espelhando o `kDH`/`mkH`/`d$R` do Droid:

- **`█` completed · `▒` pending · `░` estimate** (era 2 segmentos). Unidades = **work items =
  tasks + ship gate** (o análogo EXATO de "features + validators auto-injetados": harness-code-
  review = scrutiny, harness-qa-validator = user-testing).
- **Denominador CONSTANTE** = `(tasks − cancelled) + gateSteps` (gateSteps = 2 − skips). O ship
  gate conta como `░` estimate até materializar (todas as tasks terminam), aí vira `▒` sem mudar
  o denominador → **sem salto**. Mata o colapso 100%→9% que a métrica anterior (tasks→assertions)
  causava no início do gate.
- **`[+N]`** = estimate (passos de ship gate ainda não materializados).
- **Apportioning Hamilton** (`apportion`) — soma exata = width, **mínimo 1 char por segmento
  não-zero** ("1 de 50" pinta um sliver visível).
- **Tempo do header = tempo ATIVO** (`activeElapsedMs`, doc 11 §5): Σ dos intervalos
  run_started/resumed → paused, **pausas excluídas** (era wall-clock).
- As **assertions** (o nosso contrato) saem da barra e viram uma **linha secundária** no run
  card + a **Coverage view** — "done" = todas passed coincide com a barra cheia (gate completo).
- `readControlModel` lê os skips do `model-config` p/ o `gateSteps`; ambas as superfícies
  (overlay + run card + Runs picker) usam os MESMOS `model.counts`.

## Revisão 4 — paridade 1:1 com o cap. 08b (layout + nav restaurados) [implementado]

Passe de fidelidade ao **08b (Mission Control: inner panels)**: portamos o *chrome* que faltava,
mantendo o rebrand (Feature/Task, sem Mission/Milestones/Credits) e os nossos diferenciais
(Coverage, Delivery). O que mudou em `control-*`:

- **Split de colunas do `main` restaurado ao Droid (§1).** ESQUERDA = **só o cartão Active Task**
  (skill · milestone? · Preconditions · Expected Behavior · Description); DIREITA = **lista de Tasks
  + divisor + Progress Log** empilhados. O divisor é o **`cnu`** (`control-draw.cnuRow`): a metade
  DIREITA vira régua `├──┤` numa linha (`rightDivider` no `drawMain`), a esquerda segue fluindo.
  (Antes: esquerda = Active Task + lista; direita = só log.)
- **Sub-views são INSET (§2).** `drawSub` agora aceita `chrome` (a banda de título + a barra de
  progresso do Feature Control PERSISTEM por cima de Tasks/Workers/Coverage/Delivery/detalhes) —
  o look "inset" do Droid, em vez de uma caixa autônoma por view.
- **Nav F/W/M + g/G (§3, §9).** Os footers de lista reganham `g Top`/`G Bottom` (via
  `setSelectedIndex`; `G` = `shift+g`) e os atalhos de salto `W`/`F`/`M` (além do nosso `Tab`).
- **Tabs de filtro com contagem (§3).** `All (8) │ Pending (3) │ …` (`taskTabLabels`/`workerTabLabels`).
- **Progress Log newest-first + colorido por segmento (§1b/§1d).** `progressSegments` (o `Enu`):
  id da task em `accent` (o "ref"), ícones por estado (✓ success · ✗ error · ↩ warning), verbo `muted`;
  janela invertida (mais recente no topo).
- **K2H (§1a/§4).** `parseNumbered` quebra `"(1) … (2) …"` em itens numerados no cartão e no
  Task detail; sem marcador, 1 item por linha.
- **Handoff: `[blocking]` em VERMELHO (§8)** e tags **`(current)`/`(completed)`** na última worker
  session do Task detail (§4).
- **Glifos 1:1:** cancelled/failed `✘`→`✗` (alinha com o `lnu`/`enu` do Droid e com delivery/readiness).
- **Fix latente:** `theme.fg("secondary", …)` (usável no build antigo, **lança** no pi 0.80.3 — não
  existe "secondary" no tema) → trocado por `text`/`muted` em todo o `control-view` (inclui a banda
  Active Worker, que crashava no render de mensagens).
- **NÃO mudou (segue §1 do thesis):** sem Mission/Milestones/Credits/factoryd, sem `session_viewer`
  com interrupt-and-chat (workers são subagents efêmeros), sem Pause/Resume (overlay read-only).
  O `milestone` no cartão é **condicional** — estrutura 1:1, mas ausente (tasks do pi não têm o campo).

## Revisão 5 — paridade final com o gap-scan do droid-missions [implementado]

Fecha os missings apontados na comparação pi-harness × droid-missions (além dos sons, que
vivem fora deste repo):

- **Session viewer completo (droid §7b "Worker Session")** — nova view `session` no overlay:
  `Enter` num worker (view Workers) abre o transcript da sessão (gravada em disco via
  `readNativeWorkerEntries`/`readWorkerSession`, ou o `.output` do live agent), com **densidade
  `[`/`]` (1–5, default 4)**, **scroll `↑↓`/j/k/g/G com follow-tail** (offset null = colado ao fim;
  chegar ao fim re-engaja o follow), header rico (Session · Task · Status · Duration · density ·
  range), `s` steer (interrupt-and-chat, já existia no main) e `h` → handoff. Puros:
  `sessionWindow`/`scrollOffset`/`cycleDensity` (control-worker.ts, testados). O argumento
  "workers efêmeros → não portável" da Revisão 2 caducou com os workers session-backed (RPC).
- **Ctrl+R rename inline no Runs picker** (droid missions picker) — `renameRun` (runs.ts, puro:
  valida slug/colisão, renomeia o dir e reescreve o featureId em plan/status/feature-run) +
  `renameModePointer` (mode-store.ts: o ponteiro persistido segue o novo nome). O run ATIVO não
  renomeia; a linha "+ New feature" tampouco.
- **Per-row load errors no picker** — `RunSummary.loadError`: um run corrompido degrada A LINHA
  (`⚠ <id> · load error: …`, Enter recusado com aviso) em vez de quebrar o picker.
- **`O` = Run Dir no main** (o `D Mission Dir` do Droid — o nosso `D` é Delivery): abre
  `.harness/runs/<id>/` no gestor de ficheiros (`openDirCommand`: open/explorer/xdg-open).
- **Onboarding once-only** — o card intro do fluxo de feature agora é gated pelo
  `hasSeenFeatureOnboarding` (o `hasSeenMissionOnboarding` do Droid) em
  `~/.pi/agent/pi-harness/ui-state.json` (src/ui-state.ts): aparece na primeira feature de todas
  e nunca mais ("continue" grava; cancelar não — re-aparece).
- **Hints proativos de readiness** (droid doc 06 §6) — src/readiness-hints.ts: no startup, sem
  report → "Run /readiness-report…"; com report → o primeiro dos **6 checks L1 locais baratos**
  (`lint_config`/`type_check`/`formatter`/`unit_tests_exist`/`readme`/`env_template`) → "No
  linter detected. Run /readiness-fix…". Supressão 24h/path em
  `~/.pi/agent/pi-harness/cli-hints.json` (o análogo do `~/.factory/cli-hints.json`).
- **Completion gate** (droid: mission completa ⇔ toda assertion `passed`) — ver docs/00 §runner:
  o runLoop recusa `completed` com assertion não-passed (`completion_gate_failed` →
  `orchestrator_turn`); bypass quando o qa-validator (quem flipa o status.json) foi pulado.
- **Correção desta revisão**: a nota "Pause/Resume adiado (overlay read-only)" das Revisões 1–4
  estava DESATUALIZADA — `P`/`R`/`Shift+R`/`S` já existem via run-registry (pauseRun/steerWorker).

Mock do `main` (layout restaurado):
```
┌───────────────────────────────────────────────────────────────┐
│ ⛬ Feature Control   ~/dev/acme                              Time 2m  ·  ● Live  │
├───────────────────────────────────────────────────────────────┤
│ ●  Running   ███████▒▒▒▒░░  6/12  [+2]                                          │
├───────────────────────────────────┬───────────────────────────────┤
│ Active Task  T2                  │ Tasks                              1/3 │
│                                 │  ✓ T1  bootstrap rate-limit          │
│ skill  worker                   │ [● T2  add token-bucket]  ← inverse   │
│ fulfills A3, A4                 │  ○ T3  wire routes + config          │
│                                 ├───────────────────────────┤  ← cnu (só direita)
│ Preconditions                   │ Progress Log              6-10 of 10 │
│    · token-bucket module exists  │  1m  task T2 started                 │  ← newest-first, colorido
│ Expected Behavior               │  2m  task T1 completed ✓             │
│    · 429 on burst                 │  3m  plan stored: 3 tasks / 12 …    │
├────────────────────────────────────┴───────────────────────────────┤
│ Active Worker  #2  9f3a4b2c  ● live      … mini-transcript ao vivo …         │
├───────────────────────────────────────────────────────────────┤
│ F Tasks   W Workers   C Coverage   D Delivery   M Models   Tab Next   Alt+T Close │
└───────────────────────────────────────────────────────────────┘
```
