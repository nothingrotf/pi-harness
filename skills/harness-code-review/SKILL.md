---
name: harness-code-review
description: Ship-gate step 1 — the holistic end-of-feature review. Runs the deterministic programmatic gate once, then launches three review axes in parallel (correctness, code-quality, conventions) over the feature's accumulated diff, and synthesizes. Runner-injected; always returns to orchestrator.
---

# harness-code-review — holistic ship gate (correctness · code-quality · conventions)

You are the end-of-feature review gate, run **once** when all implementation tasks complete —
not between tasks. You run the deterministic gate, then launch three review axes in parallel
over the feature's accumulated diff, and synthesize. **Always return to the orchestrator.**

Cost posture (deliberate): there are **no per-task LLM reviews** — each task already verified the
programmatic gate at handoff (`harness-worker-base`). harness-code-review pays its LLM cost **once**: three parallel
axis reviewers over the whole diff. Keep it that way.

## Where things live
- **run dir** `.harness/runs/<feature-id>/`: `feature.md`, `contract.md`, `plan.json`, `handoffs/`, `validation/`
- **profile** `.harness/profile/`: `services.yaml`, `harness.md`, `architecture.md`, `library/` (incl. **`conventions-map.md`**), `skills/`
- **repo root** (cwd): implementation code

## 0) Programmatic gate (deterministic, once — not LLM)
Run the programmatic validators from `.harness/profile/services.yaml` over the integrated result:
`commands.test`, `commands.typecheck`, `commands.lint`. **Do NOT pipe through `| tail`/`| head`**
(masks exit codes). Each task already ran these at handoff; this single integrated run catches
**cross-task breakage** (task A green + task B green, A+B red). Attempt only trivial fixes
(auto-fix lint, obvious type/snapshot). If still failing → `EndFeatureRun` `successState:
"failure"` + `returnToOrchestrator: true` with the failing commands in `verification.commandsRun`
and the issue in `discoveredIssues`. **Do not launch the review axes on a red gate.**

## 1) Gather the feature diff (scope)
Collect the feature's accumulated changes + the changed-file contents so the reviewers evaluate
without guessing: the diff from the feature's base to HEAD (the task commits of this run) plus the
full contents of the changed files. Use Bash directly, or an `Explore` agent when the changed set
is large.

## 2) Launch the three axes in parallel
Spawn all three via the **`subagent` tool** (pi-subagents) **in the same message** — they run as
isolated fresh-context sessions and are **visible live in the UI**. Pass each the **same** scoped
diff + file contents (`### Git / diff output` and `### Changed file contents`):
- `correctness-review` — bugs, breaking changes, security, devex regressions, feature-flag leaks. **Generic.**
- `quality-review` — maintainability, structure, file-size growth, spaghetti, abstractions, code-judo. **Generic.**
- `conventions-review` — conformance to THIS repo's rules/ADRs via the cached
  **`.harness/profile/library/conventions-map.md`** (and the live rule/ADR files it indexes).
  Tell it where the map is. **Repo-aligned.**

Ask each for prioritized findings with `file:line` references and evidence.

## 3) Synthesize
After all three finish, synthesize **findings first**, deduplicated across axes. Weight overlapping
findings more heavily (same issue flagged by 2+ axes = high signal), resolve disagreements with
your judgment, keep it brief. The three axes are complementary, not redundant: correctness/security,
structural maintainability, and house-pattern conformance each catch a distinct class. Any
**blocking** finding (correctness/security defect, ADR/boundary contradiction, structural
regression that must not ship) → `status: "fail"`.

## 4) Learning loop (light)
The **blocking findings** in your synthesis are the grounded signals the orchestrator distills into
project-local **lessons** via `store_lesson` (`signal: blocking_finding`, `source` = the finding's
`file:line`) — surface them precisely (`file:line` + rule) so the lesson is groundable.

When a finding is **systemic** (a pattern the repo's guidance should encode, or a gap in the
conventions-map), record it as `suggestedGuidanceUpdates` in the synthesis, targeting
**`harness.md`**, a profile **worker skill**, or **`conventions-map.md`** — never the repo's own
AGENTS.md. The orchestrator acts on these (the profile-refresh loop). Factual operational fixes
you're confident about (a `services.yaml`/`library` correction) you may apply directly and record
as `appliedUpdates`.

## 5) Write synthesis + return to orchestrator
Write `.harness/runs/<feature-id>/validation/harness-code-review/synthesis.json`:
```json
{
  "feature": "<feature-id>", "round": 1, "status": "pass" | "fail",
  "gate": { "test": {"passed":true}, "typecheck": {"passed":true}, "lint": {"passed":true} },
  "axes": { "correctness": {...}, "quality": {...}, "conventions": {...} },
  "blockingFindings": [ { "axis":"correctness|quality|conventions", "file":"...", "line":0, "finding":"...", "rule":"<rule or null>" } ],
  "appliedUpdates": [ { "target":"services.yaml|library", "description":"..." } ],
  "suggestedGuidanceUpdates": [ { "target":"harness.md|skills|conventions-map.md", "suggestion":"...", "evidence":"...", "isSystemic":true } ],
  "previousRound": null
}
```
Call `EndFeatureRun` with `returnToOrchestrator: true` (always). Blocking findings or a red gate →
`successState: "failure"`; otherwise `"success"`. Put the synthesis path in `salientSummary`. The
orchestrator creates fix tasks for blocking findings (re-run only re-checks what failed), acts on
`suggestedGuidanceUpdates`, then the harness-qa-validator step runs next.

To run a single axis ad-hoc, spawn that one agent directly instead of this orchestrator.
