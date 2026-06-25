# ADR-0088: Coupa integration config reset-path CI gate

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Copilot / database steward review (issue #1656)
- **Supersedes / Superseded by:** none

## Context

PR #1622 merged `supabase/migrations/20260614143000_coupa_integration_config.sql`, which
registers `coupa` in the shared `integration_config` contract, adds the
`idx_integration_config_coupa_tenant` partial index, and updates the table comment to
enumerate all supported connector keys.

Issue #1656 identified that this migration shipped without a clean-reset guardrail:

1. No automated validation that `20260614143000_coupa_integration_config.sql` applies
   cleanly through `supabase db reset --config supabase/config.toml`.
2. No post-reset assertion proving the rebuilt schema still supports tenant-isolated
   Coupa connection setup (secret_refs isolation, tenant-scoped RLS, credential rotation).
3. The existing Coupa SQL behavioral tests (`coupa_integration_config.sql`) run against a
   throwaway Docker container but do not exercise the Supabase CLI reset path, which is
   the canonical migration replay mechanism for this codebase.

Without a reset-path CI gate, the migration can silently break the full migration stack
(e.g. via a duplicate-version conflict or ordering regression) without blocking a PR.

## Decision

We add a `supabase-coupa-integration-config-reset` job to `pr-validation.yml` that:

1. Installs the Supabase CLI and calls `supabase db reset` to replay all migrations.
2. Runs `supabase/tests/coupa_integration_config_reset.sql` against the rebuilt database,
   asserting: migration version recorded, Coupa index present, table comment updated,
   service_role insert with all supported scopes, secret_refs isolation, tenant-scoped
   RLS (admin sees only own row, cross-tenant deny), credential rotation, and read_only
   write denial.

The job follows the same reset-path harness pattern as `supabase-coupa-observability-
reconciliation-reset` (uses `reset_validation_lib.sh`, `run_supabase_start_with_transient_retry`,
and `run_supabase_reset_with_transient_retry`).

The result is wired into the `validation-summary` required gate.

## Consequences

- **Easier:** database and security reviewers have automated evidence that the Coupa
  tenant-scoped configuration contract survives every migration replay, closing the
  reset-path gap flagged in issue #1656.
- **Easier:** future migrations that build on the Coupa integration_config foundation
  will automatically fail this gate if they break replay order or the structural
  assertions.
- **Trade-off:** one additional Supabase CLI reset job (≈ 5–10 min) per PR run;
  consistent with existing reset-path gates.
- **Obligation:** future migrations that alter `integration_config`, the Coupa partial
  index, or the table comment must keep the assertions passing or update them accordingly.
- **Rollback:** if the test proves consistently flaky, the job can be removed from
  `validation-summary.needs` to make it non-blocking while the flakiness is investigated.

## Alternatives considered

- **Extend the existing `integration_config_reset` test** — that file already covers
  Coupa tenant-scoped behavior (resets 7b–7i), but it does not verify the structural
  artifacts introduced by migration `20260614143000` (index, comment). A dedicated file
  makes the migration's specific contract explicit and easier to maintain.
- **Reuse the throwaway Docker container pattern** from `run_coupa_integration_config.sh`
  — rejected for this gate because the acceptance criteria explicitly require the
  Supabase CLI `db reset` path, which is the repo-standard migration replay mechanism.

## Evidence

- Migration: `supabase/migrations/20260614143000_coupa_integration_config.sql`
- Test SQL: `supabase/tests/coupa_integration_config_reset.sql`
- Runner: `supabase/tests/run_coupa_integration_config_reset.sh`
- CI job: `.github/workflows/pr-validation.yml` — `supabase-coupa-integration-config-reset`
- Related ADR: ADR-0076 (narrow temporal reset-path scope), ADR-0083 (same reset-path pattern)
- Issue: #1656
- PR: #1622
