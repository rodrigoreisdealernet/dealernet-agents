-- DIA — Service Order (Oficina) entity + hardened CRUD (vertical slice, issue #7)
-- Created: 2026-06-25
--
-- Second dealership-domain entity on the generic SCD2 entity model
-- (entities + entity_versions JSONB). Mirrors the vehicle slice (issue #4):
--   * entity_type 'service_order' registered in the live type catalog
--   * hardened SECURITY DEFINER RPCs (role guard + GRANT EXECUTE)
--   * security_invoker read view with derived turnaround_hours
--   * writes only via RPC; direct client INSERT/UPDATE stays blocked by RLS
--
-- The catalog view is a hard-coded VALUES view; rental_assert_entity_type()
-- (used by the generic upsert helper + seed) would reject 'service_order'.
-- This migration recreates the catalog view WITH 'service_order' appended
-- (preserving 'vehicle' and all prior types) so the helper, the seed and the
-- state view accept it.

-- ---------------------------------------------------------------------------
-- 1. Register entity_type 'service_order' in the live type catalog
--    (catalog is a security_invoker VALUES view; re-create it appending the
--    new type — do NOT drop the existing types or 'vehicle').
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
    ('vehicle'), ('service_order')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hardened write RPCs for service_order
--    Guard mirrors dia_assert_vehicle_writer:
--      service_role OR (authenticated AND get_my_role() in admin/branch_manager).
--    read_only (and any non-listed role) is denied with errcode 42501.
-- ---------------------------------------------------------------------------

-- Internal: assert the caller may write service orders. RAISES on denial.
create or replace function public.dia_assert_service_order_writer()
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
    raise exception 'service_order write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_service_order_writer() from public;
grant execute on function public.dia_assert_service_order_writer() to authenticated, service_role;

-- Internal: validate the service_order payload (status enum + required fields).
create or replace function public.dia_validate_service_order_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_status text := coalesce(nullif(p_data ->> 'status', ''), 'aberta');
begin
  if v_status not in ('aberta', 'em_andamento', 'concluida', 'cancelada') then
    raise exception 'service_order.status must be aberta, em_andamento, concluida or cancelada (got %)', v_status
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'customer', '')), '') is null then
    raise exception 'service_order.customer is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'description', '')), '') is null then
    raise exception 'service_order.description is required'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_service_order_data(jsonb) from public;
grant execute on function public.dia_validate_service_order_data(jsonb) to authenticated, service_role;

-- create_service_order — new entity + first version.
drop function if exists public.create_service_order(jsonb);

create function public.create_service_order(p_data jsonb)
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
  perform public.dia_assert_service_order_writer();
  perform public.dia_validate_service_order_data(v_data);

  -- Default status + opened_at + a display name
  -- (rental_current_entity_state exposes data->>'name').
  if (v_data ->> 'status') is null then
    v_data := v_data || jsonb_build_object('status', 'aberta');
  end if;

  if nullif(v_data ->> 'opened_at', '') is null then
    v_data := v_data || jsonb_build_object(
      'opened_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')
    );
  end if;

  v_name := coalesce(
    nullif(btrim(v_data ->> 'name'), ''),
    nullif(btrim(v_data ->> 'order_number'), ''),
    btrim(concat_ws(' - ',
      v_data ->> 'customer',
      nullif(v_data ->> 'vehicle', '')
    ))
  );
  v_data := v_data || jsonb_build_object('name', v_name);

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'service_order',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_service_order(jsonb) from public;
grant execute on function public.create_service_order(jsonb) to authenticated, service_role;

-- update_service_order — append a new current version (SCD2) with merged data.
drop function if exists public.update_service_order(uuid, jsonb);

create function public.update_service_order(p_entity_id uuid, p_data jsonb)
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
  perform public.dia_assert_service_order_writer();

  -- Load the current version's data; assert the entity exists and is a service_order.
  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'service_order';

  if not found then
    raise exception 'Service order % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_service_order_data(v_merged);

  -- Refresh derived display name from the merged payload.
  v_name := coalesce(
    nullif(btrim(v_merged ->> 'name'), ''),
    nullif(btrim(v_merged ->> 'order_number'), ''),
    btrim(concat_ws(' - ',
      v_merged ->> 'customer',
      nullif(v_merged ->> 'vehicle', '')
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

revoke all on function public.update_service_order(uuid, jsonb) from public;
grant execute on function public.update_service_order(uuid, jsonb) to authenticated, service_role;

-- delete_service_order — soft delete / cancel: append a version flagged cancelled
-- with status 'cancelada'. No physical DELETE; SCD2 history is preserved.
drop function if exists public.delete_service_order(uuid);

create function public.delete_service_order(p_entity_id uuid)
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
  perform public.dia_assert_service_order_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'service_order';

  if not found then
    raise exception 'Service order % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || jsonb_build_object(
    'cancelled', true,
    'cancelled_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'status', 'cancelada'
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

revoke all on function public.delete_service_order(uuid) from public;
grant execute on function public.delete_service_order(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Read view — current (non-cancelled) service orders with derived
--    turnaround_hours. security_invoker = true so the caller's RLS
--    (authenticated_read) applies. turnaround_hours = (closed_at - opened_at)
--    in hours, only for 'concluida' orders; null otherwise.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_service_order_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'order_number'                            as order_number,
  rces.data ->> 'customer'                                as customer,
  rces.data ->> 'vehicle'                                 as vehicle,
  rces.data ->> 'description'                             as description,
  coalesce(nullif(rces.data ->> 'status', ''), 'aberta')  as status,
  nullif(rces.data ->> 'opened_at', '')::timestamptz      as opened_at,
  nullif(rces.data ->> 'closed_at', '')::timestamptz      as closed_at,
  nullif(rces.data ->> 'revenue', '')::numeric            as revenue,
  rces.data ->> 'technician'                              as technician,
  case
    when coalesce(nullif(rces.data ->> 'status', ''), 'aberta') = 'concluida'
         and nullif(rces.data ->> 'opened_at', '') is not null
         and nullif(rces.data ->> 'closed_at', '') is not null
    then round(
      extract(epoch from (
        nullif(rces.data ->> 'closed_at', '')::timestamptz
        - nullif(rces.data ->> 'opened_at', '')::timestamptz
      )) / 3600.0,
      2
    )
    else null
  end                                                     as turnaround_hours,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'service_order'
  and coalesce((rces.data ->> 'cancelled')::boolean, false) = false;

grant select on table public.v_dia_service_order_current to authenticated, service_role;
