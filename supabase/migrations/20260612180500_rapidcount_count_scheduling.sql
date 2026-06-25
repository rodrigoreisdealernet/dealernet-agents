-- RapidCount count scheduling and branch assignments.
--
-- Implements:
--   * Count task creation scoped to a branch/location with assignee, due date,
--     count type, and ad hoc vs recurring scheduling metadata.
--   * Controlled task-state transitions across planned → in_progress →
--     submitted → approved / closed.
--   * Explicit audit history recorded as append-only time-series events.
--   * Branch progress and overdue-task projections for the frontend.

insert into fact_types (key, label, description, unit)
values (
  'rapidcount_count_task_audit_event',
  'RapidCount Count Task Audit Event',
  'Append-only audit trail for RapidCount count scheduling and task-state changes',
  'event'
)
on conflict (key) do nothing;

create unique index if not exists uq_relationships_current_branch_has_count_task
  on public.relationships_v2 (child_id)
  where relationship_type = 'branch_has_count_task'
    and is_current;

drop function if exists public.rapidcount_append_count_task_audit_event(uuid, int, text, text, text, text, uuid, text);

create function public.rapidcount_append_count_task_audit_event(
  p_count_task_id uuid,
  p_version_number int,
  p_event_type text,
  p_previous_status text,
  p_status text,
  p_note text,
  p_actor_id uuid,
  p_actor_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fact_type_id uuid;
begin
  select id
    into v_fact_type_id
  from public.fact_types
  where key = 'rapidcount_count_task_audit_event'
  limit 1;

  if v_fact_type_id is null then
    raise exception 'Missing fact type rapidcount_count_task_audit_event'
      using errcode = '22023';
  end if;

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
        'event_type', p_event_type,
        'previous_status', p_previous_status,
        'status', p_status,
        'note', nullif(btrim(coalesce(p_note, '')), ''),
        'actor_id', p_actor_id,
        'actor_name', nullif(btrim(coalesce(p_actor_name, '')), ''),
        'version_number', p_version_number
      )
    ),
    format('rapidcount:%s:%s', p_count_task_id, p_version_number),
    '{}'::jsonb
  );
end;
$$;

drop function if exists public.rapidcount_create_count_task(text, uuid, text, date, text, text, text, text, text);

create function public.rapidcount_create_count_task(
  p_name text,
  p_branch_id uuid,
  p_assignee_name text,
  p_due_date date,
  p_count_type text,
  p_location_name text default null,
  p_schedule_type text default 'ad_hoc',
  p_recurrence_pattern text default null,
  p_description text default null
)
returns table (
  count_task_id uuid,
  entity_version_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_actor_id uuid;
  v_actor_name text;
  v_count_task_id uuid;
  v_entity_version_id uuid;
  v_version_number int;
  v_schedule_type text;
  v_count_type text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'rapidcount_create_count_task requires branch-manager write access'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'Count task name is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_assignee_name, '')), '') is null then
    raise exception 'Count task assignee is required'
      using errcode = '22023';
  end if;

  if p_due_date is null then
    raise exception 'Count task due date is required'
      using errcode = '22023';
  end if;

  if p_branch_id is null or not exists (
    select 1
    from public.entities
    where id = p_branch_id
      and entity_type = 'branch'
  ) then
    raise exception 'Count task branch % was not found', p_branch_id
      using errcode = '22023';
  end if;

  v_schedule_type := lower(coalesce(nullif(btrim(coalesce(p_schedule_type, '')), ''), 'ad_hoc'));
  if v_schedule_type not in ('ad_hoc', 'recurring') then
    raise exception 'Unsupported count-task schedule_type "%"', v_schedule_type
      using errcode = '22023';
  end if;

  if v_schedule_type = 'recurring'
     and nullif(btrim(coalesce(p_recurrence_pattern, '')), '') is null then
    raise exception 'Recurring count tasks require a recurrence pattern'
      using errcode = '22023';
  end if;

  v_count_type := lower(coalesce(nullif(btrim(coalesce(p_count_type, '')), ''), ''));
  if v_count_type not in ('full_branch', 'cycle_count', 'spot_check', 'location_recount') then
    raise exception 'Unsupported count-task count_type "%"', v_count_type
      using errcode = '22023';
  end if;

  v_actor_id := auth.uid();
  v_actor_name := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'display_name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    case when v_request_role = 'service_role' then 'service_role' else null end,
    v_actor_id::text
  );

  insert into public.entities (entity_type)
  values ('count_task')
  returning id into v_count_task_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_count_task_id,
    1,
    jsonb_strip_nulls(
      jsonb_build_object(
        'name', btrim(p_name),
        'description', nullif(btrim(coalesce(p_description, '')), ''),
        'status', 'planned',
        'branch_id', p_branch_id,
        'location_name', nullif(btrim(coalesce(p_location_name, '')), ''),
        'assignee_name', btrim(p_assignee_name),
        'due_date', p_due_date,
        'count_type', v_count_type,
        'schedule_type', v_schedule_type,
        'recurrence_pattern', case when v_schedule_type = 'recurring' then nullif(btrim(coalesce(p_recurrence_pattern, '')), '') else null end,
        'created_by', v_actor_name,
        'updated_by', v_actor_name
      )
    )
  )
  returning id, entity_versions.version_number
  into v_entity_version_id, v_version_number;

  insert into public.relationships_v2 (
    relationship_type,
    parent_id,
    child_id,
    metadata
  )
  values (
    'branch_has_count_task',
    p_branch_id,
    v_count_task_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'location_name', nullif(btrim(coalesce(p_location_name, '')), '')
      )
    )
  );

  perform public.rapidcount_append_count_task_audit_event(
    v_count_task_id,
    v_version_number,
    'created',
    null,
    'planned',
    'Count task created',
    v_actor_id,
    v_actor_name
  );

  count_task_id := v_count_task_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

drop function if exists public.rapidcount_transition_count_task(uuid, text, text);

create function public.rapidcount_transition_count_task(
  p_count_task_id uuid,
  p_status text,
  p_note text default null
)
returns table (
  count_task_id uuid,
  entity_version_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_actor_id uuid;
  v_actor_name text;
  v_current_version record;
  v_current_status text;
  v_next_status text;
  v_next_data jsonb;
  v_entity_version_id uuid;
  v_version_number int;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'rapidcount_transition_count_task requires branch-manager write access'
      using errcode = '42501';
  end if;

  v_next_status := lower(coalesce(nullif(btrim(coalesce(p_status, '')), ''), ''));
  if v_next_status not in ('planned', 'in_progress', 'submitted', 'approved', 'closed') then
    raise exception 'Unsupported count-task status "%"', v_next_status
      using errcode = '22023';
  end if;

  select
    entity_versions.entity_id,
    entity_versions.version_number,
    entity_versions.data
    into v_current_version
  from public.entity_versions
  join public.entities
    on entities.id = entity_versions.entity_id
  where entities.id = p_count_task_id
    and entities.entity_type = 'count_task'
    and entity_versions.is_current
  limit 1;

  if not found then
    raise exception 'Count task % was not found', p_count_task_id
      using errcode = '22023';
  end if;

  v_current_status := lower(coalesce(nullif(v_current_version.data ->> 'status', ''), 'planned'));

  if v_next_status = v_current_status then
    raise exception 'Count task % is already %', p_count_task_id, v_next_status
      using errcode = '22023';
  end if;

  if v_current_status in ('approved', 'closed') then
    raise exception 'Count task % is already completed and cannot transition from %', p_count_task_id, v_current_status
      using errcode = '22023';
  end if;

  if not (
    (v_current_status = 'planned' and v_next_status in ('in_progress', 'submitted', 'closed'))
    or (v_current_status = 'in_progress' and v_next_status in ('planned', 'submitted', 'closed'))
    or (v_current_status = 'submitted' and v_next_status in ('in_progress', 'approved', 'closed'))
  ) then
    raise exception 'Count task transition % -> % is not allowed', v_current_status, v_next_status
      using errcode = '22023';
  end if;

  v_actor_id := auth.uid();
  v_actor_name := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'display_name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    case when v_request_role = 'service_role' then 'service_role' else null end,
    v_actor_id::text
  );

  v_next_data := v_current_version.data
    || jsonb_strip_nulls(
      jsonb_build_object(
        'status', v_next_status,
        'updated_by', v_actor_name,
        'last_transition_note', nullif(btrim(coalesce(p_note, '')), ''),
        'closed_at', case when v_next_status in ('approved', 'closed') then now() else null end
      )
    );

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    p_count_task_id,
    v_current_version.version_number + 1,
    v_next_data
  )
  returning id, entity_versions.version_number
  into v_entity_version_id, v_version_number;

  perform public.rapidcount_append_count_task_audit_event(
    p_count_task_id,
    v_version_number,
    'status_changed',
    v_current_status,
    v_next_status,
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), format('Status changed from %s to %s', v_current_status, v_next_status)),
    v_actor_id,
    v_actor_name
  );

  count_task_id := p_count_task_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

create or replace view public.rapidcount_count_tasks_current
with (security_invoker = true) as
with current_tasks as (
  select
    entities.id as count_task_id,
    entity_versions.id as entity_version_id,
    entity_versions.version_number,
    entity_versions.valid_from as updated_at,
    entity_versions.data
  from public.entities
  join public.entity_versions
    on entity_versions.entity_id = entities.id
  where entities.entity_type = 'count_task'
    and entity_versions.is_current
),
current_branch_assignments as (
  select
    relationships_v2.child_id as count_task_id,
    relationships_v2.parent_id as branch_id
  from public.relationships_v2
  where relationships_v2.is_current
    and relationships_v2.relationship_type = 'branch_has_count_task'
)
select
  current_tasks.count_task_id,
  current_tasks.entity_version_id,
  current_tasks.version_number,
  coalesce(nullif(current_tasks.data ->> 'name', ''), 'Untitled Count Task') as task_name,
  nullif(current_tasks.data ->> 'description', '') as description,
  coalesce(nullif(current_tasks.data ->> 'status', ''), 'planned') as status,
  current_branch_assignments.branch_id,
  rental_current_branches.name as branch_name,
  nullif(current_tasks.data ->> 'location_name', '') as location_name,
  nullif(current_tasks.data ->> 'assignee_name', '') as assignee_name,
  nullif(current_tasks.data ->> 'due_date', '')::date as due_date,
  nullif(current_tasks.data ->> 'count_type', '') as count_type,
  coalesce(nullif(current_tasks.data ->> 'schedule_type', ''), 'ad_hoc') as schedule_type,
  nullif(current_tasks.data ->> 'recurrence_pattern', '') as recurrence_pattern,
  nullif(current_tasks.data ->> 'updated_by', '') as updated_by,
  current_tasks.updated_at,
  coalesce(
    (
      nullif(current_tasks.data ->> 'due_date', '')::date < current_date
      and coalesce(nullif(current_tasks.data ->> 'status', ''), 'planned') not in ('approved', 'closed')
    ),
    false
  ) as is_overdue
from current_tasks
left join current_branch_assignments
  on current_branch_assignments.count_task_id = current_tasks.count_task_id
left join public.rental_current_branches
  on rental_current_branches.entity_id = current_branch_assignments.branch_id;

create or replace view public.rapidcount_count_branch_progress
with (security_invoker = true) as
select
  branch_id,
  branch_name,
  count(*) as total_tasks,
  count(*) filter (where status = 'planned') as planned_tasks,
  count(*) filter (where status = 'in_progress') as in_progress_tasks,
  count(*) filter (where status = 'submitted') as submitted_tasks,
  count(*) filter (where status = 'approved') as approved_tasks,
  count(*) filter (where status = 'closed') as closed_tasks,
  count(*) filter (where status in ('approved', 'closed')) as completed_tasks,
  count(*) filter (where is_overdue) as overdue_tasks,
  round(
    (
      count(*) filter (where status in ('approved', 'closed'))::numeric
      / nullif(count(*)::numeric, 0)
    ) * 100,
    1
  ) as completion_pct
from public.rapidcount_count_tasks_current
group by branch_id, branch_name;

create or replace view public.rapidcount_count_task_audit_history
with (security_invoker = true) as
select
  time_series_points.id as audit_event_id,
  time_series_points.entity_id as count_task_id,
  time_series_points.observed_at,
  time_series_points.data_payload ->> 'event_type' as event_type,
  time_series_points.data_payload ->> 'previous_status' as previous_status,
  time_series_points.data_payload ->> 'status' as status,
  time_series_points.data_payload ->> 'note' as note,
  time_series_points.data_payload ->> 'actor_name' as actor_name,
  time_series_points.data_payload ->> 'actor_id' as actor_id,
  (time_series_points.data_payload ->> 'version_number')::int as version_number
from public.time_series_points
join public.fact_types
  on fact_types.id = time_series_points.fact_type_id
where fact_types.key = 'rapidcount_count_task_audit_event';

grant select on table public.rapidcount_count_tasks_current to authenticated, service_role;
grant select on table public.rapidcount_count_branch_progress to authenticated, service_role;
grant select on table public.rapidcount_count_task_audit_history to authenticated, service_role;

revoke all on function public.rapidcount_append_count_task_audit_event(uuid, int, text, text, text, text, uuid, text)
  from public;
grant execute on function public.rapidcount_append_count_task_audit_event(uuid, int, text, text, text, text, uuid, text)
  to service_role;

revoke all on function public.rapidcount_create_count_task(text, uuid, text, date, text, text, text, text, text)
  from public;
grant execute on function public.rapidcount_create_count_task(text, uuid, text, date, text, text, text, text, text)
  to authenticated, service_role;

revoke all on function public.rapidcount_transition_count_task(uuid, text, text)
  from public;
grant execute on function public.rapidcount_transition_count_task(uuid, text, text)
  to authenticated, service_role;
