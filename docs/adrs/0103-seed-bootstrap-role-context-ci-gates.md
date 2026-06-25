# ADR-0103: Seed DO-block write-RPC role-context CI gates

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Copilot coding agent (issue #2223), @ianreay
- **Supersedes / Superseded by:** none

## Context

PR #2206 hardened the three write RPCs (`create_entity_with_version`,
`rental_upsert_entity_current_state`, `rental_upsert_relationship`) with a
`request.jwt.claim.role = 'service_role'` guard that blocks unauthenticated callers
at execution time. The companion `seed.sql` was updated so its `DO $$` bootstrap
blocks call `set_config('request.jwt.claim.role', 'service_role', true)` inside each
block to satisfy the guard when the RPCs are invoked during a local stack reset.

PR #2206 shipped without automated validation of two distinct properties:

1. **Role-context invariants** — that the `set_config` scoping pattern inside a `DO $$`
   block actually satisfies the guard (and that omitting the claim blocks the call with
   `SQLSTATE 42501`). These contract invariants were never verified by CI.
2. **End-to-end reset path** — that a `supabase db reset` (all migrations + full
   `seed.sql`) completes without write-RPC guard failures. Nothing in CI exercised
   the `seed.sql` execution path.

Issue #2223 identified both gaps. The fix adds two complementary runners and two CI
jobs that together close them.

## Decision

We add two CI jobs to `pr-validation.yml`:

1. **`supabase-seed-bootstrap-role-context`** — checks out the repository and calls
   `bash supabase/tests/run_seed_bootstrap_role_context.sh`. This script spawns a
   throwaway Postgres 17 Docker container, applies the auth stub and full migration
   stack, and then runs `seed_bootstrap_role_context.sql` — four targeted invariants:
   - **A**: `set_config` inside a DO block (no outer `SET LOCAL`) enables all three
     write RPCs — proves the block is self-contained.
   - **B**: No claim set → write RPCs blocked with `SQLSTATE 42501` — proves the
     guard fires at execution time inside a DO block.
   - **C**: Outer `SET LOCAL` + inner `set_config` (exact `seed.sql` layout) succeeds
     end-to-end.
   - **D**: Outer `SET LOCAL` propagates into a subsequent DO block scope —
     documents the PostgreSQL GUC transaction-scope guarantee `seed.sql` relies on.

2. **`supabase-seed-bootstrap-role-context-reset`** — checks out the repository,
   installs the Supabase CLI, and calls
   `bash supabase/tests/run_seed_bootstrap_role_context_reset.sh`. This script runs
   `supabase db reset` (full migrations + `seed.sql`) and then executes the same
   `seed_bootstrap_role_context.sql` contract assertions against the live reset-path
   database, proving that `seed.sql` executes end-to-end without write-RPC guard
   failures.

Both jobs are added to `validation-summary.needs` and the report table so failures
surface as required-gate signals in the PR summary.

## Consequences

- **Easier:** any future migration or seed change that breaks the role-claim scoping
  pattern for write RPCs will fail CI immediately on both the isolated contract path
  and the full `supabase db reset` path.
- **Easier:** the `seed.sql` execution path is now a required gate, closing the
  regression gap identified in issue #2223.
- **Trade-off:** one additional Docker-based contract job (≈ 5 min) and one Supabase
  CLI reset job (≈ 10–15 min) per PR run; consistent with existing reset-path gates.
- **Obligation:** if the write-RPC guard pattern or its `set_config` scoping
  convention changes in a future PR, `seed_bootstrap_role_context.sql` must be
  updated to match.
- **Rollback:** either job can be removed from `validation-summary.needs` to make it
  non-blocking while investigating flakiness; the job definition should remain in the
  workflow.

## Alternatives considered

- **Contract tests only (no reset-path job)** — rejected because isolated contract
  tests do not exercise `seed.sql` through the Supabase CLI reset path; a subtle
  `seed.sql` error would pass the contract job but fail on `supabase db reset`.
- **Reset-path job only (drop the Docker contract job)** — rejected because the
  Docker job proves the four focused invariants (including the negative `SQLSTATE
  42501` guard-fires case) in isolation without the full stack overhead; losing this
  signal would make failures harder to localise.
- **Inline assertions in the existing `supabase-seed` job** — rejected because the
  existing `supabase-seed` job runs the demo-baseline seed, not the role-context
  invariants; mixing them would couple unrelated failure modes.

## Evidence

- Test SQL: `supabase/tests/seed_bootstrap_role_context.sql`
- Runners: `supabase/tests/run_seed_bootstrap_role_context.sh`,
  `supabase/tests/run_seed_bootstrap_role_context_reset.sh`
- CI jobs: `.github/workflows/pr-validation.yml` —
  `supabase-seed-bootstrap-role-context`,
  `supabase-seed-bootstrap-role-context-reset`
- Related ADRs: ADR-0096 (stop-pod-bundle reset-path CI gate pattern),
  ADR-0100 (route-exception thread bundle reset-path CI gate)
- Issue: #2223
- Source PR: #2206 (hardened write-RPC guards), this PR
