-- RapidCount mobile count capture.
-- Note: originally authored as 20260613020000 but renamed to 20260613021000
-- to resolve a duplicate primary-key collision with
-- 20260613020000_procurement_receiving_po_match_warranty.sql (incident #1434).
--
-- Implements:
--   * Count capture line recording via time_series_points with per-fact-type
--     idempotency using a stable client-generated idempotency key (source_id).
--   * Field-operator start permission: counters can transition planned →
--     in_progress for tasks where they are the named assignee.
--   * Offline queue table for durable command staging and replay.
--   * Count-lines view for reporting captured items per task.

-- ---------------------------------------------------------------------------
-- 1. Fact type for captured count lines.
-- ---------------------------------------------------------------------------

insert into fact_types (key, label, description, unit)
values (
  'rapidcount_count_capture_line',
  'RapidCount Count Capture Line',
  'A single item captured during a RapidCount count task (barcode, RFID, or manual)',
  'line'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Partial unique index enforcing idempotency per capture line.
--    source_id is the client-generated idempotency key.
-- ---------------------------------------------------------------------------

do $$
declare
  v_fact_type_id uuid;
begin
  select id into v_fact_type_id
  from public.fact_types
  where key = 'rapidcount_count_capture_line'
  limit 1;

  if v_fact_type_id is null then
    raise exception 'Missing fact type rapidcount_count_capture_line';
  end if;

  execute format(
    'create unique index if not exists uq_tsp_rapidcount_capture_line_source
       on public.time_series_points (entity_id, source_id)
       where fact_type_id = %L and source_id is not null',
    v_fact_type_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Offline capture command queue.
--    Staged by the mobile client when connectivity is absent; replayed on
--    reconnect. The authoritative write still goes through the backend RPC
--    on replay so no client can bypass auth or validation.
-- ---------------------------------------------------------------------------

create table if not exists public.rapidcount_offline_queue (
  id                uuid        not null default gen_random_uuid() primary key,
  count_task_id     uuid        not null,
  idempotency_key   text        not null,
  scan_value        text        not null,
  scan_method       text        not null,
  quantity          int         not null default 1,
  item_description  text,
  actor_id          uuid,
  actor_name        text,
  staged_at         timestamptz not null default now(),
  replayed_at       timestamptz,
  replay_status     text        not null default 'pending',
  replay_error      text,
  constraint chk_offline_queue_scan_method
    check (scan_method in ('barcode', 'rfid', 'manual')),
  constraint chk_offline_queue_quantity
    check (quantity >= 0),
  constraint chk_offline_queue_replay_status
    check (replay_status in ('pending', 'replayed', 'failed'))
);

create unique index if not exists uq_offline_queue_idempotency_key
  on public.rapidcount_offline_queue (idempotency_key);

comment on table public.rapidcount_offline_queue is
  'Durable mobile offline capture queue; entries are staged offline and replayed when connectivity returns.';

-- ---------------------------------------------------------------------------
-- 4. RPC: rapidcount_start_count_task
--    Allows field operators to transition their own assigned tasks from
--    planned → in_progress. Admins and branch managers may start any task.
--    Idempotent: returns current version if already in_progress.
-- ---------------------------------------------------------------------------

drop function if exists public.rapidcount_start_count_task(uuid);

create function public.rapidcount_start_count_task(p_count_task_id uuid)
returns table (
  count_task_id     uuid,
  entity_version_id uuid,
  version_number    int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role    text;
  v_actor_id        uuid;
  v_actor_name      text;
  v_current_ev_id   uuid;
  v_current_vnum    int;
  v_current_data    jsonb;
  v_current_status  text;
  v_assignee_name   text;
  v_new_ev_id       uuid;
  v_new_vnum        int;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if v_request_role not in ('service_role', 'authenticated') then
    raise exception 'rapidcount_start_count_task requires authentication'
      using errcode = '42501';
  end if;

  if v_request_role = 'authenticated'
     and public.get_my_role() not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'rapidcount_start_count_task requires at least field-operator access'
      using errcode = '42501';
  end if;

  v_actor_id := auth.uid();
  v_actor_name := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'display_name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    case when v_request_role = 'service_role' then 'service_role' else null end,
    v_actor_id::text
  );

  select
    ev.id,
    ev.version_number,
    ev.data
    into v_current_ev_id, v_current_vnum, v_current_data
  from public.entity_versions ev
  join public.entities e on e.id = ev.entity_id
  where e.id = p_count_task_id
    and e.entity_type = 'count_task'
    and ev.is_current
  limit 1;

  if not found then
    raise exception 'Count task % was not found', p_count_task_id
      using errcode = '22023';
  end if;

  v_current_status := lower(coalesce(nullif(v_current_data ->> 'status', ''), 'planned'));

  -- Idempotent: already in_progress.
  if v_current_status = 'in_progress' then
    count_task_id     := p_count_task_id;
    entity_version_id := v_current_ev_id;
    version_number    := v_current_vnum;
    return next;
    return;
  end if;

  if v_current_status <> 'planned' then
    raise exception 'Count task % cannot be started from status %', p_count_task_id, v_current_status
      using errcode = '22023';
  end if;

  -- Field operators may only start tasks where they are the named assignee.
  if v_request_role = 'authenticated'
     and public.get_my_role() = 'field_operator' then
    v_assignee_name := nullif(btrim(coalesce(v_current_data ->> 'assignee_name', '')), '');
    if v_assignee_name is null
       or lower(v_assignee_name) <> lower(coalesce(v_actor_name, '')) then
      raise exception 'Count task % is not assigned to you (assigned to "%")', p_count_task_id, v_assignee_name
        using errcode = '42501';
    end if;
  end if;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    p_count_task_id,
    v_current_vnum + 1,
    v_current_data || jsonb_build_object(
      'status',     'in_progress',
      'updated_by', v_actor_name,
      'started_at', now()
    )
  )
  returning id, entity_versions.version_number
  into v_new_ev_id, v_new_vnum;

  perform public.rapidcount_append_count_task_audit_event(
    p_count_task_id,
    v_new_vnum,
    'status_changed',
    'planned',
    'in_progress',
    'Count task started',
    v_actor_id,
    v_actor_name
  );

  count_task_id     := p_count_task_id;
  entity_version_id := v_new_ev_id;
  version_number    := v_new_vnum;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC: rapidcount_capture_count_line
--    Records a single scanned/entered item on an active count task.
--    Idempotent via (entity_id, source_id) unique index — safe to replay.
-- ---------------------------------------------------------------------------

drop function if exists public.rapidcount_capture_count_line(uuid, text, text, text, int, text);

create function public.rapidcount_capture_count_line(
  p_count_task_id   uuid,
  p_idempotency_key text,
  p_scan_value      text,
  p_scan_method     text,
  p_quantity        int     default 1,
  p_item_description text   default null
)
returns table (
  line_id     uuid,
  captured_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role  text;
  v_actor_id      uuid;
  v_actor_name    text;
  v_fact_type_id  uuid;
  v_current_data  jsonb;
  v_current_status text;
  v_scan_method   text;
  v_idem_key      text;
  v_line_id       uuid;
  v_captured_at   timestamptz;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if v_request_role not in ('service_role', 'authenticated') then
    raise exception 'rapidcount_capture_count_line requires authentication'
      using errcode = '42501';
  end if;

  if v_request_role = 'authenticated'
     and public.get_my_role() not in ('admin', 'branch_manager', 'field_operator') then
    raise exception 'rapidcount_capture_count_line requires at least field-operator access'
      using errcode = '42501';
  end if;

  v_idem_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_idem_key is null then
    raise exception 'idempotency_key is required for count capture'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_scan_value, '')), '') is null then
    raise exception 'scan_value is required for count capture'
      using errcode = '22023';
  end if;

  v_scan_method := lower(coalesce(nullif(btrim(coalesce(p_scan_method, '')), ''), ''));
  if v_scan_method not in ('barcode', 'rfid', 'manual') then
    raise exception 'Unsupported scan_method "%"', v_scan_method
      using errcode = '22023';
  end if;

  if coalesce(p_quantity, 0) < 0 then
    raise exception 'quantity must be non-negative'
      using errcode = '22023';
  end if;

  -- Validate the count task exists and is in a capturable state.
  select ev.data ->> 'status'
    into v_current_status
  from public.entity_versions ev
  join public.entities e on e.id = ev.entity_id
  where e.id = p_count_task_id
    and e.entity_type = 'count_task'
    and ev.is_current
  limit 1;

  if not found then
    raise exception 'Count task % was not found', p_count_task_id
      using errcode = '22023';
  end if;

  if lower(coalesce(v_current_status, '')) not in ('in_progress', 'planned') then
    raise exception 'Count task % is % and cannot accept new captures', p_count_task_id, v_current_status
      using errcode = '22023';
  end if;

  v_actor_id := auth.uid();
  v_actor_name := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'display_name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    case when v_request_role = 'service_role' then 'service_role' else null end,
    v_actor_id::text
  );

  select id into v_fact_type_id
  from public.fact_types
  where key = 'rapidcount_count_capture_line'
  limit 1;

  if v_fact_type_id is null then
    raise exception 'Missing fact type rapidcount_count_capture_line'
      using errcode = '22023';
  end if;

  -- Idempotent insert: on conflict with the partial unique index, skip.
  insert into public.time_series_points (
    entity_id,
    fact_type_id,
    observed_at,
    data_payload,
    source_id,
    metadata
  )
  values (
    p_count_task_id,
    v_fact_type_id,
    now(),
    jsonb_strip_nulls(
      jsonb_build_object(
        'scan_value',        btrim(p_scan_value),
        'scan_method',       v_scan_method,
        'quantity',          coalesce(p_quantity, 1),
        'item_description',  nullif(btrim(coalesce(p_item_description, '')), ''),
        'captured_by',       v_actor_name,
        'actor_id',          v_actor_id
      )
    ),
    v_idem_key,
    '{}'::jsonb
  )
  on conflict do nothing;

  -- Fetch the row (whether just inserted or pre-existing via idempotency).
  select tsp.id, tsp.observed_at
    into v_line_id, v_captured_at
  from public.time_series_points tsp
  where tsp.entity_id = p_count_task_id
    and tsp.fact_type_id = v_fact_type_id
    and tsp.source_id = v_idem_key
  limit 1;

  line_id     := v_line_id;
  captured_at := v_captured_at;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. View: rapidcount_count_lines_current
--    All captured lines per count task for the mobile capture screen.
-- ---------------------------------------------------------------------------

create or replace view public.rapidcount_count_lines_current
with (security_invoker = true) as
select
  tsp.id                                    as line_id,
  tsp.entity_id                             as count_task_id,
  tsp.observed_at                           as captured_at,
  tsp.data_payload ->> 'scan_value'         as scan_value,
  tsp.data_payload ->> 'scan_method'        as scan_method,
  (tsp.data_payload ->> 'quantity')::int    as quantity,
  tsp.data_payload ->> 'item_description'   as item_description,
  tsp.data_payload ->> 'captured_by'        as captured_by,
  tsp.source_id                             as idempotency_key
from public.time_series_points tsp
join public.fact_types ft on ft.id = tsp.fact_type_id
where ft.key = 'rapidcount_count_capture_line';

-- ---------------------------------------------------------------------------
-- 7. Grants and RLS for rapidcount_offline_queue.
-- ---------------------------------------------------------------------------

grant select on table public.rapidcount_count_lines_current to authenticated, service_role;

revoke all on table public.rapidcount_offline_queue from anon, authenticated;
grant select, insert, update on table public.rapidcount_offline_queue to authenticated;
grant all                                                               on table public.rapidcount_offline_queue to service_role;

alter table public.rapidcount_offline_queue enable row level security;

-- Authenticated users may read only their own staged entries.
drop policy if exists "offline_queue_owner_select" on public.rapidcount_offline_queue;
create policy "offline_queue_owner_select"
  on public.rapidcount_offline_queue
  for select
  to authenticated
  using (actor_id = auth.uid());

-- Authenticated users may stage entries only for themselves.
drop policy if exists "offline_queue_owner_insert" on public.rapidcount_offline_queue;
create policy "offline_queue_owner_insert"
  on public.rapidcount_offline_queue
  for insert
  to authenticated
  with check (actor_id = auth.uid());

-- Authenticated users may update only their own staged entries.
drop policy if exists "offline_queue_owner_update" on public.rapidcount_offline_queue;
create policy "offline_queue_owner_update"
  on public.rapidcount_offline_queue
  for update
  to authenticated
  using (actor_id = auth.uid())
  with check (actor_id = auth.uid());

-- service_role has unrestricted access for backend replay and admin operations.
drop policy if exists "offline_queue_service_role" on public.rapidcount_offline_queue;
create policy "offline_queue_service_role"
  on public.rapidcount_offline_queue
  for all
  to service_role
  using (true)
  with check (true);

revoke all on function public.rapidcount_start_count_task(uuid) from public;
grant execute on function public.rapidcount_start_count_task(uuid)
  to authenticated, service_role;

revoke all on function public.rapidcount_capture_count_line(uuid, text, text, text, int, text) from public;
grant execute on function public.rapidcount_capture_count_line(uuid, text, text, text, int, text)
  to authenticated, service_role;
