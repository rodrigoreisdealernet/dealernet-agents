# ADR-0019: Application-layer tenant scoping; Postgres RLS deferred

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Factory Architect

## Context
Investigation for the Operations Factory (ADR-0020) found the codebase is **effectively single-tenant today**: no `tenant_id`/`org_id` on the core entity tables, **no Row-Level Security**, and `branch` modelled as an entity (ADR-0001), not a scoping column. The frontend uses an unauthenticated anon client with no tenant claim (ADR-0017). Multi-tenant, config-driven agents need tenant isolation; full DB-enforced isolation is higher blast-radius than the demo needs.

## Decision
Introduce tenant scoping **at the application layer** first: a `tenants` table and a `tenant_id` on the Operations Factory's own new tables (agent config, findings), with a scope helper that every read tool and the config loader use to filter by `tenant_id`. **Postgres RLS + a JWT tenant claim on the core entity tables is explicitly deferred** to a tracked hardening follow-up.

## Consequences
- Tenant isolation is real where the agents operate (tool-belt, config), enough for the synthetic-data demo, without an RLS rollout.
- **Risk:** isolation is only as good as the application discipline — there is no DB-enforced boundary yet; this must not ship to multi-tenant production as-is.
- Adding `tenant_id` to shared core tables is additive but higher-risk and routes through `queue:database` / Tech Reviewer (ADR-0002).

## Alternatives considered
- **Immediate RLS on core tables** — rejected for v1: blocks the demo, larger blast radius.
- **No tenant boundary at all** — rejected: the product is multi-tenant by design.

## Evidence
- `docs/specs/operations-factory-agentic-workflows.md` §12 (investigation + approach), §5 (config store)
- Verified: `supabase/migrations/*` have no `tenant_id` and no `CREATE POLICY`/RLS
- Follow-up tracked as a story under the Operations Factory epic (#109 → RLS hardening)
