# ADR-0064: non-gating quality and UX observability lanes

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** @copilot
- **Supersedes / Superseded by:** none

## Context

The test-quality rollout adds new control-plane workflow behavior across `.github/workflows/pr-validation.yml`, `.github/workflows/code-quality.yml`, `.github/workflows/visual-ux.yml`, and `.github/workflows/e2e-dev.yml`:

- PR-time static analysis (`tsc`, `ruff`, `shellcheck`, `hadolint`, `gitleaks`) and push-to-main coverage publication.
- A nightly deep quality pipeline (CodeQL, Semgrep, Trivy, audits, secret scanning) that records a `quality` metric.
- A daily visual UX capture + vision-review lane that files deduplicated UX backlog issues.
- Explicit trend publishing to `ci-history` / `e2e-history` plus reviewer-agent issue filing.

These lanes cross CI behavior, permissions boundaries, and issue-creation side effects. The branch currently carries known debt (for example TypeScript backlog counts), so making these checks hard gates immediately would block delivery for existing baseline debt rather than new regressions.

## Decision

We keep the new quality/coverage/visual-UX lanes **non-gating and report-first**:

1. `pr-validation.yml`
   - `coverage` remains informational (`Coverage (non-gating)`), runs on push to `main`, and only publishes trend artifacts.
   - `static-analysis` remains `continue-on-error: true` and writes findings to step summary only.
2. `code-quality.yml` runs nightly and is non-gating by design:
   - scanners are `continue-on-error`,
   - results are aggregated into a `quality` record and pushed to `ci-history`,
   - `code-quality-reviewer` files deduplicated backlog issues.
3. `visual-ux.yml` remains non-gating:
   - capture and reflection steps are `continue-on-error`,
   - artifacts are always uploaded,
   - `ux-vision-reviewer` files deduplicated UX issues.
4. `e2e-dev.yml` keeps smoke as the deploy-health signal, while `experience` remains `continue-on-error` and backlog-oriented.

Promotion from report-only to gate is ratcheted by `qa-targets.json` thresholds once counts are stable at target.

## Consequences

- **Easier:** we get immediate visibility (quality, coverage, UX) without blocking merges on known baseline debt.
- **Easier:** durable data sinks (`ci-history` / `e2e-history`) let QA and reviewers trend progress and enforce ratcheting.
- **Trade-off:** regressions in these lanes create backlog pressure first, not immediate merge failure.
- **Obligation:** once a metric reaches/holds its target floor/ceiling, move it from report-only to a true required gate in workflow policy.

## Alternatives considered

- **Gate everything immediately** — rejected; current backlog (notably TypeScript findings) would turn this into a broad stop-ship unrelated to the incremental rollout.
- **Keep only ad-hoc local checks** — rejected; this loses durable trend telemetry and deduplicated-ticket generation needed for managed burn-down.
- **Run nightly scans without issue filing/trend sinks** — rejected; findings would be noisy and unactionable without ownership and historical context.

## Evidence

- Workflows: `.github/workflows/pr-validation.yml`, `.github/workflows/code-quality.yml`, `.github/workflows/visual-ux.yml`, `.github/workflows/e2e-dev.yml`
- Targets: `.github/qa-targets.json`
- Trend scripts: `.github/scripts/test-history-record.mjs`, `.github/scripts/test-history-render.mjs`, `.github/scripts/e2e-history-record.mjs`, `.github/scripts/e2e-history-render.mjs`, `.github/scripts/quality-compute.mjs`, `.github/scripts/coverage-compute.mjs`
- Reviewer agents: `.github/agents/code-quality-reviewer.agent.md`, `.github/agents/ux-vision-reviewer.agent.md`
- Documentation updates: `README.md` (Testing + trend history sections)
