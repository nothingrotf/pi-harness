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
- **profile** `.harness/profile/`: `services.yaml`, `harness.md`, `architecture.md`, `library/` (incl. **`conventions-map.md`** + **`coding-principles.md`**), `skills/`
- **repo root** (cwd): implementation code

## 0) Programmatic gate (deterministic, once — not LLM)

**0.a Preflight — never run the gate into a broken environment.** A red gate aborts this whole step
before the axes launch, so a red caused by a missing service costs the entire review. Before running
anything:
- Read the run's `ports_preflight` event (`progress_log.jsonl`, written at run start) — it lists
  every port `services.yaml` declares, whether something is listening, and the owning process.
- For each service the gate needs: not listening → **start it** per `services.yaml` and wait for its
  `healthcheck`. Listening but owned by a **foreign** process (another project's container — compare
  against the service's `notes`/`healthcheck` container name) → that is a **blocking environment
  issue, not a red gate**: `EndFeatureRun` `successState: "failure"`, `returnToOrchestrator: true`,
  naming the port, the expected owner and the actual owner in `discoveredIssues`. Never report it as
  a code failure — in real runs a foreign MinIO on :9000 answered HTTP 403 instead of refusing the
  connection, and the suite failure named no port at all.
- Record what you started in `verification.commandsRun` so the qa-validator knows the state.

**0.b Run the gate.** Run the programmatic validators from `.harness/profile/services.yaml` over the
integrated result: `commands.test`, `commands.typecheck`, `commands.lint`. **Do NOT pipe through
`| tail`/`| head`** (masks exit codes). Each task already ran these at handoff; this single
integrated run catches **cross-task breakage** (task A green + task B green, A+B red).

**0.c Green is not enough — confirm the suite actually RAN.** Read the test output and find the
collected/passed count. A runner that collected **zero** tests exits 0 and is indistinguishable from
a clean pass: `No test files found`, `Test Files no tests`, `collected 0 items`, `Tests: 0`. That is
a **broken gate command**, and it happened six times across the real runs — `bunx vp test --project
X run` puts `run` after `--project`, which vp reads as a name filter, collects nothing and reports
green. Treat zero collection exactly like a red gate, and say so: the fix is `services.yaml`, not
the code. Also treat a **suspiciously small** count (orders of magnitude below the repo's usual)
as a broken selection worth one sentence of verification.

**0.d Suppressed failures.** A failure matching `dismissed.json` or `harness.md` §"Known
Pre-Existing Issues" goes in `suppressed` (§0.5) and does NOT make the gate red.

Attempt only trivial fixes (auto-fix lint, obvious type/snapshot). If still failing →
`EndFeatureRun` `successState: "failure"` + `returnToOrchestrator: true` with the failing commands
in `verification.commandsRun` and the issue in `discoveredIssues`. **Do not launch the review axes
on a red gate.**

## 0.5) Prior-run check (re-run scoping — do NOT re-review the whole diff every round)
Read `.harness/runs/<feature-id>/validation/harness-code-review/synthesis.json` if it exists (a
previous round). If absent → this is **round 1**, full review (below).

**Verdict reuse (patch-id — check BEFORE anything else re-runs).** A verdict pins the *content* it
reviewed, not the SHA. Compute the current range's content id:
`git diff <base>..HEAD | git patch-id --stable | awk '{print $1}'`. If the prior synthesis has
`status: "pass"` and its `rangePatchId` equals the current one (HEAD identical, or moved only by
rebase/amend with byte-identical content), **the prior verdict stands**: do NOT re-run the gate,
the sensor, or the axes. Write `synthesis-r<round>.json` + `synthesis.json` copying the prior
synthesis with `round` incremented, `scope: "verdict-reuse"`, updated `reviewedHead`, and a
`salientSummary` naming the reused round — then `EndFeatureRun` `success`. If the patch-ids
differ, the delta is real: proceed below (and on a fix re-run, the fix commits are exactly that
delta). This is what makes a no-op re-invocation cost one git command instead of a full review.

If present and the content changed → this is a **re-run after fix tasks**, and you MUST narrow
scope, not repeat the whole 3-axis pass:
- Set `round` = previous `round` + 1 and carry the prior synthesis as `previousRound` context.
- **Scope the diff to the FIX commits only** — read `reviewedHead` straight out of the prior
  synthesis and diff `git log <reviewedHead>..HEAD`. Do NOT reconstruct it from the progress log or
  handoffs; §5 mandates the field precisely so this is one read. Each axis reviews the fix diff
  **together with the original blocking finding it addresses** (pass the prior `blockingFindings`
  as input) so it verifies the fix actually resolves the issue AND introduces no regression — not a
  blind re-scan of untouched code.
- **Load `litigatedFindings`** (the cumulative ledger, §5). It carries every finding any round has
  already judged, with its verdict. You do not re-raise anything in it — that is how a rewritten
  sentence oscillates between two opposite verdicts across rounds. Pass it to every axis.
- **Verify MULTI-PART prior findings part by part.** A finding with two clauses is resolved only
  when both are. A fix handoff claiming a whole finding closed after addressing the headline half
  is the observed failure; check each clause against HEAD yourself.
- Findings the prior round already cleared are NOT re-litigated unless the fix touched their files.
This is the droid scrutiny re-run protocol (review only fix features, original+fix together) and it
is what the orchestrator promises ("re-run only re-checks what failed"). Round 1 reviews the whole
feature diff; later rounds review the delta.

**Suppressed inputs (do NOT let these fail the run):** before §0, read `.harness/runs/<feature-id>/dismissed.json`
and `harness.md` §"Known Pre-Existing Issues". A gate failure or finding matching either is reported
in `suppressed` and does not make `status: "fail"` — three consecutive rounds of one real feature
burned on already-dismissed flakes.

## 1) Gather the feature diff + worker evidence (scope)
Collect what the reviewers need to judge **claims vs reality**, not just the diff:
- the diff from the feature's base to HEAD (round 1) or the fix delta (re-run, per §0.5), plus the
  full contents of the changed files. **Write the diff ONCE to
  `.harness/runs/<feature-id>/validation/harness-code-review/diff.patch` and hand the axes the
  PATH, not the content.** Each axis reads the file in its own context; you do not hold the full
  diff in yours. Re-dumping `git diff` into the orchestrating session is a measured waste — one
  real gate re-ran it 13 times across 20 sessions, each dump re-billed on every later turn;
- the **worker handoffs** `.harness/runs/<feature-id>/handoffs/*.json` (what the worker *claims* it
  implemented, tested, and left undone) and, when present, the **worker transcript skeleton**
  (`sessions/*.jsonl` tool/'message' skeleton) — so a reviewer can check a claim ("added tests for
  X", "handled the error path") against the actual diff and flag procedure deviations.
Use Bash directly, or an `Explore` agent when the changed set is large.

## 1.5) Discrimination sensor (do the tests actually catch regressions? — bounded, scratch-state only)
The programmatic gate (§0) proves the suite **runs green**; it does NOT prove the tests would
**fail** on a real regression. This is the TLC-Verifier discrimination check (doc 05 phase 7),
author≠verifier: the workers wrote these tests; you independently confirm they discriminate. Run it
after a green gate, **only over the feature/fix diff's changed code**, and **only in scratch state**
(never mutate the real tree):
1. Pick **1–3** behavior-level mutations on the changed code (tiered: 1–2 for a standard feature,
   ≥3–5 for a P0/critical path — auth, payments, migrations). A mutation is a small semantic flip:
   invert a condition, change a returned value, drop a required side effect, off-by-one on a bound.
   Target lines that a `fulfills` assertion or a listed edge case depends on — not cosmetic code.
2. Apply each mutation in **throwaway state** (`git stash`/a temp worktree/an in-place edit you will
   `git checkout --` immediately after), run the **relevant** tests (narrow selection, not the whole
   suite), and confirm they **FAIL** (kill the mutant). Then **discard the mutation** — the real
   working tree must be byte-identical afterward (verify `git status` clean).
3. A **surviving** mutant (tests still pass with the fault) = the suite doesn't discriminate that
   behavior → a finding (`axis: "correctness"`, `finding: "tests survive mutation: <what>"`,
   `file:line`). **Blocking on round 1 only.** From round 2 a survivor is `deferred` unless the
   mutated line is itself the fix for a prior blocking finding — every fix writes fresh lines that
   no test was written against, so a late-round sensor manufactures a survivor on demand and the
   loop never terminates (observed: survivors reported as blocking in rounds 5, 7, 8 and 17 of one
   feature). Record killed/survived per mutation in the synthesis (`sensor` block below).
Do NOT weaken or delete tests here; you only probe them. If the gate was red you never reach this
step. Keep it bounded — this is a sensor, not full mutation-testing tooling.

## 2) Launch the three axes in parallel
Spawn all three via the **`Agent` tool** (@tintinweb/pi-subagents) **in the same message** — one
`Agent` call per axis with `run_in_background: true` on each so they run concurrently as isolated
fresh-context sessions, **visible live in the UI**. Pass each the **same** scoped inputs:
`### Git / diff output`, `### Changed file contents`, `### Worker handoffs (claims)`, and (when
present) `### Worker transcript skeleton` + (on a re-run) `### Prior blocking findings`. The
handoff/transcript let a reviewer audit worker claims and procedure deviations, not just the code.
Ask each axis to ALSO emit `sharedStateObservations` (`{area, observation, evidence}`) for facts
about the repo/profile it noticed while reviewing (a stale command, a missing boundary, an
undocumented pattern) — you triage those in §4. The three axes:
- `harness-correctness-review` — bugs, breaking changes, security, devex regressions, feature-flag leaks. **Generic.**
- `harness-quality-review` — maintainability, structure, file-size growth, spaghetti, abstractions, code-judo. Scores against the cached **`.harness/profile/library/coding-principles.md`** (the same generic bias the worker read up-front — author-review symmetry), then goes beyond it. **Generic.** Tell it where the doc is.
- `harness-conventions-review` — conformance to THIS repo's rules/ADRs via the cached
  **`.harness/profile/library/conventions-map.md`** (and the live rule/ADR files it indexes).
  Tell it where the map is. **Repo-aligned.**

Ask each for prioritized findings with `file:line` references and evidence.

## 3) Synthesize
After all three finish, synthesize **findings first**, deduplicated across axes. Weight overlapping
findings more heavily (same issue flagged by 2+ axes = high signal), resolve disagreements with
your judgment, keep it brief. The three axes are complementary, not redundant: correctness/security,
structural maintainability, and house-pattern conformance each catch a distinct class.

### Severity floor (HARD — this decides whether the feature ships)
`blocking` is not "the reviewer would prefer otherwise". A finding is **blocking** only if it is
both (a) one of these classes and (b) **reachable** — demonstrated on a live path, not hypothetical:
- a **correctness or security defect** in shipped behavior (wrong result, data loss, race, injection,
  auth bypass, money moved twice);
- a **frozen contract assertion** in `contract.md` that the code does not satisfy;
- a **red programmatic gate** or a migration/rollout that cannot be applied;
- a **shared derivation re-computed** by a consumer (`feature.md` §Shared derivations) **where the
  two expressions can disagree** — show the input where they differ or the path where one updates
  without the other. Duplication that provably agrees on every input is non-blocking;
- **round 1 only:** a surviving discrimination mutant (§1.5).

Everything else is **non-blocking**, no matter how strongly an axis words it. Explicitly non-blocking,
always: documentation / ADR / runbook / comment prose that disagrees with the code; naming; file
layout; duplication; a missing test for already-correct behavior; "this could be extracted";
style. These are real — they go in `nonBlockingFindings` and become the **backlog**, not a fix task.

Why the floor exists, from this harness's own runs: across 100 review rounds, **83% of blocking
findings raised after round 1 were introduced by the previous round's fix**. In one feature, rounds
9–13 produced 7 consecutive blocking findings that were all ADR/runbook wording, while the reviewer
had already written at round 8 *"the code is correct on every reachable path"*. Prose contradictions
blocked a shipped, correct feature for 5 rounds. **Wording never blocks a release.**

### Round-aware posture
Read `round` from §0.5. Your job changes as it climbs:
- **round 1** — full review, full severity range. This is where real defects are found; spend here.
- **rounds 2–3** — verify the prior blockers are resolved; new blockers only under the floor above.
- **round 4+** — **convergence posture.** State it explicitly in `salientSummary`. Raise a new
  blocker ONLY for a correctness/security/contract defect you can demonstrate by execution. Anything
  else, including every finding you would have raised at round 1, goes to `deferredFindings` with a
  one-line reason. If the correctness axis returns zero blocking findings, say so and pass.
- A finding already recorded in `litigatedFindings` (§5) with verdict `resolved` or `deferred` is
  **not re-raised** unless you can show the same defect is live again at HEAD.

`status: "fail"` iff `blockingFindings` is non-empty or the gate is red. Non-blocking findings
NEVER produce `fail` — a feature does not stop shipping over prose.

## 4) Learning loop (light)
The **blocking findings** in your synthesis are the grounded signals the orchestrator distills into
project-local **lessons** via `store_lesson` (`signal: blocking_finding`, `source` = the finding's
`file:line`) — surface them precisely (`file:line` + rule) so the lesson is groundable.

**Triage the `sharedStateObservations` the axes emitted** through a first-principles rubric — route
each to exactly one bucket, and record the losers too (don't let a rejected observation vanish):
- **apply now** (`appliedUpdates`) — a factual, confident operational correction to a file you own
  here (`services.yaml`, `library/`): a stale command, a wrong port, a missing test doc. Apply it.
- **recommend** (`suggestedGuidanceUpdates`) — a **systemic** pattern the repo's guidance should
  encode, or a conventions-map gap: target **`harness.md`**, a profile **worker skill**,
  **`conventions-map.md`**, or — for a generic code-quality pattern workers should preempt —
  **`coding-principles.md`** (closing the loop: the quality finding becomes a principle the next
  worker reads up-front). **Never** the repo's own AGENTS.md. The orchestrator acts on these.
- **reject** (`rejectedObservations`) — out of scope, already documented, subjective, or wrong.
  Record `{observation, reason}` so the judgment is auditable and the same observation isn't
  re-surfaced verbatim next round.

## 5) Write synthesis + return to orchestrator
Write **both** `.harness/runs/<feature-id>/validation/harness-code-review/synthesis-r<round>.json`
(immutable, one per round) **and** `synthesis.json` (the same content — the pointer the next round
reads). The per-round copy exists because a single overwritten path leaves one round of memory, and
one round of memory is what lets round N+2 re-decide what round N settled.
```json
{
  "feature": "<feature-id>", "round": 1, "status": "pass" | "fail",
  "scope": "full" | "fix-delta" | "verdict-reuse",
  "reviewedHead": "<full sha of HEAD at review time>",
  "range": "<baseSha>..<reviewedHead>",
  "rangePatchId": "<git diff <base>..HEAD | git patch-id --stable — content id of the reviewed range>",
  "gate": { "test": {"passed":true}, "typecheck": {"passed":true}, "lint": {"passed":true} },
  "suppressed": [ { "what":"...", "source":"dismissed.json|harness.md" } ],
  "sensor": { "mutations": 2, "killed": 2, "survived": 0, "survivors": [] },
  "axes": { "correctness": {...}, "quality": {...}, "conventions": {...} },
  "blockingFindings": [ { "axis":"correctness|quality|conventions", "file":"...", "line":0, "finding":"...", "rule":"<rule or null>", "reachability":"<how you demonstrated it is live>" } ],
  "nonBlockingFindings": [ { "axis":"...", "file":"...", "line":0, "finding":"..." } ],
  "deferredFindings": [ { "finding":"...", "reason":"convergence posture round 4+ | sensor after round 1" } ],
  "litigatedFindings": [ { "id":"R1-B1", "round":1, "finding":"...", "verdict":"resolved|deferred|open|withdrawn", "evidence":"..." } ],
  "appliedUpdates": [ { "target":"services.yaml|library", "description":"..." } ],
  "suggestedGuidanceUpdates": [ { "target":"harness.md|skills|conventions-map.md|coding-principles.md", "suggestion":"...", "evidence":"...", "isSystemic":true } ],
  "rejectedObservations": [ { "observation":"...", "reason":"..." } ],
  "previousRound": null
}
```
`litigatedFindings` is **cumulative and append-only**: copy the prior round's array forward, update
the verdicts you resolved this round, append this round's new findings. It is the feature's memory.

On a re-run set `round` (incremented), `scope: "fix-delta"`, and `previousRound` = a short digest of
the prior synthesis (its round + which blocking findings it raised) so the trail is self-describing.
Call `EndFeatureRun` with `returnToOrchestrator: true` (always). Blocking findings or a red gate →
`successState: "failure"`; otherwise `"success"`. Put the synthesis path **and the round number** in
`salientSummary`. The orchestrator creates fix tasks for blocking findings **only** (§3 floor —
non-blocking findings are backlog and MUST NOT be dispatched as fixes), acts on
`suggestedGuidanceUpdates`, then the harness-qa-validator step runs next.

To run a single axis ad-hoc, spawn that one agent directly instead of this orchestrator.
