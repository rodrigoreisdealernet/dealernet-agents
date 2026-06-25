-- Maintenance: itemized costing (labor/parts/fees) + invoice-from-work-order
--
-- Implements child story of issue #433.
--
-- Changes:
--   1. Extend rental_entity_type_catalog with maintenance_cost_line and invoice
--      entity types (if not already present).
--   2. Add the maintenance_cost_lines table as a first-class queryable child
--      table linked to maintenance_record entities (not opaque JSONB) so that
--      totals, reporting, and audits remain reliable.
--   3. Add billing/invoice linkage columns to the maintenance_record entity
--      data via a view helper — actual billing flags live in entity_versions.data
--      (JSONB) following the existing SCD2 pattern; the new columns are surfaced
--      through the v_maintenance_work_order_billing view below.
--   4. Add v_maintenance_work_order_billing view for frontend / analytics queries.
--
-- Rollback notes (manual):
--   DROP TABLE IF EXISTS public.maintenance_cost_lines;
--   DROP VIEW  IF EXISTS public.v_maintenance_work_order_billing;
--   Re-create rental_entity_type_catalog without 'maintenance_cost_line'.

-- ---------------------------------------------------------------------------
-- 1. Extend entity-type catalog
-- ---------------------------------------------------------------------------

create or replace view public.rental_entity_type_catalog
with (security_invoker = true)
as
select *
from (
  values
    ('branch'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('maintenance_record'),
    ('maintenance_cost_line'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line'),
    ('invoice')
) as rental_entity_types(entity_type);

-- ---------------------------------------------------------------------------
-- 2. maintenance_cost_lines — first-class child records linked to a
--    maintenance_record entity.  Each row is one itemized line (labor / parts /
--    fees).  Computed totals are stored alongside source fields so that any
--    change to a line (via insert of a new row) keeps history intact.
-- ---------------------------------------------------------------------------

create table if not exists public.maintenance_cost_lines (
  id                    uuid        primary key default gen_random_uuid(),
  maintenance_record_id uuid        not null references public.entities(id) on delete cascade,
  line_type             text        not null check (line_type in ('labor', 'parts', 'fees')),
  description           text        not null,
  quantity              numeric(12, 4) not null check (quantity > 0),
  unit_cost             numeric(12, 4) not null check (unit_cost >= 0),
  sell_amount           numeric(12, 4) not null default 0 check (sell_amount >= 0),
  cost_total            numeric(12, 4) generated always as (quantity * unit_cost) stored,
  sell_line_total       numeric(12, 4) generated always as (quantity * sell_amount) stored,
  is_taxable            boolean     not null default false,
  tax_rate              numeric(7, 6) not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
  tax_amount            numeric(12, 4) generated always as (
                          case when is_taxable then round((quantity * sell_amount) * tax_rate, 4) else 0 end
                        ) stored,
  notes                 text,
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Index for fast lookup by maintenance record
create index if not exists idx_maintenance_cost_lines_record_id
  on public.maintenance_cost_lines (maintenance_record_id);

-- ---------------------------------------------------------------------------
-- 3. v_maintenance_work_order_billing — surfaced view for frontend and analytics.
--
--    Joins maintenance_record entity_versions (SCD2 current state) with rolled-up
--    cost totals from maintenance_cost_lines.  Billing flags
--    (is_customer_billable, billing_account_id) live in entity_versions.data
--    following the existing pattern.
-- ---------------------------------------------------------------------------

create or replace view public.v_maintenance_work_order_billing
with (security_invoker = true)
as
select
  e.id                                                        as maintenance_record_id,
  ev.data ->> 'name'                                          as name,
  ev.data ->> 'status'                                        as work_order_status,
  ev.data ->> 'maintenance_type'                              as maintenance_type,
  ev.data ->> 'asset_id'                                      as asset_id,
  (ev.data ->> 'is_customer_billable')::boolean               as is_customer_billable,
  ev.data ->> 'billing_account_id'                            as billing_account_id,
  ev.data ->> 'invoice_id'                                    as invoice_id,
  ev.data ->> 'invoice_status'                                as invoice_status,
  coalesce(agg.cost_line_count, 0)                            as cost_line_count,
  coalesce(agg.internal_subtotal, 0)                          as internal_subtotal,
  coalesce(agg.sell_subtotal, 0)                              as sell_subtotal,
  coalesce(agg.tax_total, 0)                                  as tax_total,
  coalesce(agg.sell_total, 0)                                 as sell_total,
  e.created_at,
  ev.valid_from                                               as last_updated_at
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
  and ev.is_current = true
left join lateral (
  select
    count(*)                                                  as cost_line_count,
    round(sum(cost_total), 2)                                 as internal_subtotal,
    round(sum(sell_line_total), 2)                            as sell_subtotal,
    round(sum(tax_amount), 2)                                 as tax_total,
    round(sum(sell_line_total) + sum(tax_amount), 2)          as sell_total
  from public.maintenance_cost_lines mcl
  where mcl.maintenance_record_id = e.id
) as agg on true
where e.entity_type = 'maintenance_record';

-- ---------------------------------------------------------------------------
-- 4. RLS: authenticated operators may SELECT cost lines; INSERT/UPDATE/DELETE
--    are service-role-only so only the Temporal worker can write cost lines.
--    This eliminates the cross-tenant injection risk: no browser session can
--    ever write a cost line that would affect v_maintenance_work_order_billing
--    totals or downstream invoice generation.
--    Mutations (UPDATE/DELETE) are intentionally omitted for MVP; corrections
--    are made by inserting a new corrective line (append-only audit trail via
--    the Temporal worker).
-- ---------------------------------------------------------------------------

alter table public.maintenance_cost_lines enable row level security;

-- Only operator roles may see cost lines; read_only and anon are excluded.
create policy maintenance_cost_lines_select
  on public.maintenance_cost_lines
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator')
  );

-- INSERT is intentionally NOT granted to authenticated — all writes must go
-- through the Temporal worker (service_role).  This prevents any authenticated
-- tenant from injecting cost lines for a work order they do not own.
create policy maintenance_cost_lines_service_role
  on public.maintenance_cost_lines
  for all
  to service_role
  using (true)
  with check (true);

-- Table-level grants: authenticated can only SELECT (policy further limits to
-- operator roles); INSERT/UPDATE/DELETE require service_role.
revoke insert, update, delete on public.maintenance_cost_lines from authenticated;
grant select on public.maintenance_cost_lines to authenticated;
grant select, insert, update, delete on public.maintenance_cost_lines to service_role;
