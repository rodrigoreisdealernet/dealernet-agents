-- DIA — Receivable entity + hardened CRUD (collections prioritizer, issue #82)
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
    ('receivable')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

create or replace function public.dia_assert_receivable_writer()
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
    raise exception 'receivable write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_receivable_writer() from public;
grant execute on function public.dia_assert_receivable_writer() to authenticated, service_role;

create or replace function public.dia_validate_receivable_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_status text := coalesce(nullif(p_data ->> 'status', ''), 'aberto');
  v_due_date date;
  v_balance numeric;
begin
  if nullif(btrim(coalesce(p_data ->> 'customer_id', '')), '') is null then
    raise exception 'receivable.customer_id is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'due_date', '')), '') is null then
    raise exception 'receivable.due_date is required'
      using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_data ->> 'balance', '')), '') is null then
    raise exception 'receivable.balance is required'
      using errcode = '22023';
  end if;

  begin
    v_due_date := (p_data ->> 'due_date')::date;
  exception when others then
    raise exception 'receivable.due_date must be a date (got %)', p_data ->> 'due_date'
      using errcode = '22023';
  end;

  begin
    v_balance := (p_data ->> 'balance')::numeric;
  exception when others then
    raise exception 'receivable.balance must be numeric (got %)', p_data ->> 'balance'
      using errcode = '22023';
  end;

  if v_status not in ('aberto', 'liquidado', 'inativo') then
    raise exception 'receivable.status must be aberto, liquidado, or inativo (got %)', v_status
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_receivable_data(jsonb) from public;
grant execute on function public.dia_validate_receivable_data(jsonb) to authenticated, service_role;

drop function if exists public.create_receivable(jsonb);

create function public.create_receivable(p_data jsonb)
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
  perform public.dia_assert_receivable_writer();
  perform public.dia_validate_receivable_data(v_data);

  if (v_data ->> 'status') is null then
    v_data := v_data || jsonb_build_object('status', 'aberto');
  end if;

  v_name := coalesce(
    nullif(btrim(v_data ->> 'name'), ''),
    btrim(concat_ws(' ', v_data ->> 'customer_name', v_data ->> 'document_number'))
  );
  v_data := v_data || jsonb_build_object('name', nullif(v_name, ''));

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'receivable',
    p_data => v_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_receivable(jsonb) from public;
grant execute on function public.create_receivable(jsonb) to authenticated, service_role;

drop function if exists public.update_receivable(uuid, jsonb);

create function public.update_receivable(p_entity_id uuid, p_data jsonb)
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
  perform public.dia_assert_receivable_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'receivable';

  if not found then
    raise exception 'Receivable % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_merged := v_current || coalesce(p_data, '{}'::jsonb);
  perform public.dia_validate_receivable_data(v_merged);

  v_name := coalesce(
    nullif(btrim(v_merged ->> 'name'), ''),
    btrim(concat_ws(' ', v_merged ->> 'customer_name', v_merged ->> 'document_number'))
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

revoke all on function public.update_receivable(uuid, jsonb) from public;
grant execute on function public.update_receivable(uuid, jsonb) to authenticated, service_role;

drop function if exists public.delete_receivable(uuid);

create function public.delete_receivable(p_entity_id uuid)
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
  perform public.dia_assert_receivable_writer();

  select ev.data
    into v_current
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'receivable';

  if not found then
    raise exception 'Receivable % not found', p_entity_id
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

revoke all on function public.delete_receivable(uuid) from public;
grant execute on function public.delete_receivable(uuid) to authenticated, service_role;

create or replace view public.v_dia_receivable_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  rces.name,
  rces.data ->> 'customer_id'                             as customer_id,
  rces.data ->> 'customer_name'                           as customer_name,
  rces.data ->> 'document_number'                         as document_number,
  rces.data ->> 'receivable_type'                         as receivable_type,
  coalesce(nullif(rces.data ->> 'balance', '')::numeric, 0) as balance,
  nullif(rces.data ->> 'due_date', '')::date              as due_date,
  rces.data ->> 'collector_code'                          as collector_code,
  rces.data ->> 'collector_name'                          as collector_name,
  coalesce(nullif(rces.data ->> 'status', ''), 'aberto')  as status,
  coalesce(
    nullif(rces.data ->> 'days_overdue', '')::int,
    greatest(now()::date - nullif(rces.data ->> 'due_date', '')::date, 0)
  )                                                       as days_overdue,
  rces.valid_from,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
where rces.entity_type = 'receivable'
  and coalesce((rces.data ->> 'retired')::boolean, false) = false;

grant select on table public.v_dia_receivable_current to authenticated, service_role;
