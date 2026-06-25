-- Migration: allow field_operator to write asset state via rental_upsert_entity_current_state
--
-- Context: the field-mobile return + follow-up inspection workflow (frontend/src/routes/field/mobile.tsx)
-- calls rental_upsert_entity_current_state with p_entity_type = 'asset' after the operator
-- completes a return or inspection, in order to persist the resulting asset status
-- (e.g. 'returned', 'inspection_hold', 'maintenance'). Without this permission the call
-- raises a 42501 exception, the submission fails, and the UI cannot show the completion
-- state after reload. Adding 'asset' to the allowed types for field_operator is the minimal
-- fix required for durable field-workflow state.

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

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  entity_type := p_entity_type;
  version_number := v_version_number;
  data := coalesce(p_data, '{}'::jsonb);
  return next;
end;
$$;
