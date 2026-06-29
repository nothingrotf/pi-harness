---
name: feature-converge
description: Converge a feature into its frozen acceptance contract and task plan under .harness/runs/<feature-id>/ (feature.md, contract.md FROZEN, status, plan.json). Reads the cached profile; runs per feature.
---

# feature-converge — converge on what to build (Tier 2)

You converge a single feature into the artifacts that define and sequence it. This is
the **per-feature run** (ephemeral, gitignored) under
**`.harness/runs/<feature-id>/`**. You produce `feature.md`, `contract.md` (**FROZEN**),
status, and `plan.json`. This authors the per-feature planning + the acceptance contract.

## What you READ (the cached profile — don't re-derive)

The profile already exists (authored by `harness-setup`). Read, don't re-author:
- `.harness/profile/architecture.md` — authoritative system design (give it to contract subagents as context).
- `.harness/profile/services.yaml` — the commands/services the gate runs.
- `.harness/profile/harness.md` — boundaries, directives, testing guidance.
- `.harness/profile/skills/<worker-type>/` — the worker types you'll assign tasks to (`skillName`).
- `.harness/profile/library/` — distilled repo knowledge.
- `.harness/profile/readiness.json` — current readiness.

If the profile is absent or stale, stop and run `harness-setup` first.

## Phase 1 — Understand THIS feature (iterative)

**Ask the user clarifying questions first** — enough to build shared understanding of
what this feature is and what matters — before investigating. Then interleave: investigate
via subagents, research unfamiliar tech, ask again. **Capture EVERY requirement the user
mentions, even casually** — named packages/tools are binding, not suggestions; echo them
back before converging.

**Gray-area decisions (explicit policy):** where the feature has ambiguous choices the profile
doesn't settle, resolve them **with the user via the `ask_user_question` tool** (don't guess) and
**record each as `{decision, rationale}`** — they go in a named `## Gray-area decisions` section of
`feature.md` so workers and validators don't re-litigate. Keep going until nothing important is
ambiguous. (This is the gray-area-policy: capture > assume; every resolved ambiguity is written down.)

## Phase 2 — feature.md (intent + scope)

Author `.harness/runs/<feature-id>/feature.md`: the intent, the scope (what's IN and
what's explicitly OUT), every captured requirement, and a named **`## Gray-area decisions`**
section listing each resolved ambiguity as `{decision, rationale}` (from Phase 1). This is the
human-readable statement of what this feature
delivers and how, plus the decisions that bound it.

## Phase 3 — contract.md (the acceptance contract → FROZEN)

The formal contract: a finite checklist of **testable behavioral assertions** that define
"done". It is the primary input for the qa-validator ship-gate step, and it is authored
**before** `plan.json` (feature-level TDD).

**Core principle:** validation is **black-box and behavior-based, never derived from
implementation.** Validators test against behavioral specifications, not against code.

Each assertion has:
- **Stable ID** with area prefix (`VAL-AUTH-001`, `VAL-CHECKOUT-003`, `VAL-CROSS-002`).
- **Title** — short behavior description.
- **Behavioral description** — semantic but unambiguous, with a clear pass/fail condition.
- **Tool** — the tool/skill to test it (e.g. `agent-browser`, `tuistory`, `curl`).
- **Evidence requirements** — screenshots, console-errors, network calls, terminal output.

Organize by area + cross-area flows:

```markdown
## Area: Authentication
### VAL-AUTH-001: Successful login
A user with valid credentials submits the login form and is redirected to the dashboard.
Tool: agent-browser
Evidence: screenshot, console-errors, network(POST /api/auth/login -> 200)

## Cross-Area Flows
### VAL-CROSS-001: Auth gates pricing
A guest sees "Sign in for pricing"; after logging in, real prices show.
Tool: agent-browser
Evidence: screenshot(guest-view), screenshot(authed-view)
```

**How to create (delegate; subagent output → `.harness/runs/<feature-id>/contract-work/`):**
Before writing, identify all user-facing areas the feature touches. **Spawn a subagent per
area** to enumerate every user interaction: what can a user DO, see, click, type, and
expect? Pass each subagent the feature.md, architecture.md, and your findings — its output
quality is bounded by the context you give it.

- **Per-area assertions:** walk each flow with **high fidelity** — every interaction, state,
  and transition. Beyond the obvious, watch for **consistency expectations** (the same entity
  in a different context carries all its behaviors — e.g. thread messages must be as
  interactable as top-level ones) and **consequential behaviors** (one action's expected
  downstream effects — e.g. changing a line-item price recalculates the total AND
  percentage discounts). Enumerating these thoroughly is hard — be diligent.
- **Cross-area assertions:** flows spanning areas, entry points, navigability, first-visit
  flow, reachability via real navigation (not just direct URL).

After drafting, run **at least 2 sequential review passes** (a subagent per area + one
cross-area; each reads the full draft + feature.md + architecture.md and hunts for missing
flows/states/transitions). Synthesize and update the contract between passes. Do your own
final pass. Then **FREEZE** the contract — it is the definition of "done" and is not edited
except via the orchestrator's mid-feature procedure.

## Phase 4 — status init

After the contract is finalized, initialize the status record with all assertion IDs set to
`"pending"`. (Lifecycle: `pending → passed | failed`; the qa-validator writes results; the
end-of-feature gate requires all `passed`.)

## Phase 5 — plan.json (ordered tasks)

`plan.json` is the **structured task queue** — the `features.json` analog and the **single source
of truth** for the tasks (there is NO separate markdown plan). You decompose into tasks and
persist them via the **`store_plan`** tool; workers read it via `jq`. Schema: `{ featureId, tasks: [...], assertions: [...] }`.

Decompose the work into **ordered tasks**, using both the contract and `architecture.md`.
Tasks execute in array order — the topmost pending runs next. Each task:

| Field | Description |
|---|---|
| `id` | unique identifier |
| `description` | what to build (clear, specific) |
| `skillName` | which **profile** worker skill handles it (must exist in `.harness/profile/skills/`) |
| `preconditions` | what must be true before starting |
| `expectedBehavior` | what success looks like |
| `fulfills` | contract assertion IDs this task COMPLETES |
| `status` | start `pending` |

**`fulfills` semantics ("completes", not "contributes to"):** only the leaf task that makes
an assertion fully testable claims it; each assertion ID appears in **exactly one** task's
`fulfills`. Foundational tasks may have empty `fulfills`.

**Coverage check (REQUIRED before running):** every assertion ID in `contract.md` is claimed
by exactly one task — no orphans, no duplicates. **Author the tasks directly** (you have the most
complete understanding; for large contracts audit coverage with a subagent first), then call
**`store_plan`** with the tasks + ALL contract assertion IDs. It enforces the coverage invariant
in trusted code and persists `plan.json` + `status.json` (assertions `pending`) — do NOT
hand-write `plan.json`/`status.json`.

**Never create ship-gate tasks** (code-review / qa-validator) — the runner injects them when all
implementation tasks complete. Order foundational tasks first; place urgent fixes at the top.

## Hand off to the runner

Once `contract.md` is frozen, status is initialized, and the coverage invariant holds, hand
control to the **runner** (blocking) to execute the tasks. Handle worker returns and the ship
gate per the `harness-orchestrator` procedure.

## Rules
- Read the cached profile; don't re-derive what `harness-setup` produced.
- `contract.md` BEFORE `plan.json` (feature-level TDD); black-box, behavior-based.
- Freeze the contract once converged; edits only via the orchestrator's mid-feature procedure.
- Coverage invariant (every assertion claimed exactly once) before running.
- Capture every requirement; record gray-area decisions in `feature.md`.
