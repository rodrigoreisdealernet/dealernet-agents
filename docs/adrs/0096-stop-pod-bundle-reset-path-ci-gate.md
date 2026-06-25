# ADR-0096: Stop proof-of-delivery bundle reset-path CI gate

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Copilot coding agent (issue #1962)
- **Supersedes / Superseded by:** none

## Context

PR #1922 ("feat: mobile proof-of-delivery and pickup evidence bundles") shipped
two migrations:

- `20260616120000_stop_pod_bundles.sql` — `stop_pod_bundles` table, RLS policies,
  `get_stop_pod` RPC, and `update_route_stop_state` extension that upserts a POD
  bundle when a stop transitions to `completed`.
- `20260617130000_delivery_complaint_proof_bundle.sql` — `delivery_complaint_cases`
  table, `upsert_complaint_case` / `get_complaint_case` RPCs, and the
  `v_complaint_case_review_bundle` view that assembles complaint + stop + route +
  POD evidence into a single reviewer-ready bundle.

Companion test scripts were subsequently added for both migrations:

| Script | Type |
|---|---|
| `supabase/tests/run_stop_pod_bundles.sh` | Docker behavioral (full RLS chain) |
| `supabase/tests/stop_pod_bundles.sql` | Assertions: grants, RLS policies, oracle normalisation |
| `supabase/tests/run_stop_pod_bundles_reset.sh` | Supabase CLI `db reset` replay |
| `supabase/tests/stop_pod_bundles_reset.sql` | Post-reset assertions: table/RLS/RPCs, full stop→bundle flow |
| `supabase/tests/run_delivery_complaint_proof_bundle_reset.sh` | Supabase CLI `db reset` replay |
| `supabase/tests/delivery_complaint_proof_bundle_reset.sql` | Post-reset assertions: table/RLS/RPCs/view, upsert idempotency, review-bundle JSONB shape |

None of these were wired into `pr-validation.yml`, leaving two gaps identified by
issue #1962:

1. No automated reset-path guardrail that all POD-bundle migrations still replay
   cleanly after a `supabase db reset` (the canonical pre-merge smoke test).
2. No CI signal when a future migration breaks the `stop_pod_bundles` RLS chain,
   the `evidence_status` invariant, the `get_stop_pod` oracle-normalisation
   contract, or the `v_complaint_case_review_bundle` JSONB shape that the field
   proof workflow depends on.

## Decision

We add three CI jobs to `pr-validation.yml`:

1. **`supabase-stop-pod-bundles`** — checks out the repository and calls
   `bash supabase/tests/run_stop_pod_bundles.sh`. This script spawns a throwaway
   Postgres 17 Docker container, applies the full migration stack, and runs
   `stop_pod_bundles.sql` (structural + grant + RLS behavioural assertions
   including oracle normalisation and field_operator / branch_manager isolation).
   Follows the same Docker-container pattern as `supabase-field-operator-asset-write`
   and `supabase-shop-morning-queue-rls`.

2. **`supabase-stop-pod-bundles-reset`** — checks out the repository, installs the
   Supabase CLI, and calls `bash supabase/tests/run_stop_pod_bundles_reset.sh`.
   This runs a full `supabase db reset` and then executes
   `stop_pod_bundles_reset.sql` to assert: (a) table exists with RLS enabled,
   (b) `get_stop_pod` and `update_route_stop_state` RPCs are present,
   (c) the full departure → arrival → completion state-machine path upserts a POD
   bundle with `evidence_status = 'complete'`, and (d) `get_stop_pod` excludes
   `driver_id` from its output.

3. **`supabase-delivery-complaint-proof-bundle-reset`** — checks out the repository,
   installs the Supabase CLI, and calls
   `bash supabase/tests/run_delivery_complaint_proof_bundle_reset.sh`. This runs a
   full `supabase db reset` and then executes
   `delivery_complaint_proof_bundle_reset.sql` to assert: (a) `delivery_complaint_cases`
   table exists with RLS enabled, (b) `upsert_complaint_case` / `get_complaint_case`
   RPCs and `v_complaint_case_review_bundle` view are present, (c) upsert is
   idempotent (repeated upsert for the same open thread returns the same `case_id`),
   and (d) the `review_bundle` JSONB from the view contains all expected `complaint`,
   `stop`, and `route` sub-objects including `requires_human_review`.

All three jobs are added to `validation-summary.needs` so a failure surfaces as a
required-gate signal in the PR summary table.

## Consequences

- **Easier:** future migrations that touch `stop_pod_bundles`, `route_stops`,
  `dispatch_routes`, `delivery_complaint_cases`, or their associated RPCs/views
  will receive immediate CI feedback if the POD or complaint proof schema breaks.
- **Easier:** the `supabase db reset` replay path for both POD migrations is now a
  required gate, closing the gap identified in issue #1962.
- **Trade-off:** two additional Supabase CLI reset jobs (≈ 10–15 min each) plus one
  Docker-based behavioral job (≈ 5 min) per PR run; consistent with all existing
  reset-path gates already in the pipeline.
- **Obligation:** future migrations that alter `stop_pod_bundles`, `get_stop_pod`,
  `delivery_complaint_cases`, `upsert_complaint_case`, `get_complaint_case`, or
  `v_complaint_case_review_bundle` must keep the corresponding test SQL assertions
  passing or update them accordingly.
- **Rollback:** if any job proves consistently flaky, it can be removed from
  `validation-summary.needs` to make it non-blocking while the flakiness is
  investigated; the job definition should remain in the workflow.

## Alternatives considered

- **Skip `supabase-delivery-complaint-proof-bundle-reset`** — rejected because the
  `v_complaint_case_review_bundle` view joins `stop_pod_bundles` and is part of the
  same field proof workflow surface. Its reset-path test script already exists and
  was written to be run in CI.
- **Use Docker-only tests for the reset coverage** — rejected because `run_stop_pod_bundles.sh`
  (Docker) does not invoke the Supabase CLI `db reset` command; verifying that migrations
  replay correctly through the CLI is the specific gap cited in the issue.
- **Merge all three into a single job** — rejected to keep failure messages
  isolated and to follow the established one-feature-per-job convention used by
  every other reset-path gate in the pipeline.

## Evidence

- Migrations: `supabase/migrations/20260616120000_stop_pod_bundles.sql`,
  `supabase/migrations/20260617130000_delivery_complaint_proof_bundle.sql`
- Test SQL: `supabase/tests/stop_pod_bundles.sql`,
  `supabase/tests/stop_pod_bundles_reset.sql`,
  `supabase/tests/delivery_complaint_proof_bundle_reset.sql`
- Runners: `supabase/tests/run_stop_pod_bundles.sh`,
  `supabase/tests/run_stop_pod_bundles_reset.sh`,
  `supabase/tests/run_delivery_complaint_proof_bundle_reset.sh`
- CI jobs: `.github/workflows/pr-validation.yml` —
  `supabase-stop-pod-bundles`,
  `supabase-stop-pod-bundles-reset`,
  `supabase-delivery-complaint-proof-bundle-reset`
- Related ADRs: ADR-0083 (field-operator asset-write reset-path pattern),
  ADR-0090 (inbound re-rental sourcing gate), ADR-0091 (shop morning queue gate)
- Issue: #1962
- Source PR: #1922
