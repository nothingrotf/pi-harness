# 04 — Paridade de resiliência com o droid (doc 07) + headless endurecido

Fecha o débito mapeado na comparação pi-harness × droid-missions: a **camada de
resiliência do `docs/07-persistence-sessions-and-kill-resume.md`** do droid. Em vez
de portar o daemon JSON-RPC (over-engineering — o pi já é o substrato de sessão),
adotamos as **semânticas** do daemon como um **supervisor fino** sobre as primitivas
do pi (`pi --print --session-id`, eventos, disco).

> Postura (fork da análise): atacamos **(A) endurecer o headless** até paridade,
> mantendo o caminho live-TUI apoiado na resiliência de sessão do pi.

---

## A matriz de paridade (doc 07 → pi-harness)

| Mecanismo droid (doc 07) | Constante | Implementação pi-harness | Onde | Teste |
|---|---|---|---|---|
| Worker = sessão resumível (transcript) | `load_session` | Worker **session-backed**: `--session-id <wsid>` + `--session-dir runs/<id>/sessions` (não mais `--no-session`) | `feature-spawn.ts` `piArgs`/`makeRealSpawn` | feature-spawn |
| Resume "continue where you left off" | `resumeWorker` | re-attach do step `in_progress` (mesma `workerSessionId`, **sem nova tentativa**) + prompt de continuação | `feature-runner.ts` runLoop (reattach) | feature-runner, headless |
| Kill **graceful × hard** | interrupt vs close | graceful (abort/402) → step **in_progress** (resumível, status `paused`); hard kill → status `running` congelado → **orphan requeue** | `loadOrBuildFeatureRun` + `cleanupOrphan` | plan, headless |
| Restart vs resume | `restartFeature` | distinção sai do **estado em disco** (`paused`→resume, `running`→requeue) | `plan.ts` `loadOrBuildFeatureRun` | plan |
| Inactivity timeout | `sB_=600000` (10 min) | watchdog no child: sem stdout por `inactivityMs` → `kill` + outcome `inactivity` → requeue | `feature-spawn.ts` (armIdle) + `workerInactivityMs()` (env `HARNESS_WORKER_INACTIVITY_MS`) | feature-spawn |
| Auto-pausa 402/usage | `unrecoverable_usage_402` | detector no stream JSON (`isUsageLimitEvent`) → `kill` + outcome `usageLimit` → pausa resumível (`usage_limit`) | `feature-spawn.ts` + runLoop | feature-spawn, feature-runner |
| Heartbeat (beacon de vida) | `FTi=180000` (3 min) | `setInterval` toca `updatedAt` + log `heartbeat` durante um spawn longo | `feature-runner.ts` runLoop (`heartbeatMs`) | feature-runner |
| Retry-budget bônus no resume | `featureRetryBudgetBonus` / `grantRetryBudgetForExhaustedFeatures` | `grantRetryBudget` + `loadOrBuildFeatureRun` concede no resume após esgotamento | `feature-runner.ts` + `plan.ts` | feature-runner, plan |
| Preempção por ordenação | firstPending < inProgress | no resume, pending acima do in_progress → requeue do in_progress (fix corre primeiro) | `feature-runner.ts` runLoop | feature-runner |
| Orphan cleanup (crash) | `cleanupOrphanedWorker` | fresh start reseta `in_progress → pending` | `feature-runner.ts` `cleanupOrphan` | feature-runner |
| Attempt budget | `V9H=5` | `STEP_ATTEMPT_BUDGET=5` (+ bônus) | `feature-runner.ts` | feature-runner |

### Estados de pausa (analog dos `pauseReason` do doc 07)
`aborted` (graceful/SIGTERM) · `usage_limit` (402) · `step_retry_limit_exceeded`
(budget) — os dois primeiros preservam o step `in_progress` (resumível); o terceiro
deixa `pending` e é destravado por budget bônus no resume.

---

## O que NÃO portamos (e por quê)
- **Daemon JSON-RPC / transports / relay / ACP / PTY / MCP broker / crons.** O pi já
  é o runtime de sessão; construir isso seria duplicar a casa. Ver a análise em
  `droid-missions-reverse-engineered/docs/daemon/` (mapa completo do daemon) — a
  conclusão foi *supervisor fino, não daemon*.
- **Heartbeat backend (`XUA`).** É liveness de daemon REMOTO (cloud computer), não o
  beacon de mission; irrelevante pro modo feature local.

## Limite honesto
O **caminho headless** (`pi --print`) agora tem paridade funcional com o doc 07
(resume real, graceful×hard, inactivity, 402, heartbeat, budget bônus, preempção).
O **caminho live-TUI** herda resiliência do próprio pi (sessão do orchestrator +
Plan `todo` sobrevivem a `/reload`); o supervisor acima cobre os workers que ele
spawna via `pi --print` no headless. Smoke ao vivo com kills reais permanece como
validação de campo (os modos de falha estão provados por testes determinísticos com
spawn/child injetados).
