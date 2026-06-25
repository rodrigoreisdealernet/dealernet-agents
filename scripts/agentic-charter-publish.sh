#!/usr/bin/env bash
# agentic-charter-publish.sh — commit any agentic-reflector edits to docs/agentic-charter.md
# and open (or update) ONE weekly charter PR for a human to dispose. Deterministic and OUT of
# the LLM (the "factory LLM rules must be code" lesson). Idempotent: force-updates the dated
# branch. A quiet week (no charter change) is a valid outcome and exits cleanly.
#
# Requires: GH_TOKEN (PAT with repo scope), GITHUB_REPOSITORY. Run from the repo root.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
DATE_UTC="$(date -u +%F)"
BRANCH="agentic-charter/weekly-${DATE_UTC}"

if [ -z "$(git status --porcelain docs/agentic-charter.md 2>/dev/null)" ]; then
  echo "agentic-charter-publish: no charter change this week — nothing to publish."
  exit 0
fi

git config user.name  "dia-factory"
git config user.email "factory@users.noreply.github.com"

git fetch origin main --quiet || true
git checkout -B "$BRANCH" origin/main   # isolate to origin/main so sibling publish steps don't bleed in
git add docs/agentic-charter.md
git commit -m "agentic-charter: weekly reflection ${DATE_UTC}

Proposed by the agentic-reflector. Evidence-backed refinements to our definition of a
great agentic workflow. Proposes only — a human disposes (merges or rejects)." \
  --author="dia-factory <factory@users.noreply.github.com>"

PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
git push --force "$PUSH_URL" "HEAD:refs/heads/${BRANCH}"

if [ -z "$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null)" ]; then
  gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "Agentic charter: weekly reflection ${DATE_UTC}" \
    --body "$(cat <<'BODY'
Weekly **agentic-charter** reflection (`docs/agentic-charter.md`).

The `agentic-reflector` reviewed the week's evidence — the factory's own agent insertions
(what removed toil vs. created noise), discovery dossiers' agentic angles, and market signal —
and **proposes** the charter edits in this diff. Each change should cite its evidence.

**Agents propose; humans dispose.** Review the diff and merge if our definition of a great
agentic workflow should evolve this way. The charter floor ("agents propose; humans dispose")
must never be lowered.
BODY
)" \
    --label "queue:product" 2>&1 | tail -2
else
  echo "agentic-charter-publish: existing open PR for ${BRANCH} updated with new commit."
fi
