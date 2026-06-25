# ADR-0083: field_operator asset-write RPC authorization behavioral test CI gate

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Copilot / database steward review (PR #1898)
- **Supersedes / Superseded by:** none

## Context

PR #1898 added `supabase/migrations/20260616080000_field_operator_asset_status_write.sql`,
which widens the `field_operator` allow-list in `rental_upsert_entity_current_state` to
include `'asset'` alongside `'inspection'`, `'maintenance_record'`, and
`'rental_contract_line'`.

The database steward review (comment on PR #1898) flagged that the migration shipped
without behavioral proof that:

1. A `field_operator` authenticated user can upsert an `asset` entity after the change.
2. A `field_operator` is still denied for entity types outside the allow-list (e.g. `customer`).
3. `anon` remains denied.
4. `admin`, `branch_manager`, and `service_role` paths are unaffected.

Without a CI gate the authorization boundary can regress silently if a future migration
accidentally narrows or resets the `rental_upsert_entity_current_state` function body.

A test script (`supabase/tests/run_field_operator_asset_write.sh`) was written that spins
up a throwaway Postgres container, applies all migrations in order, and runs
`supabase/tests/field_operator_asset_write.sql`. That SQL uses `SET LOCAL ROLE` and
`set_config('request.jwt.claims', …)` to prove all four role paths above.

## Decision

We add a `supabase-field-operator-asset-write` job to `pr-validation.yml` that runs
`bash supabase/tests/run_field_operator_asset_write.sh` on every PR, and wire the result
into the `validation-summary` required gate.

The job follows the same Docker-based throwaway-container pattern as
`supabase-ops-audit-trail-view-rls` (ADR-0061): it does not use the Supabase CLI and
does not need `supabase/setup-cli@v2` because `SET LOCAL ROLE` authorization tests run
correctly against a bare Postgres container.

## Consequences

- **Easier:** database and security reviewers have automated evidence that the
  `field_operator` asset-write boundary survives every migration replay, closing the
  behavioral-proof gap flagged in the steward review.
- **Trade-off:** one additional Docker-based job (≈ 60–90 s) per PR run; consistent with
  `supabase-ops-audit-trail-view-rls` and `supabase-rpc-guards`.
- **Obligation:** future migrations that touch `rental_upsert_entity_current_state` or the
  `field_operator` allow-list must keep the assertions passing or update them to match the
  new behavior.
- **Rollback:** if the test proves consistently flaky, the job can be removed from
  `validation-summary.needs` to make it non-blocking while the flakiness is investigated.
  Full removal requires a follow-up PR and a superseding ADR update.

## Alternatives considered

- **Skip CI and rely on manual run** — rejected; the database steward explicitly requires
  automated behavioral proof before clearing the DB review checklist item.
- **Use Supabase CLI reset harness** — the CLI harness applies migrations via
  `supabase db reset` and is suitable for schema-level checks. The RLS behavioral test
  requires `SET LOCAL ROLE` and `set_config(…)` which work in plain Postgres but the bare
  Postgres container approach is consistent with the existing RPC-guard jobs (ADR-0061).

## Evidence

- Migration: `supabase/migrations/20260616080000_field_operator_asset_status_write.sql`
- Test SQL: `supabase/tests/field_operator_asset_write.sql`
- Runner: `supabase/tests/run_field_operator_asset_write.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-field-operator-asset-write`
- Related ADR: ADR-0061 (same Docker-based pattern)
- PR: #1898
