# ADR-0055: Gating E2E for RapidCount variance review with service-role fixture seeding

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** @copilot (implementation), @ianreay (PR review)
- **Supersedes / Superseded by:** none

## Context

PR #1510 added a RapidCount variance-review E2E journey but placed it inside the
`@experience` (non-gating) suite with `test.fail(true, ...)`.  A regression in the
`/branch/counts` review flow would not fail CI because the experience job runs with
`continue-on-error: true` and the test itself is expected to fail.

Additionally the test skipped whenever no seeded submitted task existed in the target
environment — making it opportunistic rather than deterministic.

The PR review (comment 4491945403) required:
1. Moving the journey into a gating spec so a broken review flow fails CI.
2. Replacing the opportunistic skip with a deterministic fixture so the test always
   runs under conditions CI reliably provides.

Adding `branch-counts.spec.ts` to the `e2e` job in `e2e-dev.yml` is a
control-plane boundary change requiring this ADR.

## Decision

We add `frontend/e2e/branch-counts.spec.ts` as a gating Playwright spec and include
it in the `e2e` job of `e2e-dev.yml`.  To prevent merge-order regression with the
sibling PR #1505 (`dispatch-yard.spec.ts`), both specs are listed in the final gating
run command:

```
npx playwright test smoke.spec.ts auth-access-control.spec.ts \
  roles-data-access.spec.ts ops-findings.spec.ts ops-approval.spec.ts \
  dispatch-yard.spec.ts branch-counts.spec.ts
```

The spec seeds a `count_task` entity in `submitted` state directly via the Supabase
service-role REST API before each test run, so no pre-existing seed data is required.
The entity (and all cascade-deleted child rows: `entity_versions`,
`time_series_points`, `relationships_v2`) is deleted in a `finally` block after the
test, keeping the deployed-dev database clean.

`E2E_SUPABASE_URL` (with a hardcoded default matching the dev front-door) and
`E2E_SUPABASE_SERVICE_KEY` are exposed as env vars on the `e2e` job so the seeding
step has credentials at runtime.  If `E2E_SUPABASE_SERVICE_KEY` is absent, a dedicated
CI step ("Require fixture-seeding credentials") exits non-zero before Playwright runs,
and the `beforeEach` block in the spec throws an error — ensuring missing credentials
produce a hard CI failure rather than a silent skip that bypasses the gating posture.

The non-gating `test.fail` version is removed from `experience.spec.ts` to avoid
redundancy.

## Consequences

- A regression in `rapidcount_review_count_variances`, the audit-trail append, or the
  `Approve Variance` UI path now fails the `e2e` job and blocks a deploy.
- The `e2e` job's runtime increases by one deterministic Playwright test (~30–60 s on
  a cold runner with network latency to the dev environment).
- `E2E_SUPABASE_SERVICE_KEY` must be configured as a repo secret.  It was already used
  by the `experience` job for portal-URL resolution, so no new secret provisioning is
  needed — only exposure in the `e2e` job env.  If the secret is absent the `e2e` job
  fails explicitly (via the guard step and the `beforeEach` throw), so the absence is
  immediately visible rather than silently skipped.
- Future gating specs that need fixture seeding can follow the same
  `seedXxx / deleteEntity` pattern established in this file.

## Alternatives considered

- **Keep the test in `@experience` but remove `test.fail`**: The job still uses
  `continue-on-error: true`, so failures would not block deploys.  Rejected.
- **Mock the Supabase RPC**: Would not exercise the real database function or RLS
  boundary; not useful for a persistence + audit-trail test.  Rejected.
- **Use `test.skip` when no submitted task exists (original approach)**: Fails the
  gating requirement because CI may never seed submitted tasks.  Rejected.

## Evidence

- `frontend/e2e/branch-counts.spec.ts` — new gating spec (variance review journey)
- `frontend/e2e/dispatch-yard.spec.ts` — sibling gating spec (PR #1505) incorporated to prevent merge-order regression
- `frontend/src/routes/dispatch/yard.tsx` — `data-testid="yard-item-card"` added for dispatch-yard spec selectors
- `.github/workflows/e2e-dev.yml` lines added to `e2e` job env and run command
- `supabase/migrations/20260613023000_rapidcount_variance_reconciliation.sql` —
  `rapidcount_review_count_variances` function under test
- PR #1510, review comment 4491945403
