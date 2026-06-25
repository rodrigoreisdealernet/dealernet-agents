-- Stop proof-of-delivery / proof-of-collection audit bundles.
--
-- When a route stop is completed, the system packages the captured evidence
-- (signature, photos, timestamps, condition notes) plus the linked rental/asset
-- context into a stop_pod_bundles row.  This provides:
--
--   - A dispute-ready audit record that survives route/stop archival.
--   - A scoped read surface for branch and customer access that exposes only
--     the evidence for the specific stop — no fleet, route, or driver data.
--   - An evidence_status flag: 'complete' when signature + completed_at are
--     both present; 'needs_review' otherwise (agentic assist: incomplete
--     evidence leaves the bundle under review rather than auto-closing it).
--
-- update_route_stop_state (from 20260609130000) is extended here to upsert a
-- stop_pod_bundles row when a stop transitions to 'completed'.
--
-- Operating-model tasks covered:
--   field-delivery-driver:t3 — delivery capture (signature, photos, condition)
--   field-delivery-driver:t4 — pickup capture (condition, damage, missing items)
--   field-delivery-driver:t6 — proof-of-delivery/collection digital record sync

-- ── stop_pod_bundles ─────────────────────────────────────────────────────────

create table if not exists public.stop_pod_bundles (
  id                uuid        primary key default gen_random_uuid(),
  stop_id           uuid        not null references public.route_stops(id) on delete cascade,
  stop_type         text        not null,
  customer_name     text,
  job_site_name     text,
  address           text,
  contract_line_id  uuid,
  asset_id          text,
  signature         text,
  condition_notes   text,
  photo_paths       text[]      not null default '{}',
  completed_at      timestamptz,
  evidence_status   text        not null default 'needs_review',
  -- driver_id is used only for RLS scoping (field_operator sees own stops) and
  -- audit trail integrity; it is intentionally excluded from the get_stop_pod
  -- read surface so no driver identity is exposed to branch/customer callers.
  driver_id         uuid        not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint stop_pod_bundles_stop_type_chk
    check (stop_type in ('delivery', 'pickup')),
  constraint stop_pod_bundles_evidence_status_chk
    check (evidence_status in ('complete', 'needs_review'))
);

-- One bundle per stop (unique on stop_id — upsert safe).
create unique index if not exists idx_stop_pod_bundles_stop_id
  on public.stop_pod_bundles (stop_id);

create index if not exists idx_stop_pod_bundles_driver
  on public.stop_pod_bundles (driver_id);

create index if not exists idx_stop_pod_bundles_created
  on public.stop_pod_bundles (created_at);

create trigger trg_stop_pod_bundles_updated_at
  before update on public.stop_pod_bundles
  for each row execute function update_updated_at();

-- ── Grants ────────────────────────────────────────────────────────────────────
--
-- Authenticated users read bundles via get_stop_pod (security definer).
-- Direct INSERT/UPDATE is not granted so the evidence_status invariant
-- (complete ⟺ signature + completed_at present) can only be set by the RPC.

grant select on public.stop_pod_bundles to authenticated;
grant all    on public.stop_pod_bundles to service_role;

-- ── Row-level security ────────────────────────────────────────────────────────

alter table public.stop_pod_bundles enable row level security;

drop policy if exists "pod_driver_read"   on public.stop_pod_bundles;
drop policy if exists "pod_manager_read"  on public.stop_pod_bundles;
drop policy if exists "pod_service_role"  on public.stop_pod_bundles;

-- Field operators see only bundles for their own completed stops.
create policy "pod_driver_read"
  on public.stop_pod_bundles
  for select
  to authenticated
  using (
    public.ops_claim_app_role() = 'field_operator'
    and driver_id = auth.uid()
  );

-- Branch managers and admins see all bundles (branch record read surface).
create policy "pod_manager_read"
  on public.stop_pod_bundles
  for select
  to authenticated
  using (
    public.ops_claim_app_role() in ('admin', 'branch_manager')
  );

create policy "pod_service_role"
  on public.stop_pod_bundles
  for all
  to service_role
  using (true)
  with check (true);

-- ── get_stop_pod RPC ──────────────────────────────────────────────────────────
--
-- Returns the evidence bundle for a single completed stop, scoped to evidence
-- fields only.  No fleet, route, or driver identity data is returned.
-- Access control mirrors the RLS policies above.

create or replace function public.get_stop_pod(p_stop_id uuid)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_role  text;
  v_uid       uuid;
  v_bundle    record;
begin
  v_app_role := public.ops_claim_app_role();

  if v_app_role not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'get_stop_pod requires field_operator or higher role'
      using errcode = '42501';
  end if;

  -- For field_operator callers resolve the caller uid upfront so the SELECT
  -- below can scope by driver_id.  This ensures a cross-driver stop and a
  -- nonexistent stop are indistinguishable — both produce a null return rather
  -- than leaking stop existence through a distinct error path.
  if v_app_role = 'field_operator' then
    v_uid := auth.uid();
  end if;

  select
    b.stop_id,
    b.stop_type,
    b.customer_name,
    b.job_site_name,
    b.address,
    b.contract_line_id,
    b.asset_id,
    b.signature,
    b.condition_notes,
    b.photo_paths,
    b.completed_at,
    b.evidence_status
  into v_bundle
  from public.stop_pod_bundles b
  where b.stop_id = p_stop_id
    and (v_app_role <> 'field_operator' or b.driver_id = v_uid);

  if not found then
    return null;
  end if;

  -- Return only evidence fields; fleet/route/driver identity are not exposed.
  return json_build_object(
    'stop_id',          v_bundle.stop_id,
    'stop_type',        v_bundle.stop_type,
    'customer_name',    v_bundle.customer_name,
    'job_site_name',    v_bundle.job_site_name,
    'address',          v_bundle.address,
    'contract_line_id', v_bundle.contract_line_id,
    'asset_id',         v_bundle.asset_id,
    'signature',        v_bundle.signature,
    'condition_notes',  v_bundle.condition_notes,
    'photo_paths',      v_bundle.photo_paths,
    'completed_at',     v_bundle.completed_at,
    'evidence_status',  v_bundle.evidence_status
  );
end;
$$;

grant execute on function public.get_stop_pod(uuid)
  to authenticated, service_role;

-- ── Extend update_route_stop_state to write the POD bundle on completion ──────
--
-- Replaces the function from 20260609130000_driver_dispatch_execution.sql.
-- The only addition is the upsert into stop_pod_bundles when p_status is
-- 'completed'.  All existing logic, arguments, and return shape are preserved.

create or replace function public.update_route_stop_state(
  p_stop_id         uuid,
  p_status          text,
  p_signature       text    default null,
  p_condition_notes text    default null,
  p_photo_paths     text[]  default null
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
  v_ev_status   text;
  v_final_photos text[];
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

  -- For field_operator callers resolve the caller uid upfront so the SELECT
  -- below can scope by driver_id.  A cross-driver stop then produces the same
  -- "not found" result as a genuinely missing stop, eliminating the existence
  -- oracle that would otherwise leak cross-driver route-stop ids.
  if v_app_role = 'field_operator' then
    v_driver_id := auth.uid();
  end if;

  -- Load stop + parent route in one query.
  select
    s.id,
    s.route_id,
    s.stop_type,
    s.status          as current_status,
    s.signature,
    s.condition_notes,
    s.photo_paths,
    s.customer_name,
    s.job_site_name,
    s.address,
    s.contract_line_id,
    s.asset_id,
    r.driver_id,
    r.status          as route_status
  into v_stop
  from public.route_stops s
  join public.dispatch_routes r on r.id = s.route_id
  where s.id = p_stop_id
    and (v_app_role <> 'field_operator' or r.driver_id = v_driver_id);

  if not found then
    raise exception 'Route stop % not found', p_stop_id
      using errcode = '02000';
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

    -- Compute evidence completeness.
    -- A bundle is 'complete' when the driver provided a signature; otherwise
    -- it is left as 'needs_review' so the branch can follow up.
    v_ev_status := case
      when coalesce(p_signature, v_stop.signature) is not null
        then 'complete'
      else 'needs_review'
    end;

    -- Resolve the final photo_paths array for the bundle.
    -- (matches what update wrote above)
    v_final_photos := case
      when p_photo_paths is not null
        then array_cat(v_stop.photo_paths, p_photo_paths)
      else v_stop.photo_paths
    end;

    -- Upsert the POD bundle; safe to call multiple times (idempotent on stop_id).
      insert into public.stop_pod_bundles (
        stop_id,
        stop_type,
        customer_name,
        job_site_name,
        address,
        contract_line_id,
        asset_id,
        signature,
        condition_notes,
        photo_paths,
        completed_at,
        evidence_status,
        driver_id
      ) values (
        p_stop_id,
        v_stop.stop_type,
        v_stop.customer_name,
        v_stop.job_site_name,
        v_stop.address,
        v_stop.contract_line_id,
        v_stop.asset_id,
        coalesce(p_signature, v_stop.signature),
        coalesce(p_condition_notes, v_stop.condition_notes),
        v_final_photos,
        v_now,
        v_ev_status,
        v_stop.driver_id
      )
      on conflict (stop_id) do update
        set
          signature       = excluded.signature,
          condition_notes = excluded.condition_notes,
          photo_paths     = excluded.photo_paths,
          completed_at    = excluded.completed_at,
          evidence_status = excluded.evidence_status,
          updated_at      = v_now;
  end if;

  return json_build_object(
    'stop_id',          p_stop_id,
    'status',           p_status,
    'updated_at',       v_now
  );
end;
$$;

grant execute on function public.update_route_stop_state(uuid, text, text, text, text[])
  to authenticated, service_role;
