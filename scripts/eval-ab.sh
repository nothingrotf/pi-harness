#!/usr/bin/env bash
# A/B de model-config sobre UMA feature convergida do pi-harness.
#
# Protocolo (mesma feature, mesmo commit base, mesmo plan/contract congelado):
#   prep    -> snapshot do profile + base git + liga skipDelivery (eval nao abre PR)
#   archive -> arquiva a run recem-terminada com um rotulo, renomeia a branch,
#              volta pro commit base, reseta o run dir e RESTAURA o profile
#              (lessons da run A nao podem vazar pra run B)
#   finish  -> desliga skipDelivery (pra entregar a branch vencedora)
#
# Uso:
#   eval-ab.sh prep    <repo> <featureId>
#   eval-ab.sh archive <repo> <featureId> <label>
#   eval-ab.sh finish
#
# Compare depois:  python3 run-metrics.py --compare .harness/runs/.evals/<fid>/<A> .harness/runs/.evals/<fid>/<B>
set -euo pipefail

MODELS_JSON="${HOME}/.pi/agent/pi-harness/models.json"

die() { echo "eval-ab: $*" >&2; exit 1; }

set_skip_delivery() {
	python3 - "$1" <<-'EOF'
	import json, os, sys
	p = os.path.expanduser("~/.pi/agent/pi-harness/models.json")
	d = json.load(open(p))
	d.setdefault("gates", {})["skipDelivery"] = sys.argv[1] == "true"
	json.dump(d, open(p, "w"), indent=2)
	print(f"skipDelivery = {sys.argv[1]}")
	EOF
}

cmd="${1:-}"; shift || true

case "$cmd" in
prep)
	repo="${1:?repo}"; fid="${2:?featureId}"
	cd "$repo"
	run=".harness/runs/$fid"
	[ -f "$run/plan.json" ] || die "feature nao convergida: falta $run/plan.json"
	[ -f "$run/feature-run.json" ] && die "$fid ja tem feature-run.json — rode prep ANTES da primeira run"
	ev=".harness/runs/.evals/$fid"
	mkdir -p "$ev"
	branch=$(git rev-parse --abbrev-ref HEAD)
	sha=$(git rev-parse HEAD)
	printf '{"baseBranch":"%s","baseSha":"%s"}\n' "$branch" "$sha" > "$ev/base.json"
	rm -rf "$ev/profile.baseline"
	cp -R .harness/profile "$ev/profile.baseline"
	set_skip_delivery true
	echo "prep ok: base=$branch@${sha:0:8} · profile snapshotado em $ev/profile.baseline"
	echo "AGORA: confira ~/.pi/agent/pi-harness/models.json (config da run 1) e rode /harness run \"$fid\""
	;;
archive)
	repo="${1:?repo}"; fid="${2:?featureId}"; label="${3:?label}"
	cd "$repo"
	run=".harness/runs/$fid"; ev=".harness/runs/.evals/$fid"; dest="$ev/$label"
	[ -f "$run/feature-run.json" ] || die "nada pra arquivar: $run sem feature-run.json"
	[ -f "$ev/base.json" ] || die "rode prep primeiro (falta $ev/base.json)"
	[ -e "$dest" ] && die "label \"$label\" ja existe em $ev"
	if git status --porcelain | grep -qv '^.. \.harness/'; then
		die "working tree tem mudancas fora de .harness/ — commit/stash antes de arquivar"
	fi
	base_branch=$(python3 -c "import json;print(json.load(open('$ev/base.json'))['baseBranch'])")
	base_sha=$(python3 -c "import json;print(json.load(open('$ev/base.json'))['baseSha'])")
	cur=$(git rev-parse --abbrev-ref HEAD)

	cp -R "$run" "$dest"
	cp "$MODELS_JSON" "$dest/models.snapshot.json"

	if [ "$cur" != "$base_branch" ]; then
		git branch -m "$cur" "${cur}--${label}"
		git switch "$base_branch"
		echo "branch: $cur -> ${cur}--${label}; de volta em $base_branch"
	else
		echo "AVISO: ja em $base_branch — a run commitou na base? confira ${label} manualmente."
	fi
	[ "$(git rev-parse HEAD)" = "$base_sha" ] || echo "AVISO: HEAD de $base_branch != base do prep (${base_sha:0:8}) — a base andou; a proxima run parte de outro commit."

	rm -f "$run/feature-run.json" "$run/feature-run.json.bak" "$run/progress_log.jsonl" \
		"$run/next-task.json" "$run/dismissed.json" "$run/worker-transcripts.jsonl"
	rm -rf "$run/handoffs" "$run/sessions" "$run/validation" "$run/evidence"
	python3 - "$run" <<-'EOF'
	import json, re, sys
	run = sys.argv[1]
	plan = json.load(open(f"{run}/plan.json"))
	contract = set(re.findall(r"### (VAL-[A-Z0-9-]+):", open(f"{run}/contract.md").read()))
	n_fix = sum(1 for t in plan["tasks"] if t["id"].upper().startswith("FIX"))
	plan["tasks"] = [t for t in plan["tasks"] if not t["id"].upper().startswith("FIX")]
	plan["assertions"] = [a for a in plan["assertions"] if a in contract]
	json.dump(plan, open(f"{run}/plan.json", "w"), indent=2)
	status = {"featureId": plan["featureId"], "assertions": {a: "pending" for a in plan["assertions"]}}
	json.dump(status, open(f"{run}/status.json", "w"), indent=2)
	print(f"plan.json: {n_fix} FIX task(s) da run anterior removidas (contaminacao); {len(plan['assertions'])} assertions -> pending")
	EOF
	rm -rf .harness/profile
	cp -R "$ev/profile.baseline" .harness/profile
	echo "profile restaurado do baseline (lessons de \"$label\" nao vazam pra proxima run)"
	echo "arquivado em $dest"
	echo "AGORA: edite ~/.pi/agent/pi-harness/models.json (config da proxima run) e rode /harness run \"$fid\""
	;;
finish)
	set_skip_delivery false
	echo "finish ok: delivery religado. Entregue a branch vencedora (switch pra ela e rode o deliver)."
	;;
*)
	die "subcomando invalido: \"$cmd\" (prep|archive|finish)"
	;;
esac
