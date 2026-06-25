# ADR-0024: Authenticated write path via SECURITY DEFINER RPCs + RLS role policies

- **Status:** Accepted
- **Date:** 2026-06-07
- **Deciders:** Factory Architect
- **Supersedes / Superseded by:** N/A

## Context

The app moved from anon-only reads to authenticated UI/mobile writes, but write RPCs still failed under RLS when execution depended on invoker-context table privileges. At the same time, write authorization had to remain strict: anon must stay blocked, app-role policy boundaries must be enforced, and no browser write path may require `service_role`.

Issue #234 requires this write-path security/data-boundary choice to be explicitly recorded as an ADR.

## Decision

We execute authenticated write RPCs as `SECURITY DEFINER` with pinned `search_path`, while keeping table-level RLS as the effective authorization boundary through explicit app-role checks inside RPCs.

Specifically:
- allow `service_role` calls for trusted server-side maintenance paths;
- allow `authenticated` only for permitted app roles/entity types;
- deny empty/missing role-claim (`v_request_role = ''`) paths to prevent direct-role/non-PostgREST bypass;
- keep tenant scoping for core entity read/write paths deferred to #120, consistent with [ADR-0019](./0019-app-layer-tenant-scoping-rls-deferred.md).

## Consequences

- Authenticated UI/mobile writes execute reliably under RLS without granting browser clients `service_role`.
- `SECURITY DEFINER` increases responsibility on RPC guard logic; claim checks and role gating are now part of the security contract and must remain covered by tests.
- Tenant/data-boundary behavior for these core paths is unchanged in this step; tenant-claim enforcement remains a tracked follow-up (#120) rather than an implicit in-place change.

## Alternatives considered

- **Invoker-context RPCs only** — rejected: authenticated writes can fail under RLS due to invoker permission context and incomplete write-path coverage.
- **Grant broader direct table privileges to clients** — rejected: widens blast radius and weakens controlled write entrypoints.
- **Implement tenant-claim scoping in this PR** — rejected for this step: out of #234 v1 scope and already tracked as follow-up work in #120 / ADR-0019.

## Evidence

- `supabase/migrations/20260607133000_authenticated_write_rpc_hardening.sql`
- `temporal/tests/test_supabase_api_access_contract.py` (authenticated-role write contract coverage + empty-claim direct-role denial regression)
- Related ADRs: [ADR-0019](./0019-app-layer-tenant-scoping-rls-deferred.md), [ADR-0023](./0023-user-role-model-profiles.md)
- Related issues/PR: #234, #120, PR #264
