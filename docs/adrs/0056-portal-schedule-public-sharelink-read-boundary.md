# ADR-0056: Portal schedule is a curated public share-link read surface gated by contract UUID

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** Security Reviewer, Factory Architect
- **Supersedes / Superseded by:** Supersedes the "portal does not use anonymous access" statement in ADR-0043 for the read-only schedule surface only

## Context

ADR-0043 established that the customer portal uses passwordless Supabase sessions (magic-link) and
"does not use anonymous access." That principle is correct for durable portal sessions, write
operations, and off-rent request submission.

However, the portal schedule route (`/portal/schedule/:contractId`) must render when a customer
visits the URL without having gone through the full magic-link flow — for example, a customer
clicking a share link in an email before opening a dedicated session. Before this change,
`portal_get_contract_schedule` required a scope token from all non-`service_role` callers, so
visiting the URL without `?scope=` caused a load failure before off-rent buttons ever rendered.
This made the frontend's missing-token guard unreachable and the forged-token denial path
untestable.

The schedule data returned by the function is limited to:
- Contract status and number (no PII)
- Contract line identifiers, status, start/end dates, and `line_data` (operator-managed scheduling
  fields such as `planned_start`, `planned_end`, and `job_site_id`)
- Asset name and status

None of these fields are personally identifying. Operators must not store PII in `line_data` on
rental contract lines; if that constraint cannot be guaranteed in a future deployment, the
`line_data` column must be removed from the public projection or nulled for non-`service_role`
callers.

## Decision

We treat `portal_get_contract_schedule` as a curated public share-link read surface. The contract
UUID is a 128-bit opaque identifier that acts as the per-contract bearer secret for this narrow
read-only view. Non-`service_role` callers without any scope token may read the schedule; callers
who supply a non-empty but invalid scope token are explicitly rejected (`42501`) as forged/expired.

Write operations and off-rent request state reads (`portal_submit_off_rent_request`,
`portal_list_off_rent_requests`) are unaffected: they continue to require a validated scope token
for all non-`service_role` callers.

This ADR supersedes ADR-0043's general prohibition on anonymous access specifically and only for
the read-only schedule projection. The durable authenticated portal session model described in
ADR-0043 remains the correct boundary for all write and state-mutation paths.

## Consequences

- Customers can view their rental schedule by visiting the portal URL with the contract UUID alone,
  matching the expected share-link UX.
- Anyone who obtains a contract UUID can read the schedule data for that contract. The UUID's
  128-bit entropy is the access control for this surface; URLs should not be logged or shared in
  contexts where the recipient should not have schedule visibility.
- The `line_data` jsonb payload is exposed to public callers. Deployments must ensure that
  `line_data` on `rental_contract_line` entities does not contain PII or sensitive financial data.
  If that constraint cannot be enforced, replace `l.data as line_data` in the function with a
  nulled or curated projection.
- The forged-token denial path (`raise exception ... using errcode = '42501'`) is now reachable and
  covered by behavioral tests.
- Off-rent submission and off-rent request list reads continue to require a validated scope token;
  the frontend guard (`if (!scopeToken)`) covers the missing-token case, and the RPC enforces it
  server-side.

## Alternatives considered

- **Require a scope token for all non-`service_role` schedule reads (restore ADR-0043 boundary):**
  rejected because it makes the page unrenderable from a plain share link and prevents the
  forged-token denial path from being exercised in practice.
- **Use fragment-based token delivery (per ADR-0039 intake pattern):** rejected for the schedule
  read because the schedule is read-only and the per-contract UUID already provides acceptable
  entropy; fragment extraction adds complexity without improving the security posture of a read path.
- **Return `null` for `line_data` on non-`service_role` callers:** deferred; the current deployment
  does not store PII in `line_data`, so this is noted as an ongoing operational constraint rather
  than an immediate code change.

## Evidence

- `supabase/migrations/20260613222000_portal_schedule_public_read.sql` — implements the split
  token-check behavior (absent/empty → public read; non-empty invalid → 42501)
- `supabase/tests/portal_schedule_access.sql` — behavioral reset-path coverage: null token reads
  schedule (3c), forged token denied (3d), off-rent submit/list require token (4b–4c)
- `supabase/tests/portal_schedule_rls.sql` — RLS/JWT context coverage: null token public read (1a–
  1b), wrong token denied (2), valid token reads (3), service_role bypass (5), cross-contract
  isolation (6), grant check (7)
- `supabase/tests/direct_db_write_rpc_guards.sql` — multi-role coverage: 7c/7f (null → public
  read), 7d/7g (forged → 42501), 7a/7b/7e (service_role and valid-token paths), off-rent guards
  in sections 3d and 3e
- `docs/adrs/0043-customer-portal-passwordless-session-boundary.md`
