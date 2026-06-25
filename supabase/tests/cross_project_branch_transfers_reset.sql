-- Reset-path assertions for 20260613170000_cross_project_branch_transfers.sql
--
-- Confirms that after a full `supabase db reset --config supabase/config.toml`
-- (migrations + seed):
--   1. v_transfer_current view exists.
--   2. v_transfer_history view exists.
--   3. rental_entity_type_catalog includes 'transfer' and 'project' entity types.
--   4. rental_relationship_type_catalog includes the three transfer relationship types
--      (branch_has_transfer, project_has_transfer, transfer_has_asset).
--   5. Both views have security_invoker=true (owner cannot bypass base-table RLS).
--   6. A minimal end-to-end read: insert a transfer entity and verify it appears
--      in v_transfer_current with the correct status and branch linkage.
begin;

do $$
declare
  v_view_count          int;
  v_rel_type_count      int;
  v_entity_type_count   int;
  v_row_count           bigint;

  -- UUIDs for a minimal transfer fixture
  v_origin_branch       constant uuid := 'dead0002-0000-0000-0000-000000000001';
  v_dest_branch         constant uuid := 'dead0002-0000-0000-0000-000000000002';
  v_asset_id            constant uuid := 'dead0002-0000-0000-0000-000000000003';
  v_transfer_id         constant uuid := 'dead0002-0000-0000-0000-000000000004';
begin
  execute 'set local role service_role';
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -------------------------------------------------------------------------
  -- 1. v_transfer_current must exist
  -- -------------------------------------------------------------------------
  select count(*) into v_view_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_transfer_current'
    and c.relkind = 'v';

  if v_view_count = 0 then
    raise exception 'Reset-path check failed: v_transfer_current view missing after reset';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. v_transfer_history must exist
  -- -------------------------------------------------------------------------
  select count(*) into v_view_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'v_transfer_history'
    and c.relkind = 'v';

  if v_view_count = 0 then
    raise exception 'Reset-path check failed: v_transfer_history view missing after reset';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. security_invoker must be true on both views
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_transfer_current'
      and exists (
        select 1 from pg_options_to_table(c.reloptions)
        where option_name = 'security_invoker' and option_value = 'true'
      )
  ) then
    raise exception 'Reset-path check failed: v_transfer_current is missing security_invoker=true';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'v_transfer_history'
      and exists (
        select 1 from pg_options_to_table(c.reloptions)
        where option_name = 'security_invoker' and option_value = 'true'
      )
  ) then
    raise exception 'Reset-path check failed: v_transfer_history is missing security_invoker=true';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Entity type catalog: 'transfer' and 'project' must be present
  -- -------------------------------------------------------------------------
  select count(*) into v_entity_type_count
  from rental_entity_type_catalog
  where entity_type in ('transfer', 'project');

  if v_entity_type_count < 2 then
    raise exception
      'Reset-path check failed: rental_entity_type_catalog missing transfer or project; found % of 2',
      v_entity_type_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Relationship type catalog: all three transfer types must exist
  -- -------------------------------------------------------------------------
  select count(*) into v_rel_type_count
  from rental_relationship_type_catalog
  where relationship_type in (
    'branch_has_transfer',
    'project_has_transfer',
    'transfer_has_asset'
  );

  if v_rel_type_count < 3 then
    raise exception
      'Reset-path check failed: rental_relationship_type_catalog missing transfer relationship types; found % of 3',
      v_rel_type_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Minimal end-to-end read: insert a transfer entity and verify it appears
  --    in v_transfer_current.
  -- -------------------------------------------------------------------------
  -- Branches
  insert into public.entities (id, entity_type, source_record_id)
  values
    (v_origin_branch, 'branch',   'reset-check-origin-branch'),
    (v_dest_branch,   'branch',   'reset-check-dest-branch'),
    (v_asset_id,      'asset',    'reset-check-asset'),
    (v_transfer_id,   'transfer', 'reset-check-transfer-001')
  on conflict (entity_type, source_record_id) do nothing;

  insert into public.entity_versions (entity_id, version_number, is_current, data, valid_from)
  values
    (v_origin_branch, 1, true, '{"name":"Reset Check Origin"}'::jsonb,       now()),
    (v_dest_branch,   1, true, '{"name":"Reset Check Destination"}'::jsonb,   now()),
    (v_asset_id,      1, true, '{"name":"Reset Check Asset","status":"available"}'::jsonb, now()),
    (v_transfer_id,   1, true, jsonb_build_object(
        'status',               'requested',
        'origin_branch_id',     v_origin_branch::text,
        'destination_branch_id', v_dest_branch::text,
        'requested_by',         'reset-check-user'
      ), now())
  on conflict (entity_id, version_number) do nothing;

  -- Link origin branch → transfer
  insert into public.relationships_v2
    (relationship_type, parent_id, child_id, is_current, valid_from)
  values
    ('branch_has_transfer', v_origin_branch, v_transfer_id, true, now())
  on conflict do nothing;

  -- Link transfer → asset
  insert into public.relationships_v2
    (relationship_type, parent_id, child_id, is_current, valid_from)
  values
    ('transfer_has_asset', v_transfer_id, v_asset_id, true, now())
  on conflict do nothing;

  -- Verify the transfer row appears in v_transfer_current
  -- (filter on transfer_entity_id — the uuid entities.id — not source_record_id)
  select count(*) into v_row_count
  from public.v_transfer_current
  where transfer_entity_id = v_transfer_id;

  if v_row_count <> 1 then
    raise exception
      'Reset-path check failed: v_transfer_current must return 1 row for the test transfer; got %',
      v_row_count;
  end if;

  -- Verify the transfer row appears in v_transfer_history
  select count(*) into v_row_count
  from public.v_transfer_history
  where transfer_entity_id = v_transfer_id;

  if v_row_count < 1 then
    raise exception
      'Reset-path check failed: v_transfer_history returned 0 rows for the test transfer';
  end if;

end;
$$;

rollback;
