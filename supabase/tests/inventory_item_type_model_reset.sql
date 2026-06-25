-- Inventory item-type model reset-path assertions
--
-- Validates that supabase db reset (migrations + seed.sql) produces a
-- fully-working inventory item-type schema.  Exercises the complete
-- guided stock-item creation path — fact-type seeding, inventory_kind_guard,
-- create_stock_item RPC for bulk / sale / part, opening-balance TSP writes,
-- and relationship creation — from a fresh database.
--
-- Run via: bash supabase/tests/run_inventory_item_type_model_reset.sh

begin;

do $$
declare
  v_rpc_exists       bool;
  v_guard_exists     bool;
  v_view_exists      bool;
  v_fact_ob_id       uuid;
  v_fact_adj_id      uuid;
  v_branch_id        uuid;
  v_category_id      uuid;
  v_bulk_id          uuid;
  v_sale_id          uuid;
  v_part_id          uuid;
  v_is_valid         boolean;
  v_error_msg        text;
  v_count            bigint;
  v_inventory_kind   text;
  v_op_status        text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- -------------------------------------------------------------------------
  -- 1. Schema objects exist after a clean reset
  -- -------------------------------------------------------------------------

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_stock_item'
  ) into v_rpc_exists;

  if not v_rpc_exists then
    raise exception 'Reset-path check failed: public.create_stock_item is missing';
  end if;

  select exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inventory_kind_guard'
  ) into v_guard_exists;

  if not v_guard_exists then
    raise exception 'Reset-path check failed: public.inventory_kind_guard is missing';
  end if;

  select exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname = 'rental_current_stock_items'
  ) into v_view_exists;

  if not v_view_exists then
    raise exception 'Reset-path check failed: public.rental_current_stock_items view is missing';
  end if;

  raise notice 'PASS 1: schema objects present after reset';

  -- -------------------------------------------------------------------------
  -- 2. Fact types seeded by the migration
  -- -------------------------------------------------------------------------

  select id into v_fact_ob_id from fact_types where key = 'stock_opening_balance';
  if v_fact_ob_id is null then
    raise exception 'Reset-path check failed: stock_opening_balance fact type not seeded';
  end if;

  select id into v_fact_adj_id from fact_types where key = 'stock_quantity_adjustment';
  if v_fact_adj_id is null then
    raise exception 'Reset-path check failed: stock_quantity_adjustment fact type not seeded';
  end if;

  raise notice 'PASS 2: stock quantity fact types seeded';

  -- -------------------------------------------------------------------------
  -- 3. inventory_kind_guard validates correctly from a fresh schema
  -- -------------------------------------------------------------------------

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('bulk', 'stock_item');
  if not v_is_valid then
    raise exception 'Reset-path check failed: inventory_kind_guard rejected bulk+stock_item: %', v_error_msg;
  end if;

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('sale', 'stock_item');
  if not v_is_valid then
    raise exception 'Reset-path check failed: inventory_kind_guard rejected sale+stock_item: %', v_error_msg;
  end if;

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('part', 'stock_item');
  if not v_is_valid then
    raise exception 'Reset-path check failed: inventory_kind_guard rejected part+stock_item: %', v_error_msg;
  end if;

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('serialized', 'asset');
  if not v_is_valid then
    raise exception 'Reset-path check failed: inventory_kind_guard rejected serialized+asset: %', v_error_msg;
  end if;

  select is_valid, error_msg
  into v_is_valid, v_error_msg
  from inventory_kind_guard('serialized', 'stock_item');
  if v_is_valid then
    raise exception 'Reset-path check failed: inventory_kind_guard should reject serialized+stock_item';
  end if;

  raise notice 'PASS 3: inventory_kind_guard validates correctly';

  -- -------------------------------------------------------------------------
  -- 4. Fixture: branch + asset_category for relationship tests
  -- -------------------------------------------------------------------------

  insert into entities (entity_type, source_record_id)
  values ('branch', 'reset-inv-branch-01')
  returning id into v_branch_id;

  insert into entity_versions (entity_id, version_number, data)
  values (v_branch_id, 1, '{"name":"Reset Test Branch"}'::jsonb);

  insert into entities (entity_type, source_record_id)
  values ('asset_category', 'reset-inv-category-01')
  returning id into v_category_id;

  insert into entity_versions (entity_id, version_number, data)
  values (v_category_id, 1, '{"name":"Reset Test Category"}'::jsonb);

  raise notice 'PASS 4: branch + asset_category fixtures created';

  -- -------------------------------------------------------------------------
  -- 5. create_stock_item — bulk kind with opening balance + relationships
  -- -------------------------------------------------------------------------

  select entity_id into v_bulk_id
  from create_stock_item(
    p_name              => 'Hydraulic Oil 20L',
    p_inventory_kind    => 'bulk',
    p_branch_id         => v_branch_id,
    p_asset_category_id => v_category_id,
    p_description       => 'Premium hydraulic oil',
    p_opening_quantity  => 50
  );

  if v_bulk_id is null then
    raise exception 'Reset-path check failed: create_stock_item (bulk) returned null entity_id';
  end if;

  -- Entity type
  select count(*) into v_count
  from entities
  where id = v_bulk_id and entity_type = 'stock_item';
  if v_count <> 1 then
    raise exception 'Reset-path check failed: bulk stock_item entity_type not set correctly';
  end if;

  -- Version data
  select data ->> 'inventory_kind', data ->> 'operational_status'
  into v_inventory_kind, v_op_status
  from entity_versions
  where entity_id = v_bulk_id and is_current;
  if v_inventory_kind <> 'bulk' then
    raise exception 'Reset-path check failed: bulk item inventory_kind is "%", expected "bulk"', v_inventory_kind;
  end if;
  if v_op_status <> 'available' then
    raise exception 'Reset-path check failed: bulk item operational_status is "%", expected "available"', v_op_status;
  end if;

  -- Branch relationship
  select count(*) into v_count
  from relationships_v2
  where relationship_type = 'branch_has_stock_item'
    and parent_id = v_branch_id
    and child_id = v_bulk_id
    and is_current;
  if v_count <> 1 then
    raise exception 'Reset-path check failed: branch_has_stock_item relationship not created for bulk item';
  end if;

  -- Category relationship
  select count(*) into v_count
  from relationships_v2
  where relationship_type = 'asset_category_has_stock_item'
    and parent_id = v_category_id
    and child_id = v_bulk_id
    and is_current;
  if v_count <> 1 then
    raise exception 'Reset-path check failed: asset_category_has_stock_item relationship not created for bulk item';
  end if;

  -- Opening balance TSP
  select count(*) into v_count
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_bulk_id
    and ft.key = 'stock_opening_balance'
    and (tsp.data_payload ->> 'quantity')::numeric = 50;
  if v_count <> 1 then
    raise exception 'Reset-path check failed: opening balance TSP not recorded for bulk item (quantity=50)';
  end if;

  raise notice 'PASS 5: create_stock_item bulk — entity, version, relationships, and opening balance correct';

  -- -------------------------------------------------------------------------
  -- 6. create_stock_item — sale kind with opening balance
  -- -------------------------------------------------------------------------

  select entity_id into v_sale_id
  from create_stock_item(
    p_name             => 'Safety Helmet',
    p_inventory_kind   => 'sale',
    p_opening_quantity => 100
  );

  if v_sale_id is null then
    raise exception 'Reset-path check failed: create_stock_item (sale) returned null entity_id';
  end if;

  select data ->> 'inventory_kind' into v_inventory_kind
  from entity_versions
  where entity_id = v_sale_id and is_current;
  if v_inventory_kind <> 'sale' then
    raise exception 'Reset-path check failed: sale item inventory_kind is "%", expected "sale"', v_inventory_kind;
  end if;

  select count(*) into v_count
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_sale_id
    and ft.key = 'stock_opening_balance'
    and (tsp.data_payload ->> 'quantity')::numeric = 100;
  if v_count <> 1 then
    raise exception 'Reset-path check failed: opening balance TSP not recorded for sale item (quantity=100)';
  end if;

  raise notice 'PASS 6: create_stock_item sale — entity and opening balance correct';

  -- -------------------------------------------------------------------------
  -- 7. create_stock_item — part kind (no opening balance)
  -- -------------------------------------------------------------------------

  select entity_id into v_part_id
  from create_stock_item(
    p_name           => 'Hydraulic Seal Kit',
    p_inventory_kind => 'part'
  );

  if v_part_id is null then
    raise exception 'Reset-path check failed: create_stock_item (part) returned null entity_id';
  end if;

  select data ->> 'inventory_kind' into v_inventory_kind
  from entity_versions
  where entity_id = v_part_id and is_current;
  if v_inventory_kind <> 'part' then
    raise exception 'Reset-path check failed: part item inventory_kind is "%", expected "part"', v_inventory_kind;
  end if;

  -- No opening balance TSP when opening_quantity is null
  select count(*) into v_count
  from time_series_points tsp
  join fact_types ft on ft.id = tsp.fact_type_id
  where tsp.entity_id = v_part_id
    and ft.key = 'stock_opening_balance';
  if v_count <> 0 then
    raise exception 'Reset-path check failed: unexpected opening balance TSP for part item with null opening_quantity';
  end if;

  raise notice 'PASS 7: create_stock_item part — entity correct, no spurious opening balance';

  -- -------------------------------------------------------------------------
  -- 8. rental_current_stock_items view surfaces reset-created items
  -- -------------------------------------------------------------------------

  select count(*) into v_count
  from rental_current_stock_items
  where entity_id in (v_bulk_id, v_sale_id, v_part_id);
  if v_count <> 3 then
    raise exception
      'Reset-path check failed: rental_current_stock_items should return 3 items, got %', v_count;
  end if;

  select inventory_kind into v_inventory_kind
  from rental_current_stock_items
  where entity_id = v_bulk_id;
  if v_inventory_kind <> 'bulk' then
    raise exception
      'Reset-path check failed: rental_current_stock_items inventory_kind is "%", expected "bulk"', v_inventory_kind;
  end if;

  raise notice 'PASS 8: rental_current_stock_items view returns all created stock items';

  raise notice 'ALL RESET-PATH CHECKS PASSED';
end;
$$;

rollback;
