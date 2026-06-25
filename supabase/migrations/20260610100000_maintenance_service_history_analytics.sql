-- Maintenance service-history and downtime analytics surfaces
-- Created: 2026-06-10
-- Purpose: expose per-asset service history plus asset/category downtime rollups

create or replace view public.v_asset_service_history with (security_invoker = true) as
with maintenance_history as (
  select
    rel.parent_id as asset_id,
    rel.child_id as service_record_id,
    'maintenance'::text as service_record_type,
    child.name as service_name,
    child.data ->> 'maintenance_type' as service_type,
    nullif(child.data ->> 'opened_at', '')::timestamptz as opened_at,
    nullif(child.data ->> 'completed_at', '')::timestamptz as completed_at,
    -- Prefer explicit completion outcomes, then fall back to the maintained record status.
    coalesce(nullif(child.data ->> 'outcome', ''), nullif(child.data ->> 'status', '')) as outcome,
    child.data ->> 'status' as status,
    child.data ->> 'cost_summary' as cost_summary,
    downtime.downtime_minutes,
    coalesce(
      nullif(child.data ->> 'completed_at', '')::timestamptz,
      nullif(child.data ->> 'opened_at', '')::timestamptz,
      child.updated_at,
      child.created_at
    ) as service_sort_at
  from public.rental_current_relationships rel
  join public.rental_current_entity_state child
    on child.entity_id = rel.child_id
  left join public.v_asset_downtime_history downtime
    on downtime.maintenance_record_id = rel.child_id::text
  where rel.relationship_type = 'asset_has_maintenance_record'
    and child.entity_type = 'maintenance_record'
), inspection_history as (
  select
    rel.parent_id as asset_id,
    rel.child_id as service_record_id,
    'inspection'::text as service_record_type,
    child.name as service_name,
    child.data ->> 'inspection_type' as service_type,
    nullif(child.data ->> 'inspected_at', '')::timestamptz as opened_at,
    nullif(child.data ->> 'inspected_at', '')::timestamptz as completed_at,
    -- Inspections keep their operational result in outcome, so expose it for both fields.
    child.data ->> 'outcome' as outcome,
    child.data ->> 'outcome' as status,
    null::text as cost_summary,
    null::numeric as downtime_minutes,
    coalesce(
      nullif(child.data ->> 'inspected_at', '')::timestamptz,
      child.updated_at,
      child.created_at
    ) as service_sort_at
  from public.rental_current_relationships rel
  join public.rental_current_entity_state child
    on child.entity_id = rel.child_id
  where rel.relationship_type = 'asset_has_inspection'
    and child.entity_type = 'inspection'
)
select * from maintenance_history
union all
select * from inspection_history;

create or replace view public.v_asset_downtime_analytics with (security_invoker = true) as
select
  assets.entity_id as asset_id,
  assets.name as asset_name,
  assets.current_asset_category_id as asset_category_id,
  assets.current_asset_category_name as asset_category_name,
  count(history.asset_id) as downtime_intervals,
  coalesce(sum(history.downtime_minutes), 0)::numeric as total_downtime_minutes,
  coalesce(
    sum(case when coalesce(history.metadata ->> 'source', 'maintenance') = 'inspection' then history.downtime_minutes else 0 end),
    0
  )::numeric as inspection_downtime_minutes,
  coalesce(
    sum(case when coalesce(history.metadata ->> 'source', 'maintenance') <> 'inspection' then history.downtime_minutes else 0 end),
    0
  )::numeric as maintenance_downtime_minutes,
  max(history.downtime_recorded_at) as last_downtime_recorded_at
from public.rental_current_assets assets
left join public.v_asset_downtime_history history
  on history.asset_id = assets.entity_id
group by
  assets.entity_id,
  assets.name,
  assets.current_asset_category_id,
  assets.current_asset_category_name;

create or replace view public.v_asset_category_downtime_summary with (security_invoker = true) as
select
  assets.current_asset_category_id as asset_category_id,
  assets.current_asset_category_name as asset_category_name,
  count(distinct assets.entity_id) as asset_count,
  count(history.asset_id) as downtime_intervals,
  coalesce(sum(history.downtime_minutes), 0)::numeric as total_downtime_minutes,
  coalesce(avg(history.downtime_minutes), 0)::numeric as average_interval_minutes,
  coalesce(
    sum(case when coalesce(history.metadata ->> 'source', 'maintenance') = 'inspection' then history.downtime_minutes else 0 end),
    0
  )::numeric as inspection_downtime_minutes,
  coalesce(
    sum(case when coalesce(history.metadata ->> 'source', 'maintenance') <> 'inspection' then history.downtime_minutes else 0 end),
    0
  )::numeric as maintenance_downtime_minutes,
  max(history.downtime_recorded_at) as last_downtime_recorded_at
from public.rental_current_assets assets
left join public.v_asset_downtime_history history
  on history.asset_id = assets.entity_id
where assets.current_asset_category_id is not null
group by
  assets.current_asset_category_id,
  assets.current_asset_category_name;
