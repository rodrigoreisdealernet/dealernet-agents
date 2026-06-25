-- Driver run-sheet readiness: contact fields on route stops.
--
-- Adds contact_name and contact_phone to route_stops so dispatchers can
-- record the site contact before the truck departs.  The driver mobile view
-- (v_driver_dispatch_stops) is updated to expose both columns, and the
-- run-sheet readiness check on the frontend can flag missing contact info
-- as an explicit exception rather than silently omitting it.
--
-- Operating-model tasks covered:
--   field-delivery-driver:t1 — review assigned loads, contacts, and route
--                               information before leaving the yard

-- ── Schema ────────────────────────────────────────────────────────────────────

alter table public.route_stops
  add column if not exists contact_name  text,
  add column if not exists contact_phone text;

-- ── View: expose contact fields in the driver dispatch surface ─────────────────
--
-- Replaces the definition from 20260615180000_field_driver_dvir_and_exceptions.sql
-- to add contact_name and contact_phone without changing existing column positions.

create or replace view public.v_driver_dispatch_stops with (security_invoker = true) as
select
  s.id                as stop_id,
  s.route_id,
  r.driver_id,
  r.route_date,
  r.status            as route_status,
  s.sequence_order,
  s.stop_type,
  s.status            as stop_status,
  s.contract_line_id,
  s.asset_id,
  s.address,
  s.address_lat,
  s.address_lng,
  s.customer_name,
  s.job_site_name,
  s.notes,
  s.signature,
  s.condition_notes,
  s.photo_paths,
  s.departed_at,
  s.arrived_at,
  s.completed_at,
  s.created_at,
  s.updated_at,
  coalesce(t.telemetry_position_status, 'unknown') as telemetry_position_status,
  coalesce(t.eld_compliance_status, 'unknown')     as eld_compliance_status,
  coalesce(t.driver_log_status, 'unknown')         as driver_log_status,
  t.event_time                                     as telemetry_event_at,
  -- dvir_submitted: true when at least one DVIR has been recorded for this route.
  (exists (
    select 1 from public.dvir_submissions d
    where d.route_id = s.route_id
  ))::boolean                                      as dvir_submitted,
  -- exception_count: number of unresolved exceptions for this stop (for badge display).
  (select count(*)
   from public.route_stop_exceptions e
   where e.stop_id = s.id
     and e.resolved_at is null
  )::int                                           as exception_count,
  -- contact_name / contact_phone: new columns appended after all existing output columns
  -- to satisfy the PostgreSQL CREATE OR REPLACE VIEW column-order contract.
  s.contact_name,
  s.contact_phone
from public.route_stops s
join public.dispatch_routes r on r.id = s.route_id
left join lateral (
  select
    te.telemetry_position_status,
    te.eld_compliance_status,
    te.driver_log_status,
    te.event_time
  from public.logistics_telematics_events te
  where te.contract_line_id = s.contract_line_id
  order by te.event_time desc, te.updated_at desc
  limit 1
) t on true;

grant select on public.v_driver_dispatch_stops to authenticated, service_role;
alter view public.v_driver_dispatch_stops set (security_invoker = true);
