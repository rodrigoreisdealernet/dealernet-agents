-- Behavioral authorization tests for rental_upsert_entity_current_state
-- (20260616080000_field_operator_asset_status_write.sql).
--
-- Assertions:
--   1.  anon role is denied (42501)
--   2.  authenticated with no app-role claim is denied (42501)
--   3.  authenticated with read_only app-role is denied (42501)
--   4.  authenticated with field_operator app-role is denied for a
--       disallowed entity type (e.g. 'customer') → 42501
--   5.  authenticated with field_operator app-role can upsert 'asset'
--   6.  field_operator asset upsert persists an entity + entity_version
--   7.  authenticated with admin app-role can upsert 'asset'
--   8.  authenticated with branch_manager app-role can upsert 'asset'
--   9.  service_role bypasses the app-role guard and can upsert 'asset'

begin;

-- ── 1. anon denied ────────────────────────────────────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.rental_upsert_entity_current_state('asset', '{"status":"available"}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%permission denied%' or sqlerrm ilike '%access denied%' then
        v_caught := true;
      else
        raise exception 'FAIL 1: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 1: anon should be denied rental_upsert_entity_current_state';
  end if;

  raise notice 'PASS 1: anon denied rental_upsert_entity_current_state';
end;
$$;

reset role;

-- ── 2. authenticated with no app-role claim is denied ─────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.rental_upsert_entity_current_state('asset', '{"status":"available"}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 2: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 2: authenticated (no app-role) should be denied rental_upsert_entity_current_state';
  end if;

  raise notice 'PASS 2: authenticated (no app-role) denied rental_upsert_entity_current_state';
end;
$$;

reset role;

-- ── 3. read_only app-role is denied ───────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"role":"read_only"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.rental_upsert_entity_current_state('asset', '{"status":"available"}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 3: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 3: read_only should be denied rental_upsert_entity_current_state';
  end if;

  raise notice 'PASS 3: read_only denied rental_upsert_entity_current_state';
end;
$$;

reset role;

-- ── 4. field_operator denied for disallowed entity type ───────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_caught bool := false;
begin
  begin
    perform public.rental_upsert_entity_current_state('customer', '{"name":"test"}'::jsonb);
  exception
    when insufficient_privilege then v_caught := true;
    when sqlstate '42501'       then v_caught := true;
    when others then
      if sqlerrm ilike '%access denied%' then v_caught := true;
      else raise exception 'FAIL 4: unexpected % "%"', sqlstate, sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'FAIL 4: field_operator should be denied for entity type customer';
  end if;

  raise notice 'PASS 4: field_operator denied for disallowed entity type (customer)';
end;
$$;

reset role;

-- ── 5-6. field_operator can upsert asset; entity + version persist ─────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000002","app_metadata":{"role":"field_operator"}}',
  true
);

do $$
declare
  v_entity_id         uuid;
  v_entity_version_id uuid;
  v_entity_type       text;
  v_version_number    int;
  v_version_count     int;
begin
  select r.entity_id, r.entity_version_id, r.entity_type, r.version_number
    into v_entity_id, v_entity_version_id, v_entity_type, v_version_number
  from public.rental_upsert_entity_current_state(
    'asset',
    '{"status":"returned","serial_number":"FO-ASSET-TEST-001"}'::jsonb
  ) as r;

  if v_entity_id is null then
    raise exception 'FAIL 5: field_operator asset upsert returned null entity_id';
  end if;
  if v_entity_type <> 'asset' then
    raise exception 'FAIL 5: expected entity_type=asset, got %', v_entity_type;
  end if;
  if v_version_number < 1 then
    raise exception 'FAIL 5: expected version_number >= 1, got %', v_version_number;
  end if;

  raise notice 'PASS 5: field_operator asset upsert returned entity_id=% version=%',
    v_entity_id, v_version_number;

  -- Verify entity row persisted in entities table.
  if not exists (
    select 1 from public.entities
    where id = v_entity_id and entity_type = 'asset'
  ) then
    raise exception 'FAIL 6: asset entity row not found in entities table';
  end if;

  -- Verify at least one version row was written.
  select count(*) into v_version_count
  from public.entity_versions
  where entity_id = v_entity_id;

  if v_version_count < 1 then
    raise exception 'FAIL 6: no entity_versions row found for asset entity_id=%', v_entity_id;
  end if;

  raise notice 'PASS 6: asset entity + entity_version persisted correctly (% version rows)',
    v_version_count;
end;
$$;

reset role;

-- ── 7. admin can upsert asset ─────────────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000003","app_metadata":{"role":"admin"}}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select r.entity_id into v_entity_id
  from public.rental_upsert_entity_current_state(
    'asset',
    '{"status":"available","serial_number":"ADMIN-ASSET-001"}'::jsonb
  ) as r;

  if v_entity_id is null then
    raise exception 'FAIL 7: admin asset upsert returned null entity_id';
  end if;

  raise notice 'PASS 7: admin can upsert asset, entity_id=%', v_entity_id;
end;
$$;

reset role;

-- ── 8. branch_manager can upsert asset ───────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000004","app_metadata":{"role":"branch_manager"}}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select r.entity_id into v_entity_id
  from public.rental_upsert_entity_current_state(
    'asset',
    '{"status":"inspection_hold","serial_number":"BM-ASSET-001"}'::jsonb
  ) as r;

  if v_entity_id is null then
    raise exception 'FAIL 8: branch_manager asset upsert returned null entity_id';
  end if;

  raise notice 'PASS 8: branch_manager can upsert asset, entity_id=%', v_entity_id;
end;
$$;

reset role;

-- ── 9. service_role bypasses app-role guard ───────────────────────────────────

select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

do $$
declare
  v_entity_id uuid;
begin
  select r.entity_id into v_entity_id
  from public.rental_upsert_entity_current_state(
    'asset',
    '{"status":"maintenance","serial_number":"SVC-ASSET-001"}'::jsonb
  ) as r;

  if v_entity_id is null then
    raise exception 'FAIL 9: service_role asset upsert returned null entity_id';
  end if;

  raise notice 'PASS 9: service_role can upsert asset, entity_id=%', v_entity_id;
end;
$$;

select set_config('request.jwt.claims', '', true);

rollback;
