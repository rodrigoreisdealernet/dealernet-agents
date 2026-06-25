-- Expose tsp.id as row_id in ops_audit_trail_view so callers have a truly
-- unique per-row identifier for audit drill-down context preservation.
-- source_id uniqueness is narrowed to PM fact types only (see
-- 20260610210000_pm_source_dedup_narrow.sql); using source_id as the
-- active-event key caused misidentification when multiple rows share the
-- same source_id (e.g. batch-tagged analytics observations).

create or replace view public.ops_audit_trail_view
with (security_invoker = true)
as
select
  tsp.entity_id,
  e.entity_type,
  ev.data ->> 'name' as entity_name,
  tsp.fact_type_id,
  ft.key as fact_key,
  ft.label as fact_label,
  tsp.observed_at,
  tsp.data_payload,
  tsp.metadata,
  tsp.source_id,
  tsp.created_at,
  row_number() over (
    partition by tsp.entity_id
    order by tsp.observed_at, tsp.created_at, tsp.id
  ) as point_order,
  tsp.id as row_id
from public.time_series_points tsp
join public.entities e
  on e.id = tsp.entity_id
left join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
join public.fact_types ft
  on ft.id = tsp.fact_type_id;
