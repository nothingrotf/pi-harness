# 01 — Camada de integração (UX no Pi)

Como o harness se acopla ao Pi: o comando de entrada, o sinal visual de "modo", o
painel de readiness, e o despacho pro resto. Decisão central: **extensão FINA** —
compõe as primitivas que o Pi já expõe, não forka o TUI nem vira plugin pesado.

---

## 1. O Pi já expõe tudo (API real)

Da interface de extensão (`@earendil-works/pi-coding-agent`, `ExtensionAPI` +
`ExtensionUIContext`):

| Necessidade | Primitiva |
|---|---|
| Comando de entrada | `pi.registerCommand("harness", {...})` |
| Tool (se preciso) | `pi.registerTool({...})` |
| **Sinal de modo/progresso (COMPATÍVEL)** | `ctx.ui.setStatus(key, text \| undefined)` — a statusline compõe (pi-fusiontui lê `getExtensionStatuses()`) |
| Dashboard sob demanda | `ctx.ui.custom(factory)` (modal `Alt+T` / `/harness control`) |
| ~~Badge aboveEditor / recolorir o input~~ | **EVITADO**: `setWidget(aboveEditor)` / `setEditorComponent` clobberam extensões donas do editor/footer (pi-fusiontui) |
| Painel de readiness (foco de teclado) | `ctx.ui.custom(factory, {overlay:true})` |
| Gates simples | `ctx.ui.select / confirm / input / notify` |
| Tema | `ctx.ui.theme.fg/bg/bold`, `setTheme`, `setTitle` |
| Ciclo de vida | `pi.on("session_start"/"session_shutdown")`, `pi.events.on(...)` |
| Componentes | `@earendil-works/pi-tui` (`Box`, `Text`, `Container`, ...) |

Manifesto da extensão (no `package.json`):
```json
"pi": { "extensions": ["./src/extension/index.ts"], "skills": ["./skills"], "prompts": ["./prompts"] }
```

## 2. O surface mínimo da extensão

```
registerCommand("harness", handler)    # /harness <pedido> · setup · status · run · control · exit
ui.setStatus("harness", "◆ <fase>")                # modo (a statusline compõe — ex.: pi-fusiontui)
ui.setStatus("harness-progress", "██▒▒ 6/12 · T2")   # progresso (durante o run; control-strip.ts)
ui.custom(readinessGate / featureControl / proposal)            # gate · overlay Alt+T · proposal
on("session_start"/"session_shutdown" + "tool_execution_end"/"agent_end")  # liga/limpa modo + proposal
```

**Sinal de modo via `setStatus` APENAS** (decisão de COMPATIBILIDADE): nada de
`setWidget(aboveEditor)` nem `setEditorComponent`. Extensões de UI (pi-fusiontui) são
donas do **editor** Droid + do **footer**; clobberá-los quebra a UI delas. A statusline
já compõe os nossos `setStatus`. O dashboard rico é o overlay modal `Alt+T`.

## 3. O fluxo de entrada

```
/harness "<pedido>"
  1. ensureProfile()                       # gate determinístico (Fatia 2)
       sem profile  → SETUP completo (subagent do setup skill, Fatia 1) — progresso no widget
       drift        → ui.confirm("profile pode estar stale, refresh?")
  2. ui.custom(readinessGate, {overlay})   # nível + categorias + action items
       Enter = prosseguir · R = rodar/refresh setup · Esc = cancelar
  3. on proceed:
       cria runs/<feature-id>/ · ativa modo (status only — compatível c/ pi-fusiontui)
       → CONVERGE (gray-area-policy → contract frozen) — Fatia 3
```

## 4. A nuance do "modo" (honesto)

O Pi **não** tem interaction-mode nativo. O nosso modo é **emulado** pela extensão:
estado interno + `setStatus` persistente até sair (`/harness exit` ou
shutdown). Efeito visual equivalente, mas é overlay nosso — não um modo de primeira
classe do runtime.

## 5. A divisão lazy (por que não é plugin pesado)

```
EXTENSÃO (fino, ~1 index.ts)   → comando + chrome do modo + overlay readiness + DISPATCH
SKILLS / SUBAGENTS (o peso)    → setup (gera profile), convergência, validação
RUNNER (código fino, depois)   → loop sequencial determinístico
```

A extensão **não** implementa harness — dá a cara e despacha. O peso mora nas skills
(portáveis, independentes do TUI).

## 6. Readiness no TUI

O painel espelha o gate do sistema de referência: **nível** (L1–L5), **categorias**
com pass-rate, **action items**. A fonte é o snapshot de readiness gerado no setup
(Fatia 1). Mostrado no gate de entrada (`ui.custom` overlay) e, opcionalmente,
persistente como `setWidget`. Enquanto o setup não existir, o painel renderiza um
placeholder honesto ("readiness não computado — rode o setup"). `// ponytail`
