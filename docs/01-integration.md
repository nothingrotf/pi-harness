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
| Badge de modo colado no input | `ctx.ui.setWidget(key, content, {placement:"aboveEditor"\|"belowEditor"})` |
| Status compacto no rodapé | `ctx.ui.setStatus(key, text \| undefined)` |
| Footer/header custom | `ctx.ui.setFooter(factory)` / `setHeader(factory)` |
| Recolorir o input | `ctx.ui.setEditorComponent(factory)` + `class extends CustomEditor` |
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
registerCommand("harness", handler)    # /harness <pedido> · /harness setup · /harness status · /harness exit
ui.setWidget("harness-mode", badge, {placement:"aboveEditor"})   # ⬢ pi-harness · <feature> · <fase>
ui.setEditorComponent(harnessEditor)   # recolore a borda/prompt do input enquanto ativo
ui.setStatus("harness", "<fase> · readiness L<n>")               # rodapé
ui.custom(readinessGate, {overlay:true})                         # painel readiness (Enter/R/Esc)
on("session_start"/"session_shutdown")  # liga/limpa o modo
```

**Ambos os sinais de modo ligados** (decisão): badge `aboveEditor` **e** input
recolorido. O badge é o sinal primário (barato, sempre visível); o recolor reforça.

## 3. O fluxo de entrada

```
/harness "<pedido>"
  1. ensureProfile()                       # gate determinístico (Fatia 2)
       sem profile  → SETUP completo (subagent do setup skill, Fatia 1) — progresso no widget
       drift        → ui.confirm("profile pode estar stale, refresh?")
  2. ui.custom(readinessGate, {overlay})   # nível + categorias + action items
       Enter = prosseguir · R = rodar/refresh setup · Esc = cancelar
  3. on proceed:
       cria runs/<feature-id>/ · ativa modo (badge + recolor + status)
       → CONVERGE (gray-area-policy → contract frozen) — Fatia 3
```

## 4. A nuance do "modo" (honesto)

O Pi **não** tem interaction-mode nativo. O nosso modo é **emulado** pela extensão:
estado interno + badge/status/recolor persistentes até sair (`/harness exit` ou
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
