# ADR-0091: Shop morning queue reset-path CI gate

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Copilot coding agent (issue #2004)
- **Supersedes / Superseded by:** none

## Context

PR #1977 added the shop morning queue feature, which ships two migrations:
`20260614200000` (the `v_shop_morning_queue_scope` view and `security_invoker` policy)
and `20260614210000` (`pm_work_orders` RLS + grants). A companion behavioral test
script (`supabase/tests/run_shop_morning_queue_rls.sh`) and test SQL
(`supabase/tests/shop_morning_queue_rls.sql`) already exercise the RLS chain in a
throwaway Postgres container.

However, neither script was wired into the PR validation pipeline before PR #1977
was closed as conflicted. This left two gaps:

1. No automated guardrail that all migrations still replay cleanly when these two
   migrations are present (no `supabase db reset` regression coverage).
2. No CI signal when a future migration breaks the `v_shop_morning_queue_scope`
   `security_invoker` policy, the `pm_work_orders` RLS, or the service_role /
   authenticated grant chain.

Additionally, the `/ops/shop-morning-queue` route had no entry in the experience
E2E specification, leaving that page uncovered in the non-gating E2E coverage that
signals UX regressions to the backlog.

## Decision

We add:

1. A `supabase-shop-morning-queue-rls` job to `pr-validation.yml` that checks out
   the repository and calls `bash supabase/tests/run_shop_morning_queue_rls.sh`.
   The script spawns a throwaway Postgres 17 container, applies the full migration
   stack, and runs `shop_morning_queue_rls.sql` (structural + behavioral assertions
   covering `security_invoker`, RLS enabled, correct grants, and tenant-scoped read
   isolation). The job pattern follows the same lightweight Docker-container harness
   used by `supabase-field-operator-asset-write` and
   `supabase-inbound-rerental-fleet-sourcing`.

2. The new job is added to `validation-summary.needs` so it appears in the PR
   summary table and a failure surfaces as a required-gate signal.

3. A non-gating E2E test for `/ops/shop-morning-queue` is added to
   `frontend/e2e/experience.spec.ts` under a new
   `@ops shop morning queue page load and filter sanity` describe block. The test
   is marked `test.fail(true, 'Non-gating: ...')` so it never blocks a merge but
   does signal regressions in the page heading, the `ops_findings_view` query, and
   the Priority filter control.

## Consequences

- **Easier:** reviewers have automated evidence that the shop morning queue
  migrations and RLS chain survive a full migration replay, closing the reset-path
  gap first identified in PR #1977.
- **Easier:** the `/ops/shop-morning-queue` route is no longer a blind spot in the
  non-gating E2E coverage matrix — heading, data-source, and filter regressions will
  surface in the `@experience` backlog signal.
- **Trade-off:** one additional Docker-based reset-path job (≈ 5–10 min) per PR run;
  consistent with all existing lightweight behavioral-test gates.
- **Obligation:** future migrations that alter `v_shop_morning_queue_scope`,
  `pm_work_orders`, or their RLS / grant configuration must keep the
  `shop_morning_queue_rls.sql` assertions passing or update them accordingly.
- **Rollback:** if the job proves consistently flaky, it can be removed from
  `validation-summary.needs` to make it non-blocking while the flakiness is
  investigated; the job definition itself should remain in the workflow.
- **ADR numbering note:** ADR-0090 was claimed by the inbound re-rental fleet
  sourcing CI gate (merged while PR #1977 was in conflict). This ADR therefore uses
  0091.

## Alternatives considered

- **Use ADR-0090** — not possible; `0090-inbound-rerental-fleet-sourcing-ci-gate.md`
  is already Accepted in `main`.
- **Add a Supabase CLI reset-path step** — the existing `run_shop_morning_queue_rls.sh`
  uses a throwaway Docker container (the same approach as several other recently
  shipped gates). Switching to the Supabase CLI `db reset` path would require
  rewriting the script, which is out of scope for this re-kick. The Docker-container
  path already validates the full migration stack.
- **Make the E2E test gating** — rejected because queue availability depends on
  seeded ops data in the deployed dev environment; making it gating would create
  fragile flake. The non-gating `test.fail(true, ...)` pattern is the established
  convention (see fleet rebalancing and branch morning-brief tests).

## Evidence

- Migrations: `supabase/migrations/20260614200000_*.sql`,
  `supabase/migrations/20260614210000_*.sql`
- Test SQL: `supabase/tests/shop_morning_queue_rls.sql`
- Runner: `supabase/tests/run_shop_morning_queue_rls.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-shop-morning-queue-rls`
- E2E spec: `frontend/e2e/experience.spec.ts` — `@ops shop morning queue page load
  and filter sanity`
- Related ADRs: ADR-0064 (non-gating quality lanes), ADR-0083 (field-operator
  asset-write reset-path pattern), ADR-0090 (inbound re-rental sourcing gate)
- Issue: #2004
- Closed PR: #1977
