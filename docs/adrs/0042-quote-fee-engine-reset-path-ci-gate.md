# ADR-0042: Dedicated reset-path CI gate for quote fee engine + tax presets

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** Tech Reviewer
- **Supersedes / Superseded by:** -

## Context

PR #997 shipped the quote fee engine, tax presets, and staff quote-builder migration (`20260610130000_quote_fee_engine_tax_presets.sql`) with frontend unit tests and a SQL behavioral suite (`supabase/tests/quote_fee_engine.sql`), but no CI job ran `supabase db reset` before executing those assertions.

Without a reset-path job the SQL suite runs only against an already-evolved dev database. That means it cannot catch schema ordering bugs, `CREATE TABLE IF NOT EXISTS` conflicts with earlier migrations, or FK references that only exist because a prior manual migration created them. The bare-Postgres Docker path used by the existing `run_quote_fee_engine.sh` job applies all migrations sequentially but does not exercise the Supabase CLI reset machinery, so GoTrue FK enforcement (e.g. `staff_quote_drafts.created_by → auth.users`) is not validated.

The project already has a pattern for this: other feature migrations (storefront availability, CRM customer profile, portal catalog requisition, CRM intake scope tokens) each have a matching `run_*_reset.sh` CI job that runs `supabase db reset` then executes the behavioral SQL suite.

## Decision

We add a dedicated `supabase-quote-fee-engine-reset` CI job in `pr-validation.yml` that applies all migrations from scratch via `supabase db reset` and then runs `quote_fee_engine.sql` against the reset database, following the same pattern as existing reset-path jobs.

## Consequences

- The quote fee engine migration and its FK/RLS assumptions are validated against a clean rebuild on every PR, not just against an already-evolved database.
- `quote_fee_engine.sql` must seed any `auth.users` rows required by FK constraints before calling `staff_quote_save_draft`, because GoTrue enforces the FK on the Supabase reset stack.
- One additional Supabase CLI + Docker job runs on every PR, adding roughly the same wall-clock overhead as the other reset-path jobs (typically 2–4 minutes).
- The `validation-summary` job now depends on this new job, so a reset failure blocks the summary.

## Alternatives considered

- **Rely on the existing bare-Postgres `run_quote_fee_engine.sh` job:** rejected because that path does not exercise Supabase CLI reset or GoTrue FK enforcement; it cannot catch the class of ordering bug this gate is meant to detect.
- **Extend the existing `run_storefront_availability_quote_reset.sh` job:** rejected because that test suite targets availability/RLS contracts for a different migration; mixing concerns would make failures harder to diagnose.

## Evidence

- `supabase/tests/run_quote_fee_engine_reset.sh`
- `supabase/tests/quote_fee_engine.sql`
- `supabase/migrations/20260610130000_quote_fee_engine_tax_presets.sql`
- `.github/workflows/pr-validation.yml` (`supabase-quote-fee-engine-reset` job)
- PR #997 (original feature), PR #1104 (this gate)
