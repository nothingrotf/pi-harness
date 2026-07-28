#!/usr/bin/env bash
# A/B de model-config sobre UMA feature convergida do pi-harness.
#
# Protocolo (mesma feature, mesmo commit base, mesmo plan/contract congelado):
#   prep    -> snapshot do profile + base git + liga skipDelivery (eval nao abre PR)
#   archive -> arquiva a run recem-terminada com um rotulo, renomeia a branch,
#              volta pro commit base, reseta o run dir e RESTAURA o profile
#              (lessons da run A nao podem vazar pra run B)
#   arm     -> monta um braco NOVO a partir do commit base gravado, reidratando
#              plan/contract/feature de um braco ja arquivado. Necessario quando a
#              base branch ja andou (a feature anterior foi mergeada): sem isto o
#              braco novo partiria de um commit diferente e nao seria comparavel.
#   finish  -> desliga skipDelivery (pra entregar a branch vencedora)
#
# Uso:
#   eval-ab.sh prep    <repo> <featureId>
#   eval-ab.sh archive <repo> <featureId> <label>
#   eval-ab.sh arm     <repo> <featureId> <sourceLabel> <branchName>
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
	# O profile pós-run é OUTPUT da run (lessons + guidance updates do gate) — preserva no arquivo
	# e descarta do working tree ANTES do switch: harness.md/LESSONS.md são tracked, e mudança
	# tracked não-commitada aborta o checkout (falha real: archive parou no meio, branch já
	# renomeada, reset nunca rodou).
	cp -R .harness/profile "$dest/profile.after"
	git checkout -- .harness/ 2>/dev/null || true

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
arm)
	repo="${1:?repo}"; fid="${2:?featureId}"; src="${3:?sourceLabel}"; branch="${4:?branchName}"
	cd "$repo"
	run=".harness/runs/$fid"; ev=".harness/runs/.evals/$fid"
	[ -f "$ev/base.json" ] || die "rode prep primeiro (falta $ev/base.json)"
	[ -d "$ev/$src" ] || die "braco \"$src\" nao existe em $ev"
	[ -f "$run/feature-run.json" ] && die "$fid tem uma run em curso — arquive antes"
	if git status --porcelain | grep -qv '^.. \.harness/'; then
		die "working tree tem mudancas fora de .harness/ — commit/stash antes"
	fi
	base_sha=$(python3 -c "import json;print(json.load(open('$ev/base.json'))['baseSha'])")
	git rev-parse --verify "$base_sha^{commit}" >/dev/null 2>&1 || die "commit base $base_sha nao existe mais"
	git show-ref --verify --quiet "refs/heads/$branch" && die "branch \"$branch\" ja existe"

	# Reidrata os artefatos CONGELADOS do braco de origem (mesmo contrato, mesmo plano).
	mkdir -p "$run"
	for f in plan.json contract.md feature.md; do cp "$ev/$src/$f" "$run/$f"; done
	python3 - "$run" <<-'EOF'
	import json, re, sys
	run = sys.argv[1]
	plan = json.load(open(f"{run}/plan.json"))
	contract = set(re.findall(r"### (VAL-[A-Z0-9-]+):", open(f"{run}/contract.md").read()))
	n_fix = sum(1 for t in plan["tasks"] if t["id"].upper().startswith("FIX"))
	plan["tasks"] = [t for t in plan["tasks"] if not t["id"].upper().startswith("FIX")]
	plan["assertions"] = [a for a in plan["assertions"] if a in contract]
	json.dump(plan, open(f"{run}/plan.json", "w"), indent=2)
	json.dump({"featureId": plan["featureId"], "assertions": {a: "pending" for a in plan["assertions"]}}, open(f"{run}/status.json", "w"), indent=2)
	print(f"plan reidratado: {len(plan['tasks'])} tasks ({n_fix} FIX descartadas), {len(plan['assertions'])} assertions pending")
	EOF
	rm -rf .harness/profile && cp -R "$ev/profile.baseline" .harness/profile
	git switch -c "$branch" "$base_sha"
	set_skip_delivery true
	echo "braco pronto: branch \"$branch\" em ${base_sha:0:8} (mesma base dos outros bracos)"
	echo "AGORA: ajuste ~/.pi/agent/pi-harness/models.json e rode /harness run \"$fid\""
	;;
finish)
	set_skip_delivery false
	echo "finish ok: delivery religado. Entregue a branch vencedora (switch pra ela e rode o deliver)."
	;;
*)
	die "subcomando invalido: \"$cmd\" (prep|archive|finish)"
	;;
esac
