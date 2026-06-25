-- Project equipment on-hire / off-hire lifecycle workflow
-- Closes #1486
--
-- Implements the operational lifecycle for project-assigned equipment covering
-- on-order → on-hire → on-site → scheduled-pickup → off-hire → returned, with:
--   1. dim_project_equipment_status           — lifecycle states dimension
--   2. dim_project_equipment_valid_transitions — explicit state-machine edges
--   3. project_equipment_lifecycle_log         — write-once audit timeline
--   4. v_project_equipment_lifecycle_current   — latest status per (project, asset)
--   5. project_equipment_transition()          — validated lifecycle gate + SCD2 update
--   6. Fact type registrations for hire events
--
-- Design notes:
--   * The dimension and transition tables encode the state machine; invalid edges
--     raise a SQL exception rather than silently mutating state.
--   * The log table is write-once (insert-only via RLS); no update/delete policies.
--   * ownership_type (owned / external_rental) is carried on every log row so
--     the project-facing view can distinguish owned vs. re-rented equipment without
--     a separate lifecycle path.
--   * The transition RPC writes a new SCD2 version for the asset entity so
--     project_assignment_status is always current-queryable via
--     rental_current_entity_state.
--   * vendor_ref is masked for field_operator / read_only callers in the view.

-- --------------------------------------------------------------------------
-- 1. Lifecycle states dimension
-- --------------------------------------------------------------------------
create table if not exists public.dim_project_equipment_status (
  id          uuid        primary key default gen_random_uuid(),
  key         text        not null unique,
  label       text        not null,
  description text,
  sort_order  int         not null default 0,
  is_terminal boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create or replace function public.update_dim_project_equipment_status_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_dim_proj_equip_status_updated_at on public.dim_project_equipment_status;
create trigger trg_dim_proj_equip_status_updated_at
  before update on public.dim_project_equipment_status
  for each row execute function public.update_dim_project_equipment_status_updated_at();

insert into public.dim_project_equipment_status (key, label, description, sort_order, is_terminal)
values
  ('on_order',         'On Order',          'Equipment ordered from vendor or procurement; awaiting delivery',           1, false),
  ('on_hire',          'On Hire',           'Hire confirmed; equipment dispatched or delivery accepted; billing active', 2, false),
  ('on_site',          'On Site',           'Equipment physically confirmed on-site and in active project use',          3, false),
  ('scheduled_pickup', 'Scheduled Pickup',  'Collection scheduled; awaiting off-hire confirmation from site',           4, false),
  ('off_hire',         'Off Hire',          'Hire ended; equipment collected from site; billing stopped',                5, false),
  ('returned',         'Returned',          'Equipment physically returned to owning branch or vendor; terminal',        6, true)
on conflict (key) do nothing;

-- --------------------------------------------------------------------------
-- 2. Valid-transition edges (explicit state machine)
-- --------------------------------------------------------------------------
create table if not exists public.dim_project_equipment_valid_transitions (
  from_status text not null references public.dim_project_equipment_status (key),
  to_status   text not null references public.dim_project_equipment_status (key),
  primary key (from_status, to_status)
);

insert into public.dim_project_equipment_valid_transitions (from_status, to_status)
values
  -- on_order → on_hire (delivery confirmed) or off_hire (cancelled before arrival)
  ('on_order',         'on_hire'),
  ('on_order',         'off_hire'),
  -- on_hire → on_site (arrived at project) or off_hire (early collection)
  ('on_hire',          'on_site'),
  ('on_hire',          'off_hire'),
  -- on_site → scheduled_pickup (collection booked) or direct off_hire
  ('on_site',          'scheduled_pickup'),
  ('on_site',          'off_hire'),
  -- scheduled_pickup → on_site (pickup cancelled/delayed) or off_hire (confirmed)
  ('scheduled_pickup', 'on_site'),
  ('scheduled_pickup', 'off_hire'),
  -- off_hire → returned (physical return to branch/vendor)
  ('off_hire',         'returned')
on conflict (from_status, to_status) do nothing;

-- --------------------------------------------------------------------------
-- 3. Audit log: project_equipment_lifecycle_log (write-once)
-- --------------------------------------------------------------------------
create table if not exists public.project_equipment_lifecycle_log (
  id             uuid        primary key default gen_random_uuid(),
  -- Project and asset pair being tracked
  project_id     uuid        not null references public.entities(id) on delete cascade,
  asset_id       uuid        not null references public.entities(id) on delete cascade,
  -- Status key matching dim_project_equipment_status.key
  status_key     text        not null references public.dim_project_equipment_status (key),
  -- Ownership type at point of transition; drives cost-split reporting
  ownership_type text        not null default 'owned'
                             check (ownership_type in ('owned', 'external_rental')),
  -- Vendor / external-hire reference (hire order number, PO, etc.)
  -- Masked to NULL for field_operator / read_only callers in the view
  vendor_ref     text,
  -- Explicit hire-event timestamps for billing-period anchoring
  hired_at       timestamptz,
  off_hired_at   timestamptz,
  -- Actor who triggered the transition
  changed_by     text        not null default 'system',
  -- Human-readable note (dispatch reference, return receipt, etc.)
  notes          text,
  -- Tenant for cross-tenant isolation
  tenant         text        not null default 'default',
  changed_at     timestamptz not null default now()
);

comment on table public.project_equipment_lifecycle_log is
  'Write-once audit timeline of project equipment lifecycle transitions. '
  'Each row records one state change with explicit timestamp, ownership context, '
  'and actor attribution. No updates or deletes.';
comment on column public.project_equipment_lifecycle_log.vendor_ref is
  'External-rental or vendor reference (hire order number, PO, etc.). '
  'Visible to admin and branch_manager roles only; masked for field-facing roles.';

create index if not exists idx_proj_equip_lifecycle_project_asset
  on public.project_equipment_lifecycle_log (project_id, asset_id, changed_at desc);

create index if not exists idx_proj_equip_lifecycle_tenant
  on public.project_equipment_lifecycle_log (tenant);

-- --------------------------------------------------------------------------
-- 4. RLS: project_equipment_lifecycle_log
--    Authenticated callers in the same tenant may select.
--    admin / branch_manager / field_operator may insert new transitions.
--    service_role bypasses all policies for workflow writes.
--    No update or delete policies — the table is append-only.
-- --------------------------------------------------------------------------
alter table public.project_equipment_lifecycle_log enable row level security;

-- Ensure standard roles exist (defensive — mirrors user_roles_profiles migration)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$$;

grant usage  on schema public to authenticated, service_role;
grant select on public.project_equipment_lifecycle_log           to authenticated;
grant all    on public.project_equipment_lifecycle_log           to service_role;
revoke all   on public.project_equipment_lifecycle_log           from anon;

grant select on public.dim_project_equipment_status              to authenticated, anon;
grant select on public.dim_project_equipment_valid_transitions   to authenticated, anon;

drop policy if exists proj_equip_lifecycle_log_tenant_select   on public.project_equipment_lifecycle_log;
drop policy if exists proj_equip_lifecycle_log_operator_insert on public.project_equipment_lifecycle_log;
drop policy if exists proj_equip_lifecycle_log_service_role    on public.project_equipment_lifecycle_log;

-- Any authenticated caller in the same tenant can read log entries
create policy proj_equip_lifecycle_log_tenant_select
  on public.project_equipment_lifecycle_log
  for select
  to authenticated
  using (tenant = public.get_my_tenant());

-- Direct INSERT for authenticated is intentionally omitted.
-- All lifecycle writes must go through project_equipment_transition() (security definer)
-- so the state-machine guards, first-entry rule, terminal-state rule, and SCD2 side
-- effects are always enforced.  service_role retains direct write access for
-- automated workflow operations.

-- Service role bypasses RLS for automated workflow writes
create policy proj_equip_lifecycle_log_service_role
  on public.project_equipment_lifecycle_log
  for all
  to service_role
  using (true)
  with check (true);

-- --------------------------------------------------------------------------
-- 5. View: v_project_equipment_lifecycle_current
--    Most recent lifecycle status per (project_id, asset_id) within the
--    caller's tenant.  vendor_ref masked for field_operator / read_only.
-- --------------------------------------------------------------------------
create or replace view public.v_project_equipment_lifecycle_current
with (security_invoker = true) as
with ranked as (
  select
    log.id,
    log.project_id,
    log.asset_id,
    log.status_key,
    dim.label                             as status_label,
    dim.sort_order                        as status_sort_order,
    dim.is_terminal,
    log.ownership_type,
    -- mask vendor_ref for field_operator and read_only callers
    case
      when public.get_my_role() in ('admin', 'branch_manager') then log.vendor_ref
      else null
    end                                   as vendor_ref,
    log.hired_at,
    log.off_hired_at,
    log.changed_by,
    log.notes,
    log.tenant,
    log.changed_at,
    row_number() over (
      partition by log.project_id, log.asset_id
      order by log.changed_at desc
    ) as rn
  from public.project_equipment_lifecycle_log log
  join public.dim_project_equipment_status dim on dim.key = log.status_key
  where log.tenant = public.get_my_tenant()
)
select
  id,
  project_id,
  asset_id,
  status_key,
  status_label,
  status_sort_order,
  is_terminal,
  ownership_type,
  vendor_ref,
  hired_at,
  off_hired_at,
  changed_by,
  notes,
  tenant,
  changed_at
from ranked
where rn = 1;

comment on view public.v_project_equipment_lifecycle_current is
  'Current project equipment lifecycle status per (project, asset) within the '
  'caller''s tenant. vendor_ref masked to NULL for field_operator and read_only roles.';

grant select on public.v_project_equipment_lifecycle_current to authenticated, service_role;
revoke all   on public.v_project_equipment_lifecycle_current from anon;

-- --------------------------------------------------------------------------
-- 6. RPC: project_equipment_transition
--
--    Validates the state-machine edge using dim_project_equipment_valid_transitions,
--    appends an audit row to project_equipment_lifecycle_log, and writes a new SCD2
--    version for the asset entity so project_assignment_status is current-queryable
--    via rental_current_entity_state.
--
--    On-hire and off-hire transitions populate hired_at / off_hired_at explicitly
--    to anchor billing periods.
--
--    Raises a SQL exception with errcode 23514 for invalid or blocked transitions
--    so callers receive a structured error rather than silent state corruption.
-- --------------------------------------------------------------------------
create or replace function public.project_equipment_transition(
  p_project_id    uuid,
  p_asset_id      uuid,
  p_target_status text,
  p_changed_by    text    default 'system',
  p_notes         text    default null,
  p_vendor_ref    text    default null
)
returns table (
  log_id          uuid,
  transitioned_at timestamptz,
  previous_status text,
  new_status      text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_status   text;
  v_current_data     jsonb;
  v_current_version  int;
  v_ownership_type   text;
  v_hired_at         timestamptz;
  v_off_hired_at     timestamptz;
  v_log_id           uuid;
  v_now              timestamptz := clock_timestamp();
  v_project_tenant   text;
  v_request_role     text;         -- JWT/GUC 'role' (authenticated | service_role | ...)
  v_app_role         public.app_role; -- app_metadata role enum (admin | branch_manager | ...)
  v_caller_tenant    text;
begin
  -- Read caller context using the same dual-path pattern as the write-RPC
  -- hardening migrations: v_request_role for service_role detection (reads the
  -- PostgREST role GUC and JWT), v_app_role for application-level role checks.
  v_request_role  := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  v_app_role      := public.get_my_role();
  v_caller_tenant := nullif(btrim(coalesce(public.get_my_tenant(), '')), '');

  -- ---------- Null checks ----------
  if p_project_id is null then
    raise exception 'project_equipment_transition: p_project_id is required'
      using errcode = '22023';
  end if;
  if p_asset_id is null then
    raise exception 'project_equipment_transition: p_asset_id is required'
      using errcode = '22023';
  end if;
  if p_target_status is null or btrim(p_target_status) = '' then
    raise exception 'project_equipment_transition: p_target_status is required'
      using errcode = '22023';
  end if;

  -- Non-service_role callers must have a resolvable tenant; defaulting to
  -- 'default' here would silently allow cross-tenant access for callers with
  -- a malformed or missing tenant claim.
  if v_request_role <> 'service_role' and v_caller_tenant is null then
    raise exception 'project_equipment_transition: caller tenant could not be resolved; request.jwt.claims must include a tenant'
      using errcode = '42501';
  end if;

  -- Non-service_role callers must hold an authorized application role.
  -- read_only / anon callers are denied; field_operator is permitted to record
  -- on-site arrivals and off-hire confirmations.
  if v_request_role <> 'service_role'
     and v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'project_equipment_transition: role "%" is not authorized to record lifecycle transitions', v_app_role
      using errcode = '42501';
  end if;

  -- ---------- Validate target status exists ----------
  if not exists (
    select 1 from public.dim_project_equipment_status
    where key = btrim(p_target_status)
  ) then
    raise exception 'project_equipment_transition: unknown status "%"', p_target_status
      using errcode = '22023';
  end if;

  -- ---------- Project exists + tenant isolation ----------
  select coalesce(nullif(r.data ->> 'tenant', ''), 'default')
  into   v_project_tenant
  from   public.rental_current_entity_state r
  where  r.entity_id   = p_project_id
    and  r.entity_type = 'project';

  if not found then
    raise exception 'project_equipment_transition: project % not found', p_project_id
      using errcode = '22023';
  end if;

  if v_request_role <> 'service_role'
     and v_project_tenant <> v_caller_tenant then
    raise exception 'project_equipment_transition: cross-tenant access denied'
      using errcode = '42501';
  end if;

  -- ---------- Asset exists ----------
  -- Join entity_versions directly to get the current version_number; avoids a
  -- nested subquery since rental_current_entity_state already filters is_current.
  select coalesce(nullif(r.data ->> 'ownership_type', ''), 'owned'),
         r.data,
         ev.version_number
  into   v_ownership_type, v_current_data, v_current_version
  from   public.rental_current_entity_state r
  join   public.entity_versions ev
           on ev.entity_id  = p_asset_id
          and ev.is_current = true
  where  r.entity_id   = p_asset_id
    and  r.entity_type = 'asset';

  if not found then
    raise exception 'project_equipment_transition: asset % not found', p_asset_id
      using errcode = '22023';
  end if;

  -- Normalise ownership_type to allowed constraint values.
  -- Other values (e.g. 'leased', 'demo_unit') are collapsed to 'owned' because
  -- the project lifecycle only distinguishes owned vs. externally-rented for
  -- cost-split reporting.  Unexpected values are not an error here; the asset
  -- data quality check is the responsibility of the asset upsert path.
  if v_ownership_type not in ('owned', 'external_rental') then
    v_ownership_type := 'owned';
  end if;

  -- ---------- Look up current lifecycle status for this project-asset pair ----------
  select log.status_key
  into   v_current_status
  from   public.project_equipment_lifecycle_log log
  where  log.project_id = p_project_id
    and  log.asset_id   = p_asset_id
    and  log.tenant     = v_project_tenant
  order  by log.changed_at desc
  limit  1;

  -- ---------- Guard: terminal state ----------
  if v_current_status is not null
     and exists (
       select 1 from public.dim_project_equipment_status
       where key = v_current_status and is_terminal
     )
  then
    raise exception
      'project_equipment_transition: status "%" is terminal; no further transitions allowed',
      v_current_status
      using errcode = '23514';
  end if;

  -- ---------- Guard: first transition must be on_order ----------
  -- Equipment can only enter the lifecycle at on_order.  Any other initial
  -- status (e.g. off_hire, returned) would bypass the full audit chain.
  if v_current_status is null and btrim(p_target_status) <> 'on_order' then
    raise exception
      'project_equipment_transition: first lifecycle entry must be "on_order"; got "%"',
      p_target_status
      using errcode = '23514';
  end if;

  -- ---------- Guard: valid state-machine edge ----------
  if v_current_status is not null
     and not exists (
       select 1 from public.dim_project_equipment_valid_transitions
       where from_status = v_current_status
         and to_status   = btrim(p_target_status)
     )
  then
    raise exception
      'project_equipment_transition: transition from "%" to "%" is not allowed',
      v_current_status, p_target_status
      using errcode = '23514';
  end if;

  -- ---------- Derive hire-event timestamps ----------
  -- on_order → off_hire represents cancellation before the equipment was ever
  -- put on hire; hired_at intentionally remains null in that case.
  v_hired_at     := case when btrim(p_target_status) = 'on_hire'  then v_now else null end;
  v_off_hired_at := case when btrim(p_target_status) = 'off_hire' then v_now else null end;

  -- ---------- Write audit log row ----------
  insert into public.project_equipment_lifecycle_log (
    project_id,
    asset_id,
    status_key,
    ownership_type,
    vendor_ref,
    hired_at,
    off_hired_at,
    changed_by,
    notes,
    tenant,
    changed_at
  ) values (
    p_project_id,
    p_asset_id,
    btrim(p_target_status),
    v_ownership_type,
    p_vendor_ref,
    v_hired_at,
    v_off_hired_at,
    coalesce(nullif(btrim(coalesce(p_changed_by, '')), ''), 'system'),
    p_notes,
    v_project_tenant,
    v_now
  )
  returning id into v_log_id;

  -- ---------- Update asset entity via SCD2 ----------
  -- Insert a new version merging the existing data with the updated project
  -- assignment state.  The trg_entity_versions_scd2 trigger automatically
  -- closes the current version.
  -- project_id is intentionally written on every transition for the current
  -- project so rental_current_entity_state always reflects the active assignment.
  -- Cross-project reassignment must be handled by a dedicated reassignment RPC
  -- that first calls this function with off_hire/returned before opening a new
  -- on_order on the target project.
  insert into public.entity_versions (entity_id, version_number, data)
  values (
    p_asset_id,
    coalesce(v_current_version, 0) + 1,
    coalesce(v_current_data, '{}'::jsonb)
      || jsonb_build_object(
           'project_assignment_status', btrim(p_target_status),
           -- entity_versions.data is JSONB; UUIDs are stored as text strings
           -- throughout the codebase (see e.g. rental_contract_line data->>'asset_id').
           'project_id',               p_project_id::text,
           'project_assignment_updated_at', v_now
         )
  );

  -- ---------- Return result ----------
  log_id          := v_log_id;
  transitioned_at := v_now;
  previous_status := v_current_status;
  new_status      := btrim(p_target_status);
  return next;
end;
$$;

comment on function public.project_equipment_transition is
  'Validates a lifecycle transition for a project-assigned asset against the '
  'dim_project_equipment_valid_transitions state machine, appends a write-once '
  'audit row to project_equipment_lifecycle_log, and writes a new SCD2 version '
  'for the asset entity so project_assignment_status is always current in '
  'rental_current_entity_state. Raises an exception (errcode 23514) for invalid '
  'or blocked transitions rather than silently mutating state.';

revoke all    on function public.project_equipment_transition from public, anon;
grant execute on function public.project_equipment_transition to authenticated, service_role;

-- --------------------------------------------------------------------------
-- 7. Fact type registrations for hire lifecycle events
-- --------------------------------------------------------------------------
insert into public.fact_types (key, label, description, unit)
values
  ('project_equipment_on_hire',          'Project Equipment On Hire',          'Equipment put on hire for a project; billing period starts',          'event'),
  ('project_equipment_on_site',          'Project Equipment On Site',          'Equipment physically confirmed on-site at the project',               'event'),
  ('project_equipment_pickup_scheduled', 'Project Equipment Pickup Scheduled', 'Collection of project equipment scheduled; off-hire pending',         'event'),
  ('project_equipment_off_hire',         'Project Equipment Off Hire',         'Equipment taken off hire; billing period ends',                       'event'),
  ('project_equipment_returned',         'Project Equipment Returned',         'Equipment returned to owning branch or vendor after off hire',        'event')
on conflict (key) do nothing;
