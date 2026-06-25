-- DIA — Vehicle entity + hardened CRUD (vertical slice, issue #4)
-- Created: 2026-06-25
--
-- First dealership-domain entity on the generic SCD2 entity model
-- (entities + entity_versions JSONB). Validates the reusable write path:
--   * entity_type 'vehicle' registered in the live type catalog
--   * hardened SECURITY DEFINER RPCs (role guard + GRANT EXECUTE)
--   * security_invoker read view with derived days_in_stock / floor_plan_cost
--   * writes only via RPC; direct client INSERT/UPDATE stays blocked by RLS
--
-- DEVIATIONS FROM SPEC (the live schema was pruned by
-- 20260625120000_dia_core_prune_wynne_domain.sql):
--   * create_stock_item no longer exists (pruned). The RPC pattern below mirrors
--     the surviving rental_upsert_entity_current_state / delete_entity guards.
--   * rental_entity_type_catalog is a hard-coded VALUES view that did NOT contain
--     'vehicle'; rental_assert_entity_type() (used by the upsert helper + seed)
--     would reject it. This migration recreates the catalog view WITH 'vehicle'
--     appended so the helper, the seed and the state view all accept it.
--   * The state view rental_current_entity_state filters on that catalog, so the
--     new vehicle view derives from it and benefits from the catalog addition.

-- ---------------------------------------------------------------------------
-- 1. Register entity_type 'vehicle' in the live type catalog
--    (catalog is a security_invoker VALUES view; re-create it with 'vehicle').
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
    ('vehicle')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hardened write RPCs for vehicle
--    Guard mirrors rental_upsert_entity_current_state / delete_entity:
--      service_role OR (authenticated AND get_my_role() in admin/branch_manager).
--    read_only (and any non-listed role) is denied with errcode 42501.
-- ---------------------------------------------------------------------------

-- Internal: assert the caller may write vehicles. RAISES on denial.
create or replace function public.dia_assert_vehicle_writer()
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
    raise exception 'vehicle write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_vehicle_writer() from public;
grant execute on function public.dia_assert_vehicle_writer() to authenticated, service_role;

-- Internal: validate the vehicle payload (condition / status enums + required fields).
create or replace function public.dia_validate_vehicle_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_condition text := p_data ->> 'condition';
  v_status    text := coalesce(nullif(p_data ->> 'status', ''), 'em_estoque');
begin
  if v_condition is null or v_condition not in ('novo', 'usado') then
    raise exception 'vehicle.condition must be novo or usado (got %)', coalesce(v_condition, '<null>')
      using errcode = '22023';
  end if;

  if v_status not in ('em_estoque', 'vendido') then
    raise exception 'vehicle.status must be em_estoque or vendido (got %)', v_status
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'brand', '')), '') is null then
    raise exception 'vehicle.brand is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'model', '')), '') is null then
    raise exception 'vehicle.model is required'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_vehicle_data(jsonb) from public;
grant execute on function public.dia_validate_vehicle_data(jsonb) to authenticated, service_role;

-- create_vehicle — new entity + first version.
drop function if exists public.create_vehicle(jsonb);

create function public.create_vehicle(p_data jsonb)
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
  perform public.dia_assert_vehicle_writer();
  perform public.dia_validate_vehicle_data(v_data);

  -- Default status + a display name (rental_current_entity_state exposes data->>'name').
  if (v_data ->> 'status') is null then
    v_data := v_data || jsonb_build_object('status', 'em_estoque');
  end if;

  v_name := coalesce(
    nullif(btrim(v_data ->> 'name'), ''),
    btrim(concat_ws(' ',
      v_data ->> 'brand',
      v_data ->> 'model',
      nullif(v_data ->> 'model_year', '')
    ))
  );
  v_data := v_data || jsonb_build_object('name', v_name);

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'vehicle',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_vehicle(jsonb) from public;
grant execute on function public.create_vehicle(jsonb) to authenticated, service_role;

-- update_vehicle — append a new current version (SCD2) with merged data.
drop function if exists public.update_vehicle(uuid, jsonb);

create function public.update_vehicle(p_entity_id uuid, p_data jsonb)
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
  perform public.dia_assert_vehicle_writer();

  -- Load the current version's data; assert the entity exists and is a vehicle.
  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'vehicle';

  if not found then
    raise exception 'Vehicle % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_vehicle_data(v_merged);

  -- Refresh derived display name from the merged payload.
  v_name := coalesce(
    nullif(btrim(v_merged ->> 'name'), ''),
    btrim(concat_ws(' ',
      v_merged ->> 'brand',
      v_merged ->> 'model',
      nullif(v_merged ->> 'model_year', '')
    ))
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

revoke all on function public.update_vehicle(uuid, jsonb) from public;
grant execute on function public.update_vehicle(uuid, jsonb) to authenticated, service_role;

-- delete_vehicle — soft delete / retire: append a version flagged retired and
-- closed-out (status vendido). No physical DELETE; SCD2 history is preserved.
drop function if exists public.delete_vehicle(uuid);

create function public.delete_vehicle(p_entity_id uuid)
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
  perform public.dia_assert_vehicle_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'vehicle';

  if not found then
    raise exception 'Vehicle % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || jsonb_build_object(
    'retired', true,
    'retired_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'status', 'vendido'
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

revoke all on function public.delete_vehicle(uuid) from public;
grant execute on function public.delete_vehicle(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Read view — current (non-retired) vehicles with derived floor-plan cost.
--    security_invoker = true so the caller's RLS (authenticated_read) applies.
--    days_in_stock from purchase_date; floor_plan_cost = cost * 0.13/365 * days.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_vehicle_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'condition'                              as condition,
  rces.data ->> 'brand'                                  as brand,
  rces.data ->> 'model'                                  as model,
  nullif(rces.data ->> 'model_year', '')::int            as model_year,
  nullif(rces.data ->> 'cost', '')::numeric              as cost,
  nullif(rces.data ->> 'sale_price', '')::numeric        as sale_price,
  nullif(rces.data ->> 'purchase_date', '')::date        as purchase_date,
  coalesce(nullif(rces.data ->> 'status', ''), 'em_estoque') as status,
  rces.data ->> 'store'                                  as store,
  -- date - date yields integer days in Postgres; clamp at 0 for future dates.
  greatest(
    (now()::date - nullif(rces.data ->> 'purchase_date', '')::date),
    0
  )                                                      as days_in_stock,
  round(
    coalesce(nullif(rces.data ->> 'cost', '')::numeric, 0)
      * (0.13 / 365.0)
      * greatest(
          (now()::date - nullif(rces.data ->> 'purchase_date', '')::date)::numeric,
          0
        ),
    2
  )                                                      as floor_plan_cost,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'vehicle'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_vehicle_current to authenticated, service_role;
