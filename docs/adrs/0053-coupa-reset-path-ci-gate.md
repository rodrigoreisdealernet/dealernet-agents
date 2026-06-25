# ADR-0053: Coupa reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context
PR #1208 merged the Coupa observability and reconciliation migration with focused frontend contract
coverage plus SQL assertions, but without a clean-reset Supabase validation job.  The existing
`supabase/tests/run_coupa_observability_reconciliation.sh` runner only replayed migrations into a
throwaway Postgres container, so it never proved that
`supabase/migrations/20260611113000_coupa_observability_reconciliation.sql` survives
`supabase db reset` from a blank schema plus seed rebuild.

That left a gap for issue #1248: recovery controls, reconciliation views, and diagnostic queries
could look correct on an already-evolved database while still breaking when a fresh environment is
provisioned or when later migrations rebuild the schema from scratch.

## Decision
We add a named, required CI job
`supabase-coupa-observability-reconciliation-reset` to
`.github/workflows/pr-validation.yml`.  The job runs
`bash supabase/tests/run_coupa_observability_reconciliation.sh`, which now performs a full
`supabase db reset` before executing the Coupa SQL assertions against the rebuilt database.

The reset-path assertions cover:

1. Coupa observability and reconciliation views (`v_coupa_sync_dashboard`,
   `v_coupa_failed_sync_work`, `v_coupa_reconciliation_drift`,
   `v_coupa_reconciliation_summary`) still declare `security_invoker = true`.
2. Anonymous sessions remain denied direct reads of Coupa tables and views.
3. Anonymous sessions remain denied the Coupa operator RPCs.
4. Authenticated sessions without an app role still see zero Coupa tenant rows.
5. Tenant-scoped operator sessions can read only their own failed-work and reconciliation rows.
6. Recovery controls and replay/quarantine flows still work after a full reset.
7. Reconciliation summary and drift diagnostics still return the expected counts and statuses after
   a fresh migration + seed rebuild.

## Consequences
- Fresh-schema regressions in the Coupa migration path now fail PR validation before merge.
- PR validation gains one more required Supabase reset-path job, which slightly increases CI time.
- Future changes to the Coupa migration surface must keep the reset-path assertions green unless a
  superseding ADR replaces this gate.

## Alternatives considered
- Rely on manual `supabase db reset` verification during review — rejected because it is easy to
  skip and does not protect main.
- Keep the existing Docker Postgres runner only — rejected because it replays migrations outside
  the Supabase CLI reset path and cannot prove clean-reset compatibility for the real local/CI
  stack.

## Evidence
- `.github/workflows/pr-validation.yml`
- `supabase/tests/run_coupa_observability_reconciliation.sh`
- `supabase/tests/coupa_observability_reconciliation.sql`
- `supabase/migrations/20260611113000_coupa_observability_reconciliation.sql`
- Issue #1248 (`Add tests for Add Coupa observability, recovery controls, and reconciliation views`)
