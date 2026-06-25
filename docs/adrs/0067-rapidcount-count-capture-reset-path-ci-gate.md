# ADR-0067: RapidCount count-capture reset-path CI gate

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Security Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context

PR #1448 fixed a duplicate-timestamp collision by renaming the RapidCount
mobile count-capture migration from `20260613020000_rapidcount_count_capture.sql`
to `20260613021000_rapidcount_count_capture.sql` so it no longer shares a
primary-key version with
`20260613020000_procurement_receiving_po_match_warranty.sql` (incident #1434).

The rename corrected the in-repo filename, but PR #1448 shipped without any
automated assertion that a fresh `supabase db reset` applies the renamed
migration in the correct position in the sequence without a collision.
Issue #1481 tracks this gap.

Without a reset-path CI job the repository cannot detect a regression where
the duplicate-version fix is accidentally reverted, a future migration
accidentally re-uses the 20260613021000 timestamp, or the migration objects
themselves fail to apply in a clean-schema context.

The project already has a well-established pattern: every migration whose
ordering or idempotency matters gets a dedicated `run_*_reset.sh` CI job
paired with a SQL assertion file. This gate follows that same pattern.

Because the new job lives under `.github/workflows/pr-validation.yml`, it is
a control-plane change that requires an ADR in the same PR.

## Decision

We add a named, required CI job `supabase-rapidcount-count-capture-reset` to
`.github/workflows/pr-validation.yml`. The job runs
`bash supabase/tests/run_rapidcount_count_capture_reset.sh`, which:

1. Starts the local Supabase stack and runs `supabase db reset` to replay all
   migrations from scratch.
2. Executes `supabase/tests/rapidcount_count_capture_reset.sql` against the
   rebuilt database.

The reset-path SQL assertions cover:

1. **Collision guard** — both `20260613020000` and `20260613021000` appear as
   distinct rows in `supabase_migrations.schema_migrations`; no duplicate
   version entry exists.
2. **Fact type** — `rapidcount_count_capture_line` exists in `public.fact_types`.
3. **Idempotency index** — the partial unique index
   `uq_tsp_rapidcount_capture_line_source` on `public.time_series_points`
   exists.
4. **Offline queue** — `public.rapidcount_offline_queue` exists with its
   `chk_offline_queue_scan_method` and `chk_offline_queue_replay_status`
   constraints.
5. **Count-lines view** — `public.rapidcount_count_lines_current` is
   queryable without error.
6. **RPCs** — `rapidcount_start_count_task` and
   `rapidcount_capture_count_line` exist and are `SECURITY DEFINER`.
7. **Functional smoke test** — a create → start → capture → idempotent-replay
   round-trip succeeds end-to-end on the rebuilt schema.

The job is added to the `validation-summary` `needs` list and summary matrix
so the result is visible on every PR.

## Consequences

- Fresh-schema regressions in the RapidCount count-capture migration path now
  fail PR validation before merge.
- The duplicate-timestamp fix from PR #1448 is permanently guarded: any
  accidental revert or re-collision surfaces immediately in CI.
- PR validation gains one more required Supabase reset-path job, adding the
  same wall-clock overhead as other reset-path jobs (typically 2–4 minutes).
- Future changes to the 20260613020000/20260613021000 migration pair must keep
  the reset-path assertions green unless a superseding ADR replaces this gate.

## Alternatives considered

- **Rely on the existing `run_rapidcount_count_capture.sh` job** — rejected
  because that test applies migrations sequentially in a bare-Postgres Docker
  container and does not exercise the Supabase CLI reset machinery or the
  `supabase_migrations` version-tracking table, so it cannot detect duplicate-
  version collisions.
- **Add only the SQL assertions without a CI job** — rejected because without
  a CI gate the assertions are never automatically executed and provide no
  regression protection.

## Evidence

- `.github/workflows/pr-validation.yml` (job `supabase-rapidcount-count-capture-reset`)
- `supabase/tests/run_rapidcount_count_capture_reset.sh`
- `supabase/tests/rapidcount_count_capture_reset.sql`
- `supabase/migrations/20260613021000_rapidcount_count_capture.sql`
- `supabase/migrations/20260613020000_procurement_receiving_po_match_warranty.sql`
- `docs/adrs/0058-inventory-rate-structures-reset-path-ci-gate.md` — precedent
  for reset-path CI gate ADRs
- Issue #1481
- PR #1448
