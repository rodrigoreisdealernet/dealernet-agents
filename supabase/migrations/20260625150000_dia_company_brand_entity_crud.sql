-- DIA — Company + Brand entities + hardened CRUD (vertical slice, issue #5)
-- Created: 2026-06-25
--
-- Master-data entities the vehicle (#4) and future sales issues reference.
-- Mirrors the vehicle slice (20260625130000_dia_vehicle_entity_crud.sql):
--   * entity_type 'brand' registered in the live type catalog ('company' already exists)
--   * hardened SECURITY DEFINER RPCs (role guard + GRANT EXECUTE)
--   * security_invoker read views v_dia_company_current / v_dia_brand_current
--   * writes only via RPC; direct client INSERT/UPDATE stays blocked by RLS
--
-- Notes:
--   * The catalog (rental_entity_type_catalog) is a hard-coded VALUES view.
--     'company' is already present; this migration recreates it WITH 'brand'
--     appended (and keeps 'vehicle' from the #4 migration) so the upsert helper,
--     the seed and the state views accept it.
--   * delete_* is a soft delete (SCD2 retire), never a physical DELETE.

-- ---------------------------------------------------------------------------
-- 1. Register entity_type 'brand' in the live type catalog
--    (catalog is a security_invoker VALUES view; re-create it with 'brand').
--    'company' and 'vehicle' are preserved.
-- ---------------------------------------------------------------------------

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
    -- DIA dealership domain
    ('vehicle'), ('brand')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

-- ===========================================================================
-- COMPANY
-- ===========================================================================

-- Internal: assert the caller may write companies. RAISES on denial.
create or replace function public.dia_assert_company_writer()
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
    raise exception 'company write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_company_writer() from public;
grant execute on function public.dia_assert_company_writer() to authenticated, service_role;

-- Internal: validate the company payload (required fields + status enum).
create or replace function public.dia_validate_company_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_status text := coalesce(nullif(p_data ->> 'status', ''), 'ativo');
begin
  if nullif(btrim(coalesce(p_data ->> 'legal_name', '')), '') is null then
    raise exception 'company.legal_name is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'cnpj', '')), '') is null then
    raise exception 'company.cnpj is required'
      using errcode = '22023';
  end if;

  if v_status not in ('ativo', 'inativo') then
    raise exception 'company.status must be ativo or inativo (got %)', v_status
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_company_data(jsonb) from public;
grant execute on function public.dia_validate_company_data(jsonb) to authenticated, service_role;

-- create_company — new entity + first version.
drop function if exists public.create_company(jsonb);

create function public.create_company(p_data jsonb)
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
  perform public.dia_assert_company_writer();
  perform public.dia_validate_company_data(v_data);

  if (v_data ->> 'status') is null then
    v_data := v_data || jsonb_build_object('status', 'ativo');
  end if;

  -- Display name (rental_current_entity_state exposes data->>'name').
  v_name := coalesce(
    nullif(btrim(v_data ->> 'name'), ''),
    nullif(btrim(v_data ->> 'trade_name'), ''),
    btrim(v_data ->> 'legal_name')
  );
  v_data := v_data || jsonb_build_object('name', v_name);

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'company',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_company(jsonb) from public;
grant execute on function public.create_company(jsonb) to authenticated, service_role;

-- update_company — append a new current version (SCD2) with merged data.
drop function if exists public.update_company(uuid, jsonb);

create function public.update_company(p_entity_id uuid, p_data jsonb)
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
  perform public.dia_assert_company_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'company';

  if not found then
    raise exception 'Company % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_company_data(v_merged);

  v_name := coalesce(
    nullif(btrim(v_merged ->> 'name'), ''),
    nullif(btrim(v_merged ->> 'trade_name'), ''),
    btrim(v_merged ->> 'legal_name')
  );
  v_merged := v_merged || jsonb_build_object('name', v_name);

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

revoke all on function public.update_company(uuid, jsonb) from public;
grant execute on function public.update_company(uuid, jsonb) to authenticated, service_role;

-- delete_company — soft delete / retire: append a version flagged retired and
-- inactive. No physical DELETE; SCD2 history is preserved.
drop function if exists public.delete_company(uuid);

create function public.delete_company(p_entity_id uuid)
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
  perform public.dia_assert_company_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'company';

  if not found then
    raise exception 'Company % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || jsonb_build_object(
    'retired', true,
    'retired_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'status', 'inativo'
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

revoke all on function public.delete_company(uuid) from public;
grant execute on function public.delete_company(uuid) to authenticated, service_role;

-- Read view — current (non-retired) companies.
drop view if exists public.v_dia_company_current;

create view public.v_dia_company_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'legal_name'                                as legal_name,
  rces.data ->> 'trade_name'                                as trade_name,
  rces.data ->> 'cnpj'                                      as cnpj,
  rces.data ->> 'city'                                      as city,
  rces.data ->> 'state'                                     as state,
  coalesce(nullif(rces.data ->> 'status', ''), 'ativo')     as status,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'company'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_company_current to authenticated, service_role;

-- ===========================================================================
-- BRAND
-- ===========================================================================

-- Internal: assert the caller may write brands. RAISES on denial.
create or replace function public.dia_assert_brand_writer()
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
    raise exception 'brand write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_brand_writer() from public;
grant execute on function public.dia_assert_brand_writer() to authenticated, service_role;

-- Internal: validate the brand payload (required name + segment/status enums).
create or replace function public.dia_validate_brand_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_segment text := p_data ->> 'segment';
  v_status  text := coalesce(nullif(p_data ->> 'status', ''), 'ativo');
begin
  if nullif(btrim(coalesce(p_data ->> 'name', '')), '') is null then
    raise exception 'brand.name is required'
      using errcode = '22023';
  end if;

  if v_segment is null or v_segment not in ('automoveis', 'caminhoes', 'motos') then
    raise exception 'brand.segment must be automoveis, caminhoes or motos (got %)', coalesce(v_segment, '<null>')
      using errcode = '22023';
  end if;

  if v_status not in ('ativo', 'inativo') then
    raise exception 'brand.status must be ativo or inativo (got %)', v_status
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_brand_data(jsonb) from public;
grant execute on function public.dia_validate_brand_data(jsonb) to authenticated, service_role;

-- create_brand — new entity + first version.
drop function if exists public.create_brand(jsonb);

create function public.create_brand(p_data jsonb)
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
  perform public.dia_assert_brand_writer();
  perform public.dia_validate_brand_data(v_data);

  if (v_data ->> 'status') is null then
    v_data := v_data || jsonb_build_object('status', 'ativo');
  end if;

  -- Display name (rental_current_entity_state exposes data->>'name').
  v_name := btrim(v_data ->> 'name');
  v_data := v_data || jsonb_build_object('name', v_name);

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'brand',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_brand(jsonb) from public;
grant execute on function public.create_brand(jsonb) to authenticated, service_role;

-- update_brand — append a new current version (SCD2) with merged data.
drop function if exists public.update_brand(uuid, jsonb);

create function public.update_brand(p_entity_id uuid, p_data jsonb)
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
  perform public.dia_assert_brand_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'brand';

  if not found then
    raise exception 'Brand % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_brand_data(v_merged);

  v_name := btrim(v_merged ->> 'name');
  v_merged := v_merged || jsonb_build_object('name', v_name);

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

revoke all on function public.update_brand(uuid, jsonb) from public;
grant execute on function public.update_brand(uuid, jsonb) to authenticated, service_role;

-- delete_brand — soft delete / retire: append a version flagged retired and
-- inactive. No physical DELETE; SCD2 history is preserved.
drop function if exists public.delete_brand(uuid);

create function public.delete_brand(p_entity_id uuid)
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
  perform public.dia_assert_brand_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'brand';

  if not found then
    raise exception 'Brand % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || jsonb_build_object(
    'retired', true,
    'retired_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'status', 'inativo'
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

revoke all on function public.delete_brand(uuid) from public;
grant execute on function public.delete_brand(uuid) to authenticated, service_role;

-- Read view — current (non-retired) brands.
drop view if exists public.v_dia_brand_current;

create view public.v_dia_brand_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'segment'                                   as segment,
  coalesce(nullif(rces.data ->> 'status', ''), 'ativo')     as status,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'brand'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_brand_current to authenticated, service_role;
