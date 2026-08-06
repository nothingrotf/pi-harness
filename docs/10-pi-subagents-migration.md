# 10 — Migração do provider de subagents: @tintinweb → pi-subagents

Cutover limpo (sem dual-provider). O harness passou a consumir **`pi-subagents`** (>= 0.41)
como provider único de subagents in-session, e absorveu do doc 09 (v2) os mecanismos F1–F3
que NÃO dependiam do motor próprio. Este doc fixa os contratos consumidos e a disposição
revisada do v2.

## 1. Contratos do provider que consumimos (v0.41)

| Superfície | Contrato | Onde consumimos |
|---|---|---|
| Tool de spawn | `subagent` — execução `{agent, task}` \| `{tasks: [...]}` (paralelo) \| `{chain: [...]}` \| `{workflowScript}`; management via `action` (não é spawn) | `live-agents.ts` (`isExecutionArgs`), skills, dispatches |
| Partials foreground | `details.progress: AgentProgress[]` (`index`, `agent`, `status`, `task`, `currentTool`, `recentTools[]`, `recentOutput[]`, `toolCount`, `tokens`) | `agentsFromDetails` → Active Worker/run card |
| Run async aceito | `details.asyncId` + `details.asyncDir`; eventos `subagent:async-started`/`-complete` no `pi.events` (payload `{id, agent, task, goal, asyncDir}`) | registro async em `live-agents.ts`, wiring em `extension/index.ts` |
| Artefatos async | `<asyncDir>/status.json` (`state`, `steps[]` com `sessionFile`/`recentTools`, `totalTokens`) + `events.jsonl` + `output-<n>.log` | `readAsyncStatusLite` (refresh de stats), transcript |
| Sessão do child | child é sessão pi REAL: `<sessionsDir>/<parent-sem-.jsonl>/<runId>/run-<i>/session.jsonl`; em async o `sessionFile` vem no status.json | `readLiveAgentEntries` → parser NATIVO (`parseSessionEntries`) |
| Discovery de agents | manifest do pacote: `package.json → pi.subagents.agents` (resolve pacotes por path do settings) | `package.json` (substitui o espelho de symlinks no dir global) |
| Frontmatter | `tools`, `systemPromptMode`, `inheritProjectContext`, `defaultContext`, `acceptanceRole`, `completionGuard`, `fallbackModels` | `agents/harness-*.md` |
| Capability ceiling | registry global `Symbol.for("pi-subagents.capability-ceiling.v1")` (Registration `{source, ceiling:{version:1, allowedAgents, denyExtensions, sources}}`) | `capability-ceiling.ts` (sem import do pacote — contrato versionado process-local) |

O que MORREU com o provider antigo: o scraping do `.output` JSONL em tmpdir (path
reconstruído + scan por mtime), o buffer `mergeActivity` (uma string `activity` por frame),
e o espelho de agents por symlink (`contributeAgentsDir`).

## 2. Mecanismos do doc 09 absorvidos (F1–F3)

- **F1 — Reinjeção de contexto por turno** (`src/context-inject.ts`): CustomMessage oculta,
  reconstruída DO DISCO a cada `before_agent_start` do worker (task corrente, assertions do
  `fulfills` com status vivo, lembrete FROZEN, lições, finding verbatim em fix). Dedupe
  byte-idêntico estilo omp. Ativada pelo env `PI_HARNESS_WORKER_FEATURE` (setado no spawn,
  `rpc-worker.ts`).
- **F2 — Guards programáticos** (`src/guards.ts`): `tool_call → {block, reason}` acionável.
  Worker: `contract.md` FROZEN pós-`store_plan` (incluindo evasão via redirection no bash),
  `plan.json`/`status.json` tool-owned (ship-gate PODE escrever status), `AGENTS.md`/
  `CLAUDE.md` do repo intocáveis, merge é HUMANO. Orchestrator (run/ship): escrita fora de
  `.harness/` → redirect pra `fixTasks`.
- **F3 — Capability ceiling** (`src/capability-ceiling.ts`): a regra "orchestrator nunca
  implementa" imposta ANTES do spawn. Orchestrator em run/ship → só agents de análise;
  sessão de ship-gate → só os validators do harness. Sincronizado por turno, idempotente.

## 3. Watchdog (opt-in do usuário — perfil recomendado)

O pi-subagents 0.41 traz um watchdog de mudanças (review no `agent_end` gated por edição,
cadence opcional, autoFollow de blockers, LSP diagnostics). Ele é **complementar** ao ship
gate: in-loop e barato vs. fim-de-feature e repo-aware. Desligado por default; para ligar,
perfil recomendado (settings.json do usuário):

```json
{
  "subagents": {
    "watchdog": {
      "enabled": true,
      "main": { "model": "<modelo complementar ao da sessão>", "thinking": "high" },
      "autoFollow": { "blockers": true, "maxAttempts": 3, "stalemateRepeats": 3 },
      "children": { "enabled": true }
    }
  }
}
```

Regra prática: watchdog num modelo de família DIFERENTE da sessão (Anthropic ↔ Codex).
`children.enabled` cobre os validators de gate spawnados via `subagent`. O prompt do
watchdog é genérico (hard-coded no 0.41) — ele NÃO substitui os 3 eixos repo-aware do
`harness-code-review` (que leem `conventions-map.md`).

## 4. Disposição revisada do doc 09 (v2)

| Fatia v2 | Disposição |
|---|---|
| F1 reinjeção | **FEITA** (§2) |
| F2 guards | **FEITA** (§2) |
| F3 emission guard + roster | Parcial: o provider traz emission-guard próprio no watchdog; o roster repo-aware segue pendente (ver F6) |
| F4 worker in-process | **NÃO FAZER** — as dores (cola de subprocesso, orphans, `--tools` string) são cobertas pelos artefatos/leases/preflight do provider, sem o risco admitido de crash in-process derrubar o TUI |
| F5 registry/lifecycle | **NÃO FAZER** — `status.json` + eventos + `resume` (revive de session file com lease) cobrem parked/revive |
| F6 advisor runtime | **ADIAR E MEDIR** — ligar o watchdog primeiro; se os ~70% dele não derrubarem os 83%/18-rodadas, construir o roster repo-aware em cima (ou contribuir instructions custom upstream) |
| F7 pause/steer | usar `steer`/`interrupt`/`resume` do provider; destravar o `run_feature` é trabalho nosso, segue no backlog |
| F8 yield forçado + budgets | acceptance gates + `outputSchema` + budgets do provider quando o gate precisar |

Invariantes do doc 09 §8: TODAS preservadas — contract FROZEN agora é guard (F2), não prosa.
