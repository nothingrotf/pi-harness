---
name: harness-skill-eval
description: Blinded A/B evaluation of a harness skill/prompt/profile change before promoting it. Wraps scripts/eval-ab.sh (same frozen feature, two arms) and adds the blinded judge + transcript-based compliance grading. Use when a change to a skill, worker prompt, or model config needs evidence instead of faith.
---

# harness-skill-eval — test a skill change like the experiment it is

A skill edit affects every future worker session. Do not promote one because it "reads better" —
run both variants on the same frozen feature and grade the outcomes blind. The failure mode this
skill exists to kill is the **observer effect**: an agent that knows it is being evaluated behaves
differently, and a judge that knows which arm is "yours" scores it kindly.

## Blinding non-negotiables (read before anything)

- **Workers never learn this is an eval.** The arms run through the normal `/harness run` path —
  the worker bootstrap, tasks, and gates look identical to a real feature. Never inject the words
  `eval`, `candidate`, `variant`, `judge`, `rubric`, `A/B`, or "compare" into anything a worker
  can read (profile, skills, feature.md, task descriptions).
- **Arms never learn of each other.** Separate runs, archived separately; no shared scratch state;
  lessons from arm A must not leak into arm B (`eval-ab.sh` restores the profile snapshot between
  arms — that is why it exists).
- **The judge is blind.** It sees `arm-1` / `arm-2` labels, never which config produced which, and
  never the model names. One judge, one pass, one scale — a second judge run is calibration drift,
  not rigor.
- **Compliance is graded from behavior, not self-report.** "The worker says it followed the skill"
  is worthless. Grade from the session transcripts: which files it actually read, whether the
  procedure's artifacts exist (tests, decisions.tsv rows, commits per task), what the tool-call
  sequence shows. Citing a rule ≠ reading it ≠ applying it.

## Procedure

### 1) Frame
State in one paragraph: the change under test (exact file/diff), the behavior it should improve,
and the finish condition of the comparison. Then write the **judge-only rubric**: 3–6 concrete,
gradeable criteria derived from the change's intent (good: "fewer review rounds to green",
"decisions.tsv has a row per task", "no re-derived shared values in the diff"; bad: "code is
better"). Workers never see the rubric.

### 2) Pick the fixture feature
Use a **converged, un-run feature** (plan.json exists, feature-run.json does not) that genuinely
exercises the changed behavior — a change to test-authoring guidance needs a feature with fat
logic, not a copy tweak. Same feature, same base commit, same frozen plan/contract for both arms.

### 3) Run the arms via `scripts/eval-ab.sh`
```
eval-ab.sh prep <repo> <featureId>        # snapshot profile + base, skipDelivery on
# arm 1: apply variant 1 (or baseline), /harness run <featureId>
eval-ab.sh archive <repo> <featureId> <label-1>
# arm 2: apply variant 2, /harness run <featureId>   (use `arm` if the base moved)
eval-ab.sh archive <repo> <featureId> <label-2>
eval-ab.sh finish
```
Apply the variant by editing the profile/skill file under test between arms — and revert it
exactly after. Randomize which variant runs first when ordering could matter (cache warmth,
service state).

### 4) Judge (blind, once)
Spawn ONE readonly `subagent` (the `delegate` builtin or a readonly custom agent; prefer a different model family from the arms'
workers). Give it: the rubric, and the two archived run dirs under neutral labels (`arm-1`,
`arm-2` — sanitize any path/file that names the config). It scores per criterion with evidence
pointers and picks a winner or declares a tie. It never sees model names, config diffs, or which
arm is the incumbent.

### 5) Grade compliance from transcripts
Separately (yourself or one more readonly agent), verify the *mechanism*: did the changed
instruction actually change behavior? Read the arms' `sessions/*.jsonl` skeletons and run
artifacts for the behavioral trace the change predicts (a file read, an artifact produced, a
sequence followed). A win on outcomes with no trace of the mechanism is luck, not evidence.

### 6) Compare hard numbers
`python3 run-metrics.py --compare .harness/runs/.evals/<fid>/<label-1> .harness/runs/.evals/<fid>/<label-2>`
— rounds to green, fix tasks, blocking findings, cost, tokens, wall time.

### 7) Verdict
Read both arms' key outputs yourself before accepting the judge's verdict — if you disagree,
suspect the rubric before your judgment (ambiguous rubric = re-frame, not re-judge). Promote the
change only when outcomes + mechanism + numbers agree; otherwise keep the baseline and record what
you learned. One run per arm is a vibe-check, not a benchmark — say so in the verdict, and prefer
promoting changes whose mechanism trace is unambiguous even when the outcome delta is small.

## Report
End with: the change, the fixture feature, per-criterion scores (judge), the mechanism trace
(compliance), the metrics table, and the verdict (`promote` / `keep baseline` / `inconclusive` —
inconclusive is a valid verdict, not a soft promote).
