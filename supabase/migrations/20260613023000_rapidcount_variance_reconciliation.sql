-- RapidCount variance review and reconciliation posting.
--
-- Implements:
--   * Submitted count sessions with captured inventory quantities compared against
--     current system-of-record inventory for serialized and non-serialized items.
--   * Reviewer decisions (approve / reject / recount) with explicit reason capture
--     and append-only audit trail updates.
--   * Approved reconciliation posting through authenticated write surfaces that
--     record inventory quantity adjustments and reconciliation events.

insert into fact_types (key, label, description, unit)
values (
  'rapidcount_inventory_reconciliation_adjustment',
  'RapidCount Inventory Reconciliation Adjustment',
  'Serialized/non-serialized reconciliation adjustments posted from approved RapidCount variance reviews',
  'units'
)
on conflict (key) do nothing;

create or replace function public.rapidcount_submit_count_session(
  p_count_task_id uuid,
  p_captured_counts jsonb,
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
  v_branch_id uuid;
  v_next_data jsonb;
  v_entity_version_id uuid;
  v_version_number int;
  v_variance_lines jsonb;
  v_expected_line_count int;
  v_scoped_line_count int;
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
    raise exception 'rapidcount_submit_count_session requires branch-manager write access'
      using errcode = '42501';
  end if;

  if p_captured_counts is null
     or jsonb_typeof(p_captured_counts) <> 'array'
     or jsonb_array_length(p_captured_counts) = 0 then
    raise exception 'Captured counts must be a non-empty JSON array'
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
  if v_current_status not in ('planned', 'in_progress', 'submitted') then
    raise exception 'Count task % cannot submit session from status %', p_count_task_id, v_current_status
      using errcode = '22023';
  end if;

  select branch_id
    into v_branch_id
  from public.rapidcount_count_tasks_current
  where rapidcount_count_tasks_current.count_task_id = p_count_task_id;

  if v_branch_id is null then
    raise exception 'Count task % is missing a branch assignment', p_count_task_id
      using errcode = '22023';
  end if;

  with submitted_lines as (
    select
      (line ->> 'inventory_id')::uuid as inventory_id,
      coalesce(nullif(line ->> 'counted_quantity', '')::numeric, 0::numeric) as counted_quantity
    from jsonb_array_elements(p_captured_counts) as line
  ),
  scoped_lines as (
    select
      submitted_lines.inventory_id,
      inventory_records.entity_type,
      inventory_records.inventory_kind,
      submitted_lines.counted_quantity,
      case
        when inventory_records.entity_type = 'asset' then 1::numeric
        else coalesce((
          select sum(coalesce(nullif(tsp.data_payload ->> 'quantity', '')::numeric, 0::numeric))
          from public.time_series_points tsp
          join public.fact_types ft
            on ft.id = tsp.fact_type_id
          where tsp.entity_id = submitted_lines.inventory_id
            and ft.key in ('stock_opening_balance', 'stock_quantity_adjustment')
        ), 0::numeric)
      end as system_quantity
    from submitted_lines
    join public.rental_current_inventory_records inventory_records
      on inventory_records.entity_id = submitted_lines.inventory_id
     and inventory_records.current_branch_id = v_branch_id
  )
  select
    jsonb_agg(
      jsonb_build_object(
        'inventory_id', scoped_lines.inventory_id,
        'entity_type', scoped_lines.entity_type,
        'inventory_kind', scoped_lines.inventory_kind,
        'counted_quantity', scoped_lines.counted_quantity,
        'system_quantity', scoped_lines.system_quantity,
        'variance_quantity', scoped_lines.counted_quantity - scoped_lines.system_quantity,
        'has_variance', (scoped_lines.counted_quantity - scoped_lines.system_quantity) <> 0
      )
      order by scoped_lines.inventory_id
    ),
    count(*)::int
    into v_variance_lines, v_scoped_line_count
  from scoped_lines;

  v_expected_line_count := jsonb_array_length(p_captured_counts);

  if v_scoped_line_count is null or v_scoped_line_count = 0 then
    raise exception 'Captured counts did not include branch-scoped inventory records'
      using errcode = '22023';
  end if;

  if v_scoped_line_count <> v_expected_line_count then
    raise exception 'Captured counts must reference inventory records assigned to the count task branch'
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
        'status', 'submitted',
        'captured_counts', p_captured_counts,
        'variance_lines', coalesce(v_variance_lines, '[]'::jsonb),
        'updated_by', v_actor_name,
        'variance_submitted_at', now(),
        'last_transition_note', coalesce(
          nullif(btrim(coalesce(p_note, '')), ''),
          format('Submitted count session with %s captured lines', v_expected_line_count)
        )
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
    'submitted',
    coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Submitted count session for variance review'),
    v_actor_id,
    v_actor_name
  );

  count_task_id := p_count_task_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

create or replace function public.rapidcount_review_count_variances(
  p_count_task_id uuid,
  p_decision text,
  p_reason text
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
  v_decision text;
  v_next_status text;
  v_note text;
  v_next_data jsonb;
  v_entity_version_id uuid;
  v_version_number int;
  v_stock_adjustment_fact_id uuid;
  v_reconciliation_fact_id uuid;
  v_line jsonb;
  v_entity_type text;
  v_has_variance boolean;
  v_variance_quantity numeric;
  v_counted_quantity numeric;
  v_inventory_id uuid;
  v_asset_current_data jsonb;
  v_asset_next_data jsonb;
  v_asset_status text;
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
    raise exception 'rapidcount_review_count_variances requires branch-manager write access'
      using errcode = '42501';
  end if;

  v_decision := lower(coalesce(nullif(btrim(coalesce(p_decision, '')), ''), ''));
  if v_decision not in ('approve', 'reject', 'recount') then
    raise exception 'Unsupported variance review decision "%"', v_decision
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Variance review reason is required'
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
  if v_current_status <> 'submitted' then
    raise exception 'Count task % must be submitted before variance review (current: %)', p_count_task_id, v_current_status
      using errcode = '22023';
  end if;

  if coalesce(jsonb_typeof(v_current_version.data -> 'variance_lines'), 'null') <> 'array'
     or jsonb_array_length(coalesce(v_current_version.data -> 'variance_lines', '[]'::jsonb)) = 0 then
    raise exception 'Count task % has no submitted variance lines to review', p_count_task_id
      using errcode = '22023';
  end if;

  v_next_status := case v_decision
    when 'approve' then 'approved'
    when 'reject' then 'closed'
    else 'in_progress'
  end;

  v_actor_id := auth.uid();
  v_actor_name := coalesce(
    nullif(auth.jwt() -> 'user_metadata' ->> 'display_name', ''),
    nullif(auth.jwt() ->> 'email', ''),
    case when v_request_role = 'service_role' then 'service_role' else null end,
    v_actor_id::text
  );

  if v_decision = 'approve' then
    select id
      into v_stock_adjustment_fact_id
    from public.fact_types
    where key = 'stock_quantity_adjustment'
    limit 1;

    if v_stock_adjustment_fact_id is null then
      raise exception 'Missing fact type stock_quantity_adjustment'
        using errcode = '22023';
    end if;

    select id
      into v_reconciliation_fact_id
    from public.fact_types
    where key = 'rapidcount_inventory_reconciliation_adjustment'
    limit 1;

    if v_reconciliation_fact_id is null then
      raise exception 'Missing fact type rapidcount_inventory_reconciliation_adjustment'
        using errcode = '22023';
    end if;

    for v_line in
      select value
      from jsonb_array_elements(coalesce(v_current_version.data -> 'variance_lines', '[]'::jsonb))
    loop
      v_entity_type := lower(coalesce(nullif(v_line ->> 'entity_type', ''), ''));
      v_has_variance := coalesce((v_line ->> 'has_variance')::boolean, false);
      v_variance_quantity := coalesce(nullif(v_line ->> 'variance_quantity', '')::numeric, 0::numeric);
      v_counted_quantity := coalesce(nullif(v_line ->> 'counted_quantity', '')::numeric, 0::numeric);
      v_inventory_id := (v_line ->> 'inventory_id')::uuid;

      if not v_has_variance or v_variance_quantity = 0 then
        continue;
      end if;

      if v_entity_type = 'stock_item' then
        insert into public.time_series_points (
          entity_id,
          fact_type_id,
          observed_at,
          data_payload,
          source_id,
          metadata
        )
        values (
          v_inventory_id,
          v_stock_adjustment_fact_id,
          now(),
          jsonb_build_object(
            'quantity', v_variance_quantity,
            'unit', 'units',
            'reason', 'rapidcount_reconciliation',
            'count_task_id', p_count_task_id,
            'review_decision', v_decision
          ),
          format('rapidcount:reconciliation:%s:%s', p_count_task_id, v_inventory_id),
          jsonb_build_object('actor_name', v_actor_name)
        );
      end if;

      if v_entity_type = 'asset' then
        select state.data
          into v_asset_current_data
        from public.rental_current_entity_state state
        where state.entity_id = v_inventory_id
        limit 1;

        if v_asset_current_data is null then
          raise exception 'Serialized asset % referenced in variance but not found in current state', v_inventory_id
            using errcode = 'P0002';
        end if;

        if v_counted_quantity < 0 then
          raise exception 'Serialized asset counted_quantity cannot be negative: counted_quantity %, asset %, count_task %', v_counted_quantity, v_inventory_id, p_count_task_id
            using errcode = '22023';
        end if;

        v_asset_status := case
          when v_counted_quantity = 0 then 'missing'
          else 'available'
        end;

        v_asset_next_data := v_asset_current_data
          || jsonb_build_object(
            'operational_status', v_asset_status,
            'last_reconciled_count_task_id', p_count_task_id,
            'last_reconciled_at', now(),
            'last_reconciled_reason', btrim(p_reason)
          );

        perform public.rental_upsert_entity_current_state(
          p_entity_type => 'asset',
          p_data => v_asset_next_data,
          p_entity_id => v_inventory_id
        );
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
        v_inventory_id,
        v_reconciliation_fact_id,
        now(),
        jsonb_build_object(
          'count_task_id', p_count_task_id,
          'entity_type', v_entity_type,
          'variance_quantity', v_variance_quantity,
          'decision', v_decision,
          'reason', btrim(p_reason)
        ),
        format('rapidcount:reconciliation-event:%s:%s', p_count_task_id, v_inventory_id),
        jsonb_build_object('actor_name', v_actor_name)
      );
    end loop;
  end if;

  v_note := format(
    'Variance review: %s — %s',
    v_decision,
    btrim(p_reason)
  );

  v_next_data := v_current_version.data
    || jsonb_strip_nulls(
      jsonb_build_object(
        'status', v_next_status,
        'updated_by', v_actor_name,
        'closed_at', case when v_next_status in ('approved', 'closed') then now() else null end,
        'last_transition_note', v_note,
        'last_variance_review', jsonb_build_object(
          'decision', v_decision,
          'reason', btrim(p_reason),
          'reviewed_at', now(),
          'reviewed_by', v_actor_name
        )
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
    'variance_reviewed',
    v_current_status,
    v_next_status,
    v_note,
    v_actor_id,
    v_actor_name
  );

  count_task_id := p_count_task_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

create or replace view public.rapidcount_count_task_variances_current
with (security_invoker = true) as
select
  entities.id as count_task_id,
  entity_versions.version_number as task_version_number,
  entity_versions.valid_from as task_updated_at,
  coalesce(nullif(entity_versions.data ->> 'status', ''), 'planned') as task_status,
  nullif(entity_versions.data -> 'last_variance_review' ->> 'decision', '') as review_decision,
  nullif(entity_versions.data -> 'last_variance_review' ->> 'reason', '') as review_reason,
  nullif(entity_versions.data -> 'last_variance_review' ->> 'reviewed_by', '') as reviewed_by,
  (entity_versions.data -> 'last_variance_review' ->> 'reviewed_at')::timestamptz as reviewed_at,
  (variance_line.value ->> 'inventory_id')::uuid as inventory_id,
  variance_line.value ->> 'entity_type' as entity_type,
  variance_line.value ->> 'inventory_kind' as inventory_kind,
  coalesce(nullif(variance_line.value ->> 'counted_quantity', '')::numeric, 0::numeric) as counted_quantity,
  coalesce(nullif(variance_line.value ->> 'system_quantity', '')::numeric, 0::numeric) as system_quantity,
  coalesce(nullif(variance_line.value ->> 'variance_quantity', '')::numeric, 0::numeric) as variance_quantity,
  coalesce((variance_line.value ->> 'has_variance')::boolean, false) as has_variance
from public.entities
join public.entity_versions
  on entity_versions.entity_id = entities.id
 and entity_versions.is_current
join lateral jsonb_array_elements(coalesce(entity_versions.data -> 'variance_lines', '[]'::jsonb)) as variance_line(value)
  on true
where entities.entity_type = 'count_task';

grant select on table public.rapidcount_count_task_variances_current to authenticated, service_role;

revoke all on function public.rapidcount_submit_count_session(uuid, jsonb, text)
  from public;
grant execute on function public.rapidcount_submit_count_session(uuid, jsonb, text)
  to authenticated, service_role;

revoke all on function public.rapidcount_review_count_variances(uuid, text, text)
  from public;
grant execute on function public.rapidcount_review_count_variances(uuid, text, text)
  to authenticated, service_role;
