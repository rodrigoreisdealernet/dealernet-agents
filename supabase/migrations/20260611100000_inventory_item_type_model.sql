-- Inventory item-type model: serialized / bulk / sale / part
--
-- Implements the guided create path and write-guard RPC for stock_item
-- entities. Serialized items remain on the existing `asset` boundary.
-- Quantity-managed kinds (bulk, sale, part) use stock_item with quantity
-- state stored in time_series_points — no per-unit rows.
--
-- Related: inventory-asset-management spec, ADR-0024 (authenticated write RPC)

-- ---------------------------------------------------------------------------
-- 1. Fact types for quantity tracking
-- ---------------------------------------------------------------------------

insert into fact_types (key, label, description, unit)
values (
  'stock_opening_balance',
  'Stock Opening Balance',
  'Initial quantity on hand recorded when a stock item is created at a branch',
  'units'
),
(
  'stock_quantity_adjustment',
  'Stock Quantity Adjustment',
  'Append-only quantity delta (positive = receipt, negative = consumption / write-off)',
  'units'
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. create_stock_item — guarded write-path RPC
--
-- Constraints:
--   * inventory_kind must be one of: bulk, sale, part (serialized → asset)
--   * name is required
--   * branch_id and asset_category_id are optional but validated if supplied
--   * opening_quantity is optional; if > 0 an opening-balance TSP is recorded
-- ---------------------------------------------------------------------------

drop function if exists public.create_stock_item(text, text, uuid, uuid, text, numeric, jsonb);

create function public.create_stock_item(
  p_name                text,
  p_inventory_kind      text,
  p_branch_id           uuid    default null,
  p_asset_category_id   uuid    default null,
  p_description         text    default null,
  p_opening_quantity    numeric default null,
  p_data                jsonb   default '{}'::jsonb
)
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
  v_request_role         text;
  v_entity_id            uuid;
  v_entity_version_id    uuid;
  v_version_number       int;
  v_fact_type_id         uuid;
begin
  -- Auth guard (mirrors create_entity_with_version pattern)
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );

  if not (
    v_request_role = 'service_role'
    or (
      v_request_role = 'authenticated'
      and public.get_my_role() in ('admin', 'branch_manager', 'field_operator')
    )
  ) then
    raise exception 'create_stock_item requires an authenticated user with write access'
      using errcode = '42501';
  end if;

  -- Validate inventory_kind: serialized kind belongs on asset, not stock_item
  if p_inventory_kind not in ('bulk', 'sale', 'part') then
    raise exception
      'Invalid inventory_kind "%" for stock_item. Use bulk, sale, or part. Serialized items are tracked as asset entities.',
      p_inventory_kind
      using errcode = '22023';
  end if;

  -- Validate name
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'stock_item name is required'
      using errcode = '22023';
  end if;

  -- Validate branch exists (if supplied)
  if p_branch_id is not null then
    if not exists (
      select 1 from entities where id = p_branch_id and entity_type = 'branch'
    ) then
      raise exception 'Branch % not found or is not a branch entity', p_branch_id
        using errcode = '22023';
    end if;
  end if;

  -- Validate asset_category exists (if supplied)
  if p_asset_category_id is not null then
    if not exists (
      select 1 from entities where id = p_asset_category_id and entity_type = 'asset_category'
    ) then
      raise exception 'Asset category % not found or is not an asset_category entity', p_asset_category_id
        using errcode = '22023';
    end if;
  end if;

  -- Create entity
  insert into entities (entity_type)
  values ('stock_item')
  returning id into v_entity_id;

  -- Create first version (name must be present for rental_current_entity_state)
  insert into entity_versions (entity_id, version_number, data)
  values (
    v_entity_id,
    1,
    coalesce(p_data, '{}'::jsonb)
    || jsonb_build_object(
      'name',               btrim(p_name),
      'inventory_kind',     p_inventory_kind,
      'description',        nullif(btrim(coalesce(p_description, '')), ''),
      'operational_status', 'available'
    )
  )
  returning id, entity_versions.version_number
  into v_entity_version_id, v_version_number;

  -- Branch relationship
  if p_branch_id is not null then
    insert into relationships_v2 (relationship_type, parent_id, child_id)
    values ('branch_has_stock_item', p_branch_id, v_entity_id);
  end if;

  -- Asset category relationship
  if p_asset_category_id is not null then
    insert into relationships_v2 (relationship_type, parent_id, child_id)
    values ('asset_category_has_stock_item', p_asset_category_id, v_entity_id);
  end if;

  -- Opening balance time-series point
  if p_opening_quantity is not null and p_opening_quantity > 0 then
    select id into v_fact_type_id
    from fact_types
    where key = 'stock_opening_balance'
    limit 1;

    if v_fact_type_id is not null then
      insert into time_series_points (entity_id, fact_type_id, observed_at, data_payload)
      values (
        v_entity_id,
        v_fact_type_id,
        now(),
        jsonb_build_object('quantity', p_opening_quantity, 'unit', 'units')
      );
    end if;
  end if;

  entity_id         := v_entity_id;
  entity_version_id := v_entity_version_id;
  version_number    := v_version_number;
  return next;
end;
$$;

revoke all on function public.create_stock_item(text, text, uuid, uuid, text, numeric, jsonb)
  from public;
grant execute on function public.create_stock_item(text, text, uuid, uuid, text, numeric, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. inventory_kind_guard — validate inventory_kind against entity boundary
--
-- Callable by the frontend to surface validation before submission:
--   SELECT * FROM inventory_kind_guard('serialized', 'stock_item');  -- error
--   SELECT * FROM inventory_kind_guard('bulk',       'stock_item');  -- ok
--   SELECT * FROM inventory_kind_guard('serialized', 'asset');       -- ok
-- ---------------------------------------------------------------------------

drop function if exists public.inventory_kind_guard(text, text);

create function public.inventory_kind_guard(
  p_inventory_kind  text,
  p_entity_type     text
)
returns table (
  is_valid    boolean,
  error_msg   text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_entity_type = 'asset' then
    if p_inventory_kind = 'serialized' then
      return query select true::boolean, null::text;
    else
      return query select false::boolean,
        format('inventory_kind "%s" is not valid for asset; only "serialized" is supported', p_inventory_kind);
    end if;
  elsif p_entity_type = 'stock_item' then
    if p_inventory_kind in ('bulk', 'sale', 'part') then
      return query select true::boolean, null::text;
    else
      return query select false::boolean,
        format('inventory_kind "%s" is not valid for stock_item; must be bulk, sale, or part', p_inventory_kind);
    end if;
  else
    return query select false::boolean,
      format('entity_type "%s" does not support inventory_kind', p_entity_type);
  end if;
end;
$$;

revoke all on function public.inventory_kind_guard(text, text) from public;
grant execute on function public.inventory_kind_guard(text, text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Ensure rental_current_stock_items view is present (idempotent)
-- ---------------------------------------------------------------------------

create or replace view public.rental_current_stock_items
with (security_invoker = true) as
select
  rces.entity_id,
  rces.entity_type,
  rces.source_record_id,
  rces.entity_version_id,
  rces.version_number,
  rces.valid_from,
  rces.valid_to,
  rces.data,
  rces.name,
  rces.created_at,
  rces.updated_at,
  coalesce(
    nullif(rces.data ->> 'inventory_kind', ''),
    'bulk'
  ) as inventory_kind,
  rces.data ->> 'description'        as description,
  rces.data ->> 'operational_status' as operational_status
from rental_current_entity_state rces
where rces.entity_type = 'stock_item';

grant select on table public.rental_current_stock_items
  to authenticated, service_role;
