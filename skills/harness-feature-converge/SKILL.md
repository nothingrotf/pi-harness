---
name: harness-feature-converge
description: Converge a feature into its frozen acceptance contract and task plan under .harness/runs/<feature-id>/ (feature.md, contract.md FROZEN, status, plan.json). Reads the cached profile; runs per feature.
---

# harness-feature-converge — converge on what to build (Tier 2)

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

## Phase 0 — Size the feature (auto-sizing)

Before converging, assess the feature's size — it scales the **convergence depth and execution
effort**, NEVER the structure. Pick a tier:

| Size | Signal | Convergence depth (what scales) |
|---|---|---|
| **Small** | ≤~3 files, one obvious change, no new behavior surface | Author `contract.md` DIRECTLY (1–3 assertions, no per-area subagents); 1 self review pass; gray-area sweep = only dimensions obviously present; ~1 task; no research |
| **Medium** | clear single-area feature, <~10 tasks | Contract direct or 1 area subagent; ≥1 review pass; gray-area = present + the implicit dimensions actually touched; a few tasks |
| **Large** | multi-component, several user-facing areas | Full: a contract subagent PER area + cross-area flows + ≥2 review passes; full implicit-requirement dimensions sweep; ordered task decomposition; research unfamiliar tech |
| **Complex** | ambiguity / new domain / risk surface (auth, payments, migrations, concurrency) | Large + extra: research-FIRST, more HIGH gray-area asks, more contract review passes, emphasize cross-area + consequential behaviors; finer task granularity |

> **INVARIANT — never scaled away (regardless of size):** `contract.md` is FROZEN with **≥1
> black-box assertion**, `store_plan` enforces the coverage invariant (every assertion claimed by
> exactly one task), and the **ship gate (harness-code-review → harness-qa-validator → harness-deliver) always runs**. Auto-sizing
> tunes the *effort*, not the *guarantees* — a "Small" feature still gets a real contract + plan +
> gate, just cheaply. There is no path that skips the contract, the coverage gate, or the ship gate.

**Safety valve (the one bug to avoid — under-sizing):** the danger is sizing DOWN and leaving real
behavior out of the contract — because the contract is what the ship gate tests; a thin contract
ships **unvalidated behavior**. So if, while authoring the contract or decomposing, a "Small/Medium"
feature reveals cross-area behavior, >~5 tasks, or any implicit-requirement dimension (persistence,
auth, payments, concurrency, state transitions), **re-size UP** before `store_plan`: add the missing
assertions + a review pass. Sizing up is cheap; an under-specified contract is a silent gap. When in
doubt, size up.

Record the chosen size in `feature.md` (one line) so workers/validators know the intended depth.

## Phase 1 — Understand THIS feature (iterative)

**Load confirmed lessons first.** Read `.harness/profile/LESSONS.md` (the **Confirmed** section
only) — past verification failures distilled into project-local guidance by the self-improving
lessons layer — and let them shape the contract and plan (e.g. a recurring "assert the exact
persisted value" lesson → a sharper assertion; a recurring auth-boundary lesson → a cross-area
flow). Apply only Confirmed; never Candidate/Quarantined. Skip silently if the file is absent.

**Ask the user clarifying questions first** — enough to build shared understanding of
what this feature is and what matters — before investigating. Then interleave: investigate
via subagents, research unfamiliar tech, ask again. **Capture EVERY requirement the user
mentions, even casually** — named packages/tools are binding, not suggestions; echo them
back before converging.

### Gray-area policy (the explicit procedure — capture > assume, risk-tiered)

A *gray area* is any choice the feature leaves open that the profile/codebase doesn't already
settle. **Resolve every one — none ends in an unmarked state.** Weave this into convergence; it's
not a separate ceremony. (This is the harness's original piece: PUSH + risk-tiered ASK +
`[assumido]`/`[confirmado]` + auditable persistence.)

**1. Detect systematically — the implicit-requirement dimensions sweep.** Don't trust vibes; the
dangerous gray areas are the easy-to-miss ones. Sweep each dimension and either capture a decision
or mark **`N/A because <reason>`** — the N/A escape is **mandatory** (it stops you inventing
requirements to fill the checklist; bound to THIS feature's scope):

| Dimension | What to settle |
|---|---|
| Input validation & bounds | limits, formats, sanitization |
| Failure / partial-failure | timeouts, partial saves, rollbacks |
| Idempotency / retry / dedup | safe retries, dedup keys |
| Auth boundaries & rate limits | who can call what, throttling |
| Concurrency / ordering | races, ordering guarantees |
| Data lifecycle / expiry | TTL, archival, deletion |
| Observability | logging, metrics, tracing |
| External-dependency failure | fallbacks, circuit breakers |
| State-transition integrity | valid transitions, guards |

Also scan the feature's **surface** for behavioral gray areas — something users SEE (layout, empty
states, error display), CALL (response/error shape, versioning, rate limits), RUN (output, flags,
verbosity), READ (structure, tone), or ORGANIZE (grouping, naming, duplicates). Generate **concrete,
feature-specific** gray areas ("how are duplicate emails handled?", not "validation").

**Scope-tier the sweep:** substantial feature → cover every dimension (decision or `N/A`); small/clear
feature → only the dimensions obviously present, collapse the rest to one `remaining dimensions N/A
for this scope`.

**2. Tier each gray area by risk → this decides ASK vs ASSUME (the synergy).**
- **LOW** — one obvious option from profile/codebase evidence, reversible, no directional / security /
  data / cost / UX weight → resolve it yourself as an **assumption**: **PUSH** the default so the user
  can object, tag **`[assumido]`** with the evidence (`file:line` / profile decision). **Do NOT ask.**
  (As the profile accrues decisions across features, more gray areas land here → fewer asks — the
  harness learns the repo; the SKIP that makes feature N cheaper than feature 1.)
- **HIGH** — multiple valid options, conflicting patterns, or a directional / irreversible /
  security-data-cost-UX choice → **ASK** via the `ask_user_question` tool: **concrete options** (not
  "A/B"), lead with a **recommended default + the reasoning** (PUSH — don't just poll), and always
  offer **"you decide"** (captures agent discretion). User picks → **`[confirmado]`**; "you decide"
  → **`[assumido]`** (discretion, with your default + rationale). Ask **one area at a time**; let each
  answer inform the next.

**3. Stay in scope (HOW, not WHETHER).** Gray-area resolution clarifies how to build what's already
in scope — it **never adds capability**. A new-capability suggestion → record it under **Deferred
Ideas** and return to the current area; never silently expand the boundary.

**4. Nothing silently dropped.** Any dimension/area the user declines or leaves undiscussed →
**`[assumido]`** with your chosen default + rationale (never blank, never a silent guess).

**5. Closure gate (before freezing the contract).** Every swept dimension is `[assumido]`,
`[confirmado]`, or `N/A because <reason>` — **zero unmarked gray areas**. Echo the captured set back
to the user, then converge.

## Phase 2 — feature.md (intent + scope)

Author `.harness/runs/<feature-id>/feature.md`: the intent, the scope (what's IN and what's
explicitly OUT), every captured requirement, and a named **`## Gray-area decisions`** section
persisting Phase 1's policy output as an auditable table — one row per swept dimension/area:

```markdown
## Gray-area decisions

| Dimension / area | Decision | Status | Risk | Rationale / evidence |
|---|---|---|---|---|
| Duplicate email on signup | reject with 409 | [confirmado] | HIGH | user chose vs silent-merge |
| Retry on 5xx | idempotent, dedup by request-id | [assumido] | LOW | matches src/http/client.ts:40 |
| Rate limiting | N/A because no public endpoint | — | — | scope-bounded |

### Deferred Ideas
- [out-of-scope capability surfaced during gray-area discussion — captured, not built]
```

**Status** is `[assumido]` (agent-defaulted: LOW silent, declined, or "you decide") or `[confirmado]`
(user-decided); `N/A because <reason>` rows carry no status. This is the human-readable statement of
what this feature delivers and how, plus the decisions that bound it — workers and validators read it
so they never re-litigate a settled gray area.

You will **append a `## Shared derivations` section here in Phase 4.5**, once the contract exists
and you know what the system has to compute. Leave the placeholder now.

## Phase 3 — contract.md (the acceptance contract → FROZEN)

The formal contract: a finite checklist of **testable behavioral assertions** that define
"done". It is the primary input for the harness-qa-validator ship-gate step, and it is authored
**before** `plan.json` (feature-level TDD).

**Core principle:** validation is **black-box and behavior-based, never derived from
implementation.** Validators test against behavioral specifications, not against code.

**A fallback can satisfy a black-box assertion while the primary path is dead.** If the feature has
a fallback (secondary provider, degraded mode, cached answer) AND the primary path cannot be
exercised for real during the run — no credential, no sandbox, paid API, hardware absent — then
"the observable outcome happened" proves nothing about the primary. Write **both**:
- an assertion that pins **which path produced the result** (the provider/marker on the persisted
  record or the wide event), not just that a result exists; and
- an explicit **`## Rollout gate`** section naming the one live check a human runs before the
  feature is switched on, and what it must show.

State the limitation in the contract in the same breath ("provider boundary is mock-verified;
live behavior unproven"), so nobody reads a green gate as proof of the primary. Observed cost of
not doing this: a feature passed 21/21 assertions, code review and QA with a primary path that
plausibly never worked — the fallback answered every assertion, and the whole pipeline was blind
to it by construction.

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
`"pending"`. (Lifecycle: `pending → passed | failed`; the harness-qa-validator writes results; the
end-of-feature gate requires all `passed`.)

## Phase 4.5 — Shared-derivation pass (the design step — REQUIRED before you decompose)

The contract is deliberately **black-box**: it says what the system must do, never what shape the
code takes. The plan is a **delivery order**. Between them nothing has ever looked at the internal
form of what you are about to build — and that gap is the most expensive defect source this harness
has measured.

**The failure mode, from a real run.** A feature routed model choice per pipeline task. Six planned
tasks each independently touched "which tier is this call on": a policy table, tier→model config,
the reasoning budget, a quality-mode shift, a degradation step, a session pin. Every task wrote its
own expression of that one value in its own file. No task ever said "this is ONE concept". The
review then found the same defect in a different file every round: round 1 in the mode shift, round
2 in the effective policy, round 3 in the model resolver, and so on. It took **11 review rounds and
22 fix tasks** to arrive at a single 60-line `landed-tier.ts` that one design question would have
named on day one. The repo's own lesson store recorded it afterwards — *"two independent
expressions of one concept regressed three review rounds running"* — which is exactly the knowledge
that should have existed BEFORE the plan, not after the bill.

**Do this, in order:**

1. **List the derived values.** Walk the contract assertions and ask, for each: what value does the
   system have to COMPUTE to satisfy this? Write them as nouns — "the tier a call actually lands
   on", "the effective price after credits", "whether this org may spend", "the canonical status of
   a payment". Aim for 3–10. These are concepts, not functions yet.
2. **Cross them against the work.** For each derived value, mark every prospective task that would
   read, compute, or modify it. Any value touched by **2 or more tasks is a shared derivation.**
3. **Give each shared derivation ONE owner, FIRST.** Emit a foundational task (empty `fulfills`)
   that creates the single named function/module both sides call, placed before every task that
   consumes it. Name it in the task description explicitly — "create `landedTier(request)`; every
   consumer asks it, nobody re-derives". Then write into the consuming tasks' `expectedBehavior`:
   *"reads `<name>`; does not re-derive `<value>`"*. A constraint the worker has to infer is a
   constraint that gets forgotten — same rule as the hard constraints below.
4. **Check the closed vocabularies.** Any enum/status/kind the feature branches on gets ONE
   canonical declaration in the owning domain, named in a task. Two independently written literal
   sets for the same vocabulary is the same defect wearing different clothes.
5. **Record it.** Put the table (derived value → owning task → consumers) in `feature.md` under
   `## Shared derivations`. The code-review conventions axis reads it, and "consumer re-derives an
   owned value" becomes a checkable finding instead of a discovery.

**Consult the lessons first.** `.harness/profile/LESSONS.md` is grounded in this repo's own past
failures and is injected into your context. Confirmed lessons are binding here — several of them
exist precisely because a prior feature skipped this phase.

Keep it proportional: a two-task feature with no shared value writes "none" and moves on. This is a
design **question**, not a design document.

## Phase 5 — plan.json (ordered tasks)

`plan.json` is the **structured task queue** — the `features.json` analog and the **single source
of truth** for the tasks (there is NO separate markdown plan). You decompose into tasks and
persist them via the **`store_plan`** tool; workers read it via `jq`. Schema: `{ featureId, tasks: [...], assertions: [...] }`.

Decompose the work into **ordered tasks**, using the contract, `architecture.md`, **and the Phase
4.5 shared-derivation table — its owner tasks come first, before any consumer**.
Tasks execute in array order — the topmost pending runs next. Each task:

| Field | Description |
|---|---|
| `id` | unique identifier |
| `description` | what to build (clear, specific) |
| `skillName` | which **profile** worker skill handles it (must exist in `.harness/profile/skills/`) |
| `preconditions` | what must be true before starting |
| `expectedBehavior` | what success looks like — **inline hard constraints here** (see below) |
| `fulfills` | contract assertion IDs this task COMPLETES |
| `cohesion` | *(optional)* batching cohesion tag — see below |
| `batchBreakBefore` | *(optional)* force a batch seam before this task — see below |
| `weight` | *(optional)* batch-budget weight (default 1; >1 = unusually heavy task) — see below |

(Tasks carry no `status` field — assertion status lives per-ID in `status.json`, written by
`store_plan`; do not add a task-level `status`.)

**Factual claims about external services must be sourced — you are the only one who can.** A task
description that states how a third-party API behaves (which region serves a model, what an
endpoint accepts, what a field is called) is an instruction the worker will follow literally, and
**the worker has no web tools** — it cannot check you (`harness-worker-base` §1.6). Neither can the
review axes. You have `web_search`/`web_fetch`: verify the claim and cite the source in the task,
or write it as an explicit unknown for the worker to resolve locally ("confirm against the
installed SDK types before implementing"). Never state an unverified provider fact as a
requirement. Observed cost: a brief said `location 'global'` for a model that the docs list only
under regional endpoints; one worker obeyed it and shipped a plausibly-dead path, and the error was
invisible to every downstream gate.

**Hard constraints travel IN the task, not by reference.** The harness automatically resolves each
task's `fulfills` to the full assertion text and injects it into the spec `next_task` hands the
worker — so behavior captured in the contract arrives verbatim. But hard NON-functional constraints
that the assertions don't spell out (complexity bounds like "O(1) in pointer length: NO full token
scan", size/latency limits, security invariants, "never call X from Y") MUST be written into that
task's `expectedBehavior` explicitly. A constraint the worker has to go hunting for is a constraint
that gets forgotten mid-implementation; a constraint in the brief survives. Never rely on the
worker re-deriving a constraint from `feature.md` prose.

**Batching (doc 05) — you do NOT group tasks into batches; the runner does, by CONTEXT BUDGET.**
A large feature is split into task-budgeted batches (~7 tasks), one fresh worker session per batch
(no compaction), executed sequentially. **Budget drives the batch SIZE** — you never author
"milestones" or phases. Your ONLY batching levers are two optional per-task fields that constrain
*where* a cut may land, so the budget cut doesn't sever a tightly-coupled cluster:
- **`cohesion: "<tag>"`** — give consecutive tasks that MUST stay in one worker's head the same
  non-empty tag (e.g. `"auth-core"`, `"migration-seq"`); the batcher never splits a same-tag run.
  Use sparingly — only for genuine in-head coupling, not for logical grouping. A single cohesion
  cluster that alone exceeds ~1.5× the budget (~10+ tasks) is a decomposition smell — split it into
  real sub-tasks instead. **Serial-debugging/diagnosis chains are the mandatory case**: when
  consecutive tasks form one root-cause hunt (reproduce → isolate → fix → regression-test), the
  accumulated context IS the work — always give the chain a shared `cohesion` tag so a budget cut
  never severs it into separate sessions.
- **`batchBreakBefore: true`** — force a seam before a task at a hard dependency/domain frontier
  (rare). A change in `skillName` (worker type) is already treated as a preferred seam automatically;
  you don't mark those.
- **`weight: <n>`** — token-aware budget (default 1). Set >1 on an unusually **heavy** task (lots of
  code/context) so it consumes more of the ~7 budget → smaller batches around it. Use rarely; most
  tasks are weight 1.

Most tasks need NEITHER field — order foundational-first and let the budget cut. Only add a lever
when a budget cut would land in the middle of a cluster that must be built with shared context.

**`fulfills` semantics ("completes", not "contributes to"):** only the leaf task that makes
an assertion fully testable claims it; each assertion ID appears in **exactly one** task's
`fulfills`. Foundational tasks may have empty `fulfills`.

**Surface-coverage check (blast radius — REQUIRED before `store_plan`):** enumerate every
app/package/consumer that consumes the contracts/APIs/schemas/types this feature CHANGES — read
the app list from `architecture.md` + `services.yaml`, and when the consumer set isn't obvious,
spawn the `integration-scanner` subagent on the changed surface. **Do not stop at the primary
surface**: admin/back-office UIs, background workers, CLIs, generated API clients and sibling
apps are the classic misses. Every consumer ends in exactly one of two states:
- **covered** — a task in the plan owns migrating/adapting it, or
- **excluded** — `feature.md` scope lists it as explicitly OUT with a reason (and, if it will
  break, a gray-area row records that accepted breakage).

A consumer in NEITHER state is the scope hole that costs the most downstream: the repo-wide gate
goes red on a surface no task owns, every later worker inherits the failure as "pre-existing",
and the ship gate bounces the feature back as blocking findings. When this check adds surfaces,
re-size (Phase 0 safety valve) and add tasks/assertions before freezing the plan.

**Coverage check (REQUIRED before running):** every assertion ID in `contract.md` is claimed
by exactly one task — no orphans, no duplicates. **Author the tasks directly** (you have the most
complete understanding; for large contracts audit coverage with a subagent first), then call
**`store_plan`** with the tasks + ALL contract assertion IDs. It enforces the coverage invariant
in trusted code and persists `plan.json` + `status.json` (assertions `pending`) — do NOT
hand-write `plan.json`/`status.json`.

**Never create ship-gate tasks** (harness-code-review / harness-qa-validator) — the runner injects them when all
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
- Surface-coverage invariant: every consumer of a changed contract/API/schema is either owned by
  a task or explicitly excluded in `feature.md` — no consumer left in an unmarked state.
- Capture every requirement. Run the **gray-area policy** (Phase 1): dimensions sweep with the
  mandatory `N/A because` escape; risk-tier each gray area (LOW → PUSH + `[assumido]` silently from
  evidence, HIGH → `ask_user_question` → `[confirmado]`); HOW-not-WHETHER scope guardrail; zero
  unmarked gray areas at the closure gate; persist the tagged table in `feature.md`.
