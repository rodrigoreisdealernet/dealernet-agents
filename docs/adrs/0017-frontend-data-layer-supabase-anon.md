# ADR-0017: Frontend data layer — TanStack + Supabase PostgREST, unauthenticated anon client

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively)
- **Deciders:** Factory Architect

## Context
The JSON-driven UI (ADR-0016) needs to fetch, cache, and revalidate server state across routes. Supabase's PostgREST gives a query API over the entity model without a custom backend. The MVP has no auth yet and the system is single-tenant (ADR-0019).

## Decision
The frontend reads through **TanStack Router** (routing) + **TanStack Query** (server-state cache) against **Supabase PostgREST**, using an **unauthenticated anon client**. Reads go direct to PostgREST; **writes go through Temporal workflows** (ADR-0003), not direct table mutations.

## Consequences
- No custom API to build; caching/revalidation handled by React Query; clean read/write split (read via PostgREST, mutate via Temporal).
- **Security caveat:** the anon client applies no server-side access control and there is no RLS (ADR-0019) — effectively all data is readable. Acceptable only while single-tenant/MVP; must be closed before multi-tenant production (RLS + a tenant claim).
- Mutations must trigger query invalidation to keep the cache fresh.

## Alternatives considered
- **Custom GraphQL/REST backend** — rejected: added surface for an MVP PostgREST already covers.
- **Direct fetch in components / Redux** — rejected: no caching / overkill.

## Evidence
- `frontend/src/data/supabase.ts` (anon client, no tenant claim); `frontend/src/data/queryBuilder.ts`; `frontend/src/engine/useDataSources.ts`
- `frontend/src/routes/` (TanStack Router); `frontend/package.json` (`@tanstack/*`, `@supabase/supabase-js`)
- See ADR-0019 (tenant scoping / RLS deferred)
