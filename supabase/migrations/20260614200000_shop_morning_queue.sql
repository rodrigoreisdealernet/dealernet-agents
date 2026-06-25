-- Shop morning-queue scope view
-- Created: 2026-06-14
-- Purpose: Unified view that surfaces PM-due work orders, open maintenance
--          records, and not-available assets so the shop morning-queue
--          workflow can scope candidates in a single PostgREST query.
-- Issue: #1701

-- ---------------------------------------------------------------------------
-- View: v_shop_morning_queue_scope
-- ---------------------------------------------------------------------------
-- Unions three candidate sets into a single surface:
--   1. pm_due          — open PM work orders (ops t1)
--   2. work_order_priority — open/in-progress maintenance records (ops t2)
--   3. not_available_unit  — assets currently in_maintenance or
--                            on_inspection_hold (ops t3)
--
-- The 'context' column carries item-specific JSON so callers can pass it
-- directly to the AI assessment step without additional round-trips.
-- ---------------------------------------------------------------------------

create or replace view public.v_shop_morning_queue_scope
with (security_invoker = true)
as
-- 1. PM-due work orders
select
    'pm_due'::text                             as item_type,
    wo.id                                      as item_source_id,
    wo.asset_id                                as asset_id,
    wo.tenant_id                               as tenant_id,
    null::uuid                                 as branch_id,
    wo.updated_at                              as last_updated_at,
    jsonb_build_object(
        'work_order_id',  wo.id,
        'trigger_type',   wo.trigger_type,
        'policy_id',      wo.policy_id,
        'status',         wo.status,
        'reason',         wo.reason,
        'run_id',         wo.run_id,
        'created_at',     wo.created_at
    )                                          as context
from public.pm_work_orders wo
where wo.status = 'open'

union all

-- 2. Open / in-progress maintenance records
-- Note: entities have no tenant_id column; tenant isolation is enforced by
-- security_invoker=true (caller's RLS policies apply). tenant_id is
-- surfaced from data->>'tenant_id' when populated by the application.
select
    case
        when coalesce((ev.data ->> 'parts_blocked')::boolean, false)
          or coalesce((ev.data ->> 'parts_hold')::boolean, false)
        then 'parts_blocker'::text
        else 'work_order_priority'::text
    end                                        as item_type,
    e.id                                       as item_source_id,
    -- Resolve asset via relationship; fall back to data->>'asset_id'.
    coalesce(
        rel.parent_id,
        nullif((ev.data ->> 'asset_id'), '')::uuid
    )                                          as asset_id,
    (ev.data ->> 'tenant_id')::text            as tenant_id,
    null::uuid                                 as branch_id,
    e.updated_at                               as last_updated_at,
    jsonb_build_object(
        'work_order_id',     e.id,
        'maintenance_type',  ev.data ->> 'maintenance_type',
        'status',            ev.data ->> 'status',
        'parts_blocked',     coalesce((ev.data ->> 'parts_blocked')::boolean, false),
        'parts_hold',        coalesce((ev.data ->> 'parts_hold')::boolean, false),
        'opened_at',         ev.data ->> 'opened_at',
        'tech_notes',        ev.data ->> 'tech_notes'
    )                                          as context
from public.entities e
join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
left join public.relationships_v2 rel
    on rel.child_id = e.id
   and rel.relationship_type = 'asset_has_maintenance_record'
   and rel.is_current = true
where e.entity_type = 'maintenance_record'
  and (ev.data ->> 'status') in ('open', 'in_progress', 'pending')

union all

-- 3. Not-available / in-shop assets
-- Note: entities have no tenant_id column; security_invoker=true enforces
-- RLS-based tenant isolation. tenant_id surfaced from data when available.
select
    'not_available_unit'::text                 as item_type,
    e.id                                       as item_source_id,
    e.id                                       as asset_id,
    (ev.data ->> 'tenant_id')::text            as tenant_id,
    branch_rel.parent_id                       as branch_id,
    e.updated_at                               as last_updated_at,
    jsonb_build_object(
        'operational_status', ev.data ->> 'operational_status',
        'name',               ev.data ->> 'name',
        'model',              ev.data ->> 'model',
        'serial_number',      ev.data ->> 'serial_number'
    )                                          as context
from public.entities e
join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
left join public.relationships_v2 branch_rel
    on branch_rel.child_id = e.id
   and branch_rel.relationship_type = 'branch_has_asset'
   and branch_rel.is_current = true
where e.entity_type = 'asset'
  and (ev.data ->> 'operational_status') in ('in_maintenance', 'on_inspection_hold');

-- Access: service_role only. The Temporal workflow worker queries this view via
-- service_role with an explicit tenant_id filter. The frontend reads
-- ops_findings_view, not this view; no authenticated direct-read path exists.
grant select on public.v_shop_morning_queue_scope to service_role;
