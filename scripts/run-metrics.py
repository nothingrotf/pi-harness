#!/usr/bin/env python3
"""Metricas de uma feature run do pi-harness (viva ou arquivada) + modo compare A/B.

Uso:
  python3 run-metrics.py <run-dir>                      # tabela de uma run
  python3 run-metrics.py --compare <run-dir-A> <run-dir-B> [--labels A B]

Le apenas artefatos em disco (feature-run.json, progress_log.jsonl, sessions/,
validation/, status.json, handoffs/). Stdlib puro.
"""

import argparse
import glob
import json
import os
import sys
from collections import Counter
from datetime import datetime


def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def loadl(p):
    out = []
    try:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        pass
    except Exception:
        pass
    return out


def ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def session_usage(f):
    u = {"turns": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0, "models": Counter(), "maxCtx": 0}
    for e in loadl(f):
        m = e.get("message") or {}
        us = m.get("usage")
        if not us or m.get("role") != "assistant":
            continue
        u["turns"] += 1
        for k in ("input", "output", "cacheRead", "cacheWrite"):
            u[k] += us.get(k) or 0
        u["cost"] += ((us.get("cost") or {}).get("total")) or 0
        if m.get("model"):
            u["models"][m["model"]] += 1
        ctx = (us.get("input") or 0) + (us.get("cacheRead") or 0) + (us.get("cacheWrite") or 0)
        u["maxCtx"] = max(u["maxCtx"], ctx)
    return u


def collect(run_dir):
    fr = load(os.path.join(run_dir, "feature-run.json")) or {}
    prog = loadl(os.path.join(run_dir, "progress_log.jsonl"))
    status = load(os.path.join(run_dir, "status.json")) or {}
    m = {"dir": run_dir}

    times = [t for t in (ts(e.get("ts")) for e in prog) if t]
    m["wall_h"] = round((max(times) - min(times)).total_seconds() / 3600, 2) if times else None
    m["status"] = fr.get("status")
    m["gateRounds"] = fr.get("gateRounds") or 0

    steps = fr.get("steps", [])
    m["fix_tasks"] = sum(1 for s in steps if s["id"].upper().startswith("FIX"))
    m["planned_tasks"] = sum(len(s.get("tasks") or []) for s in steps if s["kind"] == "task" and not s["id"].upper().startswith("FIX"))
    for g in ("ship-gate-code-review", "ship-gate-qa-validator", "ship-gate-deliver"):
        s = next((x for x in steps if x["id"] == g), None)
        m[g.replace("ship-gate-", "") + "_attempts"] = s["attempts"] if s else None

    ev = Counter(e.get("event") for e in prog)
    m["commit_gate_passed"] = ev.get("commit_gate_passed", 0)
    m["commit_gate_failed"] = ev.get("commit_gate_failed", 0)
    m["zero_test_gates"] = ev.get("commit_gate_zero_tests", 0)
    m["rounds_consumed"] = ev.get("gate_round_consumed", 0)

    ctxs = [e.get("contextTokens", 0) for e in prog if e.get("event") == "task_context"]
    m["shadow_n"] = len(ctxs)
    m["shadow_max_k"] = round(max(ctxs) / 1000) if ctxs else None
    m["shadow_would_cut"] = ev.get("context_reseam_shadow", 0)

    synths = sorted(glob.glob(os.path.join(run_dir, "validation", "harness-code-review", "synthesis-r*.json")))
    single = os.path.join(run_dir, "validation", "harness-code-review", "synthesis.json")
    if not synths and os.path.exists(single):
        synths = [single]
    m["review_rounds"] = 0
    m["blocking_total"] = 0
    for s in synths:
        d = load(s) or {}
        m["review_rounds"] = max(m["review_rounds"], d.get("round") or 0)
        m["blocking_total"] += len(d.get("blockingFindings") or [])
    last = load(single) or (load(synths[-1]) if synths else {}) or {}
    m["review_final"] = last.get("status")
    m["sensor_survived"] = (last.get("sensor") or {}).get("survived")

    verdicts = Counter((status.get("assertions") or {}).values())
    m["assertions_passed"] = f"{verdicts.get('passed', 0)}/{sum(verdicts.values())}"

    qa_handoffs = sorted(glob.glob(os.path.join(run_dir, "handoffs", "ship-gate-qa-validator__*.json")), key=os.path.getmtime)
    m["qa_rounds"] = len(qa_handoffs)
    if qa_handoffs:
        first = load(qa_handoffs[0]) or {}
        m["qa_first_success"] = first.get("successState")

    total = {"turns": 0, "cost": 0.0, "tok": 0, "maxCtx": 0}
    per_model = Counter()
    for f in glob.glob(os.path.join(run_dir, "sessions", "*.jsonl")):
        u = session_usage(f)
        total["turns"] += u["turns"]
        total["cost"] += u["cost"]
        total["tok"] += u["input"] + u["cacheRead"] + u["cacheWrite"] + u["output"]
        total["maxCtx"] = max(total["maxCtx"], u["maxCtx"])
        for mdl, n in u["models"].items():
            per_model[mdl] += n
    m["sessions"] = len(glob.glob(os.path.join(run_dir, "sessions", "*.jsonl")))
    m["turns"] = total["turns"]
    m["cost_usd"] = round(total["cost"], 2)
    m["tokens_M"] = round(total["tok"] / 1e6, 1)
    m["peak_ctx_k"] = round(total["maxCtx"] / 1000)
    m["models"] = dict(per_model)

    cfg = load(os.path.join(run_dir, "models.snapshot.json"))
    if cfg:
        m["config"] = {r: f"{c.get('model', '(inherit)')}/{c.get('thinking', '-')}" for r, c in (cfg.get("roles") or {}).items()}
    return m


ROWS = [
    ("status", "estado final"),
    ("assertions_passed", "assertions passed"),
    ("wall_h", "wall clock (h)"),
    ("cost_usd", "custo (USD)"),
    ("tokens_M", "tokens (M)"),
    ("turns", "turnos"),
    ("sessions", "sessoes"),
    ("planned_tasks", "tasks planejadas"),
    ("fix_tasks", "FIX tasks"),
    ("review_rounds", "rounds de review"),
    ("rounds_consumed", "rodadas consumidas (gate)"),
    ("blocking_total", "blocking findings (total)"),
    ("review_final", "review final"),
    ("sensor_survived", "mutantes sobreviventes"),
    ("qa_rounds", "rounds de QA"),
    ("qa_first_success", "1o QA"),
    ("code-review_attempts", "attempts code-review"),
    ("qa-validator_attempts", "attempts qa"),
    ("commit_gate_passed", "commit gate verde"),
    ("commit_gate_failed", "commit gate vermelho"),
    ("zero_test_gates", "gates zero-teste"),
    ("shadow_max_k", "sombra: pico ctx (k)"),
    ("shadow_would_cut", "sombra: would-cut"),
    ("peak_ctx_k", "pico contexto real (k)"),
]


def show_one(m):
    print(f"run: {m['dir']}")
    if m.get("config"):
        for r, c in m["config"].items():
            print(f"  {r:14} {c}")
    for k, label in ROWS:
        print(f"  {label:28} {m.get(k)}")
    print(f"  {'modelos':28} {m.get('models')}")


def show_compare(a, b, la, lb):
    w = 30
    print(f"{'metrica':{w}} {la:>24} {lb:>24}")
    print("-" * (w + 50))
    if a.get("config") or b.get("config"):
        for role in ("orchestrator", "worker", "validator"):
            print(f"{role:{w}} {str((a.get('config') or {}).get(role, '?')):>24} {str((b.get('config') or {}).get(role, '?')):>24}")
        print("-" * (w + 50))
    for k, label in ROWS:
        print(f"{label:{w}} {str(a.get(k)):>24} {str(b.get(k)):>24}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--labels", nargs=2, default=["A", "B"])
    args = ap.parse_args()
    if args.compare:
        if len(args.dirs) != 2:
            sys.exit("--compare exige exatamente 2 run dirs")
        show_compare(collect(args.dirs[0]), collect(args.dirs[1]), *args.labels)
    else:
        for d in args.dirs:
            show_one(collect(d))
