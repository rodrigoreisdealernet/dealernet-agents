-- DIA — Fast BI analytic layer (aggregated views + fact_types), issue #14
-- Created: 2026-06-25
--
-- Purpose: provide the stable, named read-only contract that the Fast BI
-- dashboards (#15–#18) bind to — owner KPI snapshot, VN/VU sales, service
-- (oficina), inventory / floor plan and parts.
--
-- All views are security_invoker = true (caller's RLS applies) with stable
-- documented column names and are granted to authenticated + service_role.
--
-- DATA-SOURCE NOTE (parallel issues):
--   In this branch only the 'vehicle' entity exists (v_dia_vehicle_current,
--   entity_type = 'vehicle'). The service/oficina (#7), parts (#8) and
--   parts-sales (#10) entity types are NOT yet in the catalog or seed.
--   The service- and parts-derived views (v_dia_service_summary,
--   v_dia_parts_summary) and the related KPI columns are written DEFENSIVELY:
--   they read from rental_current_entity_state filtered by the anticipated
--   entity_type names ('service_order'/'part'/'parts_sale') with all JSON
--   fields optional (nullif/coalesce + iso date regex guard). They return
--   ZERO rows / ZERO totals today (no errors) and populate automatically once
--   the sibling issues seed those entity types.
--
-- This migration only CREATEs new objects and INSERTs fact_types idempotently.
-- It does NOT edit any shipped migration, nor v_dia_vehicle_current.

-- ---------------------------------------------------------------------------
-- 0. fact_types (idempotent; key has a UNIQUE constraint)
-- ---------------------------------------------------------------------------

insert into fact_types (key, label, description, unit) values
  ('vn_units_sold',       'VN Units Sold',       'New vehicle (VN) units sold',     'count'),
  ('vn_revenue',          'VN Revenue',          'New vehicle (VN) sales revenue',  'BRL'),
  ('vu_units_sold',       'VU Units Sold',       'Used vehicle (VU) units sold',    'count'),
  ('vu_revenue',          'VU Revenue',          'Used vehicle (VU) sales revenue', 'BRL'),
  ('service_revenue',     'Service Revenue',     'Service (oficina) revenue',       'BRL'),
  ('parts_sales_revenue', 'Parts Sales Revenue', 'Parts sales revenue',             'BRL')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. v_dia_sales_summary — sold vehicles by month / condition / brand / store
--    sale_date = data->>'sold_at' (if present) else updated_at else valid_from.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_sales_summary
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
sold as (
  select
    vc.entity_id,
    vc.condition,
    vc.brand,
    vc.store,
    vc.cost,
    vc.sale_price,
    vc.purchase_date,
    coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ (select iso_date_or_timestamp from input_patterns)
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) as sale_date
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  where vc.status = 'vendido'
)
select
  date_trunc('month', sale_date)::date                       as period_month,
  condition,
  brand,
  store,
  count(*)                                                   as units_sold,
  coalesce(sum(sale_price), 0)::numeric(18,2)                as revenue,
  coalesce(sum(sale_price - cost), 0)::numeric(18,2)         as margin,
  coalesce(avg(sale_date - purchase_date), 0)::numeric(18,2) as avg_days_to_sell
from sold
group by date_trunc('month', sale_date)::date, condition, brand, store;

grant select on table public.v_dia_sales_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. v_dia_sales_trend — daily sold-vehicle units/revenue, trailing 90 days.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_sales_trend
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
sold as (
  select
    vc.sale_price,
    coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ (select iso_date_or_timestamp from input_patterns)
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) as sale_date
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  where vc.status = 'vendido'
)
select
  sale_date,
  count(*)                                     as units_sold,
  coalesce(sum(sale_price), 0)::numeric(18,2)  as revenue
from sold
where sale_date >= (now()::date - 90)
group by sale_date;

grant select on table public.v_dia_sales_trend to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. v_dia_inventory_summary — in-stock vehicles by age band / brand / store.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_inventory_summary
with (security_invoker = true) as
with in_stock as (
  select
    case
      when days_in_stock <= 30 then '0-30'
      when days_in_stock <= 60 then '31-60'
      when days_in_stock <= 90 then '61-90'
      else '90+'
    end as age_band,
    brand,
    store,
    cost,
    floor_plan_cost
  from public.v_dia_vehicle_current
  where status = 'em_estoque'
)
select
  age_band,
  brand,
  store,
  count(*)                                       as vehicles_count,
  coalesce(sum(cost), 0)::numeric(18,2)          as inventory_value,
  coalesce(sum(floor_plan_cost), 0)::numeric(18,2) as floor_plan_cost
from in_stock
group by age_band, brand, store;

grant select on table public.v_dia_inventory_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. v_dia_service_summary — service orders by status / month (0 rows today).
--    Defensive: reads anticipated 'service_order' entity_type + JSON fields.
--    turnaround = closed_at - opened_at (days).
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_service_summary
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
service_orders as (
  select
    lower(coalesce(nullif(rces.data ->> 'status', ''), 'open')) as status,
    case
      when coalesce(rces.data ->> 'revenue', '') ~ '^-?\d+(\.\d+)?$'
        then (rces.data ->> 'revenue')::numeric
      else 0::numeric
    end as revenue,
    case
      when coalesce(rces.data ->> 'opened_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end as opened_at,
    case
      when coalesce(rces.data ->> 'closed_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'closed_at', '')::date
      else null
    end as closed_at
  from public.rental_current_entity_state rces
  where rces.entity_type = 'service_order'
)
select
  date_trunc('month', coalesce(opened_at, closed_at))::date  as period_month,
  status,
  count(*)                                                   as orders_count,
  coalesce(sum(revenue), 0)::numeric(18,2)                   as revenue,
  coalesce(avg(closed_at - opened_at), 0)::numeric(18,2)     as avg_turnaround
from service_orders
group by date_trunc('month', coalesce(opened_at, closed_at))::date, status;

grant select on table public.v_dia_service_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. v_dia_parts_summary — parts inventory by stock_status + sales by period.
--    Defensive: reads anticipated 'part' / 'parts_sale' entity_types.
--    UNION ALL of (a) inventory rows and (b) sales rows. 0 rows today.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_parts_summary
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
parts_inventory as (
  select
    lower(coalesce(nullif(rces.data ->> 'stock_status', ''), 'ok')) as stock_status,
    coalesce(
      case
        when coalesce(rces.data ->> 'value', '') ~ '^-?\d+(\.\d+)?$'
          then (rces.data ->> 'value')::numeric
        else null
      end,
      case
        when coalesce(rces.data ->> 'unit_value', '') ~ '^-?\d+(\.\d+)?$'
         and coalesce(rces.data ->> 'quantity', '') ~ '^-?\d+(\.\d+)?$'
          then (rces.data ->> 'unit_value')::numeric * (rces.data ->> 'quantity')::numeric
        else null
      end,
      0::numeric
    ) as inventory_value
  from public.rental_current_entity_state rces
  where rces.entity_type = 'part'
),
parts_sales as (
  select
    case
      when coalesce(rces.data ->> 'sold_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'sold_at', '')::date
      else null
    end as sold_at,
    case
      when coalesce(rces.data ->> 'quantity', '') ~ '^-?\d+(\.\d+)?$'
        then (rces.data ->> 'quantity')::numeric
      else 0::numeric
    end as quantity,
    coalesce(
      case
        when coalesce(rces.data ->> 'revenue', '') ~ '^-?\d+(\.\d+)?$'
          then (rces.data ->> 'revenue')::numeric
        else null
      end,
      case
        when coalesce(rces.data ->> 'total', '') ~ '^-?\d+(\.\d+)?$'
          then (rces.data ->> 'total')::numeric
        else null
      end,
      0::numeric
    ) as revenue
  from public.rental_current_entity_state rces
  where rces.entity_type = 'parts_sale'
),
inventory_rows as (
  select
    stock_status,
    coalesce(sum(inventory_value), 0)::numeric(18,2) as inventory_value,
    null::date                                       as period_month,
    null::numeric                                    as units_sold,
    null::numeric(18,2)                              as revenue
  from parts_inventory
  group by stock_status
),
sales_rows as (
  select
    null::text                                       as stock_status,
    null::numeric(18,2)                              as inventory_value,
    date_trunc('month', sold_at)::date               as period_month,
    coalesce(sum(quantity), 0)::numeric              as units_sold,
    coalesce(sum(revenue), 0)::numeric(18,2)         as revenue
  from parts_sales
  group by date_trunc('month', sold_at)::date
)
select stock_status, inventory_value, period_month, units_sold, revenue from inventory_rows
union all
select stock_status, inventory_value, period_month, units_sold, revenue from sales_rows;

grant select on table public.v_dia_parts_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. v_dia_owner_kpis — exactly one complete (non-null) row.
--    Mirrors v_home_dashboard_kpis: single-row CTEs cross-joined; every metric
--    coalesced to 0. Vehicle metrics come from real seed data; service/parts
--    metrics read defensively and are 0 until #7/#8/#10 land.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_kpis
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
sold as (
  select
    vc.cost,
    vc.sale_price,
    coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ (select iso_date_or_timestamp from input_patterns)
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) as sale_date
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  where vc.status = 'vendido'
),
sales_month as (
  select
    coalesce(count(*), 0)                         as sales_units_month,
    coalesce(sum(sale_price), 0)::numeric(18,2)   as sales_revenue_month,
    coalesce(sum(sale_price - cost), 0)::numeric(18,2) as margin_month
  from sold
  where date_trunc('month', sale_date) = date_trunc('month', now())
),
inventory as (
  select
    coalesce(sum(cost), 0)::numeric(18,2)            as inventory_vehicle_value,
    coalesce(sum(floor_plan_cost), 0)::numeric(18,2) as floor_plan_total,
    coalesce(avg(days_in_stock), 0)::numeric(18,2)   as avg_days_in_stock
  from public.v_dia_vehicle_current
  where status = 'em_estoque'
),
service_orders as (
  select
    lower(coalesce(nullif(rces.data ->> 'status', ''), 'open')) as status,
    case
      when coalesce(rces.data ->> 'revenue', '') ~ '^-?\d+(\.\d+)?$'
        then (rces.data ->> 'revenue')::numeric
      else 0::numeric
    end as revenue,
    case
      when coalesce(rces.data ->> 'opened_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end as opened_at,
    case
      when coalesce(rces.data ->> 'closed_at', '') ~ (select iso_date_or_timestamp from input_patterns)
        then nullif(rces.data ->> 'closed_at', '')::date
      else null
    end as closed_at
  from public.rental_current_entity_state rces
  where rces.entity_type = 'service_order'
),
service_kpis as (
  select
    coalesce(count(*) filter (
      where status not in ('closed', 'completed', 'cancelled', 'entregue', 'finalizado')
    ), 0) as service_orders_open,
    coalesce(sum(revenue) filter (
      where date_trunc('month', coalesce(opened_at, closed_at)) = date_trunc('month', now())
    ), 0)::numeric(18,2) as service_revenue_month,
    coalesce(avg(closed_at - opened_at), 0)::numeric(18,2) as service_avg_turnaround
  from service_orders
),
parts_inventory as (
  select
    lower(coalesce(nullif(rces.data ->> 'stock_status', ''), 'ok')) as stock_status,
    coalesce(
      case
        when coalesce(rces.data ->> 'value', '') ~ '^-?\d+(\.\d+)?$'
          then (rces.data ->> 'value')::numeric
        else null
      end,
      case
        when coalesce(rces.data ->> 'unit_value', '') ~ '^-?\d+(\.\d+)?$'
         and coalesce(rces.data ->> 'quantity', '') ~ '^-?\d+(\.\d+)?$'
          then (rces.data ->> 'unit_value')::numeric * (rces.data ->> 'quantity')::numeric
        else null
      end,
      0::numeric
    ) as inventory_value
  from public.rental_current_entity_state rces
  where rces.entity_type = 'part'
),
parts_kpis as (
  select
    coalesce(sum(inventory_value), 0)::numeric(18,2) as parts_inventory_value,
    coalesce(count(*) filter (
      where stock_status in ('critical', 'critico', 'low')
    ), 0) as parts_critical_count
  from parts_inventory
)
select
  now() as as_of,
  sales_month.sales_units_month,
  sales_month.sales_revenue_month,
  sales_month.margin_month,
  service_kpis.service_orders_open,
  service_kpis.service_revenue_month,
  service_kpis.service_avg_turnaround,
  inventory.inventory_vehicle_value,
  inventory.floor_plan_total,
  inventory.avg_days_in_stock,
  parts_kpis.parts_inventory_value,
  parts_kpis.parts_critical_count
from sales_month
cross join inventory
cross join service_kpis
cross join parts_kpis;

grant select on table public.v_dia_owner_kpis to authenticated, service_role;
