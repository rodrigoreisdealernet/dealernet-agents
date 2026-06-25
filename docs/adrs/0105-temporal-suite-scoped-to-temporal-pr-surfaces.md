# ADR-0105: Scope Temporal suite to Temporal/control-plane PR surfaces

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Copilot implementation for PR #2259
- **Supersedes / Superseded by:** None

## Context
Issue #2273 documents a shared PR-validation blocker where `PR Validation / Temporal worker tests` remains in progress long after the rest of the matrix settles for Supabase-only PRs.

Those DB-touching PRs already execute dedicated Supabase reset-path validation jobs in the same workflow. Running the full Temporal suite on top of those jobs duplicates coverage and extends the required-check critical path.

## Decision
In `pr-validation.yml` scope detection, we gate the Temporal suite to PRs that touch `temporal/` or `.github/workflows/pr-validation.yml` (control-plane edits). We still skip for truly empty diffs.

For Supabase-only and other non-Temporal PRs, `skip_temporal_suite=1` short-circuits `Test Temporal suite`; Supabase reset-path jobs remain the coverage mechanism for DB changes.

Push-to-main still runs the full Temporal suite.

## Consequences
- No-delta and Supabase-only PRs no longer block on the long Temporal lane.
- Required check state converges faster under shared runner load.
- Temporal and control-plane PRs still run Temporal tests before merge; push-to-main remains full coverage.

## Alternatives considered
- Keep running full Temporal tests on every PR: rejected because it keeps the shared blocker active for DB-only changes already covered by dedicated reset-path jobs.
- Skip all Supabase reset-path jobs instead: rejected because that would reduce DB validation coverage.

## Evidence
- Workflow change: `.github/workflows/pr-validation.yml`
- Workflow contract tests: `temporal/tests/test_pr_validation_workflow_contract.py`
- Incident: `#2273`
- PR: `#2259`
