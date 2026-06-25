#!/usr/bin/env bash
# operating-model-reconcile.sh <vertical> — the FEEDBACK LOOP.
# When a story that implements a mapped task ships (its issue closes), advance that task's
# implementation status so roadmap-coverage % and captured ROI climb. Stories carry a
# `<role>:<task-id>` tag (the epic asks the Architect to thread it through); we scan closed
# issues for those tags and mark the matching tasks `supported`. Deterministic + idempotent;
# a no-op until tagged stories start closing.
#
# Writes file changes only (the operating-model publish step commits them). Run after the
# cartographer, before render/publish. Requires GH_TOKEN, GITHUB_REPOSITORY. From repo root.
set -uo pipefail

VERTICAL="${1:?usage: operating-model-reconcile.sh <vertical>}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
ROLES_DIR="docs/discovery/domain/${VERTICAL}/roles"
[ -d "$ROLES_DIR" ] || { echo "no roles dir for ${VERTICAL}"; exit 0; }

# Known (role:task-id) pairs that are NOT yet supported/automated, from the task store.
mapfile -t PAIRS < <(python3 - "$ROLES_DIR" <<'PY'
import json, os, sys, glob
done = {"supported", "automated"}
for f in glob.glob(os.path.join(sys.argv[1], "*.tasks.jsonl")):
    role = os.path.basename(f)[:-len(".tasks.jsonl")]
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        t = json.loads(line)
        if t.get("implementation") not in done:
            print(f"{role}:{t.get('id')}")
PY
)
[ "${#PAIRS[@]}" -eq 0 ] && { echo "reconcile: no open (un-built) tasks to check."; exit 0; }

# Closed issues' text (title+body) in one pull — match tags against the open pairs.
closed_text="$(gh issue list --state closed --limit 200 --json title,body \
  --jq '.[] | .title + " " + (.body // "")' 2>/dev/null || true)"
[ -z "$closed_text" ] && { echo "reconcile: no closed issues to scan."; exit 0; }

advanced=0
for pair in "${PAIRS[@]}"; do
  role="${pair%%:*}"; tid="${pair##*:}"
  if printf '%s' "$closed_text" | grep -qF "${role}:${tid}"; then
    ( cd .github/tools/shared && npx tsx src/operating-model.ts set-impl "$VERTICAL" "$role" "$tid" supported >/dev/null ) \
      && { echo "reconcile: ${role}/${tid} → supported (closed story found)"; advanced=$((advanced+1)); }
  fi
done
echo "reconcile: advanced ${advanced} task(s) to supported."

# Re-render the Coverage & ROI doc so the burn-up reflects the new status.
( cd .github/tools/shared && npx tsx src/operating-model.ts render-model "$VERTICAL" >/dev/null ) || true
