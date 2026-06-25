-- Driver dispatch execution tables.
-- Provides the persistence layer for the driver mobile dispatch experience:
-- assignment inbox, sequential route stops, depart/arrive/complete state
-- machine, and field evidence attachment (signature, condition notes, photos).

-- dispatch_routes: one row per driver-day route assignment.
create table if not exists public.dispatch_routes (
  id              uuid        primary key default gen_random_uuid(),
  driver_id       uuid        not null,
  route_date      date        not null,
  status          text        not null default 'pending',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint dispatch_routes_status_chk
    check (status in ('pending', 'in_progress', 'completed', 'cancelled'))
);

create index if not exists idx_dispatch_routes_driver_date
  on public.dispatch_routes (driver_id, route_date);

create trigger trg_dispatch_routes_updated_at
  before update on public.dispatch_routes
  for each row execute function update_updated_at();

-- route_stops: individual stops on a dispatch route, in sequence order.
create table if not exists public.route_stops (
  id                uuid        primary key default gen_random_uuid(),
  route_id          uuid        not null references public.dispatch_routes(id) on delete cascade,
  sequence_order    int         not null,
  stop_type         text        not null,
  status            text        not null default 'pending',
  contract_line_id  uuid,
  asset_id          text,
  address           text,
  address_lat       numeric(10, 7),
  address_lng       numeric(10, 7),
  customer_name     text,
  job_site_name     text,
  notes             text,
  signature         text,
  condition_notes   text,
  photo_paths       text[]      not null default '{}',
  departed_at       timestamptz,
  arrived_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint route_stops_stop_type_chk
    check (stop_type in ('delivery', 'pickup')),
  constraint route_stops_status_chk
    check (status in ('pending', 'departed', 'arrived', 'completed')),
  constraint route_stops_sequence_order_chk
    check (sequence_order >= 0)
);

create index if not exists idx_route_stops_route_id
  on public.route_stops (route_id, sequence_order);

create trigger trg_route_stops_updated_at
  before update on public.route_stops
  for each row execute function update_updated_at();

-- View: driver sees their own stops with route metadata joined.
create or replace view public.v_driver_dispatch_stops as
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
  s.updated_at
from public.route_stops s
join public.dispatch_routes r on r.id = s.route_id;

grant select on public.v_driver_dispatch_stops to authenticated, service_role;

alter view public.v_driver_dispatch_stops set (security_invoker = true);

-- RPC: update a single stop's state machine with optional field evidence.
-- Enforces valid state transitions and updates parent route status.
create or replace function public.update_route_stop_state(
  p_stop_id       uuid,
  p_status        text,
  p_signature     text    default null,
  p_condition_notes text  default null,
  p_photo_paths   text[]  default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role    text;
  v_driver_id   uuid;
  v_stop        record;
  v_now         timestamptz := now();
begin
  -- Role gate: only operational users may execute stops.
  v_app_role := public.ops_claim_app_role();
  if v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'update_route_stop_state requires field_operator or higher role'
      using errcode = '42501';
  end if;

  -- Validate target status value (pending is a database state but is not a
  -- valid transition target — stops begin as pending automatically).
  if p_status not in ('departed', 'arrived', 'completed') then
    raise exception 'Invalid stop status %. Valid transition targets are: departed, arrived, completed.', p_status
      using errcode = '22023';
  end if;

  -- Load stop + parent route in one query.
  select
    s.id,
    s.route_id,
    s.status          as current_status,
    s.signature,
    s.condition_notes,
    s.photo_paths,
    r.driver_id,
    r.status          as route_status
  into v_stop
  from public.route_stops s
  join public.dispatch_routes r on r.id = s.route_id
  where s.id = p_stop_id;

  if not found then
    raise exception 'Route stop % not found', p_stop_id
      using errcode = '02000';
  end if;

  -- Field operators may only advance their own stops.
  if v_app_role = 'field_operator' then
    v_driver_id := auth.uid();
    if v_stop.driver_id <> v_driver_id then
      raise exception 'Field operators may only update their own route stops'
        using errcode = '42501';
    end if;
  end if;

  -- Enforce ordered state machine: pending → departed → arrived → completed.
  if p_status = 'departed' and v_stop.current_status <> 'pending' then
    raise exception 'Stop must be pending to depart (current: %)', v_stop.current_status
      using errcode = '23514';
  end if;
  if p_status = 'arrived' and v_stop.current_status <> 'departed' then
    raise exception 'Stop must be departed to arrive (current: %)', v_stop.current_status
      using errcode = '23514';
  end if;
  if p_status = 'completed' and v_stop.current_status <> 'arrived' then
    raise exception 'Stop must be arrived to complete (current: %)', v_stop.current_status
      using errcode = '23514';
  end if;

  -- Apply the update.
  update public.route_stops
  set
    status          = p_status,
    signature       = coalesce(p_signature,       signature),
    condition_notes = coalesce(p_condition_notes, condition_notes),
    photo_paths     = case
                        when p_photo_paths is not null
                          then array_cat(photo_paths, p_photo_paths)
                        else photo_paths
                      end,
    departed_at     = case when p_status = 'departed'  then v_now else departed_at  end,
    arrived_at      = case when p_status = 'arrived'   then v_now else arrived_at   end,
    completed_at    = case when p_status = 'completed' then v_now else completed_at end,
    updated_at      = v_now
  where id = p_stop_id;

  -- Advance the parent route to in_progress when the first stop departs.
  if p_status = 'departed' then
    update public.dispatch_routes
    set status = 'in_progress', updated_at = v_now
    where id = v_stop.route_id
      and status = 'pending';
  end if;

  -- Close the route when the last stop is completed.
  if p_status = 'completed' then
    if not exists (
      select 1 from public.route_stops
      where route_id = v_stop.route_id
        and status   <> 'completed'
        and id       <> p_stop_id
    ) then
      update public.dispatch_routes
      set status = 'completed', updated_at = v_now
      where id = v_stop.route_id;
    end if;
  end if;

  return json_build_object(
    'stop_id', p_stop_id,
    'status',  p_status,
    'updated_at', v_now
  );
end;
$$;

grant execute on function public.update_route_stop_state(uuid, text, text, text, text[])
  to authenticated, service_role;

-- Grants and RLS -----------------------------------------------------------

revoke all on table public.dispatch_routes from anon, authenticated;
grant select, insert, update on table public.dispatch_routes to authenticated;
grant all                                                     on table public.dispatch_routes to service_role;

revoke all on table public.route_stops from anon, authenticated;
grant select, insert, update on table public.route_stops to authenticated;
grant all                                                 on table public.route_stops to service_role;

alter table public.dispatch_routes enable row level security;
alter table public.route_stops      enable row level security;

-- dispatch_routes policies -------------------------------------------------

drop policy if exists "dispatch_routes_driver_read"    on public.dispatch_routes;
drop policy if exists "dispatch_routes_manager_read"   on public.dispatch_routes;
drop policy if exists "dispatch_routes_insert"         on public.dispatch_routes;
drop policy if exists "dispatch_routes_manager_update" on public.dispatch_routes;
drop policy if exists "dispatch_routes_service_role"   on public.dispatch_routes;

-- Drivers see only their own routes.
create policy "dispatch_routes_driver_read"
  on public.dispatch_routes
  for select
  to authenticated
  using (
    public.ops_claim_app_role() = 'field_operator'
    and driver_id = auth.uid()
  );

-- Managers and admins see all routes.
create policy "dispatch_routes_manager_read"
  on public.dispatch_routes
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- Managers and admins can insert routes.
create policy "dispatch_routes_insert"
  on public.dispatch_routes
  for insert
  to authenticated
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- Managers and admins can update routes directly.
-- Field operators advance stop state exclusively via the update_route_stop_state RPC
-- (security definer), so no UPDATE policy is needed for the field_operator role.
create policy "dispatch_routes_manager_update"
  on public.dispatch_routes
  for update
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  )
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- service_role has unrestricted access.
create policy "dispatch_routes_service_role"
  on public.dispatch_routes
  for all
  to service_role
  using (true)
  with check (true);

-- route_stops policies -----------------------------------------------------

drop policy if exists "route_stops_driver_read"    on public.route_stops;
drop policy if exists "route_stops_manager_read"   on public.route_stops;
drop policy if exists "route_stops_insert"         on public.route_stops;
drop policy if exists "route_stops_manager_update" on public.route_stops;
drop policy if exists "route_stops_service_role"   on public.route_stops;

-- Drivers can read stops on their own routes.
create policy "route_stops_driver_read"
  on public.route_stops
  for select
  to authenticated
  using (
    public.ops_claim_app_role() = 'field_operator'
    and exists (
      select 1 from public.dispatch_routes r
      where r.id = route_id
        and r.driver_id = auth.uid()
    )
  );

-- Managers and admins can read all stops.
create policy "route_stops_manager_read"
  on public.route_stops
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- Managers and admins can insert stops.
create policy "route_stops_insert"
  on public.route_stops
  for insert
  to authenticated
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- Managers and admins can update stops directly.
-- Field operators advance stop state exclusively via the update_route_stop_state RPC
-- (security definer), so no UPDATE policy is needed for the field_operator role.
create policy "route_stops_manager_update"
  on public.route_stops
  for update
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  )
  with check (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

-- service_role has unrestricted access.
create policy "route_stops_service_role"
  on public.route_stops
  for all
  to service_role
  using (true)
  with check (true);
