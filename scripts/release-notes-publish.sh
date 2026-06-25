#!/usr/bin/env bash
# release-notes-publish.sh — commit whatever the release-notes crew wrote under
# docs/release-notes/ (curator entries + marketer plans) and open (or update) ONE nightly
# release-notes PR. Kept deterministic and OUT of the LLM agents so the git/PR mechanics are
# reliable and idempotent (the "factory LLM rules must be code" lesson). Safe to run
# repeatedly in a day — it force-updates the dated branch.
#
# Requires: GH_TOKEN (PAT with repo scope), GITHUB_REPOSITORY. Run from the repo root.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
DATE_UTC="$(date -u +%F)"
BRANCH="release-notes/nightly-${DATE_UTC}"

# Nothing to publish? Exit cleanly — a quiet night (no user-facing PRs merged) is valid.
if [ -z "$(git status --porcelain docs/release-notes 2>/dev/null)" ]; then
  echo "release-notes-publish: no changes under docs/release-notes — nothing to publish."
  exit 0
fi

git config user.name  "wynne-factory"
git config user.email "factory@users.noreply.github.com"

# Remember where we started so we can restore HEAD afterwards. This step runs in the
# MIDDLE of the daily pipeline (a later discovery-publish step also does `checkout -B`);
# if we left HEAD on our branch, that step would branch off our commit. Restore at the end.
ORIG_SHA="$(git rev-parse HEAD)"

git fetch origin main --quiet || true
git checkout -B "$BRANCH" origin/main   # isolate to origin/main so sibling publish steps don't bleed in
git add docs/release-notes
git commit -m "release-notes: nightly update ${DATE_UTC}

Automated release-notes output (release-notes-curator / release-marketer).
End-user release entries + the day's marketing plan, for owner review.
No build tickets are created by this commit; doc-gap tickets (if any) are filed
in the user-docs lane by the curator." \
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
    --title "Release Notes: nightly update ${DATE_UTC}" \
    --body "$(cat <<'BODY'
Automated nightly output of the **Release Notes** sub-pipeline (`docs/release-notes/`).

- **release-notes-curator** turned the last 24h of user-facing merged PRs into plain-language
  end-user release entries, and cross-checked each one for an end-user guide — linking the
  guide, or the `user-docs` doc ticket tracking it (filing one if none existed).
- **release-marketer** drafted the day's marketing plan (`marketing/<date>.md`): value props,
  target personas, and ready-to-use promotional copy per channel for what shipped.

This PR is the morning "what did we ship, and how are we telling people about it?" diff.
Review the release entries and the marketing draft. Merging records them; the marketing copy
is a draft for humans to use, not anything that gets sent automatically.

See `docs/release-notes/README.md` for the layout and the documentation cross-check rule.
BODY
)" \
    --label "release-notes,queue:docs" 2>&1 | tail -2
else
  echo "release-notes-publish: existing open PR for ${BRANCH} updated with new commit."
fi

# Restore HEAD to where we started so later pipeline steps branch from the original base,
# not from our release-notes commit. docs/release-notes is committed (clean) at this point.
git checkout --quiet "$ORIG_SHA"
