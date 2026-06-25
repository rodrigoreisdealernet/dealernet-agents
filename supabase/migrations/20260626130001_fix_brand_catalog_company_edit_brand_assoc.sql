-- DIA — Fix brand visibility, legacy company edit, and company↔brand association
-- Created: 2026-06-26 (issue #31)
--
-- Three fixes, all on the generic SCD2 entity model, mirroring the precedents in
-- 20260625130000_dia_vehicle_entity_crud.sql and
-- 20260625150000_dia_company_brand_entity_crud.sql:
--
--   (1) BRAND INVISIBLE — rental_entity_type_catalog is a hard-coded VALUES view
--       that several later DIA migrations each recreate keeping ONLY their own
--       type (the part / service_order / part_sale slices dropped 'brand'). Since
--       rental_current_entity_state filters on this catalog, v_dia_brand_current
--       returns 0 rows. This migration recreates the catalog with ALL DIA types
--       (vehicle, brand, part, service_order, part_sale) so none is lost.
--
--   (2) EDIT LEGACY COMPANY FAILS — seed/legacy company entities store
--       data->>'name' but NOT data->>'legal_name'; update_company merges then
--       validates and raises 'company.legal_name is required'. update_company is
--       made resilient: when the merged payload lacks legal_name, fall back to the
--       existing 'name'. create_company stays strict (unchanged).
--
--   (3) COMPANY↔BRAND ASSOCIATION — create_company / update_company now persist an
--       optional 'brand_id' (the brand entity_id) inside the company JSONB, and
--       v_dia_company_current exposes brand_id plus a resolved brand_name
--       (left join to v_dia_brand_current).
--
-- Idempotent: create or replace view + create or replace function throughout.

-- ---------------------------------------------------------------------------
-- 1. Recreate the entity type catalog with ALL DIA dealership types.
--    Later migrations each kept only their own DIA type and dropped the rest;
--    'brand' was lost. Restore the full set so v_dia_brand_current resolves.
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
    -- DIA dealership domain (keep every type added by prior DIA migrations)
    ('vehicle'), ('brand'), ('part'), ('service_order'), ('part_sale')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 + 3. update_company: resilient legal_name + persist brand_id.
--    create_company: keep strict validation, but also persist brand_id.
-- ---------------------------------------------------------------------------

-- create_company — new entity + first version (strict validation unchanged).
create or replace function public.create_company(p_data jsonb)
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

  -- Normalize brand_id: blank string clears the association (store as null key).
  if nullif(btrim(coalesce(v_data ->> 'brand_id', '')), '') is null then
    v_data := v_data - 'brand_id';
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

-- update_company — merge, backfill legal_name for legacy rows, persist brand_id.
create or replace function public.update_company(p_entity_id uuid, p_data jsonb)
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

  -- Legacy/seed companies carry only data->>'name' (rental domain), not
  -- 'legal_name'. Backfill legal_name from name so validation succeeds and the
  -- legacy entity becomes editable. create_company stays strict.
  if nullif(btrim(coalesce(v_merged ->> 'legal_name', '')), '') is null then
    v_merged := v_merged || jsonb_build_object(
      'legal_name',
      coalesce(
        nullif(btrim(v_merged ->> 'name'), ''),
        nullif(btrim(v_merged ->> 'trade_name'), '')
      )
    );
  end if;

  perform public.dia_validate_company_data(v_merged);

  -- Normalize brand_id: blank string clears the association.
  if nullif(btrim(coalesce(v_merged ->> 'brand_id', '')), '') is null then
    v_merged := v_merged - 'brand_id';
  end if;

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

-- ---------------------------------------------------------------------------
-- 3 (read side). Recreate v_dia_company_current exposing brand_id + brand_name.
--    brand_name resolved via left join to v_dia_brand_current (current version).
-- ---------------------------------------------------------------------------

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
  nullif(rces.data ->> 'brand_id', '')::uuid                as brand_id,
  b.name                                                    as brand_name,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
left join public.v_dia_brand_current b
  on b.entity_id = nullif(rces.data ->> 'brand_id', '')::uuid
where rces.entity_type = 'company'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_company_current to authenticated, service_role;
