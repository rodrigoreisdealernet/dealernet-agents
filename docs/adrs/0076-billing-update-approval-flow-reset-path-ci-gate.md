# ADR-0076: Billing-update request approval-flow reset-path validation is a required PR gate

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** Copilot (PR #1744)
- **Supersedes / Superseded by:** none

## Context

PR #1744 merged
`supabase/migrations/20260615210000_billing_update_request_approval_flow.sql`,
which adds:

- `portal_billing_update_scope_tokens` — SHA-256-hashed, expiring, revocable
  tokens scoped to a customer/billing account.
- `billing_update_request` — request records with full audit log.
- `v_billing_update_request_queue` — ops review queue view (service_role only).
- `ops_get_billing_update_queue` — security-definer RPC for browser ops callers.
- Six RPCs: `portal_issue_billing_update_token`,
  `portal_revoke_billing_update_token`,
  `portal_submit_billing_update_request`,
  `portal_get_billing_update_status`,
  `ops_record_billing_update_decision`,
  `ops_apply_billing_update`,
  `ops_get_billing_update_queue`.

The database steward review (PR #1744) identified three issues across two rounds:

Round 1:
1. `v_billing_update_request_queue` was declared with `security_invoker = true`
   while the underlying `billing_update_request` table revokes all privileges
   from `authenticated`.  This made the view unreachable for authenticated ops
   users (the intended audience).
2. `ops_record_billing_update_decision` and `ops_apply_billing_update` checked
   the caller's app role but not their tenant, allowing an authenticated ops
   admin from tenant-A to act on tenant-B's requests.
3. No `supabase db reset` guardrail existed to prove the security model
   survives migration replay.

Round 2:
4. After removing `security_invoker = true` in round 1 and granting the view
   to `authenticated`, the steward identified that this creates a non-`security_invoker`
   view accessible to `authenticated` — which is blocked by the repo-wide database
   stewardship rule for issue #272 (all new/modified views exposed to
   `anon`/`authenticated` must declare `security_invoker`).  A security-definer
   view without `security_invoker` bypasses base-table RLS/privilege enforcement.

## Decision

1. **Fix the view access model** — `v_billing_update_request_queue` is restricted
   to `service_role` only (no `authenticated` grant, no `security_invoker` needed).
   It is intended for trusted backend use (Temporal activities, admin tooling).
2. **Add `ops_get_billing_update_queue` security-definer RPC** — browser-authenticated
   ops callers (admin / branch_manager / credit_manager) call this function instead
   of querying the view directly.  The function enforces: role check (42501 for
   non-ops callers), tenant scoping (authenticated callers see only their own
   tenant), and optional status/type filters.  service_role bypasses tenant
   scoping.  anon has no EXECUTE grant.
3. **Add tenant scoping** to `ops_record_billing_update_decision` and
   `ops_apply_billing_update` so authenticated callers are denied for requests
   belonging to other tenants.
4. **Add `supabase/tests/billing_update_request_approval_flow.sql`** — 15+
   behavioral assertions covering: structural grants (including view being
   service_role-only and RPC being granted to authenticated), full service_role
   lifecycle, anon submission/status, invalid/revoked/expired token denial,
   direct table denial, non-ops role denial, own-tenant ops access via RPC,
   and cross-tenant ops denial.
5. **Add `supabase/tests/run_billing_update_request_approval_flow_reset.sh`**
   — reset runner that applies a full `supabase db reset` and executes the
   SQL test suite, proving the security model survives migration replay.
6. **Add a CI gate** in `.github/workflows/pr-validation.yml` as job
   `supabase-billing-update-request-reset`, wired into `validation-summary`,
   so future PRs touching this surface are gated on the reset validation.
7. **Add RPC data source support to the JSON UI engine** — `SupabaseDataSource`
   in the engine gains optional `rpc` and `params` fields.  `executeSupabaseQuery`
   routes through `client.rpc()` when `source.rpc` is set.  This allows the
   `ops-billing-update-queue` page to call `ops_get_billing_update_queue` as a
   first-class data source without an additional HTTP indirection layer.

## Consequences

- `v_billing_update_request_queue` is no longer accessible to `authenticated`.
  Browser ops callers use `ops_get_billing_update_queue()`.  Temporal activities
  continue to use the view via service_role.
- Cross-tenant ops decision and apply are blocked at the RPC level for
  authenticated callers.
- A full `supabase db reset` (~2 min) is added to PR CI.  This is consistent
  with the existing pattern established by ADR-0074 and ADR-0075.
- The CI job is classified `timeout-minutes: 20`, matching the convention for
  reset-path jobs.
