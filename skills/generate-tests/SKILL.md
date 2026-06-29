---
name: generate-tests
description: Author tests that catch real bugs, not coverage numbers. Classifies each unit as thin (orchestration → covered by the qa-validator E2E surface, no internal-mock unit test) or fat (business rules → focused behavior tests, one rule per test, real objects, mock only at the boundary), then enforces quality with a classification-gated coverage matrix, an evidence-or-zero adequacy review, and a discrimination (mutation) sensor. Behavior-driven and wired into the harness (services.yaml commands, harness.md §Testing precedence, contract.md assertions, qa-validator). Use whenever a worker writes/updates tests for a task, or when asked "does X need tests?".
---

# generate-tests — behavior-driven tests (thin/fat) with adequacy + mutation gate

You are a test author who values **tests that catch real bugs over tests that inflate coverage
numbers**. A test exists to describe and verify **behavior**, never to document **implementation**.
Before writing any test ask: *"does this describe a business rule, or just restate how the code is
wired?"* If the best name you can give a test paraphrases the implementation, it does not justify
existing as a unit/integration test.

## The spine: thin vs fat (this gates everything below)

Every unit sits on a spectrum. The classification — not a layer quota — decides what to test.

**Fat** — contains business logic worth testing in isolation:
- Conditional branches (`if`/`switch`/ternary) that encode business rules
- Validation / invariant enforcement (rejecting bad input)
- Data transformations (mapping, normalizing, computing derived values)
- Error handling with business meaning (lock after N attempts, rate limiting)
- State machines / multi-step flows with branching outcomes

**Thin** — orchestration that delegates with no branching:
- Receives input, calls a repository/service, returns the result
- Chains calls in sequence without branching
- Passes data through with no transformation

→ **Fat → focused behavior tests.** **Thin → covered by the E2E surface; no dedicated internal-mock test.**

**Why mocks are dangerous for thin code.** Mocking the repository inside a thin use case tests *how*
the code is wired, not *what* it does. Refactoring the internals (which should be safe) breaks the
mock expectations: red tests, zero bugs — the opposite of testing's purpose. **Mock only at the
boundary** (HTTP, DB, external service, side effects you can't afford), and only when you must.

## Where this fits in the harness

- **Who runs it.** A worker invokes this while writing/updating tests for its task (the test part of
  its `skillName` Work Procedure). The discrimination sensor (Step 7) may also be run by `code-review`
  over the feature diff. `qa-validator` is where **thin code's E2E coverage actually lands**.
- **Source of WHAT to assert** (in precedence): the task's `fulfills` → the matching `contract.md`
  assertions (`VAL-*`, black-box, with their Evidence), then the task's `expectedBehavior`, then the
  spec/feature.md. **Tests derive from these, never from reading the implementation.**
- **Source of COMMANDS:** `.harness/profile/services.yaml` only (`test`/`typecheck`/`lint`). Never
  invent a command or assume an ecosystem — read the manifest. If a needed command is missing, return
  to the orchestrator (don't guess).
- **Precedence for testing rules:** `harness.md` §Testing & Validation Guidance (highest) → the repo's
  own `AGENTS.md` / `.agents/rules/` (style, location, framework) → the defaults in this skill.
- **Thin ⇒ E2E ⇒ qa-validator.** In the harness, the "E2E that covers thin code" is the qa-validator
  black-box assertion through the real surface (`agent-browser`/`tuistory`/`curl`). E2E does **not**
  require a frontend — for an API it's an HTTP call. So thin code is **not** "unverified": its
  verification is the `contract.md` assertion, not an internal-mock unit test.

## Procedure

### 1. Classify the unit (thin or fat) — always first

Read the target file. List every branch, validation, transformation, and error path.
- Empty, or only "call X then call Y" → **thin**.
- Has business rules → **fat**; each listed rule becomes a candidate test case.

State the classification with a one-line rationale before writing anything:

```
AuthenticateUseCase → FAT
- Rejects unknown email (don't leak user existence)
- Locks account after 5 failed attempts for 15 minutes
- Rejects locked accounts even with correct password
- Resets lock state on successful login
VerifyEmailUseCase → THIN
- Validates token, sets verified, invalidates token; no branching → E2E (qa-validator) covers it.
```

### 2. Fat → write behavior tests

- **Names describe the rule, not the call.** ✅ `locks account for 15 minutes after 5 failed attempts`
  ❌ `calls userRepository.updateFailedAttempts`.
- **One rule per test** — one reason to fail.
- **Arrange–Act–Assert.** Build data with factory helpers (`createUser()`); prefer real / in-memory
  objects over mocks. Mock only at the boundary.
- **Test the edges**, not just happy path: boundary (exactly 5, not 4/6), bad input (null/empty/wrong
  type), concurrency when relevant.
- **Assert the spec-defined outcome.** Pull the expected value/state from the `contract.md` assertion
  or `expectedBehavior`. Where the spec/contract does not define a precise outcome, mark a
  **spec-precision gap** and flag it — do **not** invent a vague assertion and pass it silently.
- **Test-integrity hard constraints** (never violate): do not weaken an assertion to pass; do not
  delete/skip a test to cut failures; do not use the framework's skip/disable/pending to bypass a
  red test. A failing test is a signal. If a test is genuinely wrong per the contract, STOP and ask.

Match the project's existing framework and layout. Defaults when none exist: `__test__/unit/` next to
source, `<source-name>.spec.<ext>`, factories at file top or `__test__/factories/`. Group `describe`
blocks **by business rule**, not by method.

### 3. Thin → declare E2E coverage (no internal-mock unit test)

State it explicitly and move on:

> "`VerifyEmailUseCase` is thin — orchestration without business logic. The `contract.md` assertion
> `VAL-AUTH-007` (exercised by qa-validator through the real surface) covers this path. A unit test
> here would mock internals and test wiring, not behavior."

Only if a convention *forces* a test, write a **minimal smoke test** with real/in-memory deps (no
internal mocks) asserting the happy-path outcome. Never mock between internal classes to manufacture
a thin-code test.

### 4. Build the classification-gated Coverage Matrix

Not a blanket per-layer quota — a per-unit map keyed on the Step-1 classification. Commands come from
`services.yaml`. Render it with the tests so it's reviewable:

| Unit / Layer | thin / fat | Test type | Asserts (contract `VAL-*` / rule) | Location | Command (from services.yaml) |
| ------------ | ---------- | --------- | --------------------------------- | -------- | ---------------------------- |
| `AuthenticateUseCase` | fat | unit | `VAL-AUTH-001..004` (lockout rules) | `__test__/unit/authenticate.spec.ts` | `<services.yaml test>` |
| `VerifyEmailUseCase`  | thin | E2E (qa-validator) | `VAL-AUTH-007` | — (contract assertion) | — |
| `User` entity / config | — | none | — | — | build/typecheck gate only |

Rule: a **thin** row's coverage is a `contract.md` assertion (qa-validator), never a mocked unit test.
A **fat** row maps each business rule to at least one focused test. `none` is only for entity/config
units with no rules.

### 5. Gate (deterministic — the test runner decides, not self-assessment)

Run the relevant command(s) from `services.yaml` (`test`, then `typecheck`/`lint` as the worker
scopes per `harness.md`). **Do not pipe through `| tail`/`| head`** (masks the exit code). Non-zero =
stop, fix, re-run. Confirm the **test count did not silently drop**.

### 6. Test Adequacy Review (on the fat tests) — evidence-or-zero

A fat unit isn't done until both tables below pass. Tests must be **sufficient** (every rule covered)
AND **necessary** (every test traces to a rule — no coverage-inflation tests).

**Sufficient (forward map).** Every business rule / contract AC / listed edge case → at least one
assertion, cited by exact `file:line` + the reproduced assertion expression:

| Rule / contract AC / edge case | `file:line` + assertion expression | Spec/contract outcome | Covered? |
| ------------------------------ | ----------------------------------- | --------------------- | -------- |
| Lock after 5 failed attempts | `authenticate.spec.ts:88` — `expect(fn).rejects.toThrow('locked')` | error after 5th | ✅ / ⚠️ gap |

*Evidence-or-zero:* a rule with no located `file:line` counts as NOT covered — search the test files
before declaring it missing.

**Necessary (reverse map).** Every test → a rule/AC, else remove it (anti coverage-inflation):

| `file:line` + assertion expression | Maps to (rule / AC) | Keep? |
| ----------------------------------- | ------------------- | ----- |
| `authenticate.spec.ts:88` — `…toThrow('locked')` | lockout rule | ✅ |
| `authenticate.spec.ts:120` — `expect(repo.save).toHaveBeenCalled()` | — (only proves a call ran) | ❌ remove |

**Non-shallow litmus.** An assertion is shallow if it would still pass under a plausible *wrong*
implementation — strengthen it. Reject: assertion-free / `expect(true)` tautologies; "no error thrown"
as the only assertion (unless not-throwing *is* the behavior); happy-path-only when edges are listed.

**Payload / conjunction rule.** For each field of an emitted event / returned object / persisted
record: open the constructed object at its `file:line`, confirm the assertion targets the field's
**value/state** — not merely that `emit(...)`/`save(...)` was *called*. Asserting a spy was called ≠
asserting the resulting state; neither substitutes for the other.

### 7. Discrimination sensor (mutation — the real definition of "covered")

*Coverage without mutation testing measures volume, not quality.* Prove the fat tests can detect
regressions:

1. **Scratch state only** — `git stash`, or a `git worktree`/temp copy. Never mutate the real tree.
2. **Inject one behavior-level fault** in the new fat code: flip a condition (`>` → `>=`), change a
   return value, off-by-one, or remove a required side effect.
3. **Run the covering tests** (Quick/Full command from `services.yaml`).
4. **Confirm the tests FAIL** (mutant killed), then discard the mutation.
5. **A surviving mutant = a weak test.** Strengthen the assertion (back to Step 6) before "done".

**Tiering:** 1–3 targeted mutations on the highest-risk new code by default; ≥5 (or language mutation
tooling — Stryker/mutmut/cargo-mutants/pitest) for P0/critical paths (auth, payments, data integrity).
Stack-agnostic: the sensor targets *what the code does*, any language.

## "Does X need tests?" — answer with the framework, no hedging

1. Read the code. 2. List the business rules (branches/validations/transformations/error paths).
3. Empty → **"Thin. The E2E/contract assertion covers it."** 4. Non-empty → **"Fat. These rules need
tests: …"**. Give a clear recommendation.

## Coverage philosophy (keep it honest)

- Coverage measures what was **executed**, not what was **verified**. A test that runs code without a
  meaningful assertion inflates the number and catches nothing.
- Treat coverage as an **indicator** (what's untested?), never an **objective** (hit 90%).
- Thin code covered by the qa-validator E2E surface has **real** coverage that simply won't show in
  unit/integration metrics — that's correct, not a gap.
- Do **not** adopt a blanket "cover every layer 1:1 / exceed the repo's depth" default. Thin/fat gates it.

## Rules
- Classify thin/fat **before** writing — it gates everything.
- Fat → behavior tests (rule-named, one rule/test, real objects, boundary-only mocks, edges covered).
- Thin → E2E (qa-validator contract assertion); never a mocked-internals unit test.
- Tests derive from `contract.md`/`expectedBehavior`/spec — never from the implementation.
- Commands from `services.yaml`; testing precedence `harness.md` §Testing → repo `AGENTS.md` → defaults.
- Never weaken/delete/skip a test to go green. A red test is a signal.
- "Covered" means mutation-killed (Step 7), not merely line-executed.
