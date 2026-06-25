-- DIA — Part entity + hardened CRUD (vertical slice, issue #8)
-- Created: 2026-06-25
--
-- Second dealership-domain entity on the generic SCD2 entity model
-- (entities + entity_versions JSONB). Mirrors the vehicle slice
-- (20260625130000_dia_vehicle_entity_crud.sql):
--   * entity_type 'part' registered in the live type catalog
--   * hardened SECURITY DEFINER RPCs (role guard + GRANT EXECUTE)
--   * security_invoker read view with derived stock_value / stock_status
--   * a secondary criticality view (v_dia_parts_critical) for the reorder alert
--   * writes only via RPC; direct client INSERT/UPDATE stays blocked by RLS
--
-- stock_status precedence (highest severity wins, assumes min_stock <= reorder_point):
--   zerado   — quantity_in_stock = 0
--   critico  — quantity_in_stock <= min_stock (and > 0)
--   baixo    — quantity_in_stock <= reorder_point (and > min_stock)
--   ok       — above reorder_point
--
-- NOTE: stock_item was pruned from the live schema
-- (20260625120000_dia_core_prune_wynne_domain.sql) — this is a dedicated
-- 'part' entity, not a reuse of the old inventory flow.

-- ---------------------------------------------------------------------------
-- 1. Register entity_type 'part' in the live type catalog
--    (catalog is a security_invoker VALUES view; re-create it with 'part').
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
    ('vehicle'), ('part')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hardened write RPCs for part
--    Guard mirrors dia_assert_vehicle_writer:
--      service_role OR (authenticated AND get_my_role() in admin/branch_manager).
--    read_only (and any non-listed role) is denied with errcode 42501.
-- ---------------------------------------------------------------------------

-- Internal: assert the caller may write parts. RAISES on denial.
create or replace function public.dia_assert_part_writer()
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
    raise exception 'part write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_part_writer() from public;
grant execute on function public.dia_assert_part_writer() to authenticated, service_role;

-- Internal: validate the part payload (status enum + required fields).
create or replace function public.dia_validate_part_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_status text := coalesce(nullif(p_data ->> 'status', ''), 'ativo');
begin
  if nullif(btrim(coalesce(p_data ->> 'part_number', '')), '') is null then
    raise exception 'part.part_number is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'description', '')), '') is null then
    raise exception 'part.description is required'
      using errcode = '22023';
  end if;

  if v_status not in ('ativo', 'inativo') then
    raise exception 'part.status must be ativo or inativo (got %)', v_status
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_part_data(jsonb) from public;
grant execute on function public.dia_validate_part_data(jsonb) to authenticated, service_role;

-- create_part — new entity + first version.
drop function if exists public.create_part(jsonb);

create function public.create_part(p_data jsonb)
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
  perform public.dia_assert_part_writer();
  perform public.dia_validate_part_data(v_data);

  -- Default status + a display name (rental_current_entity_state exposes data->>'name').
  if (v_data ->> 'status') is null then
    v_data := v_data || jsonb_build_object('status', 'ativo');
  end if;

  v_name := coalesce(
    nullif(btrim(v_data ->> 'name'), ''),
    btrim(concat_ws(' ', v_data ->> 'part_number', v_data ->> 'description'))
  );
  v_data := v_data || jsonb_build_object('name', v_name);

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'part',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_part(jsonb) from public;
grant execute on function public.create_part(jsonb) to authenticated, service_role;

-- update_part — append a new current version (SCD2) with merged data.
drop function if exists public.update_part(uuid, jsonb);

create function public.update_part(p_entity_id uuid, p_data jsonb)
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
  perform public.dia_assert_part_writer();

  -- Load the current version's data; assert the entity exists and is a part.
  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'part';

  if not found then
    raise exception 'Part % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_part_data(v_merged);

  -- Refresh derived display name from the merged payload.
  v_name := coalesce(
    nullif(btrim(v_merged ->> 'name'), ''),
    btrim(concat_ws(' ', v_merged ->> 'part_number', v_merged ->> 'description'))
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

revoke all on function public.update_part(uuid, jsonb) from public;
grant execute on function public.update_part(uuid, jsonb) to authenticated, service_role;

-- delete_part — soft delete / retire: append a version flagged retired and
-- inactivated (status inativo). No physical DELETE; SCD2 history is preserved.
drop function if exists public.delete_part(uuid);

create function public.delete_part(p_entity_id uuid)
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
  perform public.dia_assert_part_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'part';

  if not found then
    raise exception 'Part % not found', p_entity_id
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

revoke all on function public.delete_part(uuid) from public;
grant execute on function public.delete_part(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Read view — current (non-retired) parts with derived stock value/status.
--    security_invoker = true so the caller's RLS (authenticated_read) applies.
--    stock_value = round(quantity_in_stock * unit_cost, 2).
--    stock_status via CASE in precedence zerado -> critico -> baixo -> ok.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_part_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'part_number'                              as part_number,
  rces.data ->> 'description'                              as description,
  rces.data ->> 'manufacturer'                             as manufacturer,
  nullif(rces.data ->> 'unit_cost', '')::numeric           as unit_cost,
  nullif(rces.data ->> 'unit_price', '')::numeric          as unit_price,
  coalesce(nullif(rces.data ->> 'quantity_in_stock', '')::numeric, 0) as quantity_in_stock,
  coalesce(nullif(rces.data ->> 'min_stock', '')::numeric, 0)         as min_stock,
  coalesce(nullif(rces.data ->> 'reorder_point', '')::numeric, 0)     as reorder_point,
  rces.data ->> 'location'                                 as location,
  coalesce(nullif(rces.data ->> 'status', ''), 'ativo')    as status,
  round(
    coalesce(nullif(rces.data ->> 'quantity_in_stock', '')::numeric, 0)
      * coalesce(nullif(rces.data ->> 'unit_cost', '')::numeric, 0),
    2
  )                                                        as stock_value,
  case
    when coalesce(nullif(rces.data ->> 'quantity_in_stock', '')::numeric, 0) = 0 then 'zerado'
    when coalesce(nullif(rces.data ->> 'quantity_in_stock', '')::numeric, 0)
         <= coalesce(nullif(rces.data ->> 'min_stock', '')::numeric, 0) then 'critico'
    when coalesce(nullif(rces.data ->> 'quantity_in_stock', '')::numeric, 0)
         <= coalesce(nullif(rces.data ->> 'reorder_point', '')::numeric, 0) then 'baixo'
    else 'ok'
  end                                                      as stock_status,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'part'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_part_current to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Criticality view — parts needing reorder (base for the reorder alert, #D).
--    Ordered by criticality rank (zerado -> critico -> baixo) then part_number.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_parts_critical
with (security_invoker = true) as
select
  p.*,
  case p.stock_status
    when 'zerado' then 0
    when 'critico' then 1
    when 'baixo' then 2
    else 3
  end as criticality_rank
from public.v_dia_part_current p
where p.stock_status in ('baixo', 'critico', 'zerado')
order by criticality_rank, p.part_number;

grant select on table public.v_dia_parts_critical to authenticated, service_role;
