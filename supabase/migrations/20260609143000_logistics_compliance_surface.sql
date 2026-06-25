-- ---------------------------------------------------------------------------
-- Logistics telemetry + compliance integration surface
--
-- Adds a normalized, vendor-agnostic telemetry/ELD contract for transport
-- operations and exposes it through dispatcher/driver-facing views.
--
-- Contract goals:
--   - Deduplicate inbound events by source_system + source_event_id + contract_line_id
--   - Keep retry/sync status metadata on each normalized event
--   - Expose latest route-position + compliance statuses without vendor-specific
--     frontend logic
-- ---------------------------------------------------------------------------

create table if not exists public.logistics_telematics_events (
  id                     uuid primary key default gen_random_uuid(),
  contract_line_id       uuid not null,
  route_id               uuid,
  source_system          text not null,
  source_event_id        text not null,
  event_time             timestamptz not null,
  telemetry_position_status text not null default 'unknown',
  eld_compliance_status  text not null default 'unknown',
  driver_log_status      text not null default 'unknown',
  latitude               numeric(10, 7),
  longitude              numeric(10, 7),
  sync_status            text not null default 'applied',
  retry_count            integer not null default 0,
  sync_error             text,
  payload                jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint logistics_telematics_events_position_chk
    check (telemetry_position_status in ('fresh', 'stale', 'missing', 'unknown')),
  constraint logistics_telematics_events_eld_chk
    check (eld_compliance_status in ('compliant', 'warning', 'violation', 'unknown')),
  constraint logistics_telematics_events_driver_log_chk
    check (driver_log_status in ('current', 'missing', 'out_of_hours', 'unknown')),
  constraint logistics_telematics_events_sync_status_chk
    check (sync_status in ('applied', 'duplicate', 'retryable_failure', 'rejected', 'unknown')),
  constraint logistics_telematics_events_dedupe_uniq
    unique (source_system, source_event_id, contract_line_id)
);

create index if not exists idx_logistics_telematics_contract_time
  on public.logistics_telematics_events (contract_line_id, event_time desc);

create index if not exists idx_logistics_telematics_route_time
  on public.logistics_telematics_events (route_id, event_time desc);

create trigger trg_logistics_telematics_events_updated_at
  before update on public.logistics_telematics_events
  for each row execute function update_updated_at();

revoke all on table public.logistics_telematics_events from anon, authenticated;
grant select on table public.logistics_telematics_events to authenticated;
grant all on table public.logistics_telematics_events to service_role;

alter table public.logistics_telematics_events enable row level security;

drop policy if exists "logistics_telematics_events_ops_read" on public.logistics_telematics_events;
drop policy if exists "logistics_telematics_events_service_role" on public.logistics_telematics_events;

create policy "logistics_telematics_events_ops_read"
  on public.logistics_telematics_events
  for select
  to authenticated
  using (public.ops_claim_app_role() in ('admin', 'branch_manager', 'field_operator'));

create policy "logistics_telematics_events_service_role"
  on public.logistics_telematics_events
  for all
  to service_role
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- Dispatcher live route view: add normalized telemetry/compliance columns.
-- ---------------------------------------------------------------------------
create or replace view public.v_dispatch_route_live with (security_invoker = true) as
select
    e.id                                                         as line_id,
    ev.data ->> 'contract_id'                                    as contract_id,
    ev.data ->> 'asset_id'                                       as asset_id,
    a.name                                                       as asset_name,
    a.serial_number                                              as asset_serial,
    ev.data ->> 'status'                                         as line_status,
    ev.data -> 'confirm_load' ->> 'assigned_driver'              as assigned_driver,
    ev.data -> 'confirm_load' ->> 'assigned_truck'               as assigned_truck,
    ev.data -> 'confirm_load' ->> 'departure_at'                 as departure_at,
    ev.data ->> 'actual_start'                                   as actual_start,
    ev.data ->> 'actual_end'                                     as actual_end,
    case
        when ev.data ->> 'status' = 'returned' then 'delivered'
        when ev.data -> 'confirm_load' ->> 'departure_at' is not null then 'in_transit'
        when ev.data ->> 'status' = 'checked_out' then 'pending_departure'
        else ev.data ->> 'status'
    end                                                          as route_status,
    case
        when ev.data ->> 'status' = 'checked_out'
             and ev.data -> 'confirm_load' ->> 'assigned_driver' is null
             then 'missing_driver'
        when ev.data ->> 'status' = 'checked_out'
             and ev.data ->> 'actual_start' is not null
             and (ev.data ->> 'actual_start')::timestamptz < now() - interval '24 hours'
             and ev.data ->> 'actual_end' is null
             then 'overdue'
        else null
    end                                                          as exception_state,
    a.state ->> 'home_branch_id'                                 as branch_id,
    ev.valid_from                                                as updated_at,
    coalesce(t.telemetry_position_status, 'unknown')             as telemetry_position_status,
    coalesce(t.eld_compliance_status, 'unknown')                 as eld_compliance_status,
    coalesce(t.driver_log_status, 'unknown')                     as driver_log_status,
    t.event_time                                                 as telemetry_event_at,
    coalesce(t.sync_status, 'unknown')                           as telemetry_sync_status
from public.entities e
join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
left join public.v_current_assets a
    on a.asset_id::text = ev.data ->> 'asset_id'
left join lateral (
    select
      te.telemetry_position_status,
      te.eld_compliance_status,
      te.driver_log_status,
      te.event_time,
      te.sync_status
    from public.logistics_telematics_events te
    where te.contract_line_id = e.id
    order by te.event_time desc, te.updated_at desc
    limit 1
) t on true
where e.entity_type = 'rental_contract_line'
  and ev.data ->> 'status' in ('checked_out', 'returned');


revoke all on table public.v_dispatch_route_live from anon;
grant select on table public.v_dispatch_route_live to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Fleet efficiency summary: include compliance and telemetry freshness counts.
-- ---------------------------------------------------------------------------
create or replace view public.v_transport_efficiency_summary with (security_invoker = true) as
select
    count(*)                                                           as total_routes,
    count(*) filter (
        where ev.data -> 'confirm_load' ->> 'assigned_truck' is not null
    )                                                                  as loaded_routes,
    count(*) filter (
        where ev.data -> 'confirm_load' ->> 'assigned_truck' is null
    )                                                                  as empty_routes,
    round(
        100.0
        * count(*) filter (
            where ev.data -> 'confirm_load' ->> 'assigned_truck' is not null
          )
        / nullif(count(*), 0),
        1
    )                                                                  as load_utilization_pct,
    count(*) filter (
        where ev.data ->> 'status' = 'checked_out'
    )                                                                  as active_routes,
    count(*) filter (
        where ev.data ->> 'status' = 'returned'
    )                                                                  as completed_routes,
    count(*) filter (
        where ev.data ->> 'status' = 'checked_out'
          and ev.data -> 'confirm_load' ->> 'assigned_driver' is null
    )                                                                  as missing_driver_count,
    count(*) filter (
        where ev.data ->> 'status' = 'checked_out'
          and ev.data ->> 'actual_start' is not null
          and (ev.data ->> 'actual_start')::timestamptz < now() - interval '24 hours'
          and ev.data ->> 'actual_end' is null
    )                                                                  as overdue_count,
    count(*) filter (
        where coalesce(t.eld_compliance_status, 'unknown') = 'warning'
    )                                                                  as eld_warning_count,
    count(*) filter (
        where coalesce(t.eld_compliance_status, 'unknown') = 'violation'
    )                                                                  as eld_violation_count,
    count(*) filter (
        where coalesce(t.telemetry_position_status, 'unknown') = 'stale'
    )                                                                  as stale_position_count
from public.entities e
join public.entity_versions ev
    on ev.entity_id = e.id
   and ev.is_current = true
left join lateral (
    select
      te.telemetry_position_status,
      te.eld_compliance_status
    from public.logistics_telematics_events te
    where te.contract_line_id = e.id
    order by te.event_time desc, te.updated_at desc
    limit 1
) t on true
where e.entity_type = 'rental_contract_line'
  and ev.data ->> 'status' in ('checked_out', 'returned');


revoke all on table public.v_transport_efficiency_summary from anon;
grant select on table public.v_transport_efficiency_summary to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Driver stop view: expose normalized compliance/telemetry fields per stop.
-- ---------------------------------------------------------------------------
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
  coalesce(t.eld_compliance_status, 'unknown') as eld_compliance_status,
  coalesce(t.driver_log_status, 'unknown') as driver_log_status,
  t.event_time as telemetry_event_at
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
