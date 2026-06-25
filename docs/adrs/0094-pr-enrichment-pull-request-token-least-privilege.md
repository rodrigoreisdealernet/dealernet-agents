# ADR-0094: PR enrichment pull_request workflow uses scoped github.token only

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** none

## Context

PR enrichment runs on `pull_request`, where workflow code is sourced from the PR
branch. Using a privileged PAT fallback in that execution path (`secrets.PROJECT_MANAGER_PAT || github.token`)
expands the blast radius if the secret is configured, because PR-controlled code
would receive a broader token than required for label/comment operations.

The workflow already declares explicit job permissions (`issues: write`,
`pull-requests: write`) that are sufficient when using the default scoped
`github.token`.

## Decision

The PR enrichment `pull_request` workflow uses `github-token: ${{ github.token }}`
for `actions/github-script` and does not include a PAT fallback in that path.
Any privileged PAT usage must stay in separately trusted workflows that do not
execute PR-controlled workflow code.

## Consequences

- Least-privilege posture is enforced for PR-triggered enrichment runs.
- The workflow still has enough rights to list changed files, read labels, and
  add/remove labels on the PR.
- If privileged automation is needed in the future, it must be implemented in a
  trusted trigger path with a separate review decision.

## Evidence

- `.github/workflows/pr-enrichment.yml`
- `temporal/tests/test_pr_enrichment_workflow_logic.py`
