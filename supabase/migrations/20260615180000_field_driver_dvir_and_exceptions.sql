-- Field driver DVIR and route exception capture.
--
-- Adds the persistence layer for the two capabilities missing from the driver
-- dispatch execution baseline (20260609130000):
--
--   dvir_submissions       — pre-trip Driver Vehicle Inspection Report (one per
--                            driver per route; safe-to-drive flag escalates
--                            automatically when defects are recorded).
--   route_stop_exceptions  — structured ETA/delay/access/damage exceptions per
--                            stop, each with an evidence bundle (photos + notes).
--
-- Replaces v_driver_dispatch_stops to expose dvir_submitted and exception_count
-- so the mobile driver surface can reflect readiness state without a second
-- round-trip.
--
-- Operating-model tasks covered:
--   field-delivery-driver:t2 — DVIR capture and safe-to-drive escalation
--   field-delivery-driver:t5 — ETA / delay / access exception updates
--   field-delivery-driver:t7 — damage / missing-attachment escalation with
--                              evidence bundle for branch review

-- ── dvir_submissions ─────────────────────────────────────────────────────────

create table if not exists public.dvir_submissions (
  id                 uuid         primary key default gen_random_uuid(),
  route_id           uuid         not null references public.dispatch_routes(id) on delete cascade,
  driver_id          uuid         not null,
  truck_id           text,
  odometer_reading   numeric(10, 1),
  defects            jsonb        not null default '[]',
  is_safe_to_drive   boolean      not null,
  notes              text,
  signature          text,
  requires_review    boolean      not null default false,
  submitted_at       timestamptz  not null default now(),
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now(),
  constraint dvir_defects_is_array check (jsonb_typeof(defects) = 'array')
);

create index if not exists idx_dvir_submissions_route_id
  on public.dvir_submissions (route_id);

create index if not exists idx_dvir_submissions_driver_date
  on public.dvir_submissions (driver_id, submitted_at);

create trigger trg_dvir_submissions_updated_at
  before update on public.dvir_submissions
  for each row execute function update_updated_at();

-- ── route_stop_exceptions ─────────────────────────────────────────────────────

create table if not exists public.route_stop_exceptions (
  id                        uuid         primary key default gen_random_uuid(),
  stop_id                   uuid         not null references public.route_stops(id) on delete cascade,
  exception_type            text         not null,
  notes                     text,
  photo_paths               text[]       not null default '{}',
  estimated_delay_minutes   int,
  requires_human_review     boolean      not null default true,
  resolved_at               timestamptz,
  submitted_at              timestamptz  not null default now(),
  created_at                timestamptz  not null default now(),
  updated_at                timestamptz  not null default now(),
  constraint route_stop_exceptions_type_chk
    check (exception_type in ('eta_delay', 'access_issue', 'damage', 'missing_attachment'))
);

create index if not exists idx_route_stop_exceptions_stop_id
  on public.route_stop_exceptions (stop_id);

create trigger trg_route_stop_exceptions_updated_at
  before update on public.route_stop_exceptions
  for each row execute function update_updated_at();

-- ── Grants ────────────────────────────────────────────────────────────────────
--
-- Authenticated users interact with these tables exclusively through the
-- submit_dvir and submit_stop_exception RPCs (security definer).  Direct
-- INSERT/UPDATE is intentionally not granted so that RPC-only invariants
-- (unsafe DVIR => requires_review, all exceptions => requires_human_review)
-- cannot be bypassed via raw SQL.

grant select on public.dvir_submissions to authenticated;
grant select on public.route_stop_exceptions to authenticated;
grant all on public.dvir_submissions to service_role;
grant all on public.route_stop_exceptions to service_role;

-- ── Row-level security ────────────────────────────────────────────────────────

alter table public.dvir_submissions enable row level security;
alter table public.route_stop_exceptions enable row level security;

-- dvir_submissions policies ------------------------------------------------

drop policy if exists "dvir_driver_read"   on public.dvir_submissions;
drop policy if exists "dvir_manager_read"  on public.dvir_submissions;
drop policy if exists "dvir_driver_insert" on public.dvir_submissions;
drop policy if exists "dvir_service_role"  on public.dvir_submissions;

-- Drivers can read their own DVIR submissions.
create policy "dvir_driver_read"
  on public.dvir_submissions
  for select
  to authenticated
  using (
    public.ops_claim_app_role() = 'field_operator'
    and driver_id = auth.uid()
  );

-- Managers and admins can read all DVIR submissions.
create policy "dvir_manager_read"
  on public.dvir_submissions
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- Drivers write through the submit_dvir RPC (security definer) exclusively.
-- Direct INSERT is restricted to service_role to preserve the
-- requires_review escalation invariant.
create policy "dvir_service_role"
  on public.dvir_submissions
  for all
  to service_role
  using (true)
  with check (true);

-- route_stop_exceptions policies -------------------------------------------

drop policy if exists "rse_driver_read"   on public.route_stop_exceptions;
drop policy if exists "rse_manager_read"  on public.route_stop_exceptions;
drop policy if exists "rse_driver_insert" on public.route_stop_exceptions;
drop policy if exists "rse_service_role"  on public.route_stop_exceptions;

-- Drivers can read exceptions for their own stops.
create policy "rse_driver_read"
  on public.route_stop_exceptions
  for select
  to authenticated
  using (
    public.ops_claim_app_role() = 'field_operator'
    and exists (
      select 1 from public.route_stops s
      join public.dispatch_routes r on r.id = s.route_id
      where s.id = stop_id
        and r.driver_id = auth.uid()
    )
  );

-- Managers and admins can read all exceptions.
create policy "rse_manager_read"
  on public.route_stop_exceptions
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- Drivers write through the submit_stop_exception RPC (security definer)
-- exclusively.  Direct INSERT is restricted to service_role to preserve
-- the requires_human_review invariant.
create policy "rse_service_role"
  on public.route_stop_exceptions
  for all
  to service_role
  using (true)
  with check (true);

-- ── submit_dvir RPC ───────────────────────────────────────────────────────────
--
-- Security definer so field_operator can bypass direct-insert restrictions
-- while the function enforces ownership and escalation rules.
-- A DVIR with is_safe_to_drive = false is automatically flagged requires_review
-- so the branch cannot silently clear a safety exception.

create or replace function public.submit_dvir(
  p_route_id           uuid,
  p_truck_id           text      default null,
  p_odometer_reading   numeric   default null,
  p_defects            jsonb     default '[]',
  p_is_safe_to_drive   boolean   default true,
  p_notes              text      default null,
  p_signature          text      default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app_role  text;
  v_driver_id uuid;
  v_dvir_id   uuid;
begin
  v_app_role  := public.ops_claim_app_role();
  v_driver_id := auth.uid();

  if v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'submit_dvir requires field_operator or higher role';
  end if;

  if v_app_role = 'field_operator' then
    if not exists (
      select 1 from public.dispatch_routes r
      where r.id = p_route_id
        and r.driver_id = v_driver_id
    ) then
      raise exception 'Field operators may only submit DVIR for their own routes';
    end if;
  end if;

  insert into public.dvir_submissions (
    route_id,
    driver_id,
    truck_id,
    odometer_reading,
    defects,
    is_safe_to_drive,
    notes,
    signature,
    requires_review
  ) values (
    p_route_id,
    v_driver_id,
    p_truck_id,
    p_odometer_reading,
    coalesce(p_defects, '[]'),
    p_is_safe_to_drive,
    p_notes,
    p_signature,
    -- Unsafe DVIR always requires branch review; the system must not auto-clear it.
    not p_is_safe_to_drive
  )
  returning id into v_dvir_id;

  return v_dvir_id;
end;
$$;

revoke all on function public.submit_dvir from public;
grant execute on function public.submit_dvir to authenticated;

-- ── submit_stop_exception RPC ─────────────────────────────────────────────────
--
-- Security definer. Damage and missing_attachment exceptions are always flagged
-- requires_human_review; ETA/delay/access exceptions default to true as well
-- because money-moving or customer-facing dispositions must stay with humans.

create or replace function public.submit_stop_exception(
  p_stop_id                 uuid,
  p_exception_type          text,
  p_notes                   text    default null,
  p_photo_paths             text[]  default '{}',
  p_estimated_delay_minutes int     default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app_role  text;
  v_driver_id uuid;
  v_exc_id    uuid;
begin
  v_app_role  := public.ops_claim_app_role();
  v_driver_id := auth.uid();

  if v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'submit_stop_exception requires field_operator or higher role';
  end if;

  if p_exception_type not in ('eta_delay', 'access_issue', 'damage', 'missing_attachment') then
    raise exception 'Invalid exception_type: %', p_exception_type;
  end if;

  if v_app_role = 'field_operator' then
    if not exists (
      select 1 from public.route_stops s
      join public.dispatch_routes r on r.id = s.route_id
      where s.id = p_stop_id
        and r.driver_id = v_driver_id
    ) then
      raise exception 'Field operators may only submit exceptions for their own stops';
    end if;
  end if;

  insert into public.route_stop_exceptions (
    stop_id,
    exception_type,
    notes,
    photo_paths,
    estimated_delay_minutes,
    requires_human_review
  ) values (
    p_stop_id,
    p_exception_type,
    p_notes,
    coalesce(p_photo_paths, '{}'),
    p_estimated_delay_minutes,
    true
  )
  returning id into v_exc_id;

  return v_exc_id;
end;
$$;

revoke all on function public.submit_stop_exception from public;
grant execute on function public.submit_stop_exception to authenticated;

-- ── v_driver_dispatch_stops: add dvir_submitted + exception_count ─────────────
--
-- Replaces the definition from 20260609143000_logistics_compliance_surface.sql
-- to expose two new readiness signals without changing existing column positions.

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
  )::int                                           as exception_count
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
