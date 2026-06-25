# ADR-0098: actions-monitor uses job timeout budget before hang escalation

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** @copilot, @ianreay
- **Supersedes / Superseded by:** none

## Context

The `actions-monitor` agent raises or updates shared-cause incidents for stuck GitHub Actions runs.
Its prompt previously treated any run that stayed `in_progress` for more than 30 minutes, and
especially more than 70 minutes, as a likely hang without first checking the job's declared
`timeout-minutes`.

That heuristic produced false-positive hang incidents for the `Temporal worker tests` job even
though the workflow explicitly budgets that job for 90 minutes. Changes under `.github/agents/`
are control-plane behavior for the factory and need an explicit decision record plus a regression
contract.

## Decision

The `actions-monitor` agent must look up a job's declared `timeout-minutes` in workflow YAML before
treating a long-running run as hung. A run whose elapsed time is still within its declared timeout
budget is normal expected behavior and must not trigger hang escalation or shared-cause incident
updates; when no timeout is declared, the existing `>70 min` fallback remains the default.

The prompt contract test for `actions-monitor` must assert this budget-aware behavior, including the
canonical `Temporal worker tests` 90-minute example.

## Consequences

- Prevents false-positive incident fan-out for within-budget long-running jobs.
- Keeps the monitor aligned with actual workflow runtime budgets instead of a fixed heuristic.
- Requires future edits to the stuck-run policy to preserve the timeout-budget lookup and contract
  test coverage.

## Alternatives considered

- Keep the fixed `>30 min` / `>70 min` heuristic for all jobs — rejected because it misclassifies
  intentionally long-budget jobs as hangs.
- Raise incidents based only on current runtime without consulting workflow YAML — rejected because
  the budget source of truth already exists in the workflow definition.

## Evidence

- `.github/agents/actions-monitor.agent.md`
- `temporal/tests/test_action_required_runbook.py`
- PR #2117
