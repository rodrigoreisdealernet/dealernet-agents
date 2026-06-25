# ADR-0089: Temporal fail-fast timeout must wrap the full pytest logging pipeline

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Copilot (issue #1822)
- **Supersedes / Superseded by:** Supersedes ADR-0071

## Context

Issue #1822 reported fresh PR Validation incidents where the `Temporal worker tests`
job remained stuck in the `Test Temporal suite` step across multiple PRs.

The step already used GNU `timeout`, but it wrapped only the `python -m pytest`
process while `tee` lived outside that timeout boundary in a shell pipeline.
If child processes outlived pytest and kept the pipe open, the step could stay
in-progress even after the intended fail-fast budget.

## Decision

Run the pytest+tee pipeline inside `bash -o pipefail -c` and apply GNU `timeout`
to that shell wrapper so the entire pipeline shares one fail-fast boundary.

## Consequences

- The Temporal lane keeps live pytest logs via `tee` while still failing closed
  when the fail-fast budget expires.
- Timeout enforcement now applies to the full pipeline, reducing risk of wedge
  scenarios where a partial command boundary leaves the step in-progress.
- Workflow contract tests must assert the wrapped pipeline shape to prevent
  regressions.

## Alternatives considered

- **Keep timeout on pytest only:** rejected because it does not bound the whole
  pipeline process tree.
- **Drop live `tee` logging:** rejected because it removes useful in-run and
  post-failure diagnostics from required-check runs.

## Evidence

- Workflow: `.github/workflows/pr-validation.yml` (`temporal` job, `Test Temporal suite` step)
- Contract tests: `temporal/tests/test_pr_validation_workflow_contract.py`
- Incident issue: #1822
