-- DIA — Collection contact entity + hardened CRUD (collections prioritizer, issue #82)
-- Mirrors the dealership entity CRUD pattern on the generic SCD2 entity model.

create or replace view public.rental_entity_type_catalog
with (security_invoker = true) as
select entity_type
from (
  values
    ('company'), ('region'), ('branch'), ('project'),
    ('project_equipment_assignment'), ('customer'), ('billing_account'),
    ('contact'), ('job_site'), ('asset_category'), ('asset'), ('stock_item'),
    ('inventory_kit'), ('maintenance_record'), ('inspection'), ('rental_order'),
    ('rental_order_line'), ('rental_contract'), ('rental_contract_line'),
    ('invoice'), ('invoice_line'), ('transfer'), ('rate_card'), ('document'),
    ('note'), ('agent_config'), ('customer_issue'), ('requisition'),
    ('supplier'), ('purchase_order'),
    ('vehicle'), ('brand'), ('service_order'), ('part'), ('part_sale'),
    ('receivable'), ('collection_contact')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

create or replace function public.dia_assert_collection_contact_writer()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
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
    raise exception 'collection_contact write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_collection_contact_writer() from public;
grant execute on function public.dia_assert_collection_contact_writer() to authenticated, service_role;

create or replace function public.dia_validate_collection_contact_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(coalesce(p_data ->> 'customer_id', '')), '') is null then
    raise exception 'collection_contact.customer_id is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'action', '')), '') is null then
    raise exception 'collection_contact.action is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'contact_date', '')), '') is not null then
    begin
      perform (p_data ->> 'contact_date')::date;
    exception when others then
      raise exception 'collection_contact.contact_date must be a date (got %)', p_data ->> 'contact_date'
        using errcode = '22023';
    end;
  end if;

  if nullif(btrim(coalesce(p_data ->> 'next_contact_date', '')), '') is not null then
    begin
      perform (p_data ->> 'next_contact_date')::date;
    exception when others then
      raise exception 'collection_contact.next_contact_date must be a date (got %)', p_data ->> 'next_contact_date'
        using errcode = '22023';
    end;
  end if;
end;
$$;

revoke all on function public.dia_validate_collection_contact_data(jsonb) from public;
grant execute on function public.dia_validate_collection_contact_data(jsonb) to authenticated, service_role;

drop function if exists public.create_collection_contact(jsonb);

create function public.create_collection_contact(p_data jsonb)
returns table (
  entity_id          uuid,
  entity_version_id  uuid,
  version_number     int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_name text;
begin
  perform public.dia_assert_collection_contact_writer();
  perform public.dia_validate_collection_contact_data(v_data);

  v_name := coalesce(
    nullif(btrim(v_data ->> 'name'), ''),
    btrim(concat_ws(' ', v_data ->> 'action', v_data ->> 'contact_date'))
  );
  v_data := v_data || jsonb_build_object('name', nullif(v_name, ''));

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'collection_contact',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_collection_contact(jsonb) from public;
grant execute on function public.create_collection_contact(jsonb) to authenticated, service_role;

drop function if exists public.update_collection_contact(uuid, jsonb);

create function public.update_collection_contact(p_entity_id uuid, p_data jsonb)
returns table (
  entity_id          uuid,
  entity_version_id  uuid,
  version_number     int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current jsonb;
  v_merged  jsonb;
  v_name    text;
  v_version int;
  v_version_id uuid;
begin
  perform public.dia_assert_collection_contact_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'collection_contact';

  if not found then
    raise exception 'Collection contact % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_collection_contact_data(v_merged);

  v_name := coalesce(
    nullif(btrim(v_merged ->> 'name'), ''),
    btrim(concat_ws(' ', v_merged ->> 'action', v_merged ->> 'contact_date'))
  );
  v_merged := v_merged || jsonb_build_object('name', nullif(v_name, ''));

  select coalesce(max(entity_versions.version_number), 0) + 1
    into v_version
  from public.entity_versions
  where entity_versions.entity_id = p_entity_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (p_entity_id, v_version, v_merged)
  returning id into v_version_id;

  entity_id         := p_entity_id;
  entity_version_id := v_version_id;
  version_number    := v_version;
  return next;
end;
$$;

revoke all on function public.update_collection_contact(uuid, jsonb) from public;
grant execute on function public.update_collection_contact(uuid, jsonb) to authenticated, service_role;

drop function if exists public.delete_collection_contact(uuid);

create function public.delete_collection_contact(p_entity_id uuid)
returns table (
  entity_id          uuid,
  entity_version_id  uuid,
  version_number     int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current jsonb;
  v_merged  jsonb;
  v_version int;
  v_version_id uuid;
begin
  perform public.dia_assert_collection_contact_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'collection_contact';

  if not found then
    raise exception 'Collection contact % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || jsonb_build_object(
    'retired', true,
    'retired_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')
  );

  select coalesce(max(entity_versions.version_number), 0) + 1
    into v_version
  from public.entity_versions
  where entity_versions.entity_id = p_entity_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (p_entity_id, v_version, v_merged)
  returning id into v_version_id;

  entity_id         := p_entity_id;
  entity_version_id := v_version_id;
  version_number    := v_version;
  return next;
end;
$$;

revoke all on function public.delete_collection_contact(uuid) from public;
grant execute on function public.delete_collection_contact(uuid) to authenticated, service_role;

create or replace view public.v_dia_collection_contact_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'customer_id'                             as customer_id,
  rces.data ->> 'receivable_id'                           as receivable_id,
  rces.data ->> 'action'                                  as action,
  rces.data ->> 'note'                                    as note,
  nullif(rces.data ->> 'contact_date', '')::date          as contact_date,
  nullif(rces.data ->> 'next_contact_date', '')::date     as next_contact_date,
  rces.data ->> 'result'                                  as result,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'collection_contact'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_collection_contact_current to authenticated, service_role;
