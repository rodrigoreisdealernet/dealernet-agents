# ADR-0039: Portal intake bearer token stays client-only and tenant-bound

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Security Reviewer
- **Supersedes / Superseded by:** -

## Context

The CRM self-serve intake flow needs a shareable email/SMS link that lets an external recipient submit a narrow intake form before they have an authenticated app session. That creates a bearer-secret transport problem: the raw intake secret must reach the browser, but placing it in the request URL leaks it into server access logs, reverse proxies, copied URLs, and referrer-bearing surfaces before frontend code can scrub it.

The intake token is also a cross-tenant write boundary. Back-office issue/revoke paths run as `SECURITY DEFINER`, so they cannot trust caller-supplied tenant IDs without binding the operation to trusted JWT claims. The public submit path must stay narrow and field-allowlisted rather than accepting arbitrary JSON.

## Decision

We deliver the raw intake bearer token only in the URL fragment (`#token=...`) so it never reaches the server request line, and we scrub the fragment after extraction. We store only hashed intake tokens in Postgres, bind issue/revoke operations to the caller's tenant claims (except `service_role`), and keep the public submit RPC limited to explicit intake fields.

## Consequences

- The intake flow remains usable for external recipients without expanding the bearer-secret boundary into server logs or referrer surfaces.
- The browser must extract the fragment token client-side and retain it only in memory for submission.
- Back-office admins can no longer mint or revoke intake tokens across tenants by supplying a different `p_tenant_id`.
- The database and frontend must keep the intake surface narrowly allowlisted; arbitrary JSON merge paths are out of bounds for this public route.

## Alternatives considered

- **Query-string token plus `history.replaceState` after mount:** rejected because the initial request URL still leaks the bearer secret before React runs.
- **Store raw intake tokens in Postgres:** rejected because bearer secrets should not be recoverable from the database.
- **Require authenticated customer sessions before intake:** rejected because the product requirement is a pre-auth shareable intake link delivered by email/SMS.

## Evidence

- Issue #567
- PR #984
- `frontend/src/routes/portal/intake/$tokenId.tsx`
- `frontend/src/test/portal-intake.test.tsx`
- `supabase/migrations/20260610010000_crm_intake_scope_tokens.sql`
