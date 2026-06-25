-- Rerent routing: auto-init unit status log on first external-rerent routing
-- Closes: #2021
-- Purpose: when a rental_order_line is first routed to external rerent via
--          rental_upsert_entity_current_state (fulfillment_source = 'external_rerent'),
--          automatically insert a rerent_unit_status_log row with status_key = 'requested'
--          so that v_rerent_unit_current_status immediately reflects the routing decision
--          and the operator-visible "unit: Requested" badge surfaces on the order detail page.
--
-- Design notes:
--   * The insert is guarded by a NOT EXISTS check so subsequent updates to the same
--     line (e.g. changing override reason) do not produce duplicate "requested" entries.
--   * changed_by is populated from the JWT sub claim (Supabase user UUID) with a
--     safe fallback of 'system' for service-role callers.
--   * All other logic in rental_upsert_entity_current_state is unchanged.

create or replace function public.rental_upsert_entity_current_state(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb,
  p_entity_id uuid default null,
  p_source_record_id text default null
)
returns table (
  entity_id uuid,
  entity_version_id uuid,
  entity_type text,
  version_number int,
  data jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_id uuid;
  v_entity_type text;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
  v_app_role public.app_role;
  v_org_scope_id uuid;
  v_actor_id text;
begin
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  v_app_role := public.get_my_role();

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and (
        v_app_role in ('admin', 'branch_manager')
        or (
          v_app_role = 'field_operator'
          and p_entity_type in ('asset', 'inspection', 'maintenance_record', 'rental_contract_line')
        )
      )
    )
  ) then
    raise exception 'rental_upsert_entity_current_state requires authenticated write access for this entity type'
      using errcode = '42501';
  end if;

  perform public.rental_assert_entity_type(p_entity_type);

  if p_entity_id is not null then
    v_entity_id := p_entity_id;
  elsif p_source_record_id is not null then
    select entities.id
      into v_entity_id
    from public.entities
    where entities.entity_type = p_entity_type
      and entities.source_record_id = p_source_record_id;
  end if;

  if v_entity_id is null then
    select created.entity_id, created.entity_version_id, created.version_number
      into v_entity_id, v_entity_version_id, v_version_number
    from public.create_entity_with_version(
      p_entity_type => p_entity_type,
      p_data => coalesce(p_data, '{}'::jsonb),
      p_source_record_id => p_source_record_id
    ) as created;
  else
    select entities.entity_type
      into v_entity_type
    from public.entities
    where entities.id = v_entity_id;

    if not found then
      raise exception 'Unknown rental entity: %', v_entity_id
        using errcode = '22023';
    end if;

    if v_entity_type <> p_entity_type then
      raise exception
        'Entity % has type % but % was requested',
        v_entity_id,
        v_entity_type,
        p_entity_type
        using errcode = '22023';
    end if;

    select coalesce(max(entity_versions.version_number), 0) + 1
      into v_version_number
    from public.entity_versions
    where entity_versions.entity_id = v_entity_id;

    insert into public.entity_versions (entity_id, version_number, data)
    values (v_entity_id, v_version_number, coalesce(p_data, '{}'::jsonb))
    returning id into v_entity_version_id;
  end if;

  v_org_scope_id := case
    when p_entity_type in ('company', 'region', 'branch') then v_entity_id
    else public.derive_entity_org_scope_id(p_entity_type, coalesce(p_data, '{}'::jsonb))
  end;

  update public.entities
     set org_scope_id = v_org_scope_id
   where id = v_entity_id
     and org_scope_id is distinct from v_org_scope_id;

  -- Auto-init rerent unit status log when a rental_order_line is first routed to
  -- external rerent.  The NOT EXISTS guard prevents duplicate "requested" entries
  -- when the same line is updated again (e.g. override reason correction).
  if p_entity_type = 'rental_order_line'
     and coalesce(p_data->>'fulfillment_source', '') = 'external_rerent'
     and not exists (
       select 1 from public.rerent_unit_status_log
       where order_line_id = v_entity_id
     ) then

    -- Resolve actor: prefer JWT sub claim (Supabase user UUID), fall back to
    -- auth.uid() for edge cases where sub is absent, then 'system' for
    -- service-role or non-authenticated callers.
    v_actor_id := coalesce(
      nullif(
        (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}'))::jsonb ->> 'sub',
        ''
      ),
      auth.uid()::text,
      'system'
    );

    insert into public.rerent_unit_status_log (order_line_id, status_key, changed_by, tenant)
    values (v_entity_id, 'requested', v_actor_id, public.get_my_tenant());
  end if;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  entity_type := p_entity_type;
  version_number := v_version_number;
  data := coalesce(p_data, '{}'::jsonb);
  return next;
end;
$$;
