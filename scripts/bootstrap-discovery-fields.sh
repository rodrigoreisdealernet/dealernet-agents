#!/usr/bin/env bash
# bootstrap-discovery-fields.sh — OPTIONAL, run-once by a human with GitHub Project admin
# scope. Adds the discovery "scoreboard" custom fields to Project #15 so `ready` handoff
# issues can be sorted/filtered by maturity and score.
#
# The discovery pipeline works WITHOUT these fields — the canonical roadmap is the
# git-tracked dossiers (docs/discovery/) + roadmap.md, and the per-idea handoff issues.
# These fields are only a convenience lens on the board.
#
# Requires: a PAT with `project` scope in GH_TOKEN (org Projects v2 admin). Idempotent:
# re-creating an existing field is a no-op-with-warning.
set -uo pipefail

OWNER="${PROJECT_OWNER:-Volaris-AI}"
NUMBER="${PROJECT_NUMBER:-15}"

create_field() {
  local name="$1" type="$2" opts="${3:-}"
  echo "--- ensuring field: $name ($type) ---"
  if [ -n "$opts" ]; then
    gh project field-create "$NUMBER" --owner "$OWNER" --name "$name" \
      --data-type "$type" --single-select-options "$opts" 2>&1 | tail -1 || true
  else
    gh project field-create "$NUMBER" --owner "$OWNER" --name "$name" \
      --data-type "$type" 2>&1 | tail -1 || true
  fi
}

create_field "Discovery Rung" "SINGLE_SELECT" "signal,opportunity,idea,validated,ready"
create_field "Idea Score"     "NUMBER"
create_field "Evidence Count" "NUMBER"
create_field "Last Researched" "DATE"

echo "Done. Discovery scoreboard fields ensured on Project #${NUMBER} (owner ${OWNER})."
