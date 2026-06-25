# ADR-0054: Live Yard View board E2E spec wired into gating e2e-dev workflow

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Copilot (implementation), @ianreay (review)
- **Supersedes / Superseded by:** —

## Context

`/dispatch/yard` had unit coverage but no deployed-app E2E journey coverage providing merge-blocking regression protection. A gating spec (`frontend/e2e/dispatch-yard.spec.ts`) was added that validates four operational journeys: lane rendering, display-mode coherence, lane link handoff, and auto-refresh filter isolation. However, the spec was not wired into `.github/workflows/e2e-dev.yml`, so a regression in any of those journeys would still pass CI green.

Any change to `.github/workflows/**` is a control-plane boundary and requires an ADR per the project's architecture conventions.

## Decision

We add `dispatch-yard.spec.ts` to the gating `npx playwright test` invocation in the `e2e` job of `.github/workflows/e2e-dev.yml`. The spec is listed alongside the existing gating files (`smoke.spec.ts`, `auth-access-control.spec.ts`, `roles-data-access.spec.ts`, `ops-findings.spec.ts`, `ops-approval.spec.ts`, `branch-counts.spec.ts`). A failure in any of the four yard-board journey tests will fail the gating CI check and block merge.

The final resolved gating command is:

```
npx playwright test smoke.spec.ts auth-access-control.spec.ts roles-data-access.spec.ts ops-findings.spec.ts ops-approval.spec.ts dispatch-yard.spec.ts branch-counts.spec.ts
```

This preserves every spec already on main (including `branch-counts.spec.ts` added by PR #1510) plus `dispatch-yard.spec.ts` from this PR.

## Consequences

- Regressions in the Live Yard View board's lane rendering, display-mode switching, lane link handoff, or auto-refresh filter isolation will fail CI and block merges.
- All tests in the spec skip cleanly when `E2E_AUTH_EMAIL` / `E2E_AUTH_PASSWORD` are not configured, so the gate does not block CI runs in uncredentialed environments.
- CI wall-clock time increases by the duration of the four yard-board checks when credentials are configured.

## Alternatives considered

- **Keep spec in `experience.spec.ts` with `continue-on-error: true`** — rejected because failures in those tests do not block merges and the stated goal of this PR is merge-blocking regression protection.
- **Add a dedicated workflow job for dispatch-yard** — rejected as unnecessary complexity; the existing `e2e` smoke job already provides the right gating semantics and environment variables.

## Merge coordination (resolved)

PR #1510 (`copilot/add-e2e-workflow-rapidcount-variance`) was a concurrent PR that also edited the same `npx playwright test` invocation in `e2e-dev.yml`, adding `branch-counts.spec.ts`. PR #1510 has since merged into main. This branch was restacked on that updated main and the workflow conflict resolved: the final command (above) preserves all existing gating specs plus both `dispatch-yard.spec.ts` and `branch-counts.spec.ts`.

## Evidence

- Spec: `frontend/e2e/dispatch-yard.spec.ts`
- Workflow change: `.github/workflows/e2e-dev.yml` (gating `e2e` job, "Run E2E smoke" step)
- PR: Add E2E coverage — Live Yard View board (gating spec with deterministic auto-refresh validation)
- Sibling PR: #1510 (merged — `branch-counts.spec.ts` preserved in resolved command)
