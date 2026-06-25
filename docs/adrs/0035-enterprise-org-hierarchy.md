# ADR-0035: Enterprise org hierarchy — company → region → branch

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** @ianreay, Copilot
- **Supersedes / Superseded by:** —

## Context

The rental platform initially modelled all operational scope as a flat set of
`branch` entities. Multi-tenant, multi-region enterprise customers need a three-level
org tree (company → region → branch) so that:
- per-location config (currency, locale, tax region, timezone) can be set at any
  level and inherited downward;
- data-scoping queries can filter by company, region, or branch without bespoke
  recursive SQL in every caller;
- the schema is ready for scoped RBAC (deferred to issue #596) without a
  breaking migration.

The existing `entities` / `entity_versions` / `relationships_v2` model already
supports arbitrary typed nodes and edges, so the hierarchy can be layered on top
without a schema redesign.

## Decision

We extend the generic entity model with three additions:

1. **New entity types** `company` and `region` in `rental_entity_type_catalog`
   (alongside the existing `branch`).
2. **New relationship types** `company_has_region` and `region_has_branch` in
   `rental_relationship_type_catalog`.
3. **`entities.org_scope_id`** — a nullable FK to `entities.id` that records the
   owning scope node:
   - company/region/branch entities point to themselves;
   - branch-owned operational entities (currently assets) point to their branch.
4. **`org_scope_closure`** — a standard closure table (ancestor\_id,
   descendant\_id, depth) maintained by triggers on `entities` and
   `relationships_v2`, enabling O(1) ancestor/descendant lookups with no
   recursive SQL.
5. **Per-scope config** stored in `entity_versions.data` for company/region/branch
   entities (keys: `default_currency_code`, `locale_code`, `tax_region_code`,
   `timezone`).  Resolved via `org_scope_effective_config(scope_id)` which walks
   the closure table from the nearest ancestor (depth=0) upward.

All changes are additive; existing branch-centric views and read paths are
preserved without modification.

## Consequences

- Ancestor/descendant traversal is a simple WHERE clause against
  `org_scope_closure`; no recursive CTEs needed by callers.
- Per-scope config inheritance follows the principle of least surprise: the most
  specific scope wins (branch overrides region overrides company).
- `entities.org_scope_id` is nullable; entities that pre-date this story or are
  not branch-owned keep `NULL` until explicitly assigned.
- Scoped RBAC is deliberately **not** implemented here; `org_scope_id` prepares
  the schema for it (see issue #596).
- The closure table must be kept in sync by triggers; cascading deletes on
  `entities.id` handle node removal.

## Alternatives considered

- **Recursive CTEs on `relationships_v2`** — rejected: every caller would need
  the same recursive logic, and performance degrades with depth.
- **`ltree` path column** — rejected: requires `ltree` extension and reparenting
  is a multi-row rewrite; closure table is simpler and already supported by the
  existing FK model.
- **Separate `org_units` table** — rejected: the generic entity model is the
  established substrate for all domain objects (ADR-0001); adding a parallel
  table would fragment the query surface.

## Evidence

- `supabase/migrations/20260609151000_enterprise_org_hierarchy.sql` — migration
- `supabase/tests/enterprise_org_hierarchy.sql` — SQL smoke test
- `supabase/tests/run_enterprise_org_hierarchy.sh` — test runner
- `temporal/tests/test_rental_master_data_foundation.py` — Python tests
  (`test_enterprise_org_hierarchy_smoke_validation`,
  `test_enterprise_org_hierarchy_closure_and_config`)
- `supabase/seed.sql` — demo company/region seed data with per-scope config
