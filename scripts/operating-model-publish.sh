#!/usr/bin/env bash
# operating-model-publish.sh — commit any domain-cartographer edits under
# docs/discovery/domain/ and open (or update) ONE weekly operating-model PR for review.
# Deterministic, OUT of the LLM (the "factory LLM rules must be code" lesson). Idempotent:
# force-updates the dated branch. A quiet week (no map change) exits cleanly.
#
# Requires: GH_TOKEN (PAT with repo scope), GITHUB_REPOSITORY. Run from the repo root.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
DATE_UTC="$(date -u +%F)"
BRANCH="operating-model/weekly-${DATE_UTC}"

if [ -z "$(git status --porcelain docs/discovery/domain 2>/dev/null)" ]; then
  echo "operating-model-publish: no operating-model change this week — nothing to publish."
  exit 0
fi

git config user.name  "wynne-factory"
git config user.email "factory@users.noreply.github.com"

git fetch origin main --quiet || true
git checkout -B "$BRANCH" origin/main   # isolate to origin/main so sibling publish steps don't bleed in
git add docs/discovery/domain
git commit -m "operating-model: weekly map update ${DATE_UTC}

Domain-cartographer extension of the operating model (roles, cited tasks, agentic
assessments). Research only — surfaces opportunities into the discovery pipeline; opens
no build tickets." \
  --author="wynne-factory <factory@users.noreply.github.com>"

PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
git push --force "$PUSH_URL" "HEAD:refs/heads/${BRANCH}"

if [ -z "$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null)" ]; then
  gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "Operating model: weekly map update ${DATE_UTC}" \
    --body "$(cat <<'BODY'
Weekly **operating-model** update (`docs/discovery/domain/`) — the answer to *"what does it
take to operate an X?"*, extended by the domain-cartographer this week.

- New/extended role task inventories, each task **cited** (no citation, no task).
- Agentic potential assessed per task (per `docs/agentic-charter.md`).
- High-value tasks surfaced as **opportunities into the discovery pipeline** — this PR opens
  **no build tickets**; `ready` ideas still wait for the owner's go/no-go.

Review the role/task diffs and `coverage` movement. See `docs/discovery/domain/README.md`.
BODY
)" \
    --label "queue:product" 2>&1 | tail -2
else
  echo "operating-model-publish: existing open PR for ${BRANCH} updated with new commit."
fi
