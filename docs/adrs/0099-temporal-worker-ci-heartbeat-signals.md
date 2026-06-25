# ADR-0099: Emit heartbeat progress during PR Temporal test execution

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Copilot implementation for issue #1689
- **Supersedes / Superseded by:** None

## Context
`PR Validation / Temporal worker tests` is a required gate and can run for a long window when reset-heavy tests execute. Even with job/step timeouts and diagnostics on failure, maintainers still needed a clearer signal that the suite was actively progressing (versus truly wedged) while the step remained in `in_progress`.

Issue #1689 also called out stale-run churn after trusted re-triggers, so workflow-level rerun cancellation semantics needed to remain explicit and stable across PR retries.

## Decision
We keep the existing timeout+diagnostic fail-fast guard and add an explicit heartbeat loop in `Test Temporal suite` that logs elapsed progress every two minutes to both live logs and an uploaded artifact (`temporal/pytest-heartbeat.log`).

We also make concurrency grouping explicit to the workflow plus PR identity (`github.workflow` + PR number/ref) while preserving conditional `cancel-in-progress` behavior for pull requests.

## Consequences
- PRs now emit periodic, deterministic progress lines during long Temporal runs, reducing ambiguity around “slow vs hung” states.
- Timeout/failure incidents include heartbeat evidence in artifacts, improving post-incident triage.
- Stale PR runs continue to be auto-cancelled on new pushes, with grouping keyed directly to PR identity for clearer rerun behavior.
- The workflow contract test suite must continue asserting heartbeat and artifact wiring so this reliability signal cannot regress silently.

## Alternatives considered
- Rely only on pytest’s default per-test output: rejected because long-running phases can still look idle to reviewers in real incidents.
- Lower the global Temporal timeout aggressively: rejected because it risks false failures for valid reset-heavy runs.
- Add external monitoring only: rejected because the required signal should live directly inside the required check output/artifacts.

## Evidence
- Workflow: `.github/workflows/pr-validation.yml`
- Contract tests: `temporal/tests/test_pr_validation_workflow_contract.py`
- Issue: `#1689`
