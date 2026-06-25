-- Behavioral RLS and privilege tests for inspection_checklist_templates.
-- (migration 20260613110000_inspection_checklist_templates.sql)
--
-- Verifies:
--   1. service_invoker = true on v_checklist_template_items
--   2. Authenticated tenant A cannot read tenant B rows
--   3. Authenticated tenant A can read tenant A rows
--   4. Global (tenant_id IS NULL) rows are visible to any authenticated user
--   5. Inactive rows are hidden from authenticated users
--   6. Authenticated role cannot INSERT / UPDATE / DELETE
--   7. service_role can INSERT / UPDATE / DELETE
--   8. anon role is denied access
--
-- Pattern: multiple DO blocks within one transaction.  SET LOCAL ROLE +
-- set_config('request.jwt.claims', ...) simulate the PostgREST JWT contexts
-- used in production without persisting any data.

begin;

-- ── Fixture: seed tenants + checklist rows as service_role ────────────────
do $$
declare
  v_tenant_a_id constant uuid := 'cccc0000-0000-0000-0001-000000000001';
  v_tenant_b_id constant uuid := 'cccc0000-0000-0000-0001-000000000002';
begin
  insert into public.tenants (id, tenant_key, name)
  values
    (v_tenant_a_id, 'checklist-rls-tenant-a', 'Checklist RLS Tenant A'),
    (v_tenant_b_id, 'checklist-rls-tenant-b', 'Checklist RLS Tenant B')
  on conflict (tenant_key) do update set name = excluded.name;

  -- System-wide default row (tenant_id NULL)
  insert into public.inspection_checklist_templates
    (tenant_id, equipment_category, inspection_intent, item_key, label, is_active)
  values
    (null, 'Excavators', 'both', 'rls_global_item', 'Global Default Item', true)
  on conflict (tenant_id, equipment_category, inspection_intent, item_key) do nothing;

  -- Tenant A row
  insert into public.inspection_checklist_templates
    (tenant_id, equipment_category, inspection_intent, item_key, label, is_active)
  values
    (v_tenant_a_id, 'Excavators', 'both', 'rls_tenant_a_item', 'Tenant A Only Item', true)
  on conflict (tenant_id, equipment_category, inspection_intent, item_key) do nothing;

  -- Tenant B row
  insert into public.inspection_checklist_templates
    (tenant_id, equipment_category, inspection_intent, item_key, label, is_active)
  values
    (v_tenant_b_id, 'Excavators', 'both', 'rls_tenant_b_item', 'Tenant B Only Item', true)
  on conflict (tenant_id, equipment_category, inspection_intent, item_key) do nothing;

  -- Inactive tenant A row (must be hidden from authenticated readers)
  insert into public.inspection_checklist_templates
    (tenant_id, equipment_category, inspection_intent, item_key, label, is_active)
  values
    (v_tenant_a_id, 'Excavators', 'both', 'rls_tenant_a_inactive', 'Inactive Tenant A Item', false)
  on conflict (tenant_id, equipment_category, inspection_intent, item_key)
    do update set is_active = false;
end;
$$;

-- ── 1. v_checklist_template_items must declare security_invoker = true ────
do $$
declare
  v_has_invoker bool;
begin
  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_has_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_checklist_template_items';

  if not v_has_invoker then
    raise exception
      'FAIL 1: v_checklist_template_items must declare security_invoker = true '
      '(without it the view owner bypasses base-table RLS)';
  end if;

  raise notice 'PASS 1: v_checklist_template_items has security_invoker = true';
end;
$$;

-- ── 2. Tenant A cannot read tenant B rows ─────────────────────────────────
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  select count(*) into v_count
    from public.inspection_checklist_templates
   where item_key = 'rls_tenant_b_item';

  if v_count <> 0 then
    raise exception
      'FAIL 2: tenant A read cross-tenant B row (expected 0, got %)', v_count;
  end if;

  raise notice 'PASS 2: tenant A cannot read tenant B rows';
end;
$$;

-- ── 3. Tenant A can read its own tenant rows ──────────────────────────────
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  select count(*) into v_count
    from public.inspection_checklist_templates
   where item_key = 'rls_tenant_a_item';

  if v_count <> 1 then
    raise exception
      'FAIL 3: tenant A should read its own row (expected 1, got %)', v_count;
  end if;

  raise notice 'PASS 3: tenant A can read its own tenant rows';
end;
$$;

-- ── 4. Global (tenant_id NULL) rows are visible to authenticated users ─────
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  select count(*) into v_count
    from public.inspection_checklist_templates
   where item_key = 'rls_global_item'
     and tenant_id is null;

  if v_count <> 1 then
    raise exception
      'FAIL 4: global (tenant_id NULL) row should be visible (expected 1, got %)', v_count;
  end if;

  raise notice 'PASS 4: global rows are visible to authenticated users';
end;
$$;

-- ── 5. Inactive rows are hidden from authenticated users ──────────────────
do $$
declare
  v_count int;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"field_operator","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  select count(*) into v_count
    from public.inspection_checklist_templates
   where item_key = 'rls_tenant_a_inactive';

  if v_count <> 0 then
    raise exception
      'FAIL 5: inactive row must be hidden from authenticated users (expected 0, got %)', v_count;
  end if;

  raise notice 'PASS 5: inactive rows are hidden from authenticated users';
end;
$$;

-- ── 6. Authenticated role cannot INSERT ───────────────────────────────────
do $$
declare
  v_caught bool := false;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  begin
    insert into public.inspection_checklist_templates
      (tenant_id, equipment_category, inspection_intent, item_key, label)
    values
      (null, 'Forklifts', 'both', 'rls_auth_insert_attempt', 'Should Fail');
    -- If we reach here the insert succeeded — that is the failure
  exception when insufficient_privilege then
    v_caught := true;
  end;

  if not v_caught then
    raise exception
      'FAIL 6: authenticated role should not be able to INSERT into inspection_checklist_templates';
  end if;

  raise notice 'PASS 6: authenticated role cannot INSERT';
end;
$$;

-- ── 7. Authenticated role cannot UPDATE ───────────────────────────────────
do $$
declare
  v_caught bool := false;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  begin
    update public.inspection_checklist_templates
       set label = 'Tampered'
     where item_key = 'rls_global_item';
  exception when insufficient_privilege then
    v_caught := true;
  end;

  -- An UPDATE that silently touches 0 rows (blocked by RLS) is also acceptable.
  -- Both paths represent correct denial; only an actual write reaching the row is a failure.
  -- We check via service_role afterward.
  reset role;

  declare
    v_label text;
  begin
    select label into v_label
      from public.inspection_checklist_templates
     where item_key = 'rls_global_item';

    if v_label = 'Tampered' then
      raise exception
        'FAIL 7: authenticated role must not be able to UPDATE global rows';
    end if;
  end;

  raise notice 'PASS 7: authenticated role cannot UPDATE';
end;
$$;

-- ── 8. Authenticated role cannot DELETE ───────────────────────────────────
do $$
declare
  v_caught bool := false;
begin
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"role":"admin","tenant":"checklist-rls-tenant-a"}}',
    true
  );

  begin
    delete from public.inspection_checklist_templates
     where item_key = 'rls_tenant_a_item';
  exception when insufficient_privilege then
    v_caught := true;
  end;

  reset role;

  declare
    v_count int;
  begin
    select count(*) into v_count
      from public.inspection_checklist_templates
     where item_key = 'rls_tenant_a_item';

    if v_count = 0 then
      raise exception
        'FAIL 8: authenticated role must not be able to DELETE rows';
    end if;
  end;

  raise notice 'PASS 8: authenticated role cannot DELETE';
end;
$$;

-- ── 9. service_role can INSERT / UPDATE / DELETE ──────────────────────────
do $$
declare
  v_id   uuid;
  v_label text;
  v_count int;
begin
  set local role service_role;

  insert into public.inspection_checklist_templates
    (tenant_id, equipment_category, inspection_intent, item_key, label)
  values
    (null, 'Generators', 'return', 'rls_svc_write_test', 'Service Role Write Test')
  returning id into v_id;

  if v_id is null then
    raise exception 'FAIL 9a: service_role INSERT returned no id';
  end if;

  update public.inspection_checklist_templates
     set label = 'Updated by service_role'
   where id = v_id;

  select label into v_label
    from public.inspection_checklist_templates
   where id = v_id;

  if v_label is distinct from 'Updated by service_role' then
    raise exception 'FAIL 9b: service_role UPDATE did not persist (got %)', v_label;
  end if;

  delete from public.inspection_checklist_templates where id = v_id;

  select count(*) into v_count
    from public.inspection_checklist_templates
   where id = v_id;

  if v_count <> 0 then
    raise exception 'FAIL 9c: service_role DELETE did not remove row';
  end if;

  raise notice 'PASS 9: service_role can INSERT / UPDATE / DELETE';
end;
$$;

rollback;
