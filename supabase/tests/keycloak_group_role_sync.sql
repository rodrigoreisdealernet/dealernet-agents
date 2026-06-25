-- Behavioral tests for the Keycloak group→role sync migration (20260609210000).
--
-- Verifies:
--   1. keycloak_groups_to_role() function exists and maps groups correctly.
--   2. Updated handle_new_user() function exists.
--   3. keycloak_groups_to_role() returns the most-privileged role for each canonical group.
--   4. keycloak_groups_to_role() defaults to read_only for unmapped or empty groups.
--   5. handle_new_user() trigger writes correct profiles.role and profiles.tenant for
--      admin / branch_manager / field_operator / read_only Keycloak users.
--   6. Trigger defaults profiles.role to read_only for unmapped Keycloak groups.
--   7. Tenant fallback chain: user_meta.tenant > app_meta.tenant > 'default'.
--   8. Non-Keycloak users: role and tenant are read from raw_app_meta_data.
--   9. raw_app_meta_data is backfilled with role + tenant after a Keycloak INSERT.
--  10. Recursion guard: trigger chain completes without error; final profile state is correct.

begin;

do $$
declare
  v_count int;
  v_role  public.app_role;
begin

  -- ── 1. keycloak_groups_to_role function exists ──────────────────────────────
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'keycloak_groups_to_role';

  if v_count <> 1 then
    raise exception 'keycloak_groups_to_role function does not exist';
  end if;

  -- ── 2. handle_new_user trigger function exists ───────────────────────────────
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'handle_new_user';

  if v_count <> 1 then
    raise exception 'handle_new_user function does not exist';
  end if;

  -- ── 3. Group → role mapping (affirmative cases) ──────────────────────────────

  -- wynne-admin → admin
  v_role := public.keycloak_groups_to_role('["wynne-admin"]'::jsonb);
  if v_role <> 'admin' then
    raise exception 'wynne-admin group should map to admin, got %', v_role;
  end if;

  -- wynne-branch-manager → branch_manager
  v_role := public.keycloak_groups_to_role('["wynne-branch-manager"]'::jsonb);
  if v_role <> 'branch_manager' then
    raise exception 'wynne-branch-manager group should map to branch_manager, got %', v_role;
  end if;

  -- wynne-field-operator → field_operator
  v_role := public.keycloak_groups_to_role('["wynne-field-operator"]'::jsonb);
  if v_role <> 'field_operator' then
    raise exception 'wynne-field-operator group should map to field_operator, got %', v_role;
  end if;

  -- wynne-read-only → read_only
  v_role := public.keycloak_groups_to_role('["wynne-read-only"]'::jsonb);
  if v_role <> 'read_only' then
    raise exception 'wynne-read-only group should map to read_only, got %', v_role;
  end if;

  -- ── 4. Edge cases ────────────────────────────────────────────────────────────

  -- empty groups → read_only (default)
  v_role := public.keycloak_groups_to_role('[]'::jsonb);
  if v_role <> 'read_only' then
    raise exception 'empty groups should default to read_only, got %', v_role;
  end if;

  -- unmapped group → read_only (default)
  v_role := public.keycloak_groups_to_role('["some-other-group"]'::jsonb);
  if v_role <> 'read_only' then
    raise exception 'unmapped group should default to read_only, got %', v_role;
  end if;

  -- most-privileged wins: admin takes priority over branch_manager
  v_role := public.keycloak_groups_to_role('["wynne-branch-manager","wynne-admin"]'::jsonb);
  if v_role <> 'admin' then
    raise exception 'admin group should win over branch_manager, got %', v_role;
  end if;

  -- most-privileged wins: branch_manager takes priority over field_operator
  v_role := public.keycloak_groups_to_role('["wynne-field-operator","wynne-branch-manager"]'::jsonb);
  if v_role <> 'branch_manager' then
    raise exception 'branch_manager should win over field_operator, got %', v_role;
  end if;

  raise notice 'keycloak_group_role_sync: function/mapping checks passed';
end;
$$;

-- ── 5–10. Trigger behavioral tests ───────────────────────────────────────────
-- Exercise handle_new_user() end-to-end via auth.users INSERT.
-- Each sub-test inserts one row and asserts the resulting profiles row and
-- (where applicable) the backfilled raw_app_meta_data on auth.users.
-- All changes are rolled back by the outer BEGIN … ROLLBACK.

do $$
declare
  v_uid      uuid;
  v_role     public.app_role;
  v_tenant   text;
  v_app_meta jsonb;
begin

  -- ── 5. Keycloak group → role mapping through the trigger ──────────────────────

  -- 5a. admin
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-admin@test.invalid',
    '{"provider":"keycloak","providers":["keycloak"]}'::jsonb,
    '{"groups":["wynne-admin"],"tenant":"acme"}'::jsonb
  );

  select role, tenant into v_role, v_tenant
  from public.profiles where id = v_uid;

  if v_role <> 'admin' then
    raise exception 'Trigger admin: profiles.role expected admin, got %', v_role;
  end if;
  if v_tenant <> 'acme' then
    raise exception 'Trigger admin: profiles.tenant expected acme, got %', v_tenant;
  end if;

  -- 5b. branch_manager
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-bm@test.invalid',
    '{"provider":"keycloak"}'::jsonb,
    '{"groups":["wynne-branch-manager"],"tenant":"branch-co"}'::jsonb
  );

  select role into v_role from public.profiles where id = v_uid;
  if v_role <> 'branch_manager' then
    raise exception 'Trigger branch_manager: profiles.role expected branch_manager, got %', v_role;
  end if;

  -- 5c. field_operator
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-fo@test.invalid',
    '{"provider":"keycloak"}'::jsonb,
    '{"groups":["wynne-field-operator"],"tenant":"field-co"}'::jsonb
  );

  select role into v_role from public.profiles where id = v_uid;
  if v_role <> 'field_operator' then
    raise exception 'Trigger field_operator: profiles.role expected field_operator, got %', v_role;
  end if;

  -- 5d. read_only (explicit group)
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-ro@test.invalid',
    '{"provider":"keycloak"}'::jsonb,
    '{"groups":["wynne-read-only"],"tenant":"ro-co"}'::jsonb
  );

  select role into v_role from public.profiles where id = v_uid;
  if v_role <> 'read_only' then
    raise exception 'Trigger read_only: profiles.role expected read_only, got %', v_role;
  end if;

  -- ── 6. Unmapped Keycloak group → read_only default ────────────────────────────
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-unmapped@test.invalid',
    '{"provider":"keycloak"}'::jsonb,
    '{"groups":["some-unknown-group"]}'::jsonb
  );

  select role into v_role from public.profiles where id = v_uid;
  if v_role <> 'read_only' then
    raise exception 'Trigger unmapped group: profiles.role expected read_only, got %', v_role;
  end if;

  -- ── 7. Tenant fallback chain ──────────────────────────────────────────────────

  -- 7a. user_meta.tenant takes priority over app_meta.tenant
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-tenant-priority@test.invalid',
    '{"provider":"keycloak","tenant":"app-tenant"}'::jsonb,
    '{"groups":["wynne-admin"],"tenant":"user-tenant"}'::jsonb
  );

  select tenant into v_tenant from public.profiles where id = v_uid;
  if v_tenant <> 'user-tenant' then
    raise exception 'Tenant priority: expected user-tenant (user_meta wins), got %', v_tenant;
  end if;

  -- 7b. app_meta.tenant used when user_meta.tenant is absent
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-tenant-app-fallback@test.invalid',
    '{"provider":"keycloak","tenant":"app-co"}'::jsonb,
    '{"groups":["wynne-admin"]}'::jsonb
  );

  select tenant into v_tenant from public.profiles where id = v_uid;
  if v_tenant <> 'app-co' then
    raise exception 'Tenant fallback to app_meta: expected app-co, got %', v_tenant;
  end if;

  -- 7c. 'default' used when both user_meta and app_meta tenants are absent
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-tenant-default@test.invalid',
    '{"provider":"keycloak"}'::jsonb,
    '{"groups":["wynne-admin"]}'::jsonb
  );

  select tenant into v_tenant from public.profiles where id = v_uid;
  if v_tenant <> 'default' then
    raise exception 'Tenant fallback to default: expected default, got %', v_tenant;
  end if;

  -- ── 8. Non-Keycloak users: role and tenant from raw_app_meta_data ─────────────

  -- 8a. admin role set explicitly
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'local-admin@test.invalid',
    '{"provider":"email","role":"admin","tenant":"local-co"}'::jsonb,
    '{}'::jsonb
  );

  select role, tenant into v_role, v_tenant from public.profiles where id = v_uid;
  if v_role <> 'admin' then
    raise exception 'Non-Keycloak admin: profiles.role expected admin, got %', v_role;
  end if;
  if v_tenant <> 'local-co' then
    raise exception 'Non-Keycloak admin: profiles.tenant expected local-co, got %', v_tenant;
  end if;

  -- 8b. no role in app_metadata → read_only default
  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'local-norole@test.invalid',
    '{"provider":"email"}'::jsonb,
    '{}'::jsonb
  );

  select role into v_role from public.profiles where id = v_uid;
  if v_role <> 'read_only' then
    raise exception 'Non-Keycloak no-role: profiles.role expected read_only, got %', v_role;
  end if;

  -- ── 9. raw_app_meta_data backfill after Keycloak INSERT ──────────────────────
  -- After a Keycloak-federated INSERT the trigger UPDATEs auth.users to embed
  -- role + tenant in raw_app_meta_data.  Both fields must be present.

  v_uid := gen_random_uuid();
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (
    v_uid,
    'kc-backfill@test.invalid',
    '{"provider":"keycloak","providers":["email","keycloak"]}'::jsonb,
    '{"groups":["wynne-branch-manager"],"tenant":"backfill-co"}'::jsonb
  );

  select raw_app_meta_data into v_app_meta from auth.users where id = v_uid;
  if v_app_meta ->> 'role' is distinct from 'branch_manager' then
    raise exception 'Backfill: raw_app_meta_data.role expected branch_manager, got %', v_app_meta ->> 'role';
  end if;
  if v_app_meta ->> 'tenant' is distinct from 'backfill-co' then
    raise exception 'Backfill: raw_app_meta_data.tenant expected backfill-co, got %', v_app_meta ->> 'tenant';
  end if;

  -- ── 10. Recursion guard ───────────────────────────────────────────────────────
  -- The Keycloak trigger path UPDATEs auth.users at depth 1, which re-fires
  -- handle_new_user() at depth 2.  The pg_trigger_depth() = 1 guard must prevent
  -- a further UPDATE at depth 2, avoiding infinite recursion.
  -- If this INSERT completes without a stack-overflow or recursion error, the guard
  -- is working.  We additionally assert the final profile is in a correct state.

  begin
    v_uid := gen_random_uuid();
    insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
    values (
      v_uid,
      'kc-recursion@test.invalid',
      '{"provider":"keycloak"}'::jsonb,
      '{"groups":["wynne-field-operator"],"tenant":"recursion-co"}'::jsonb
    );

    select role, tenant into v_role, v_tenant from public.profiles where id = v_uid;
    if v_role <> 'field_operator' then
      raise exception 'Recursion guard: profiles.role expected field_operator, got %', v_role;
    end if;
    if v_tenant <> 'recursion-co' then
      raise exception 'Recursion guard: profiles.tenant expected recursion-co, got %', v_tenant;
    end if;
  exception when others then
    raise exception 'Recursion guard: trigger raised unexpected error: %', sqlerrm;
  end;

  raise notice 'keycloak_group_role_sync: trigger behavioral tests passed';
end;
$$;

rollback;
