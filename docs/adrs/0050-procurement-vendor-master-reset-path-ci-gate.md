# ADR-0050: Procurement vendor master reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Tech Review, Platform, Copilot
- **Supersedes / Superseded by:** N/A

## Context
PR #1334 merged `supabase/migrations/20260612194000_procurement_vendor_master_controls.sql` with SQL regression coverage (the existing `run_procurement_vendor_master_controls.sh` / `procurement_vendor_master_controls.sql` pair) but without a clean-reset migration validation job.  The migration introduces `procurement_upsert_vendor_master`, `procurement_upsert_vendor_contact`, `procurement_evaluate_vendor_authorization`, `procurement_authorization_policies`, and the `procurement_vendor_master_current` / `procurement_vendor_purchasing_contacts_current` views — none of which had a CI gate proving they survive `supabase db reset` from a blank database.

The risk is reset-path drift: behavior validated only against an already-evolved database can break silently on a fresh schema rebuild, leaving the regression undiscovered until a new environment is provisioned or a later migration conflicts.  Issue #1373 captured this gap explicitly.

## Decision
We add a named, required CI job `supabase-procurement-vendor-master-reset` to `.github/workflows/pr-validation.yml`.  The job runs `bash supabase/tests/run_procurement_vendor_master_controls_reset.sh`, which performs a full `supabase db reset` and then asserts:

1. `procurement_upsert_vendor_master` (SECURITY DEFINER), `procurement_upsert_vendor_contact` (SECURITY DEFINER), and `procurement_evaluate_vendor_authorization` (SECURITY INVOKER) exist in the rebuilt schema with the correct identity-argument signatures.
2. `procurement_vendor_master_current` and `procurement_vendor_purchasing_contacts_current` views exist.
3. `procurement_authorization_policies` table exists.
4. `procurement_upsert_vendor_master` creates a vendor at version 1 and surfaces it correctly via the view.
5. A subsequent update closes the prior version (SCD2) and creates version 2.
6. `procurement_evaluate_vendor_authorization` returns `vendor_inactive` for a deactivated vendor.
7. `procurement_upsert_vendor_contact` creates an approved purchasing contact that appears in the contacts view.
8. Policy-based authorization returns `auto_approved` / `approval_required` correctly based on configured amount tiers.
9. `read_only` role is denied direct INSERT on `procurement_authorization_policies` (RLS, 42501).
10. `branch_manager` role can INSERT directly into `procurement_authorization_policies`.
11. `read_only` role is denied `procurement_upsert_vendor_master` and `procurement_upsert_vendor_contact` RPCs (42501).
12. `branch_manager` role can successfully call both vendor and contact upsert RPCs.

## Consequences
- Fresh-schema regressions in the procurement vendor master migration path fail PR validation before merge.
- The PR workflow gains one more required Supabase reset-path job, adding to CI runtime.
- Future changes to `20260612194000_procurement_vendor_master_controls.sql` or dependent migrations must keep the reset-path assertions green unless a superseding ADR replaces this gate.

## Alternatives considered
- Rely on manual `supabase db reset` checks only — rejected because it is easy to skip and does not protect main.
- Fold assertions into the existing `supabase-procurement-vendor-master` job — rejected because that job uses a throwaway Docker Postgres container, not the Supabase CLI reset path, and cannot prove clean-reset compatibility.

## Evidence
- `.github/workflows/pr-validation.yml`
- `supabase/tests/procurement_vendor_master_controls_reset.sql`
- `supabase/tests/run_procurement_vendor_master_controls_reset.sh`
- `supabase/migrations/20260612194000_procurement_vendor_master_controls.sql`
- Issue #1373 (`Add tests for Add procurement vendor master and purchasing authorization controls`)
