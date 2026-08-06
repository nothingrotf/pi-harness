---
name: harness-setup
description: Author the Tier-1 Repo Profile in .harness/profile/ (architecture.md, services.yaml, init.sh, harness.md, skills/<worker>/, library/) and stamp it via store_profile. Brownfield-first profile authoring. Run once per repo, refreshable.
---

# harness-setup — author the Repo Profile (Tier 1)

You author the **cached repo profile** — the expensive, generate-once,
reusable-across-features layer (stable between features; the team commits, versions,
and reviews it). This is the planning + worker-design method, pointed at a
**profile**: **no per-feature plan/contract here** — those are per-feature
(`harness-feature-converge`).

All artifacts go in **`.harness/profile/`**. Do **not** rewrite the repo's own
`AGENTS.md` / `.agents/rules/` / `docs/adr/` — those govern code; you READ and defer to
them, never reauthor. You finish by calling **`store_profile`**, which validates the
artifacts and stamps `profile.json` (the fingerprint) — you never hand-write it.

## Delegation (from the orchestrator)

Your context window is finite. **Delegate hands-on extraction and analysis to
subagents** (the `subagent` tool) and synthesize their reports. Brownfield extraction across a
real repo is exactly where a single shallow context pass fails — split it per area.
Every `subagent` task must state the exact output path/schema and require the subagent to
**return the filepaths it wrote**. You keep: structural overview, synthesis, user
interaction, sequencing.

## Phase 0 — Brownfield Extraction FIRST (the inversion)

Before deriving anything, EXTRACT what the repo already declares. Read in parallel
(delegate per area):

- `AGENTS.md` / `CLAUDE.md`, `.agents/rules/`, `docs/adr/` — conventions, decisions, DoD.
- Package manifests + lockfiles (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, …) and `scripts/`.
- README, existing CI (`.github/workflows/`), `docker-compose*`, `.env.example`.
- Discover the **real** commands — install, build, test, lint, typecheck — by running `--help` / inspecting scripts. **Do not guess.**
- Probe running infra so the profile fits the machine: `lsof -i -P -n | grep LISTEN`, `docker ps`, `ps aux | grep -E 'node|python|go|java'`. Note ports in use and services to reuse vs avoid.

Use the **readiness criteria as a map of WHERE to look** (`agents_md`,
`single_command_setup`, `env_template`, the test/lint/typecheck commands). Synthesize
from the repo — don't impose a template.

**Readiness first (the profile consumes + triggers it):** read
`.harness/profile/readiness.json` if it exists — its **level + weakest categories** tell you
where the repo is thin, so you focus extraction/derivation there. If it's **absent**, run the
`harness-readiness-audit` skill now to compute it before continuing. Carry the level + weak areas into
`repo-facts.md` (Phase 8) and let them prioritize the conventions-map (Phase 9).

## Phase 1 — Understand & Plan (iterative)

Planning is an **iterative exploration loop**, not one pass: investigate → enumerate
what you still don't know → prioritize the most important unknowns → explore them (via
subagents, or ask the user for ambiguous decisions) → repeat until nothing important is
ambiguous. For every part of the system, be able to answer: what does it do, what are
its boundaries, where does complexity concentrate, and **how would an independent party
verify it works**. If you can't answer these, keep investigating.

## Phase 2 — architecture.md

Write `.harness/profile/architecture.md`: the authoritative design — components, their
responsibilities, how they interact, data flows, boundaries. For an existing codebase
this **DESCRIBES the current architecture** (synthesized from Phase 0), not a greenfield
design. It is the reference every feature and worker reads.

## Phase 3 — Infrastructure & Boundaries → services.yaml + init.sh

Determine services, processes, ports, external deps. Reuse what's already running; avoid
conflicts; note off-limits ports/dirs.

`.harness/profile/services.yaml` = the **single source of truth** for commands and services:
- `commands`: `install`, `build`, `test`, `typecheck`, `lint` — the exact, **verified** commands (Phase 7 proves them).
- `services`: each with `start`, `stop`, `healthcheck`, `port`, `depends_on`.
- **If a service uses a port, hardcode that port in `start`/`stop`/`healthcheck` AND in `port`.**
  The `port:` field is machine-read: the harness logs a `ports_preflight` event at every run start
  naming who holds each declared port, which is how a foreign container squatting your port becomes
  visible in minute one instead of as an inscrutable red gate hours later. A service without `port:`
  is invisible to that check. One port per service, never shared between two entries.
- **Prefer ports unlikely to collide.** Other projects live on this machine and the collisions were
  real (`:9000` MinIO, `:5434`/`:6380` postgres/redis). If a default port is already contended,
  remap this repo's service and say so in `notes`.
- **Resource-aware test command:** check machine resources, then set parallelism (e.g. `max(1, floor(cpus/2))` conservative, `cpus-1` capable).

`.harness/profile/init.sh` = idempotent env setup run at the start of **every** worker
session (install deps, write env files, warm caches). **No** service-start commands here.

## Phase 4 — Credentials & Accounts

If the repo needs external integrations to be validated end-to-end, document what's
required: env var names + placeholders (so the user has somewhere to put them), with
clear setup steps. **Never commit secrets** — gitignore them. Note any deferred
credentials. (Profile-level = *what the repo needs*; per-feature credential setup
happens in `harness-feature-converge`.)

## Phase 5 — harness.md (operational overlay)

`.harness/profile/harness.md` **defers to the repo's `AGENTS.md` for code conventions**
and is **authoritative for operations + testing**. Do NOT name it `AGENTS.md` (it would
collide with the repo's own). Include:
- **Boundaries (NEVER VIOLATE):** port ranges, external services to use vs avoid, off-limits paths.
- **Directives:** tools / skills / dependencies workers must use.
- **Testing & Validation Guidance** — the **Programmatic Validation Plan**: the exact
  `test`/`typecheck`/`lint` the ship gate runs verbatim, PLUS worker-scoping guidance
  (how workers scope those commands before handoff, e.g. package-level typecheck, area-scoped tests). Validators treat this section as authoritative.
  **Test-authoring philosophy is the `harness-generate-tests` skill** (behavior-driven, thin/fat
  classification, mock only at the boundary, mutation-killed = covered): thin/orchestration code
  is covered by the harness-qa-validator E2E surface (no internal-mock unit test), fat/business-rule code
  gets focused per-rule tests. Reference it here so workers and validators share one standard;
  do NOT impose blanket per-layer coverage quotas.
- **Delivery & Branching** — document the repo's VCS convention: the **branch naming template**, the
  **base branch**, and the **merge strategy** the `harness-deliver` ship-gate step follows. Infer the
  convention from the repo (`git branch -a` → dominant prefixes like `feat/`,`fix/`,`chore/`; the
  default base from `git symbolic-ref refs/remotes/origin/HEAD` or the most-merged branch) and
  **confirm the base with the user** (don't guess between `main`/`develop`/`next`).

  Then ALSO write the machine-readable mirror **`.harness/profile/delivery.json`** — the harness
  **code** reads this at run-start to create the feature branch (the prose in harness.md is for
  humans/LLM; `delivery.json` is the source of truth the code parses). Schema:
  ```json
  { "branch": { "enabled": true, "template": "{type}/{key}-{slug}", "defaultType": "feat",
                "base": "<confirmed-base>", "maxSlugLen": 40 },
    "commitGate": { "enabled": true, "command": "<fast repo-wide gate, e.g. the typecheck command>",
                    "timeoutSec": 300 } }
  ```
  Placeholders: `{type}` (feat/fix/chore, inferred from the feature), `{key}` (the Linear/Jira
  issue, e.g. `adm-84`, dropped cleanly when absent), `{slug}` (kebab of the feature title). Match
  `template` to the repo's real convention. Set `enabled:false` to keep committing on the current
  branch (opt-out). At the first `/harness run`, the harness creates/switches to that branch
  **only when on the base with a clean tree** (`.harness/`-only dirt is ignored — harness-owned);
  otherwise it respects the current branch.

  **`commitGate` (strongly recommended)** — the deterministic per-task-boundary check: `next_task`
  runs this command before marking a worker's task complete; **red → the task is re-handed with
  the failure tail instead of advancing** (prevents a batch from committing a non-compiling tree
  that every later worker inherits). Pick the **fastest command that proves the tree is sane** —
  usually the repo-wide typecheck, NOT the full test suite (it runs at every task boundary).
  Verify it in Phase 7 like every other command, and it must be **green at setup time** — a
  baseline-red gate would deadlock workers. Omit the key to opt out.

## Phase 6 — Worker System → skills/<worker-type>/

Design the worker **types this REPO needs** — one per distinct layer/domain
(feature-agnostic, because skills are profile-level and cached). For each, write
`.harness/profile/skills/<worker-type>/SKILL.md`:

1. **YAML frontmatter** — name, description.
2. **Required Skills & Tools** — everything the worker must use (binding choices included). "None" if N/A.
3. **Work Procedure** — step-by-step: **TDD (red→green)** — for the test-authoring step the worker **invokes the `harness-generate-tests` skill** (classify thin/fat → fat = behavior tests, thin = harness-qa-validator E2E coverage → adequacy review → discrimination/mutation sensor), **manual verification** (tests are necessary, not sufficient), **no orphaned processes** (no watch mode; kill by PID what you started), ending in the **verified gate** from `services.yaml`.
4. **Example Handoff** — a complete, realistic handoff. **This defines the upper bound of worker effort** — workers pattern-match against it. Show the schema: `salientSummary`, `whatWasImplemented`, `whatWasLeftUndone`, `verification.commandsRun[{command,exitCode,observation}]`, `verification.interactiveChecks`, `tests.added[{file,cases}]`, `discoveredIssues[{severity,description,suggestedFix?}]`.
5. **When to Return to Orchestrator** — skill-specific conditions.

NOTE in each skill: startup/cleanup are handled by `harness-worker-base` — the skill defines the WORK PROCEDURE only.

## Phase 7 — Profile Readiness Check (verify-by-execution) — REQUIRED

This is the gate that makes the profile **trusted, not merely declared**. Skipping it is
exactly what makes a profile shallow. Delegate **two subagents, sequentially** (dependency
first — it may install/start what validation needs):

- **Dependency readiness:** for each package/SDK/tool/API the architecture needs, *actually*
  verify it now — run a **real install** (not `npm view`/`--dry-run`), make a **real request**
  to each external endpoint, **execute** each CLI (`--version` / a minimal command). Registry
  or config inspection is not sufficient.
- **Validation readiness:** start the dev server, confirm pages load and the testing tools
  actually interact with the surface; confirm `services.yaml` commands run **green**; measure
  resources (memory/CPU/process count before & after exercising a flow).

**Self-proof (REQUIRED — a surface that was never driven is a draft, not a deliverable):** drive
**ONE real user flow end-to-end** exactly as `library/user-testing.md` teaches it: bring the surface
up per the Launch recipe → run the **Doctor** check → drive the flow with the named tool
(agent-browser/tuistory/curl) → capture evidence (screenshot/transcript/response + the resulting
state, not just the final screen) → clean up. After cleanup, confirm the evidence still exists at
its named location — a cleanup that eats the proof fails this step. Record the driven flow as the
**first Feature Map entry** (Phase 8 contract). If the drive fails, fix the recipe (or report the
product defect) before `store_profile` — a profile whose user-testing doc was never executed teaches
wrong steps to every future validator.

**Resource Cost Classification:** compute max concurrent validators per surface — **70% of
available headroom**, capped at **5** — with explicit per-surface reasoning (how much each
validator instance costs vs machine headroom). Record it in `library/user-testing.md`
`## Validation Concurrency`. **Do not trust a `services.yaml` command until it has actually
run green here.**

**Every test command must PROVE it collects tests — green is not proof.** Run each `test*` command
and read the collected/passed count out of the output. A command that collects **zero** tests exits
0 and is indistinguishable from a clean pass, so it silently turns the whole ship gate into a
rubber stamp. This is not hypothetical: `bunx vp test --project X run` shipped in a real
`services.yaml` — vp parses the trailing `run` as a name filter, collects nothing, exits 0 — and
six gates approved code no test had touched. Record the observed count as a comment next to each
command (`# 318 tests`) so drift is visible on the next refresh, and re-verify on every refresh.
Same rule for per-project commands: each one must select a non-empty, DIFFERENT set.

## Phase 8 — library/

`.harness/profile/library/` (flat, by topic):
- `environment.md` — env vars, external deps, setup notes (NOT ports — those live in `services.yaml`).
- `user-testing.md` — the verification manual for the app's real user surface. Required sections:
  - `## Validation Surface` — surfaces, URLs, auth, tools per surface.
  - `## Launch` — exact bring-up recipe (idempotent) + readiness signal + teardown.
  - `## Doctor` — ONE read-only check per surface answering "is this instance worth driving?"
    (process up, right build, port owned by us, auth valid). Validators run it before the first
    drive and after any failed drive — never drive an instance that hasn't been health-checked
    since it last did something surprising.
  - `## Validation Prerequisites` (how each was verified in Phase 7).
  - `## Validation Concurrency` (max concurrent + numbers + rationale).
  - `## Evidence` — what proves behavior on this app (UI = screenshot + resulting state; API =
    request/response; mutation = a read-only second view of the stored value) and where artifacts
    live. Cleanup removes instances and scratch state, **never evidence**.
  - `## Feature Map` — the index: one line per mapped feature linking its
    `user-testing-<feature-slug>.md` file with a one-line coverage summary.
- `user-testing-<feature-slug>.md` — one per mapped user-facing feature (seed the map with the top
  3–5 features mined from routes/commands/menus + the Phase 7 self-proof flow; `harness-qa-validator`
  enriches the map every feature run). **Fixed contract — exactly these four H2s, in order:**
  1. `## Sub-features` — short IDs with one-line behaviors.
  2. `## How to get to it (user POV)` — every entry point (route, menu, shortcut, command).
  3. `## Driving it` — preconditions, then user action → exact tool command → observable result;
     stable handles (ARIA roles/labels, prompt strings, route paths) over coordinates.
  4. `## Gotchas` — traps that waste runs (debounce → wait for the observable, focus-dependent
     shortcuts, seed-data quirks).
  Keep implementation details out — user paths, stable handles, commands, observable proof only.
- `repo-facts.md` — distilled repo facts so workers don't re-derive: identity, the gate, conventions, layout, "don't break"/"don't do" lists, **and the readiness level + weakest categories** (from `readiness.json`).
- `conventions-map.md` — see Phase 9.
- `coding-principles.md` — see Phase 8.1.
- other `<topic>.md` as useful — distilled, worker-facing knowledge.

### Phase 8.1 — coding-principles.md (author-side of the ship-gate quality axis)

The **harness-quality-review axis** (ship-gate) enforces a rich generic rubric — file-size growth,
spaghetti branching, unearned abstractions, code-judo simplifications, canonical-layer/reuse,
type/boundary cleanliness, atomicity. Workers historically never saw that rubric up-front, so the
reviewer caught quality regressions *after* the fact → fix task → re-review (rework). Close that
asymmetry: write the **worker-facing distillation** of the quality rubric here, so workers read it
before coding (`harness-worker-base` Phase 1) and the quality axis scores against the **same doc**
(single source → no drift).

This file is **generic and stable** — repo-agnostic behavioral bias, NOT repo-specific conventions
(those live in `conventions-map.md` / the repo's `AGENTS.md`, enforced by the conventions axis). It
is NOT regenerated on rules drift; it is preserved across refreshes like any `library/` file. On any
conflict with the repo's `AGENTS.md`/`.agents/rules`, **the repo wins** — state that precedence in the
file. Drop in this baseline (lightly tailor the examples to the repo's stack, keep the generic core):

```markdown
# Coding Principles (generic quality bias — read before implementing)

Behavioral bias, not a checklist. The ship-gate **quality axis** scores against this file, so
following it up-front means fewer blocking findings and less rework. On any conflict with the
repo's `AGENTS.md` / `.agents/rules`, **the repo wins** — this is the generic floor, not an override.

## Simplicity
- Minimum code that satisfies the contract assertion — no features, abstractions, flexibility, or
  error handling for impossible cases that weren't asked for.
- Prefer deleting complexity over rearranging it. If there's a "code-judo" reframing that makes whole
  branches/helpers/modes disappear, take it.
- After each change ask: "would a senior engineer call this overcomplicated?" If yes, simplify first.

## Structure & size
- Don't push a file from under ~1k lines to over it without a strong reason — extract helpers/modules.
- No random spaghetti growth: don't bolt ad-hoc conditionals / one-off branches onto unrelated flows;
  push logic into a dedicated helper, policy, or module.
- Keep logic in its canonical layer; reuse existing canonical helpers instead of bespoke near-duplicates.
- No thin wrappers / identity abstractions / pass-through indirection that don't buy clarity.

## Boundaries & types
- Question unnecessary optionality, `any`/`unknown`, or cast-heavy code; prefer explicit typed contracts.
- Don't paper over an unclear invariant with a silent fallback — make the boundary explicit.

## Surgical changes
- Touch only the files the task requires. Don't "improve" adjacent code, comments, or formatting.
- Match existing style even if you'd do it differently. Note unrelated dead code; don't delete it.
- Remove only the imports/vars/functions YOUR change orphaned.

## Test integrity (never violate)
- Never weaken an assertion, delete/skip a test, or use skip/pending to bypass a failing test.
- Tests derive from the contract assertions, not from the implementation; the implementation conforms
  to the tests. If a test is genuinely wrong, STOP and confirm before changing it.
```

If the repo's `AGENTS.md` already documents strong code-quality principles, cite them here and keep this
file to the generic gaps the quality axis still enforces — never restate or contradict the repo.

## Phase 9 — conventions-map.md (the deep mapping the ship gate consumes)

The **harness-conventions-review axis** (the ship-gate reviewer that enforces house patterns) must NOT
re-discover the repo's rules on every feature — that's slow and shallow. Pay the **deep mapping
once here**, cached in the profile, refreshed on drift (the fingerprint's `rules` part already
tracks `.agents/rules`+`AGENTS.md`+the common ADR/decision homes (`docs/adr`, `docs/decisions`, `adr/`, …) — ADRs don't live in one canonical place — so a rule/ADR change re-triggers this on refresh wherever they live).

Do a thorough pass (delegate to a subagent) that **maps, identifies, and indexes** the repo's
review-enforced conventions — search broadly by term, not just fixed paths:
- **ADRs:** `docs/adr/`, `docs/decisions/`, `**/ADR-*.md`, `**/adr/**`, or an ADR index README. Record each: id, title, status (accepted/superseded/proposed), what it decides, and a `file:line` anchor.
- **Rule files:** `.agents/rules/`, `.cursor/rules/`, `CONVENTIONS.md`, `CONTRIBUTING.md`, `AGENTS.md`/`CLAUDE.md` sections. Record what each governs + key terms to cite.
- **House patterns** discovered in the code (layering, API boundary, naming, error/logging contracts, enum style) — the kind a linter can't enforce. Record the pattern + a canonical example reference.
- **Gate-enforced vs review-enforced:** note which checks are script-gated (lint/format/typecheck/custom scripts) so the reviewer **defers** them to the programmatic gate and spends findings only on what review must catch.

Write `.harness/profile/library/conventions-map.md` as an index with references (path, title,
status, governs, key terms, canonical example). If the repo documents **no** conventions, write a
thin map saying so — the conventions axis then degrades to AGENTS.md-only (graceful, not a block).

## Encode Findings (which finding → which file)

- `harness.md`: repo-wide operational rules workers must follow.
- `skills/`: per-worker-type procedures + the tools used at each step.
- `library/user-testing.md`: validator tools, validation prerequisites, concurrency.
- `architecture.md`: how mission-critical dependencies fit and where they're used.
- `library/environment.md`: factual env/access state (verified availability, allowlist status, accounts, env vars, endpoints, install notes).

## Finish — store_profile

Call **`store_profile`** — it validates the profile artifacts exist and are coherent, then
stamps `profile.json` (`version`, `generatedAt`, `sourceCommit`, `fingerprint`)
deterministically. **Do not hand-write `profile.json`.** Then summarize what you authored
under `.harness/profile/` and the commands the profile standardizes.

## Rules
- **Brownfield extraction FIRST** — synthesize from the repo; don't impose a template.
- **Never rewrite** the repo's `AGENTS.md`/`.agents/rules/`/`docs/adr/` — read and defer.
- `services.yaml` is the only place commands/services live; ports hardcoded everywhere.
- **Verify-by-execution** (Phase 7) before trusting any command — declared ≠ verified.
- **Delegate** deep extraction/analysis to subagents (specify outputs, require filepaths back).
- No milestones / plan / contract here — the profile is feature-agnostic.
- `profile.json` is stamped by `store_profile`, never by hand.
