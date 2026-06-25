# ADR-0071: Trusted PR Temporal lane fail-fast timeout and diagnostics

- **Status:** Superseded by ADR-0089
- **Date:** 2026-06-14
- **Deciders:** Copilot (issue #1534)
- **Supersedes / Superseded by:** Superseded by ADR-0089

## Context

Issue #1534 reported trusted-actor PR Validation runs stuck indefinitely in the
`Temporal worker tests` lane at `Test Temporal suite`, blocking unrelated PRs.
Even with a job-level timeout, a hung or deadlocked pytest process can leave
little/no actionable evidence and starve the shared required-check lane until
the outer timeout expires.

The incident needed two controls in the Temporal lane itself:
1. A bounded fail-fast guard around pytest execution.
2. Persistent diagnostics/log artifacts whenever pytest fails or times out.

## Decision

We keep the existing job timeout and add an inner fail-fast guard in the
`Test Temporal suite` step:

- run pytest through `timeout --preserve-status --signal=SIGINT --kill-after=60s`;
- cap pytest runtime to 70 minutes (inside the 75-minute job timeout);
- run pytest with `python -X faulthandler` for hang diagnostics;
- on non-zero exit, write `temporal/pytest-diagnostics.txt` (docker process
  snapshots + log tail) and summarize timeout/failure in step summary;
- always upload `temporal/pytest-report.json`, `temporal/pytest-output.log`, and
  `temporal/pytest-diagnostics.txt` as artifacts.

Workflow-contract tests now assert the fail-fast timeout guard and diagnostics
artifact wiring in `temporal/tests/test_pr_validation_workflow_contract.py`.

## Consequences

- The trusted PR lane now fails closed faster instead of silently wedging.
- Timeout/failure incidents retain actionable artifacts for root-cause analysis.
- CI time remains bounded while preserving existing Temporal test coverage.

## Alternatives considered

- **Rely only on job-level `timeout-minutes`** — rejected; this can terminate the
  job without in-step diagnostics and delays signal until the outer timeout.
- **Remove/relax Temporal required checks** — rejected; DB/workflow regression
  coverage must remain required for safe merges.

## Evidence

- Workflow: `.github/workflows/pr-validation.yml` (`temporal` job, `Test Temporal suite` step)
- Contract tests: `temporal/tests/test_pr_validation_workflow_contract.py`
- Incident issue: #1534
