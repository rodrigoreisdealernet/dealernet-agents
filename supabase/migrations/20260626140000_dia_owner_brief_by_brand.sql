-- DIA — Morning Brief do Dono: aggregation views by brand / store (issue #43)
-- Created: 2026-06-26
--
-- Purpose: one row per brand (and the by-store drill variant) describing the
-- PREVIOUS DAY's business for the owner's morning brief. Each row carries the 5
-- sectors the brief renders: Novos, Usados, Peças, AT/Oficina and Floor Plan.
--
-- Both views are security_invoker = true (the caller's RLS applies) with stable,
-- documented column names, granted to authenticated + service_role — mirroring
-- the other v_dia_* analytic views (20260625170000_dia_fast_bi_analytics.sql).
--
-- "PREVIOUS DAY" = (now()::date - 1), computed on-the-fly (no snapshot table /
-- scheduled job — see spec non-goals). Sale date is derived exactly like
-- v_dia_sales_summary: coalesce(data->>'sold_at', updated_at, valid_from)::date.
--
-- DEFENSIVE / DATA-SOURCE NOTES (parallel issues):
--   * Novos/Usados come from real seed (v_dia_vehicle_current, status='vendido').
--   * Peças (entity_type 'parts_sale') and AT/Oficina (entity_type
--     'service_order') are read DEFENSIVELY: if those entity types return 0 rows
--     for the previous day, the sector columns come back NULL → the UI renders
--     "—". No errors when the seed is absent.
--   * Floor Plan reads in-stock vehicles (status='em_estoque') from
--     v_dia_vehicle_current. fp_value = sum(floor_plan_cost).
--
-- AT-RISK <7d PROXY (phase 1):
--   There is NO real floor-plan financing maturity date in the schema yet (only
--   days_in_stock / floor_plan_cost). Phase 1 approximates "FP em risco <7d" by
--   an AGING threshold: a unit is "at risk" once days_in_stock >= 83, i.e. it is
--   within 7 days of crossing the 90-day aging band that drives the heaviest
--   floor-plan carrying cost (see v_dia_inventory_summary's '90+' band). The
--   boundary lives in the dia_owner_brief_at_risk_days() helper below so it is a
--   single documented knob; when a real maturity date lands (follow-up) this
--   proxy is replaced without touching the views' shape.

-- ---------------------------------------------------------------------------
-- 0. At-risk aging boundary (single documented knob for the <7d FP proxy).
--    90-day band minus a 7-day warning window = 83 days in stock.
-- ---------------------------------------------------------------------------

create or replace function public.dia_owner_brief_at_risk_days()
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select 83
$$;

revoke all on function public.dia_owner_brief_at_risk_days() from public;
grant execute on function public.dia_owner_brief_at_risk_days() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. v_dia_owner_brief_by_brand — one row per brand for the previous day.
--    Brands come from the vehicles' brand field (the inventory/sales grain).
--    Vehicles with a blank/NULL brand fall into the 'Sem marca' bucket so the
--    UI can render the spec's "Sem marca" group. brand_id stays NULL here (the
--    sales/inventory grain is the free-text brand, not the company brand FK).
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_brief_by_brand
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
prev_day as (
  select (now()::date - 1) as d
),
at_risk as (
  select public.dia_owner_brief_at_risk_days() as days
),
-- Sold vehicles on the previous day, with the same sale_date derivation as
-- v_dia_sales_summary. Brand normalised to a 'Sem marca' bucket when blank.
sold as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    nullif(btrim(vc.store), '')                        as store,
    vc.condition,
    vc.sale_price,
    vc.cost
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  cross join input_patterns ip
  cross join prev_day p
  where vc.status = 'vendido'
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) = p.d
),
-- In-stock vehicles (floor plan) — NOT date-filtered (stock is "as of now").
in_stock as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    nullif(btrim(vc.store), '')                        as store,
    vc.floor_plan_cost,
    vc.days_in_stock
  from public.v_dia_vehicle_current vc
  where vc.status = 'em_estoque'
),
-- Parts sales on the previous day (defensive: 0 rows until 'parts_sale' seeded).
parts AS (
  -- sum() over 0 rows → NULL (sector renders "—"). When 'parts_sale' is seeded
  -- for the previous day this yields a real total.
  select
    sum(
      case
        when coalesce(rces.data ->> 'total', '') ~ '^-?\d+(\.\d+)?$' then (rces.data ->> 'total')::numeric
        when coalesce(rces.data ->> 'revenue', '') ~ '^-?\d+(\.\d+)?$' then (rces.data ->> 'revenue')::numeric
        else 0::numeric
      end
    )::numeric(18,2) as pecas_value,
    -- No reliable parts cost/margin in the seed → margin stays NULL (renders "—").
    null::numeric(18,2)  as pecas_margin
  from public.rental_current_entity_state rces
  cross join input_patterns ip
  cross join prev_day p
  where rces.entity_type = 'parts_sale'
    and case
      when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'sold_at', '')::date
      else null
    end = p.d
),
-- Service orders (AT/Oficina) opened on the previous day (defensive: 0 rows
-- until 'service_order' seeded).
service AS (
  -- sum() over 0 rows → NULL (sector renders "—").
  select
    sum(
      case
        when coalesce(rces.data ->> 'revenue', '') ~ '^-?\d+(\.\d+)?$' then (rces.data ->> 'revenue')::numeric
        else 0::numeric
      end
    )::numeric(18,2) as at_value,
    null::numeric(18,2)  as at_margin
  from public.rental_current_entity_state rces
  cross join input_patterns ip
  cross join prev_day p
  where rces.entity_type = 'service_order'
    and case
      when coalesce(rces.data ->> 'opened_at', '') ~ ip.iso_date_or_timestamp
        then nullif(rces.data ->> 'opened_at', '')::date
      else null
    end = p.d
),
-- Per-brand vehicle aggregates (novos/usados + floor plan).
brand_keys as (
  select distinct brand_key from (
    select brand_key from sold
    union all
    select brand_key from in_stock
  ) u
),
sold_agg as (
  select
    brand_key,
    count(*) filter (where condition = 'novo')                                   as novos_units,
    sum(sale_price) filter (where condition = 'novo')                            as novos_value,
    sum(sale_price - cost) filter (where condition = 'novo')                     as novos_margin,
    count(*) filter (where condition = 'usado')                                  as usados_units,
    sum(sale_price) filter (where condition = 'usado')                           as usados_value,
    sum(sale_price - cost) filter (where condition = 'usado')                    as usados_margin
  from sold
  group by brand_key
),
stock_agg as (
  select
    i.brand_key,
    count(*)                                                                     as fp_units,
    sum(i.floor_plan_cost)                                                       as fp_value,
    count(*) filter (where i.days_in_stock >= (select days from at_risk))        as fp_units_at_risk,
    sum(i.floor_plan_cost) filter (where i.days_in_stock >= (select days from at_risk)) as fp_value_at_risk
  from in_stock i
  group by i.brand_key
)
select
  bk.brand_key                                                                   as brand_name,
  null::uuid                                                                     as brand_id,
  -- store count = distinct non-null stores seen for this brand (sold + in-stock).
  (
    select count(distinct st) from (
      select store as st from sold     where brand_key = bk.brand_key and store is not null
      union
      select store as st from in_stock where brand_key = bk.brand_key and store is not null
    ) s
  )::int                                                                         as store_count,
  -- Novos / Usados (NULL sectors → "—" in the UI).
  sa.novos_units,
  sa.novos_value::numeric(18,2)                                                  as novos_value,
  sa.novos_margin::numeric(18,2)                                                 as novos_margin,
  sa.usados_units,
  sa.usados_value::numeric(18,2)                                                 as usados_value,
  sa.usados_margin::numeric(18,2)                                                as usados_margin,
  -- Peças / AT are group-wide today (no per-brand attribution in the seed) →
  -- exposed identically per row; the UI sums them once via the group total.
  p.pecas_value,
  p.pecas_margin,
  s.at_value,
  s.at_margin,
  -- Floor plan.
  coalesce(stk.fp_units, 0)                                                      as fp_units,
  stk.fp_value::numeric(18,2)                                                    as fp_value,
  coalesce(stk.fp_units_at_risk, 0)                                              as fp_units_at_risk,
  coalesce(stk.fp_value_at_risk, 0)::numeric(18,2)                               as fp_value_at_risk,
  -- Resultado = total value across the sectors that have data.
  (
    coalesce(sa.novos_value, 0) + coalesce(sa.usados_value, 0)
    + coalesce(p.pecas_value, 0) + coalesce(s.at_value, 0)
  )::numeric(18,2)                                                               as resultado
from brand_keys bk
left join sold_agg  sa  on sa.brand_key  = bk.brand_key
left join stock_agg stk on stk.brand_key = bk.brand_key
cross join parts p
cross join service s;

grant select on table public.v_dia_owner_brief_by_brand to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. v_dia_owner_brief_by_store — same shape, one row per (brand, store) for the
--    drill. Peças/AT are NULL here (no per-store attribution in the seed → "—").
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_owner_brief_by_store
with (security_invoker = true) as
with input_patterns as (
  select '^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([zZ]|[+-]\d{2}:\d{2})?)?$'::text as iso_date_or_timestamp
),
prev_day as (
  select (now()::date - 1) as d
),
at_risk as (
  select public.dia_owner_brief_at_risk_days() as days
),
sold as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    coalesce(nullif(btrim(vc.store), ''), 'Sem loja')  as store_key,
    vc.condition,
    vc.sale_price,
    vc.cost
  from public.v_dia_vehicle_current vc
  left join public.rental_current_entity_state rces
    on rces.entity_id = vc.entity_id
   and rces.entity_type = 'vehicle'
  cross join input_patterns ip
  cross join prev_day p
  where vc.status = 'vendido'
    and coalesce(
      case
        when coalesce(rces.data ->> 'sold_at', '') ~ ip.iso_date_or_timestamp
          then nullif(rces.data ->> 'sold_at', '')::date
        else null
      end,
      vc.updated_at::date,
      vc.valid_from::date
    ) = p.d
),
in_stock as (
  select
    coalesce(nullif(btrim(vc.brand), ''), 'Sem marca') as brand_key,
    coalesce(nullif(btrim(vc.store), ''), 'Sem loja')  as store_key,
    vc.floor_plan_cost,
    vc.days_in_stock
  from public.v_dia_vehicle_current vc
  where vc.status = 'em_estoque'
),
keys as (
  select distinct brand_key, store_key from (
    select brand_key, store_key from sold
    union all
    select brand_key, store_key from in_stock
  ) u
),
sold_agg as (
  select
    brand_key, store_key,
    count(*) filter (where condition = 'novo')                as novos_units,
    sum(sale_price) filter (where condition = 'novo')         as novos_value,
    sum(sale_price - cost) filter (where condition = 'novo')  as novos_margin,
    count(*) filter (where condition = 'usado')               as usados_units,
    sum(sale_price) filter (where condition = 'usado')        as usados_value,
    sum(sale_price - cost) filter (where condition = 'usado') as usados_margin
  from sold
  group by brand_key, store_key
),
stock_agg as (
  select
    brand_key, store_key,
    count(*)                                                               as fp_units,
    sum(floor_plan_cost)                                                   as fp_value,
    count(*) filter (where days_in_stock >= (select days from at_risk))    as fp_units_at_risk,
    sum(floor_plan_cost) filter (where days_in_stock >= (select days from at_risk)) as fp_value_at_risk
  from in_stock
  group by brand_key, store_key
)
select
  k.brand_key                                          as brand_name,
  null::uuid                                           as brand_id,
  k.store_key                                          as store_name,
  sa.novos_units,
  sa.novos_value::numeric(18,2)                        as novos_value,
  sa.novos_margin::numeric(18,2)                       as novos_margin,
  sa.usados_units,
  sa.usados_value::numeric(18,2)                       as usados_value,
  sa.usados_margin::numeric(18,2)                      as usados_margin,
  -- Peças / AT: no per-store attribution in the seed → NULL ("—" in the UI).
  null::numeric(18,2)                                  as pecas_value,
  null::numeric(18,2)                                  as pecas_margin,
  null::numeric(18,2)                                  as at_value,
  null::numeric(18,2)                                  as at_margin,
  coalesce(stk.fp_units, 0)                            as fp_units,
  stk.fp_value::numeric(18,2)                          as fp_value,
  coalesce(stk.fp_units_at_risk, 0)                    as fp_units_at_risk,
  coalesce(stk.fp_value_at_risk, 0)::numeric(18,2)     as fp_value_at_risk,
  (coalesce(sa.novos_value, 0) + coalesce(sa.usados_value, 0))::numeric(18,2) as resultado
from keys k
left join sold_agg  sa  on sa.brand_key = k.brand_key and sa.store_key = k.store_key
left join stock_agg stk on stk.brand_key = k.brand_key and stk.store_key = k.store_key;

grant select on table public.v_dia_owner_brief_by_store to authenticated, service_role;
