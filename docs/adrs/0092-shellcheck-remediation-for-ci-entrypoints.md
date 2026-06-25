# ADR-0092: ShellCheck remediation in CI and release entrypoints must preserve existing command contracts

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** none

## History

| Date | Event |
|------|-------|
| 2026-06-17 | PR #1998 authored; `Temporal worker tests` job hung after re-trigger, leaving the PR unresolvable. |
| 2026-06-17 | Issue #2009 raised to re-kick the remediation from a fresh `main` checkout. |
| 2026-06-17 | PR #2010 completed the implementation; merged to `main`. PR #1998 superseded and closed. |

## Context

PR #2010 (re-kick of PR #1998) fixes ShellCheck findings in scripts that participate in CI and release
control-plane behavior, including `.github/scripts/temporal-ui-image.sh`,
chart validation entrypoints, and frontend container entrypoint tests.

Because `.github/**` is a control-plane boundary in this repository, even a
small lint-driven edit needs an explicit record of the contract being preserved.
The touched scripts are already relied on by required checks and image/tag
composition flows, so broad rewrites or blanket linter suppressions would raise
operational risk disproportionate to the warning cleanup.

## Decision

When remediating ShellCheck findings in CI and release entrypoints, prefer the
smallest behavior-preserving change that keeps existing script contracts intact:

1. Validate and copy environment inputs into local variables before composing
   image references or command arguments.
2. Use targeted `# shellcheck disable=...` annotations only where the script is
   intentionally asserting or emitting literal `$...` text.
3. Refactor test harnesses to avoid subshell-scoped mutation patterns only when
   the assertions and invocation contract remain equivalent.

## Consequences

- Control-plane shell lint cleanup stays reviewable and low risk.
- Existing chart/render, container-entrypoint, and image-tagging behavior remains
  the source of truth rather than being redefined by the linter pass.
- Future CI-shell cleanups on similar paths should follow the same narrow-change
  approach unless a separate ADR intentionally changes behavior.

## Evidence

- `.github/scripts/temporal-ui-image.sh`
- `charts/app/ci-test.sh`
- `charts/monitoring/ci-test.sh`
- `frontend/docker/entrypoint.sh`
- `frontend/docker/test-entrypoint.sh`
