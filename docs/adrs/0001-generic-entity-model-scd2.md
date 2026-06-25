# ADR-0001: Generic entity model with SCD2 versioning

- **Status:** Accepted
- **Date:** 2026-06-06 (recorded retroactively; decision made at project inception)
- **Deciders:** Factory Architect

## Context
An equipment-rental ERP has many domain objects (assets, categories, branches, customers, orders, line items, contracts, transfers, inspections, maintenance records, invoices) that each carry rich, evolving state and a regulatory need for a full audit trail. Modelling each as its own table couples the schema to the domain and makes every new attribute or entity a migration.

## Decision
We store all domain objects in a single polymorphic `entities` table (identity + `entity_type`), with state held as JSONB in `entity_versions` using Slowly-Changing-Dimension Type 2 (SCD2) semantics (`is_current`, `valid_from`, `valid_to`), typed edges in `relationships_v2`, numeric KPIs in `entity_facts`, and an event stream in `time_series_points`.

## Consequences
- Full, immutable history and temporal queries come for free; this is also the audit substrate the Operations Factory relies on (see ADR-0020).
- New entity types and attributes need no schema change — only new `entity_type` values and JSONB shapes.
- Trade-off: no DB-level foreign keys; cross-entity navigation is explicit graph joins on `relationships_v2`, and reads must filter `is_current = true`. Payload validation moves to the application layer.

## Alternatives considered
- **Object-specific relational tables** — rejected: schema churn per attribute, heavier migrations, no uniform history.

## Evidence
- `supabase/migrations/20251202090000_core_entity_model.sql` (entities / entity_versions / relationships_v2)
- `supabase/migrations/20251203090000_analytics_foundation.sql` (entity_facts / time_series_points)
- `docs/specs/equipment-rental-domain-model.md`; `DATABASE.md`
- `supabase/migrations/20260605154500_rental_master_data_foundation.sql` (rental entity-type catalog, `branch_has_asset` relationships)
