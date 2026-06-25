-- Reset-path assertions for 20260618235000_inventory_kit_rpc_ensure.sql.
--
-- Confirms that after a full `supabase db reset` replay:
--   1. staff_upsert_inventory_kit exists in public.
--   2. rental_current_inventory_kits exists and is granted to authenticated.
--   3. rental_inventory_kit_components_current exists and is granted to authenticated.
--   4. staff_upsert_inventory_kit is executable by authenticated but not anon.
--   5. An admin-context call to staff_upsert_inventory_kit succeeds immediately after replay.
--   6. The created kit and component rows are readable from the rebuilt views.

begin;

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'staff_upsert_inventory_kit'
  ) then
    raise exception 'Reset-path FAIL 1: public.staff_upsert_inventory_kit missing after migration replay';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'rental_current_inventory_kits'
      and c.relkind in ('v', 'm')
  ) then
    raise exception 'Reset-path FAIL 2: public.rental_current_inventory_kits missing after migration replay';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'rental_inventory_kit_components_current'
      and c.relkind in ('v', 'm')
  ) then
    raise exception 'Reset-path FAIL 3: public.rental_inventory_kit_components_current missing after migration replay';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.staff_upsert_inventory_kit(uuid,text,text,date,date,uuid,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Reset-path FAIL 4: authenticated lacks EXECUTE on staff_upsert_inventory_kit after replay';
  end if;

  if has_function_privilege(
    'anon',
    'public.staff_upsert_inventory_kit(uuid,text,text,date,date,uuid,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'Reset-path FAIL 5: anon should not have EXECUTE on staff_upsert_inventory_kit';
  end if;

  if not has_table_privilege('authenticated', 'public.rental_current_inventory_kits', 'SELECT') then
    raise exception 'Reset-path FAIL 6: authenticated lacks SELECT on rental_current_inventory_kits';
  end if;

  if not has_table_privilege('authenticated', 'public.rental_inventory_kit_components_current', 'SELECT') then
    raise exception 'Reset-path FAIL 7: authenticated lacks SELECT on rental_inventory_kit_components_current';
  end if;

  if has_table_privilege('anon', 'public.rental_current_inventory_kits', 'SELECT') then
    raise exception 'Reset-path FAIL 8: anon should not have SELECT on rental_current_inventory_kits';
  end if;

  if has_table_privilege('anon', 'public.rental_inventory_kit_components_current', 'SELECT') then
    raise exception 'Reset-path FAIL 9: anon should not have SELECT on rental_inventory_kit_components_current';
  end if;

  raise notice 'PASS 1-9: inventory-kit RPC and views exist with expected grants after reset';
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-2222-4333-8444-555555555555","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_category_id uuid;
  v_kit_id uuid;
  v_entity_version_id uuid;
  v_version_number bigint;
  v_component_quantity numeric;
begin
  select seeded.entity_id
    into v_category_id
  from rental_upsert_entity_current_state(
    p_entity_type => 'asset_category',
    p_data => jsonb_build_object('name', 'Inventory Kit Reset Harness Category')
  ) as seeded;

  if v_category_id is null then
    raise exception 'Reset-path FAIL 10: could not seed asset_category fixture';
  end if;

  select k.kit_id, k.entity_version_id, k.version_number
    into v_kit_id, v_entity_version_id, v_version_number
  from public.staff_upsert_inventory_kit(
    p_name => 'Inventory Kit Reset Harness Kit',
    p_description => 'Validates staff_upsert_inventory_kit immediately after migration replay',
    p_components => jsonb_build_array(
      jsonb_build_object(
        'component_type', 'asset_category',
        'component_id', v_category_id,
        'component_name', 'Inventory Kit Reset Harness Category',
        'quantity', 3,
        'is_required', true,
        'is_default', false
      )
    )
  ) as k;

  if v_kit_id is null or v_entity_version_id is null or v_version_number < 1 then
    raise exception 'Reset-path FAIL 11: staff_upsert_inventory_kit did not return expected identifiers';
  end if;

  if not exists (
    select 1
    from public.rental_current_inventory_kits kits
    where kits.entity_id = v_kit_id
      and kits.name = 'Inventory Kit Reset Harness Kit'
  ) then
    raise exception 'Reset-path FAIL 12: created kit is not visible in rental_current_inventory_kits';
  end if;

  select quantity
    into v_component_quantity
  from public.rental_inventory_kit_components_current components
  where components.kit_id = v_kit_id
    and components.component_id = v_category_id
  limit 1;

  if v_component_quantity is null then
    raise exception 'Reset-path FAIL 13: created component is not visible in rental_inventory_kit_components_current';
  end if;

  if v_component_quantity <> 3 then
    raise exception 'Reset-path FAIL 14: expected component quantity 3 after replay, got %', v_component_quantity;
  end if;

  raise notice 'PASS 10-14: staff_upsert_inventory_kit is callable and its data is queryable after reset';
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
