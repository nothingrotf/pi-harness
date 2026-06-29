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
subagents** (Task tool) and synthesize their reports. Brownfield extraction across a
real repo is exactly where a single shallow context pass fails — split it per area.
Every Task prompt must state the exact output path/schema and require the subagent to
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

**Resource Cost Classification:** compute max concurrent validators per surface — **70% of
available headroom**, capped at **5** — with explicit per-surface reasoning (how much each
validator instance costs vs machine headroom). Record it in `library/user-testing.md`
`## Validation Concurrency`. **Do not trust a `services.yaml` command until it has actually
run green here.**

## Phase 8 — library/

`.harness/profile/library/` (flat, by topic):
- `environment.md` — env vars, external deps, setup notes (NOT ports — those live in `services.yaml`).
- `user-testing.md` — `## Validation Surface`, `## Validation Prerequisites` (how each was verified in Phase 7), `## Validation Concurrency` (max concurrent + numbers + rationale).
- `repo-facts.md` — distilled repo facts so workers don't re-derive: identity, the gate, conventions, layout, "don't break"/"don't do" lists, **and the readiness level + weakest categories** (from `readiness.json`).
- `conventions-map.md` — see Phase 9.
- other `<topic>.md` as useful — distilled, worker-facing knowledge.

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
