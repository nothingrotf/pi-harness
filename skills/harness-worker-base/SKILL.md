---
name: harness-worker-base
description: Universal worker startup + cleanup + handoff procedure every harness worker runs before its task-specific skill. Reads the cached profile + the feature run; ends with a structured handoff.
---

# Worker Base Procedures

You are a worker in a multi-agent feature delivery. **You own your assigned slice end-to-end** — a
single continuous session that delivers every task handed to you, not one task in isolation. That
slice is the **whole feature** when it fits one context budget (K=1), or **one task-budgeted batch**
of it when the feature is large enough to be split into batches (doc 05). Your bootstrap message
tells you which (it says "batch k/K" when batched). This skill defines the procedures ALL workers
follow. After startup you work through your task list, invoking each task's task-specific skill for
its work procedure.

> **Why one session for your whole slice (read this).** You run the startup below **once** and your
> context carries across every task in your slice — the code you wrote for task 1 is already in your
> head when you do task 2. Do NOT try to split your slice across sessions or stop after one task;
> that loses context, repeats the startup, and wastes tokens and time. The decomposition into tasks
> is *your* execution checklist, not a hand-off boundary. **If you are a batch worker (k/K):** the
> earlier batches are already committed by prior workers — do NOT redo them; read `git log`/diffs
> for any context you need. `next_task` hands you ONLY your batch's tasks and reports done at your
> batch boundary; later batches run after you in fresh sessions.

## Your Assigned Feature (an ordered list of tasks)

Your bootstrap message contains the **full ordered task list** for this feature (and
`.harness/runs/<feature-id>/plan.json` is the canonical copy). Each task has:
- `id` — task identifier
- `description` — what to build
- `skillName` — the skill you invoke for that task's work procedure
- `expectedBehavior` — what success looks like
- `fulfills` — contract assertion IDs (if present)

**Each task's `fulfills` lists contract assertions that must be true after that task.** Read them
in `contract.md` before starting — together they define "done" for the feature. Before finishing,
ensure every assertion across all your tasks would pass; if one can't be fulfilled in scope, flag
it in your handoff (don't silently drop it).

**Explicit technology choices are binding.** If the feature/orchestrator specified a
package, library, SDK, or tool, use that exact choice — don't substitute because it's
easier or already installed. If it's unavailable/blocked, return to the orchestrator
instead of substituting.

## Service Management via Manifest

`.harness/profile/services.yaml` is the **single source of truth** for commands and
services. Read it to find commands/services; for services use `start`/`stop`/`healthcheck`
exactly as declared. **Starting:** start `depends_on` first → run `start` → wait for
`healthcheck` (retry with backoff) → if it won't pass in a reasonable time, return to
orchestrator. **Stopping:** use the manifest's `stop` (port-based kills are allowed for
the declared port). **If the manifest is broken:** return to orchestrator
(`returnToOrchestrator: true`) — don't fix it yourself. If you discover reusable
services/commands future workers need, ADD them to `services.yaml` (Phase 3.3).

## CRITICAL: Never Kill User Processes

**FORBIDDEN:** `pkill`/`killall`/`kill` by process name; port-based kills on ports NOT in
`services.yaml`; killing any process you didn't start. **ALLOWED:** port-based kills using
the manifest's declared `stop`; killing by PID processes YOU started this session. Port
conflict on an undeclared port → return to orchestrator; NEVER kill the existing process.
Never violate the Boundaries in `harness.md`.

## Phase 1: Startup

### 1.1 Read Context (parallelize — single tool-call batch)
- `.harness/runs/<feature-id>/feature.md` — the feature intent + scope.
- `.harness/profile/architecture.md` — authoritative architecture (mandatory: understand how your task fits).
- the repo's own `AGENTS.md` + `.agents/rules/` — code conventions/DoD (governs how code is written).
- `.harness/profile/library/coding-principles.md` — generic code-quality bias the ship-gate **quality axis** scores against; internalize it before coding to avoid rework (defers to the repo's `AGENTS.md` on conflict).
- `.harness/profile/harness.md` — operational overlay: **Boundaries you must NEVER violate**, directives, testing guidance. May be updated mid-feature — always check for latest.
- if your task has `fulfills`, the specific assertions in `.harness/runs/<feature-id>/contract.md`.
- `.harness/profile/services.yaml` — how to run commands/services.
- `.harness/runs/<feature-id>/plan.json` — the task list (your task's milestone-free context).
- `git log --oneline -20` — recent history.
- `.harness/profile/library/` — distilled repo knowledge.

(CRITICAL) `harness.md` Boundaries and `services.yaml` are non-negotiable. Violating
Boundaries could damage the user's system or other projects.

### 1.2 Initialize Environment
Run `.harness/profile/init.sh` if it exists (idempotent). If init fails → EndFeatureRun
with `returnToOrchestrator: true` explaining the failure.

### 1.3–1.5 Understand & Check Library
Read `architecture.md` to understand the system and where your task fits. View your task's
context in `plan.json`. Check `library/` for technology-specific patterns/SDK usage.
**Load lessons:** read `.harness/profile/LESSONS.md` (the **Confirmed** section) and apply any
lesson relevant to your task's area — they're past verification failures distilled into rules
(e.g. "assert the resulting state, not the mock call count"). Only Confirmed; ignore
Candidate/Quarantined; skip if absent.

### 1.6 Online Research (Conditional)
If your task involves a technology/SDK/integration where you're unsure of idiomatic usage
and `library/` doesn't cover it, do an online lookup before implementing.

### 1.7 Start Services
Start needed services from `services.yaml` (`depends_on` first; wait for healthcheck). If
any fails → return to orchestrator immediately.

## Code Quality Principles (non-negotiable)
**Canonical source: `.harness/profile/library/coding-principles.md`** — the generic quality bias the
ship-gate **quality axis** scores against. Internalizing it up-front is how you avoid the
ship → quality-finding → fix-task → re-review loop. The essentials it encodes: avoid god files
(split when large); create reusable components (don't duplicate); minimum code that satisfies the
assertion (no unearned abstractions/flexibility); no spaghetti branching bolted onto unrelated
flows; keep changes focused; stay in scope (note clearly-unrelated issues in `discoveredIssues` as
`non_blocking` prefixed "Pre-existing:" — check `harness.md` "Known Pre-Existing Issues"
to avoid re-reporting; don't go off-track to fix them). On conflict, the repo's `AGENTS.md` wins.

## Phase 2: Work the tasks (one continuous session, driven by `next_task`)
The harness hands you tasks **one at a time** and records progress **by machine** — do NOT assume the
list, the `next_task` tool is the source of truth. Loop until it says you're done:

1. **Pull the next task:** call `next_task({ featureId })`. It returns the task spec (id, skillName,
   description, preconditions, expectedBehavior, fulfills) and records it as started. When it reports
   **all tasks are done**, stop the loop and go to Phase 3 (one `EndFeatureRun`).
2. **Invoke the task's `skillName` skill** and follow its Work Procedure. **If the skill doesn't
   exist**, do not proceed — EndFeatureRun with `returnToOrchestrator: true` explaining which skill
   is missing.
3. **Implement + verify** to satisfy that task's `expectedBehavior` and `fulfills` assertions
   (write tests per the `harness-generate-tests` skill where the task warrants them).
4. **Commit the repo change with the task id in the message** (e.g. `[<taskId>] <summary>`). You
   **MUST commit before moving on** — `next_task` re-hands you the same task until a commit lands
   (that git check is how the harness marks the task done deterministically, without trusting
   the message or you to self-report). The gate requires a **NEW commit on top** of the recorded
   HEAD (ancestry-checked): `git commit --amend` or a rebase moves HEAD but does NOT advance the
   task — always add a fresh commit.
5. **Call `next_task` again** for the following task.

**Resume / re-run safety (critical).** If you were restarted (a fresh attempt after a failure, or a
hard-kill recovery), just call `next_task` — it resumes at the next uncommitted task automatically
(it checks git HEAD, never re-completes an uncommitted task). Never redo committed work.

**Stop and return early** (one `EndFeatureRun` with `returnToOrchestrator: true`) if a task is
blocked by something outside your scope (missing dependency, unmet precondition, broken manifest,
a decision needed) — don't burn the remaining tasks against a blocker. Report what you completed
and what remains.

## Phase 3: Cleanup & Handoff

### 3.1 Final Validation
Run the verification step(s) from your task skill's Work Procedure (the gate from
`services.yaml`). Fix failures your work introduced. Don't hand off with broken verification.
**Tests you wrote must follow the `harness-generate-tests` skill**: thin/orchestration code is covered by
the harness-qa-validator E2E surface (no internal-mock unit test), fat/business-rule code gets focused
per-rule behavior tests that derive from the `contract.md` assertions (never from the
implementation), survive the adequacy review (evidence-or-zero, no shallow assertions), and are
mutation-killed by the discrimination sensor. `harness.md` §Testing overrides these defaults.

### 3.2 Environment Cleanup
Stop services you started (manifest `stop`); kill by PID anything else you started; ensure
clean git status in repos you changed (commit/stash). Run-artifact-only changes need no commit.

### 3.3 Add Discovered Services/Commands
If you found reusable services/commands future workers need, ADD them to `services.yaml`
(port hardcoded in `start`/`stop`/`healthcheck` + `port`; additive only).

### 3.4 Call EndFeatureRun (ONCE, for the whole feature)
After ALL tasks are done (or you hit a blocker), call `EndFeatureRun` **exactly once** for the
feature — not once per task. Use the `taskId` from your bootstrap (the implementation step id).
Report the aggregate result per your task skills' Example Handoff:
```
EndFeatureRun({
  successState: "success" | "partial" | "failure",
  returnToOrchestrator: boolean,
  commitId?, repoPath?,          // when repository code changed
  validatorsPassed: boolean,     // must be true if success
  handoff: {
    salientSummary, whatWasImplemented, whatWasLeftUndone,  // "" if truly complete
    verification: { commandsRun: [{command,exitCode,observation}], interactiveChecks: [{action,observed}] },
    tests: { added: [{file, cases:[{name,description}]}], coverage },
    discoveredIssues: [{severity, description, suggestedFix?}],
    skillFeedback: { followedProcedure, deviations, suggestedChanges? }
  }
})
```

#### Verification Hygiene
Do NOT pipe validators/tests through `| tail`/`| head` — pipes mask the real exit code.
Prefer narrower test selection over output truncation.

#### Skill Feedback
Reflect honestly: followed the procedure → `followedProcedure: true`, empty `deviations`;
deviated → record `{step, whatIDidInstead, why}`. Deviations aren't failures — they're data
that improves future workers (the orchestrator's learning loop updates the profile skills).

#### When to Return to Orchestrator
Set `returnToOrchestrator: true` when: you can't complete within Boundaries; a service
won't start / healthcheck fails; a dependency that SHOULD exist is inaccessible and you
can't restore it; blocked by missing deps / unmet preconditions / unclear requirements;
previous worker left broken state you can't fix; a decision/input is needed.

#### When You Cannot Validate Your Work
If an environment/access blocker prevents real verification (app logged out, page won't
load, service unreachable, credentials expired), do NOT report `success` and do NOT
silently defer the unverifiable check into a vague follow-up. Call EndFeatureRun with
`failure` (or `partial` if some assertions were genuinely verified) + `returnToOrchestrator:
true`, putting the exact blocker and which assertions remain unverified in `salientSummary`
and `discoveredIssues` (severity `blocking`). A clear blocking failure is what lets it get
fixed or escalated.

**CRITICAL: After calling EndFeatureRun, end your turn immediately.** No more work, no
other task, no further tool calls. Your session is complete.
