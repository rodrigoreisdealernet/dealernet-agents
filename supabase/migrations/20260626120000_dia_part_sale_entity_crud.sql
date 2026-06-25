-- DIA — Part sale entity + hardened CRUD with atomic stock movement (issue #10)
-- Created: 2026-06-26
--
-- Transactional entity 'part_sale' on the generic SCD2 entity model
-- (entities + entity_versions JSONB). Completes the Parts concept started in
-- #8 (20260625150200_dia_part_entity_crud.sql): a sale decrements the referenced
-- part's quantity_in_stock in the SAME transaction, and a cancellation restocks
-- it. Mirrors the part slice's hardened-RPC pattern:
--   * entity_type 'part_sale' registered in the live type catalog
--   * hardened SECURITY DEFINER RPCs (role guard + GRANT EXECUTE)
--   * security_invoker read view with derived total + join to the part
--   * writes only via RPC; direct client INSERT/UPDATE stays blocked by RLS
--
-- Atomicity contract (acceptance #2):
--   create_part_sale validates available stock under a row lock (FOR UPDATE on
--   the part's current entity_versions row). If quantity > quantity_in_stock it
--   RAISES errcode 22023 BEFORE any write, so the plpgsql function body rolls
--   back as a unit — no sale row is created and stock stays unchanged (never
--   negative). cancel_part_sale restocks under the same lock and is idempotent.
--
-- Fields in entity_versions.data: part_id (uuid of the part entity), quantity,
-- unit_price, discount (optional, default 0), sale_date, customer, salesperson,
-- channel ('balcao'), status ('registrada'|'cancelada'). total is DERIVED in the
-- view (quantity * unit_price - coalesce(discount,0)), not persisted.

-- ---------------------------------------------------------------------------
-- 1. Register entity_type 'part_sale' in the live type catalog
--    (catalog is a security_invoker VALUES view; re-create it with 'part_sale').
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
    ('vehicle'), ('part'), ('part_sale')
) as rental_entity_types(entity_type);

grant select on table public.rental_entity_type_catalog to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Hardened write RPCs for part_sale
--    Guard mirrors dia_assert_part_writer:
--      service_role OR (authenticated AND get_my_role() in admin/branch_manager).
--    read_only (and any non-listed role) is denied with errcode 42501.
-- ---------------------------------------------------------------------------

-- Internal: assert the caller may write part sales. RAISES on denial.
create or replace function public.dia_assert_part_sale_writer()
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
    raise exception 'part_sale write requires admin or branch_manager (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.dia_assert_part_sale_writer() from public;
grant execute on function public.dia_assert_part_sale_writer() to authenticated, service_role;

-- Internal: validate the part_sale payload (required refs + numeric ranges).
create or replace function public.dia_validate_part_sale_data(p_data jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_part_id   text    := nullif(btrim(coalesce(p_data ->> 'part_id', '')), '');
  v_quantity  numeric := nullif(p_data ->> 'quantity', '')::numeric;
  v_price     numeric := nullif(p_data ->> 'unit_price', '')::numeric;
  v_discount  numeric := coalesce(nullif(p_data ->> 'discount', '')::numeric, 0);
begin
  if v_part_id is null then
    raise exception 'part_sale.part_id is required'
      using errcode = '22023';
  end if;

  -- part_id must be a well-formed uuid (cast raises 22P02 otherwise; normalize).
  begin
    perform v_part_id::uuid;
  exception when others then
    raise exception 'part_sale.part_id must be a valid uuid (got %)', v_part_id
      using errcode = '22023';
  end;

  if v_quantity is null or v_quantity <= 0 then
    raise exception 'part_sale.quantity must be greater than zero (got %)', coalesce(v_quantity::text, 'null')
      using errcode = '22023';
  end if;

  if v_price is null or v_price < 0 then
    raise exception 'part_sale.unit_price must be zero or greater (got %)', coalesce(v_price::text, 'null')
      using errcode = '22023';
  end if;

  if v_discount < 0 then
    raise exception 'part_sale.discount must be zero or greater (got %)', v_discount
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.dia_validate_part_sale_data(jsonb) from public;
grant execute on function public.dia_validate_part_sale_data(jsonb) to authenticated, service_role;

-- create_part_sale — validate stock under a row lock, decrement the part
-- (SCD2 new version), then record the sale. The whole plpgsql body is atomic:
-- an over-stock RAISE rolls everything back, so stock never goes negative.
drop function if exists public.create_part_sale(jsonb);

create function public.create_part_sale(p_data jsonb)
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
  v_data       jsonb   := coalesce(p_data, '{}'::jsonb);
  v_part_id    uuid;
  v_quantity   numeric;
  v_part_entity_id uuid;
  v_part_data  jsonb;
  v_qty_in_stock numeric;
  v_part_name  text;
  v_part_version int;
  v_sale_data  jsonb;
begin
  perform public.dia_assert_part_sale_writer();
  perform public.dia_validate_part_sale_data(v_data);

  v_part_id  := (v_data ->> 'part_id')::uuid;
  v_quantity := (v_data ->> 'quantity')::numeric;

  -- Resolve + LOCK the part's current version row to serialize concurrent sales.
  select e.id, ev.data
    into v_part_entity_id, v_part_data
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = v_part_id
    and e.entity_type = 'part'
  for update of ev;

  if not found then
    raise exception 'Part % not found', v_part_id
      using errcode = 'P0002';
  end if;

  v_qty_in_stock := coalesce(nullif(v_part_data ->> 'quantity_in_stock', '')::numeric, 0);

  if v_quantity > v_qty_in_stock then
    raise exception 'insufficient stock for part % (requested %, available %)',
      v_part_id, v_quantity, v_qty_in_stock
      using errcode = '22023';
  end if;

  -- Decrement: append a NEW current part version (SCD2), preserving name.
  v_part_name := coalesce(nullif(btrim(v_part_data ->> 'name'), ''), v_part_data ->> 'part_number');

  select coalesce(max(entity_versions.version_number), 0) + 1
    into v_part_version
  from public.entity_versions
  where entity_versions.entity_id = v_part_entity_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    v_part_entity_id,
    v_part_version,
    v_part_data || jsonb_build_object(
      'quantity_in_stock', v_qty_in_stock - v_quantity,
      'name', v_part_name
    )
  );

  -- Build the sale payload with defaults; total is derived in the view.
  v_sale_data := v_data
    || jsonb_build_object(
         'status', coalesce(nullif(v_data ->> 'status', ''), 'registrada'),
         'channel', coalesce(nullif(v_data ->> 'channel', ''), 'balcao'),
         'discount', coalesce(nullif(v_data ->> 'discount', '')::numeric, 0)
       );

  -- Drop the transport-only source_record_id key from the version data
  -- (it is stored on the entities row by create_entity_with_version).
  v_sale_data := v_sale_data - 'source_record_id';

  return query
  select created.entity_id, created.entity_version_id, created.version_number
  from public.create_entity_with_version(
    p_entity_type => 'part_sale',
    p_data => v_sale_data,
    p_source_record_id => nullif(v_data ->> 'source_record_id', '')
  ) as created;
end;
$$;

revoke all on function public.create_part_sale(jsonb) from public;
grant execute on function public.create_part_sale(jsonb) to authenticated, service_role;

-- cancel_part_sale — mark the sale cancelled (SCD2 new version, no DELETE) and
-- restock the part. Idempotent: cancelling an already-cancelled sale is a no-op
-- (no double restock).
drop function if exists public.cancel_part_sale(uuid);

create function public.cancel_part_sale(p_entity_id uuid)
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
  v_sale_data   jsonb;
  v_status      text;
  v_part_id     uuid;
  v_quantity    numeric;
  v_sale_version int;
  v_sale_version_id uuid;
  v_part_entity_id uuid;
  v_part_data   jsonb;
  v_qty_in_stock numeric;
  v_part_name   text;
  v_part_version int;
begin
  perform public.dia_assert_part_sale_writer();

  -- Load the current sale version; assert the entity exists and is a part_sale.
  select ev.data
    into v_sale_data
  from public.entities e
  join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
  where e.id = p_entity_id
    and e.entity_type = 'part_sale';

  if not found then
    raise exception 'Part sale % not found', p_entity_id
      using errcode = 'P0002';
  end if;

  v_status := coalesce(nullif(v_sale_data ->> 'status', ''), 'registrada');

  -- Idempotent no-op: already cancelled → return current ids without restocking.
  if v_status = 'cancelada' then
    select ev.id, ev.version_number
      into v_sale_version_id, v_sale_version
    from public.entity_versions ev
    where ev.entity_id = p_entity_id
      and ev.is_current;

    entity_id         := p_entity_id;
    entity_version_id := v_sale_version_id;
    version_number    := v_sale_version;
    return next;
    return;
  end if;

  v_part_id  := nullif(v_sale_data ->> 'part_id', '')::uuid;
  v_quantity := coalesce(nullif(v_sale_data ->> 'quantity', '')::numeric, 0);

  -- Restock: lock + append a new part version adding the quantity back.
  if v_part_id is not null and v_quantity > 0 then
    select e.id, ev.data
      into v_part_entity_id, v_part_data
    from public.entities e
    join public.entity_versions ev on ev.entity_id = e.id and ev.is_current
    where e.id = v_part_id
      and e.entity_type = 'part'
    for update of ev;

    if found then
      v_qty_in_stock := coalesce(nullif(v_part_data ->> 'quantity_in_stock', '')::numeric, 0);
      v_part_name := coalesce(nullif(btrim(v_part_data ->> 'name'), ''), v_part_data ->> 'part_number');

      select coalesce(max(entity_versions.version_number), 0) + 1
        into v_part_version
      from public.entity_versions
      where entity_versions.entity_id = v_part_entity_id;

      insert into public.entity_versions (entity_id, version_number, data)
      values (
        v_part_entity_id,
        v_part_version,
        v_part_data || jsonb_build_object(
          'quantity_in_stock', v_qty_in_stock + v_quantity,
          'name', v_part_name
        )
      );
    end if;
  end if;

  -- Append the cancelled sale version (SCD2; history preserved).
  select coalesce(max(entity_versions.version_number), 0) + 1
    into v_sale_version
  from public.entity_versions
  where entity_versions.entity_id = p_entity_id;

  insert into public.entity_versions (entity_id, version_number, data)
  values (
    p_entity_id,
    v_sale_version,
    v_sale_data || jsonb_build_object(
      'status', 'cancelada',
      'cancelled_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')
    )
  )
  returning id into v_sale_version_id;

  entity_id         := p_entity_id;
  entity_version_id := v_sale_version_id;
  version_number    := v_sale_version;
  return next;
end;
$$;

revoke all on function public.cancel_part_sale(uuid) from public;
grant execute on function public.cancel_part_sale(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Read view — current part sales with derived total and join to the part.
--    security_invoker = true so the caller's RLS (authenticated_read) applies.
--    total = round(quantity * unit_price - coalesce(discount,0), 2).
--    status is exposed (including 'cancelada') but the default list filters it.
-- ---------------------------------------------------------------------------

create or replace view public.v_dia_part_sale_current
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_version_id,
  rces.version_number,
  rces.source_record_id,
  (rces.data ->> 'part_id')::uuid                          as part_id,
  p.part_number                                            as part_number,
  p.description                                            as description,
  coalesce(nullif(rces.data ->> 'quantity', '')::numeric, 0)   as quantity,
  coalesce(nullif(rces.data ->> 'unit_price', '')::numeric, 0) as unit_price,
  coalesce(nullif(rces.data ->> 'discount', '')::numeric, 0)   as discount,
  round(
    coalesce(nullif(rces.data ->> 'quantity', '')::numeric, 0)
      * coalesce(nullif(rces.data ->> 'unit_price', '')::numeric, 0)
      - coalesce(nullif(rces.data ->> 'discount', '')::numeric, 0),
    2
  )                                                         as total,
  rces.data ->> 'sale_date'                                as sale_date,
  rces.data ->> 'customer'                                 as customer,
  rces.data ->> 'salesperson'                              as salesperson,
  coalesce(nullif(rces.data ->> 'channel', ''), 'balcao')  as channel,
  coalesce(nullif(rces.data ->> 'status', ''), 'registrada') as status,
  rces.created_at,
  rces.updated_at
from public.rental_current_entity_state rces
left join public.v_dia_part_current p
  on p.entity_id = (rces.data ->> 'part_id')::uuid
where rces.entity_type = 'part_sale'
  and coalesce(nullif(rces.data ->> 'status', ''), 'registrada') <> 'cancelada';

grant select on table public.v_dia_part_sale_current to authenticated, service_role;
