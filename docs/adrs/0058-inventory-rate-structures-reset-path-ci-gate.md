# ADR-0058: Inventory rate structures reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Security Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context

PR #1392 merged `20260613001000_inventory_rate_structures.sql` with focused SQL coverage for
effective-dated rental pricing, but default-branch CI did not replay that contract through a full
`supabase db reset` path.

The existing repository checks proved the migration on an already-running schema, but they did not
guarantee that a fresh environment rebuild still preserved the required pricing boundary: rate-plan
resolution must remain deterministic and previously-saved quote/reservation price snapshots must
not change when an operator later edits the source rate plan.

Because the missing guard lived under `.github/workflows/pr-validation.yml`, it is a control-plane
change that requires an ADR in the same PR.

## Decision

We add a named, required CI job `supabase-inventory-rate-structures-reset` to
`.github/workflows/pr-validation.yml`. The job runs
`bash supabase/tests/run_inventory_rate_structures_reset.sh`, which performs a full
`supabase db reset` before executing SQL assertions against the rebuilt database.

The reset-path assertions cover:

1. Required tables and functions for inventory rate structures exist with the expected grants after
   reset.
2. Effective-dated rate-plan creation and version switching work on the rebuilt schema.
3. Rate-plan precedence remains deterministic (`asset > category > branch`).
4. `staff_save_quote_order` persists `resolved_rate_snapshot` and
   `rate_resolution_source = rate_plan` on saved quote/order lines.
5. Later edits to `inventory_rate_plans.daily_rate` do not retroactively change an already-saved
   line snapshot.

The job is added to the `validation-summary` `needs` list and summary matrix so the result is
visible on every PR.

## Consequences

- Fresh-schema regressions in the inventory rate-structure migration path now fail PR validation
  before merge.
- PR validation gains one more required Supabase reset-path job, slightly increasing CI time.
- Future pricing-surface changes must keep the reset-path assertions green unless a superseding ADR
  replaces this gate.

## Alternatives considered

- Rely on existing migration-local or incremental-schema tests — rejected because they do not prove
  the clean-reset path used for new environments and disaster recovery.
- Rely on manual `supabase db reset` verification during review — rejected because it is easy to
  skip and does not protect main.

## Evidence

- `.github/workflows/pr-validation.yml` (job `supabase-inventory-rate-structures-reset`)
- `supabase/tests/run_inventory_rate_structures_reset.sh`
- `supabase/tests/inventory_rate_structures_reset.sql`
- `supabase/migrations/20260613001000_inventory_rate_structures.sql`
- `docs/adrs/0057-netsuite-entity-mapping-sync-contract-reset-path-ci-gate.md` — precedent for
  reset-path CI gate ADRs
- PR #1553
