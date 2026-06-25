# ADR-0057: NetSuite entity mapping sync contract reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context

PR #1362 merged `20260612214000_netsuite_entity_mapping_sync_contract.sql` with focused SQL
coverage under `supabase/tests/netsuite_entity_mapping_sync_contract.sql`, but no clean-reset
Supabase validation job was wired into `.github/workflows/pr-validation.yml`.

The existing Docker-based runner (`supabase/tests/run_netsuite_entity_mapping_sync_contract.sh`)
applies migrations manually against a throwaway Postgres container, which is sufficient for
regression testing on a running schema but does not exercise the `supabase db reset` path.  A
fresh environment provision (as used in dev, staging, and new team-member onboarding) goes through
`supabase db reset`, which can expose ordering or dependency issues that only appear when the
entire migration chain is replayed from scratch.

Issue #1395 identified this gap: the NetSuite supported-entity contract, mapping view, idempotency
constraint, and external-ID immutability trigger had no reset-path guardrail proving they still
behave correctly after a fresh migration rebuild.

## Decision

We add a named, required CI job `supabase-netsuite-entity-mapping-sync-contract-reset` to
`.github/workflows/pr-validation.yml`.  The job runs
`bash supabase/tests/run_netsuite_entity_mapping_sync_contract_reset.sh`, which performs a full
`supabase db reset` before executing SQL assertions against the rebuilt database.

The reset-path assertions cover:

1. `netsuite_supported_entity_contract()` function exists and returns the expected entity/direction
   shape — five entries (customer outbound, invoice outbound, general_ledger outbound,
   accounts_payable inbound, accounts_receivable inbound) plus four required external-identifier
   fields.
2. `v_netsuite_entity_mapping_contract` view exists with `security_invoker = true`.
3. `trg_external_id_map_netsuite_external_id_guard` trigger exists on `external_id_map`.
4. `integration_delivery_log_netsuite_external_identifier_chk` check constraint exists on
   `integration_delivery_log`.
5. Replay-safe delivery log: the check constraint blocks a payload missing `external_id`; a
   correct payload inserts successfully; an idempotent upsert preserves exactly one row.
6. Replay-safe external_id_map: an `UPDATE` that changes `external_id` is rejected by the trigger;
   a stable-ID replay upsert preserves exactly one row with the original `external_id`.

The job is added to the `validation-summary` `needs` list and summary matrix so the result is
visible on every PR.

## Consequences

- Fresh-schema regressions in the NetSuite migration path now fail PR validation before merge.
- PR validation gains one more required Supabase reset-path job, slightly increasing CI time.
- Future changes to the NetSuite migration surface must keep the reset-path assertions green unless
  a superseding ADR replaces this gate.

## Alternatives considered

- Rely on the existing Docker-based `run_netsuite_entity_mapping_sync_contract.sh` — rejected
  because it does not exercise `supabase db reset` and therefore cannot catch fresh-reset ordering
  or dependency failures.
- Rely on manual `supabase db reset` verification during review — rejected because it is easy to
  skip and does not protect main.

## Evidence

- `.github/workflows/pr-validation.yml` (job `supabase-netsuite-entity-mapping-sync-contract-reset`)
- `supabase/tests/run_netsuite_entity_mapping_sync_contract_reset.sh`
- `supabase/tests/netsuite_entity_mapping_sync_contract_reset.sql`
- `supabase/migrations/20260612214000_netsuite_entity_mapping_sync_contract.sql`
- ADR-0054 (`0054-sage-observability-reconciliation-reset-path-ci-gate.md`) — precedent for this gate pattern
- Issue #1395
