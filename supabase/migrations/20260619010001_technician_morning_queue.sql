-- Technician morning-queue scope view
-- Created: 2026-06-19
-- Purpose: Unified view that surfaces returned units, open PM work orders,
--          active maintenance repairs, and near-complete rent-ready checks so
--          the technician morning-queue workflow can scope candidates in a
--          single PostgREST query.
-- Issue: #2126

-- ---------------------------------------------------------------------------
-- View: v_technician_morning_queue_scope
-- ---------------------------------------------------------------------------
-- Unions four candidate sets into a single surface:
--   1. returned_unit     — assets with operational_status in
--                          ('returned', 'on_inspection_hold') needing
--                          inspection / repair follow-up (tech t1)
--   2. pm_work           — open PM work orders ready for execution (tech t2)
--   3. active_repair     — open/in-progress maintenance records (tech t2)
--   4. rent_ready_check  — maintenance records in 'completed' or
--                          'pending_approval' state — final prep before
--                          returning the unit to available fleet (tech t5)
--
-- The 'context' column carries item-specific JSON so callers can pass it
-- directly to the AI assessment step without additional round-trips.
--
-- This view is granted to service_role only; authenticated callers read
-- ops_findings_view (filtered to agent_key = 'technician-morning-queue').
-- The Temporal workflow worker accesses it via service_role and applies its
-- own tenant_id and branch_id filters in Python.
-- ---------------------------------------------------------------------------

create or replace view public.v_technician_morning_queue_scope
with (security_invoker = true)
as
-- 1. Returned units needing inspection / repair follow-up (tech t1)
select
    'returned_unit'::text                      as item_type,
    e.id                                       as item_source_id,
    e.id                                       as asset_id,
    (ev.data ->> 'tenant_id')::text            as tenant_id,
    null::uuid                                 as branch_id,
    ev.updated_at                              as last_updated_at,
    jsonb_build_object(
        'operational_status',   ev.data ->> 'operational_status',
        'asset_name',           ev.data ->> 'name',
        'updated_at',           ev.updated_at
    )                                          as context
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
where e.entity_type = 'asset'
  and (ev.data ->> 'operational_status') in ('returned', 'on_inspection_hold')

union all

-- 2. Open PM work orders ready for execution (tech t2)
select
    'pm_work'::text                            as item_type,
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

-- 3. Active repairs: open/in-progress maintenance records (tech t2)
-- 4. Rent-ready checks: completed/pending-approval maintenance records (tech t5)
select
    case
        when (ev.data ->> 'status') in ('completed', 'pending_approval')
        then 'rent_ready_check'::text
        else 'active_repair'::text
    end                                        as item_type,
    e.id                                       as item_source_id,
    -- Resolve asset via relationship; fall back to data->>'asset_id'.
    -- Null-safe cast: blank or malformed asset_id yields NULL rather than
    -- aborting the whole view query for service-role consumers.
    coalesce(
        rel.parent_id,
        case
            when (ev.data ->> 'asset_id') ~
                 '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then (ev.data ->> 'asset_id')::uuid
        end
    )                                          as asset_id,
    (ev.data ->> 'tenant_id')::text            as tenant_id,
    null::uuid                                 as branch_id,
    ev.updated_at                              as last_updated_at,
    jsonb_build_object(
        'maintenance_record_id',  e.id,
        'status',                 ev.data ->> 'status',
        'parts_blocked',          coalesce((ev.data ->> 'parts_blocked')::boolean, false),
        'parts_hold',             coalesce((ev.data ->> 'parts_hold')::boolean, false),
        'description',            ev.data ->> 'description',
        'updated_at',             ev.updated_at
    )                                          as context
from public.entities e
join public.entity_versions ev
  on ev.entity_id = e.id
 and ev.is_current
left join public.relationships_v2 rel
  on rel.child_id = e.id
 and rel.relationship_type = 'asset_has_maintenance_record'
 and rel.is_current
where e.entity_type = 'maintenance_record'
  and (ev.data ->> 'status') in ('open', 'in_progress', 'pending', 'completed', 'pending_approval');

-- Grant read access to service_role only (no authenticated direct-read path;
-- authenticated callers read ops_findings_view).
revoke all on public.v_technician_morning_queue_scope from anon, authenticated;
grant select on public.v_technician_morning_queue_scope to service_role;
