#!/usr/bin/env bash
# operating-model-epics.sh <vertical> — the research→ticket BRIDGE.
# Upserts ONE epic per populated role (not one per task — that would flood the backlog).
# The epic carries the persona link + a task checklist (each item tagged with the task id and
# its agentic angle), grounded so the PO/Architect can split it into stories and YOU gate the
# build. Checklist boxes are DERIVED from each task's implementation status (the feedback loop:
# supported/automated → checked), so the epic is a live burn-up. Idempotent + capped by design.
#
# Files into queue:product + needs-triage (NOT ready-for-dev) — research proposes, humans dispose.
# Requires: GH_TOKEN (PAT), GITHUB_REPOSITORY. Run from repo root after the cartographer + render.
set -uo pipefail

VERTICAL="${1:?usage: operating-model-epics.sh <vertical>}"
ROLES_DIR="docs/discovery/domain/${VERTICAL}/roles"
[ -d "$ROLES_DIR" ] || { echo "no roles dir for ${VERTICAL}"; exit 0; }

# ensure the label exists (idempotent)
gh label create operating-model --color "1d76db" \
  --description "Epic generated from the operating model (docs/discovery/domain)" 2>/dev/null || true

shopt -s nullglob
for tasks_file in "$ROLES_DIR"/*.tasks.jsonl; do
  role="$(basename "$tasks_file" .tasks.jsonl)"
  [ -s "$tasks_file" ] || continue   # skip roles with no tasks yet
  role_md="$ROLES_DIR/${role}.md"
  title_line="$(grep -m1 '^title:' "$role_md" 2>/dev/null | sed 's/^title:[[:space:]]*//')"
  role_title="${title_line:-$role}"
  fp="<!-- operating-model-epic:${VERTICAL}:${role} -->"

  # Build the checklist from the task records (box derived from implementation status).
  checklist="$(python3 - "$tasks_file" <<'PY'
import json, sys
done = {"supported", "automated"}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    t = json.loads(line)
    box = "x" if t.get("implementation") in done else " "
    tid = t.get("id", "?")
    ag = t.get("agentic_potential", "unassessed")
    print(f"- [{box}] `{tid}` {t.get('task','').strip()} _(agentic: {ag})_")
PY
)"

  body="$(cat <<EOF
**Epic generated from the operating model** — what the **${role_title}** does to run the business.

- **Persona + ROI:** docs/discovery/domain/${VERTICAL}/roles/${role}.md (see the vertical Coverage & ROI for the addressable prize).
- **Why these:** each item is a real, cited task this role performs. PO/Architect: split the high-value ones into stories; the owner gates what actually gets built. Carry the \`${role}:&lt;task-id&gt;\` tag into each story so the feedback loop can mark it done.
- Checklist boxes are auto-derived from each task's implementation status (supported/automated = checked).

### Tasks
${checklist}

${fp}
EOF
)"

  # Dedup by fingerprint: list issues with our label and grep the marker (list, don't --search).
  existing="$(gh issue list --state all --label operating-model --limit 200 \
    --json number,body --jq ".[] | select(.body|contains(\"${fp}\")) | .number" 2>/dev/null | head -1)"

  if [ -n "$existing" ]; then
    gh issue edit "$existing" --body "$body" >/dev/null && echo "updated epic #$existing (${role})"
  else
    gh issue create \
      --title "Epic: ${role_title} — operational coverage (operating model)" \
      --body "$body" \
      --label "operating-model,enhancement,queue:product,needs-triage" 2>&1 | tail -1
  fi
done
