# ADR-0090: Inbound re-rental fleet sourcing — CI behavioral test gates

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Copilot coding agent (issue #1275)
- **Supersedes / Superseded by:** none

## Context

Issue #1275 introduced the inbound re-rental fleet sourcing model — migration
`20260615190000_inbound_rerental_fleet_sourcing.sql` and the companion
external-rental reporting migration `20260615203000_external_rental_reporting.sql`.
Both migrations ship with dedicated Docker-based behavioral test scripts
(`supabase/tests/run_inbound_rerental_fleet_sourcing.sh` and
`supabase/tests/run_external_rental_reporting.sh`) but neither script was wired
into the PR validation pipeline.

Without CI gates, a future migration could silently break the inbound re-rental
RPC functions, RLS policies, custody-transition logic, or the external-rental
reporting view without any automated signal.

## Decision

We add two gating CI jobs to `.github/workflows/pr-validation.yml`:

1. **`supabase-inbound-rerental-fleet-sourcing`** — runs
   `supabase/tests/run_inbound_rerental_fleet_sourcing.sh`, which applies all
   migrations in a throwaway Postgres container and exercises the full
   `rental_create_inbound_rerental_supply` / `rental_transition_inbound_rerental_custody`
   lifecycle plus tenant-scoped RLS on `v_inbound_rerental_supply_current`.

2. **`supabase-external-rental-reporting`** — runs
   `supabase/tests/run_external_rental_reporting.sh`, which applies all
   migrations and verifies the `v_external_rental_reporting` view joins and
   RLS behavior for the `third_party_rerental` fulfillment-model rows.

Both jobs gate the `validation-summary` job so a red result blocks merges.

## Consequences

- Regression detection for the inbound re-rental custody lifecycle, provenance
  recording, payable-event emission, and audit log completeness is now
  continuous.
- External-rental reporting accuracy (owned-fleet vs third-party rerental
  separation) is now continuously validated.
- Each job spins up a Postgres 17 container and applies the full migration
  sequence (~130 migrations), which currently completes within the 20-minute
  timeout on `ubuntu-latest`.
- Adding jobs to the required gate (`validation-summary` needs) increases PR
  CI time proportionally, but both jobs are independent and run in parallel.

## Alternatives considered

- **Reset-path (Supabase CLI) tests**: The Supabase CLI reset-path tests are
  more realistic but require the CLI to be installed and a Supabase project
  to be configured. The existing Docker-based approach is self-contained and
  already validated locally; switching would require refactoring the test
  scripts without additional coverage benefit.
- **Defer CI gate**: Leaving the scripts without a CI gate creates a silent
  regression risk every time a migration is added. Rejected in favour of
  prompt gating given the security-invoker and RLS requirements of this
  feature.

## Evidence

- Migration: `supabase/migrations/20260615190000_inbound_rerental_fleet_sourcing.sql`
- Migration: `supabase/migrations/20260615203000_external_rental_reporting.sql`
- Test SQL: `supabase/tests/inbound_rerental_fleet_sourcing.sql`
- Test SQL: `supabase/tests/external_rental_reporting.sql`
- Test runners: `supabase/tests/run_inbound_rerental_fleet_sourcing.sh`,
  `supabase/tests/run_external_rental_reporting.sh`
- CI workflow: `.github/workflows/pr-validation.yml` (this PR)
