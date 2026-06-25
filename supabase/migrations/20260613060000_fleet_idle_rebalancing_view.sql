-- Migration: Fleet idle-rebalancing signal view
-- Purpose: Surface per-branch, per-category idle inventory alongside cross-branch
--          open demand so operations can review rebalancing opportunities and
--          accept suggested moves into transfer planning.
--
-- Creates:
--   public.v_fleet_idle_rebalancing  (security invoker view)
--
-- Each row represents one rebalancing candidate: a surplus branch (idle assets)
-- paired with a deficit branch (open order demand > local supply) for the same
-- asset category. The suggested_transfer_qty is capped at the idle count and the
-- demand gap so operators never see inflated move counts.
--
-- Depends on:
--   entities, entity_versions, relationships_v2  (core entity model)
--
-- Rollback:
--   DROP VIEW IF EXISTS public.v_fleet_idle_rebalancing;

-- -------------------------------------------------------------------------
-- 1. View: v_fleet_idle_rebalancing
-- -------------------------------------------------------------------------
create or replace view public.v_fleet_idle_rebalancing
with (security_invoker = true) as
with
-- Resolve current branch names
branches as (
  select
    e.id                                        as branch_id,
    coalesce(ev.data ->> 'name', e.source_record_id) as branch_name
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id and ev.is_current
  where e.entity_type = 'branch'
),
-- Resolve current asset category names
categories as (
  select
    e.id                                        as category_id,
    coalesce(ev.data ->> 'name', e.source_record_id) as category_name
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id and ev.is_current
  where e.entity_type = 'asset_category'
),
-- Idle (available or returned) assets grouped by branch + category.
-- Uses the current relationship tables to locate branch and category assignments.
idle_by_branch_category as (
  select
    b_rel.parent_id                             as branch_id,
    c_rel.parent_id                             as category_id,
    count(*)                                    as idle_count
  from public.entities e
  join public.entity_versions ev
    on ev.entity_id = e.id and ev.is_current
  join public.relationships_v2 b_rel
    on b_rel.child_id = e.id
   and b_rel.relationship_type = 'branch_has_asset'
   and b_rel.is_current
  join public.relationships_v2 c_rel
    on c_rel.child_id = e.id
   and c_rel.relationship_type = 'asset_category_has_asset'
   and c_rel.is_current
  where e.entity_type = 'asset'
    and ev.data ->> 'operational_status' in ('available', 'returned')
  group by b_rel.parent_id, c_rel.parent_id
),
-- Open (unallocated) order lines that still need fulfillment
open_order_lines as (
  select
    oline_ev.data ->> 'category_id'             as category_id_text,
    coalesce(
      oline_ev.data ->> 'rental_order_id',
      oline_ev.data ->> 'order_id'
    )                                           as order_id_text
  from public.entities oline
  join public.entity_versions oline_ev
    on oline_ev.entity_id = oline.id and oline_ev.is_current
  where oline.entity_type = 'rental_order_line'
    and oline_ev.data ->> 'status' in ('pending', 'confirmed', 'quoted', 'open')
    and oline_ev.data ->> 'category_id' is not null
),
-- Open rental orders: resolve the branch the order was placed for
open_orders as (
  select
    order_ev.entity_id::text                    as order_id_text,
    order_ev.data ->> 'branch_id'               as branch_id_text
  from public.entities ordr
  join public.entity_versions order_ev
    on order_ev.entity_id = ordr.id and order_ev.is_current
  where ordr.entity_type = 'rental_order'
    and order_ev.data ->> 'status' in ('open', 'confirmed', 'quoted', 'pending', 'draft')
    and order_ev.data ->> 'branch_id' is not null
),
-- Aggregate demand: how many open lines per branch + category
demand_by_branch_category as (
  select
    oo.branch_id_text,
    ol.category_id_text,
    count(*)                                    as open_demand_count
  from open_order_lines ol
  join open_orders oo on oo.order_id_text = ol.order_id_text
  group by oo.branch_id_text, ol.category_id_text
),
-- Deficit branches: demand exceeds local idle supply for that category
deficit as (
  select
    d.branch_id_text,
    d.category_id_text,
    d.open_demand_count,
    coalesce(ibc.idle_count, 0)                                       as local_idle_count,
    greatest(0, d.open_demand_count - coalesce(ibc.idle_count, 0))   as demand_gap
  from demand_by_branch_category d
  left join idle_by_branch_category ibc
    on ibc.branch_id::text = d.branch_id_text
   and ibc.category_id::text = d.category_id_text
  where d.open_demand_count > coalesce(ibc.idle_count, 0)
)
select
  ibc.branch_id                                                   as surplus_branch_id,
  b_surplus.branch_name                                           as surplus_branch_name,
  ibc.category_id                                                 as asset_category_id,
  cat.category_name                                               as asset_category_name,
  ibc.idle_count,
  def.branch_id_text::uuid                                        as deficit_branch_id,
  b_deficit.branch_name                                           as deficit_branch_name,
  def.open_demand_count,
  def.demand_gap,
  least(ibc.idle_count, def.demand_gap)::int                      as suggested_transfer_qty
from idle_by_branch_category ibc
join branches b_surplus  on b_surplus.branch_id  = ibc.branch_id
join categories cat       on cat.category_id      = ibc.category_id
join deficit def
  on def.category_id_text = ibc.category_id::text
 and def.branch_id_text   != ibc.branch_id::text
join branches b_deficit  on b_deficit.branch_id  = def.branch_id_text::uuid
where ibc.idle_count > 0
  and def.demand_gap  > 0;

-- Grant read access
grant select on public.v_fleet_idle_rebalancing to authenticated, service_role;

comment on view public.v_fleet_idle_rebalancing is
  'Branch-level idle-fleet rebalancing signals: each row is a surplus→deficit '
  'branch pair for the same asset category. surplus_branch_id has idle assets; '
  'deficit_branch_id has open demand that exceeds its local supply. '
  'suggested_transfer_qty = min(idle_count, demand_gap).';
