---
name: harness-deliver
description: Ship-gate step 3 (delivery analog). After scrutiny + user-testing pass, opens/assembles the PR, scrapes the linked Linear/Jira issue (branch + commits + PR body, droid-style), watches CI, runs a bounded safe fix-loop until green, then STOPS at a human merge/cancel gate. Never merges without explicit user confirmation. Runner-injected; always returns to orchestrator.
---

# harness-deliver — the delivery ship gate (PR → CI → merge gate)

You take a feature whose contract is green (scrutiny + user-testing passed) and **deliver it as a
pull request**: assemble the PR, link the Linear/Jira issue, drive CI to green with a bounded safe
fix-loop, then hand a mergeable PR to the **human merge/cancel gate**. You **never merge without
explicit user confirmation**. **Always return to the orchestrator** when done.

This is the harness analog of the standalone `ci-watcher` + `fix-ci` + `new-branch-and-pr` skills,
composed into one gated flow.

## Where things live (precedence)
| Source | Purpose | Precedence |
|---|---|---|
| `.harness/profile/harness.md` (§ Delivery / VCS / CI) | delivery instructions (PR conventions, base branch, CI source of truth) | **Highest — overrides all** |
| `.harness/profile/services.yaml` | `test` / `typecheck` / `lint` commands to reproduce CI failures locally | |
| `.harness/runs/<feature-id>/feature.md` + `contract.md` | what shipped — the PR summary + assertions | |
| `.harness/runs/<feature-id>/` status | every assertion must be `"passed"` before delivery | |
| `.harness/runs/<feature-id>/validation/delivery/record.json` | delivery record (output) — **written via the `store_delivery` tool**, read by the cockpit Delivery tab | |
| `src/linear-link.ts` (harness package) | canonical, tested Linear/Jira link extractor (droid §4.1 port) | |

**The interface (cockpit).** Every `store_delivery` call updates the **Delivery tab** in Feature
Control (Ctrl+T) live (PR · linked issue · CI checks · fix-loop · merge state). Call it at each
transition so the human watching the cockpit sees progress — don't batch. The human **merge gate**
is a TUI overlay, not a chat question: you trigger it by writing `state:"awaiting_merge"` (Step 5).

## 0) Preconditions — refuse to deliver an unfinished feature
1. Read status — **every in-scope assertion must be `"passed"`.** If not, STOP and return to the
   orchestrator: delivery runs *after* scrutiny + user-testing are green, not before.
2. Read `validation/delivery/record.json` if it exists (or open the Delivery tab) → a non-empty
   record with a `prNumber` means a **re-run** (PR already opened): skip to the CI watch/fix-loop
   (Step 3) for the existing PR, don't open a second one.
3. Confirm `gh auth status` and a clean-enough tree. Commit any pending feature work on the
   feature branch first (conventional-commit subject). Never deliver with an unrelated dirty tree.

## 1) Resolve the linked Linear / Jira issue (droid-style scrape)
Gather three signals and extract issue references — **branch + commits + PR body**:

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMITS=$(git log --format=%s origin/<base>..HEAD)   # subjects only
# PR body draft (from feature.md summary; see Step 2)
```

Extraction rules (identical to droid's `extractLinkedIssueMetadata`, doc `09` §4.1):
- **Linear (authoritative):** any URL `https://linear.app/<workspace>/issue/<ID>/...` → `<ID>` (e.g. `ENG-123`).
- **Jira (authoritative):** any URL `<site>/browse/<KEY>` where `KEY` matches `^[A-Z][A-Z0-9_]*-\d+$`.
- **Bare key candidates:** `ENG-123`-style tokens in the **branch name** (`user/eng-123-slug` is
  Linear's branch convention) or **commit subjects** → *candidate* Linear issues (ambiguous with
  Jira without the `/browse/` URL, so confirm before relying on them).

Run the canonical tested extractor (deterministic) by piping a JSON payload to it:
```bash
printf '%s' "$(jq -n --arg b "$BRANCH" --arg body "$PR_BODY" --arg fid "<feature-id>" \
  '{branch:$b, prBody:$body, featureId:$fid, commits:($COMMITS|split("\n"))}' )" \
  | node --experimental-strip-types <harness-pkg>/src/linear-link.ts
# → { linearIssueIds, jiraIssueKeys, linkedTicketUrls, candidateKeys }
# NB: the harness feature id usually encodes the issue (e.g. `work-on-linear-issue-adm-84-…`
# → candidate ADM-84). feature.md's title also names it — use both to build the `Closes` line.
```
If you cannot resolve the harness package path, fall back to scanning yourself with the rules
above. If `linearIssueIds`/`jiraIssueKeys` are empty and there are `candidateKeys`, and an
`ask_user_question` tool is available, confirm the issue once; otherwise note "no issue linked" —
**a missing link is non-fatal** (it only widens `attributionGaps` in analytics, doc `09` §5.2).

## 2) Assemble & open the PR
- **Branch:** the harness already created the feature branch at run-start (`{type}/{key}-{slug}` from
  `.harness/profile/delivery.json`) when on a clean base — so `HEAD` is usually the feature branch.
  If `HEAD` is still the base branch (branch-per-feature was skipped/opted out), the work is on the
  base; surface that rather than opening a base→base PR.
- **Base branch:** read `branch.base` from `.harness/profile/delivery.json` (fallback: `harness.md`
  §Delivery, default the repo's main branch). **Sync** first (`git fetch origin`).
- **Body:** a concise summary from `feature.md` (what shipped) + the contract assertions that
  passed (the verification record) + a **"Closes"** line for each resolved Linear/Jira issue
  (`Closes https://linear.app/<ws>/issue/<ID>/...`) so the link is persisted in the PR body (doc
  `09` §4.1: putting the Linear URL in the body is enough to link it).
- **Open:** `git push -u origin HEAD` then `gh pr create --base <base> --title <conv-title> --body <body>`.
  If a PR already exists for the branch, **update** it (`gh pr edit`) instead of creating a duplicate.
- **Publish to the cockpit:** call **`store_delivery`** with `state:"open"`, the `prNumber`/`prUrl`/
  `prTitle`/`baseBranch`/`headBranch`, and the resolved `linkedIssues`. This lights up the Delivery
  tab (Ctrl+T).

## 3) Watch CI (ci-watcher analog)
`gh pr checks` is the **source of truth** for overall PR CI state.
```bash
gh pr checks --json name,bucket,state,workflow,link   # snapshot
gh pr checks --watch --fail-fast                        # block until settled
```
- After each settled snapshot, call **`store_delivery`** with the `ci.checks` array (map each
  check's bucket to `passed`/`failed`/`pending`/`skipped`) and `ci.state` so the cockpit reflects CI live.
- All green → go to Step 5 (merge gate).
- Any failure → go to Step 4 (fix-loop).
- External (non-Actions) check failed → open its `link`, identify the failing command/service.

## 4) Bounded safe fix-loop (fix-ci analog) — **max 3 iterations**
Iterate red → green, **one actionable failure at a time**:
1. **Find the first actionable error.** For a failed GitHub Actions check: `gh run view <run-id> --log-failed`.
   Extract the root error, not just the exit code.
2. **Reproduce locally** with the matching `services.yaml` command (`test`/`typecheck`/`lint`) before fixing.
3. **Apply the smallest safe fix.** **Scope guard:**
   - ✅ Free to fix: lint/format, type errors, flaky/config/CI-infra, obvious test wiring.
   - 🛑 **Product-logic / behavioral changes require a human checkpoint** — if green demands changing
     business logic (or a test that encodes a contract assertion), STOP and ask the user via
     `ask_user_question` (or return to the orchestrator with the specific decision). Don't silently
     alter behavior to force green.
   - 🚫 Never disable, skip, `xfail`, or delete a check to fake green.
4. **Push and re-check.** `git push`, then re-run `gh pr checks --watch --fail-fast`. Call
   **`store_delivery`** after each iteration with the updated `ci.iterations`, `ci.checks`, and the
   `fixesApplied` entry (e.g. `"eslint --fix"`) — the cockpit shows the fix-loop ticking.
5. **Cap:** after **3** iterations still red → STOP. Call **`store_delivery`** with `state:"ci_blocked"`
   and `ci.primaryFailure` (failing job + root error), then return to the orchestrator (it may create a fix task).

If a fix touches a contract assertion's behavior, flag it — the orchestrator may need to re-run the
relevant ship-gate step.

## 5) Human merge/cancel gate — a TUI overlay, **never merge autonomously**
When CI is green **and** the PR is mergeable (`gh pr view --json mergeable,mergeStateStatus,reviewDecision`):

1. Call **`store_delivery`** with `state:"awaiting_merge"` (CI checks all `passed`). This **pops the
   merge-gate overlay** in the cockpit — a Merge / Cancel / Leave-open menu (the human's call). Then
   **end your turn** and wait: the human's choice comes back to you as a `[harness-deliver] Human
   merge gate decision…` message.
2. **Act on the injected decision** (it names the exact `gh`):
   - **MERGE** → `gh pr merge --squash` (respect `harness.md` strategy); the `Closes <issue>` line
     transitions the Linear/Jira issue → call `store_delivery` `state:"merged"`.
   - **CANCEL** → `gh pr close --delete-branch` → call `store_delivery` `state:"cancelled"`.
   - **LEAVE OPEN** → call `store_delivery` `state:"open"`; a human merges later.

If `mergeable` is false for a non-CI reason (conflicts, required reviews), **don't** write
`awaiting_merge` — surface the blocker (fix conflicts, or return to the orchestrator). The overlay is
only for a genuinely mergeable PR. (No `ask_user_question` here — the overlay *is* the interface.)

## 6) Return
The final `store_delivery` (Step 5.2) is the record. **Return to the orchestrator** with: PR url,
linked issue(s), final CI state, and the merge decision. The feature's contract was already green
before this step — delivery state (merged/open/cancelled) is reported, not a gate on assertion success.

## Guardrails (the contract of this gate)
- **Never merge without explicit user confirmation.** The merge-gate overlay is the only path to a
  merge; you trigger it with `store_delivery` `state:"awaiting_merge"`, never `gh pr merge` on your own.
- **Drive the cockpit:** call `store_delivery` at every transition (open / CI change / fix / await) —
  the Delivery tab is the live interface; don't go silent.
- **`gh pr checks` is the source of truth** for CI state — not Actions-only views.
- **Bounded loop (≤3) and one fix at a time** — no speculative batches; product-logic fixes escalate.
- **Never fake green** (disable/skip/xfail/delete a check) to force merge-ability.
- **Linear link is best-effort** — a missing link is non-fatal; never block delivery on it.
- **Idempotent** — a re-run reuses the existing PR; never open duplicates.
