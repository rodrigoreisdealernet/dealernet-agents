-- Require explicit JWT role claims for write RPC access.
--
-- This migration redefines write RPC guards so direct/no-JWT role contexts are
-- denied unless an explicit service_role claim is set.

create or replace view rental_entity_type_catalog
with (security_invoker = true) as
select *
from (
  values
    ('branch'),
    ('customer'),
    ('billing_account'),
    ('contact'),
    ('job_site'),
    ('asset_category'),
    ('asset'),
    ('maintenance_record'),
    ('inspection'),
    ('rental_order'),
    ('rental_order_line'),
    ('rental_contract'),
    ('rental_contract_line')
) as rental_entity_types(entity_type);

create or replace function create_entity_with_version(
  p_entity_type text,
  p_data jsonb default '{}'::jsonb,
  p_source_record_id text default null
)
returns table (
  entity_id uuid,
  entity_version_id uuid,
  version_number int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entity_id uuid;
  v_entity_version_id uuid;
  v_version_number int;
  v_request_role text;
begin
  v_request_role := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role', '');

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager', 'field_operator')
    )
  ) then
    raise exception 'create_entity_with_version requires an authenticated user with write access'
      using errcode = '42501';
  end if;

  insert into entities (entity_type, source_record_id)
  values (p_entity_type, p_source_record_id)
  returning id into v_entity_id;

  insert into entity_versions (entity_id, version_number, data)
  values (v_entity_id, 1, coalesce(p_data, '{}'::jsonb))
  returning id, entity_versions.version_number
  into v_entity_version_id, v_version_number;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  version_number := v_version_number;
  return next;
end;
$$;

create or replace function rental_upsert_entity_current_state(
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
begin
  v_request_role := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role', '');
  v_app_role := public.get_my_role();

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and (
        v_app_role in ('admin', 'branch_manager')
        or (
          v_app_role = 'field_operator'
          and p_entity_type in ('inspection', 'maintenance_record', 'rental_contract_line')
        )
      )
    )
  ) then
    raise exception 'rental_upsert_entity_current_state requires authenticated write access for this entity type'
      using errcode = '42501';
  end if;

  perform rental_assert_entity_type(p_entity_type);

  if p_entity_id is not null then
    v_entity_id := p_entity_id;
  elsif p_source_record_id is not null then
    select entities.id
      into v_entity_id
    from entities
    where entities.entity_type = p_entity_type
      and entities.source_record_id = p_source_record_id;
  end if;

  if v_entity_id is null then
    select created.entity_id, created.entity_version_id, created.version_number
      into v_entity_id, v_entity_version_id, v_version_number
    from create_entity_with_version(
      p_entity_type => p_entity_type,
      p_data => coalesce(p_data, '{}'::jsonb),
      p_source_record_id => p_source_record_id
    ) as created;
  else
    select entities.entity_type
      into v_entity_type
    from entities
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
    from entity_versions
    where entity_versions.entity_id = v_entity_id;

    insert into entity_versions (entity_id, version_number, data)
    values (v_entity_id, v_version_number, coalesce(p_data, '{}'::jsonb))
    returning id into v_entity_version_id;
  end if;

  entity_id := v_entity_id;
  entity_version_id := v_entity_version_id;
  entity_type := p_entity_type;
  version_number := v_version_number;
  data := coalesce(p_data, '{}'::jsonb);
  return next;
end;
$$;

create or replace function rental_upsert_relationship(
  p_relationship_type text,
  p_parent_id uuid,
  p_child_id uuid,
  p_metadata jsonb default '{}'::jsonb,
  p_valid_from timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relationship_id uuid;
  v_request_role text;
begin
  v_request_role := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role', '');

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager')
    )
  ) then
    raise exception 'rental_upsert_relationship requires authenticated manager write access'
      using errcode = '42501';
  end if;

  perform rental_assert_relationship(
    p_relationship_type => p_relationship_type,
    p_parent_id => p_parent_id,
    p_child_id => p_child_id
  );

  insert into relationships_v2 (
    relationship_type,
    parent_id,
    child_id,
    metadata,
    valid_from
  )
  values (
    p_relationship_type,
    p_parent_id,
    p_child_id,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_valid_from, now())
  )
  returning id into v_relationship_id;

  return v_relationship_id;
end;
$$;
