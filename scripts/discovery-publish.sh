#!/usr/bin/env bash
# discovery-publish.sh — commit whatever the discovery crew wrote under docs/discovery/
# and open (or update) ONE nightly discovery PR. Kept deterministic and OUT of the LLM
# agents so the git/PR mechanics are reliable and idempotent (the "factory LLM rules must
# be code" lesson). Safe to run repeatedly in a day — it force-updates the dated branch.
#
# Requires: GH_TOKEN (PAT with repo scope), GITHUB_REPOSITORY. Run from the repo root.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
DATE_UTC="$(date -u +%F)"
BRANCH="discovery/nightly-${DATE_UTC}"

# Nothing to publish? Exit cleanly — a quiet night is a valid outcome.
if [ -z "$(git status --porcelain docs/discovery 2>/dev/null)" ]; then
  echo "discovery-publish: no changes under docs/discovery — nothing to publish."
  exit 0
fi

git config user.name  "wynne-factory"
git config user.email "factory@users.noreply.github.com"

git fetch origin main --quiet || true
git checkout -B "$BRANCH" origin/main   # isolate to origin/main so sibling publish steps don't bleed in
git add docs/discovery
git commit -m "discovery: nightly roadmap update ${DATE_UTC}

Automated discovery-crew output (market-scout / product-strategist / discovery-critic).
Evidence + dossier changes for owner review. No build tickets created by this commit." \
  --author="wynne-factory <factory@users.noreply.github.com>"

# Push with an explicit token (checkout uses persist-credentials:false).
PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
git push --force "$PUSH_URL" "HEAD:refs/heads/${BRANCH}"

# Open the PR if one is not already open for this branch; otherwise the pushed commit
# updates the existing PR in place.
if [ -z "$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null)" ]; then
  gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "Discovery: nightly roadmap update ${DATE_UTC}" \
    --body "$(cat <<'BODY'
Automated nightly output of the **discovery pipeline** (`docs/discovery/`).

- **market-scout** captured fresh, cited market signal as evidence.
- **product-strategist** enriched dossiers, scored, and advanced ideas one rung.
- **discovery-critic** verified citations and promoted design-ready ideas.

This PR is the morning "what changed in the roadmap last night" diff. Review the dossier
and `roadmap.md` changes. Merging records the research; it does **not** put anything into
the build funnel — `ready` ideas wait for an explicit owner go/no-go.

See `docs/discovery/README.md` for the maturity ladder and approval chain.
BODY
)" \
    --label "queue:product" 2>&1 | tail -2
else
  echo "discovery-publish: existing open PR for ${BRANCH} updated with new commit."
fi
