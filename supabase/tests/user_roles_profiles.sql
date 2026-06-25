-- Smoke tests for the user_roles_profiles migration (20260607120000).
--
-- Verifies:
--   1. app_role enum exists with the expected labels.
--   2. profiles table exists with the expected columns.
--   3. get_my_role() / get_my_tenant() functions exist.
--   4. Trigger handle_new_user exists on auth.users.
--   5. RLS is enabled on profiles.
--   6. Expected RLS policies exist on profiles.
--   7. Role-gated policies were added to core entity tables.
--   8. Behavioral RLS checks respect assumed JWT role + subject context.

begin;

do $$
declare
  v_count int;
  v_has_enum bool;
begin

  -- ── 1. app_role enum ────────────────────────────────────────────────────────
  select exists(
    select 1 from pg_type where typname = 'app_role' and typtype = 'e'
  ) into v_has_enum;

  if not v_has_enum then
    raise exception 'app_role enum type does not exist';
  end if;

  select count(*) into v_count
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  where t.typname = 'app_role'
    and e.enumlabel in ('admin','branch_manager','field_operator','read_only');

  if v_count <> 4 then
    raise exception 'app_role enum: expected 4 values, found %', v_count;
  end if;

  -- ── 2. profiles table ───────────────────────────────────────────────────────
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'profiles'
    and column_name  in ('id','display_name','role','tenant','created_at','updated_at');

  if v_count <> 6 then
    raise exception 'profiles table: expected 6 columns, found %', v_count;
  end if;

  -- ── 3. Helper functions ──────────────────────────────────────────────────────
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('get_my_role','get_my_tenant');

  if v_count <> 2 then
    raise exception 'Expected get_my_role and get_my_tenant functions, found %', v_count;
  end if;

  -- ── 4. Trigger on auth.users ─────────────────────────────────────────────────
  select count(*) into v_count
  from information_schema.triggers
  where event_object_schema = 'auth'
    and event_object_table  = 'users'
    and trigger_name        in ('on_auth_user_created','on_auth_user_updated');

  if v_count <> 2 then
    raise exception 'Expected 2 triggers on auth.users (created+updated), found %', v_count;
  end if;

  -- ── 5. RLS enabled on profiles ───────────────────────────────────────────────
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'profiles'
    and c.relrowsecurity;

  if v_count <> 1 then
    raise exception 'RLS is not enabled on public.profiles';
  end if;

  -- ── 6. RLS policies on profiles ──────────────────────────────────────────────
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'profiles'
    and policyname in (
      'profiles_select_own',
      'profiles_select_admin',
      'profiles_update_own',
      'profiles_admin_all'
    );

  if v_count <> 4 then
    raise exception 'Expected 4 RLS policies on profiles, found %', v_count;
  end if;

  -- ── 7. Role-gated policies on core entity tables ─────────────────────────────
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and policyname in (
      'authenticated_read',
      'authenticated_manager_write',
      'authenticated_field_insert'
    );

  if v_count < 3 then
    raise exception 'Expected at least 3 authenticated role policies on entity tables, found %', v_count;
  end if;

  raise notice 'user_roles_profiles migration smoke tests: all checks passed';
end;
$$;

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '11111111-1111-1111-1111-111111111111'::uuid,
    'authenticated',
    'authenticated',
    'admin-role-test@example.test',
    'unused-test-fixture',
    now(),
    jsonb_build_object('role', 'admin', 'tenant', 'default'),
    jsonb_build_object('display_name', 'Admin Role Test'),
    now(),
    now()
  ),
  (
    '22222222-2222-2222-2222-222222222222'::uuid,
    'authenticated',
    'authenticated',
    'manager-role-test@example.test',
    'unused-test-fixture',
    now(),
    jsonb_build_object('role', 'branch_manager', 'tenant', 'default'),
    jsonb_build_object('display_name', 'Manager Role Test'),
    now(),
    now()
  ),
  (
    '33333333-3333-3333-3333-333333333333'::uuid,
    'authenticated',
    'authenticated',
    'operator-role-test@example.test',
    'unused-test-fixture',
    now(),
    jsonb_build_object('role', 'field_operator', 'tenant', 'default'),
    jsonb_build_object('display_name', 'Operator Role Test'),
    now(),
    now()
  ),
  (
    '44444444-4444-4444-4444-444444444444'::uuid,
    'authenticated',
    'authenticated',
    'readonly-role-test@example.test',
    'unused-test-fixture',
    now(),
    jsonb_build_object('role', 'read_only', 'tenant', 'default'),
    jsonb_build_object('display_name', 'Read Only Role Test'),
    now(),
    now()
  );

insert into public.entities (id, entity_type, source_record_id)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid, 'branch', 'role-matrix-seed-a'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid, 'branch', 'role-matrix-seed-b');

do $$
declare
  v_count int;
begin
  select count(*)
    into v_count
  from public.profiles
  where id in (
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    '44444444-4444-4444-4444-444444444444'::uuid
  );

  if v_count <> 4 then
    raise exception 'Expected 4 seeded profiles from auth.users triggers, found %', v_count;
  end if;
end;
$$;

select set_config('request.jwt.claims', '', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '11111111-1111-1111-1111-111111111111',
    'app_metadata', jsonb_build_object('role', 'admin', 'tenant', 'default')
  )::text,
  true
);

do $$
declare
  v_profile_count int;
  v_self_profile_count int;
  v_entity_id uuid;
  v_updated_source text;
  v_caught bool;
begin
  select count(*), count(*) filter (where id = '11111111-1111-1111-1111-111111111111'::uuid)
    into v_profile_count, v_self_profile_count
  from public.profiles;

  if v_profile_count <> 4 or v_self_profile_count <> 1 then
    raise exception 'admin profile read expected 4 visible rows including self, found total=% self=%', v_profile_count, v_self_profile_count;
  end if;

  update public.profiles
     set display_name = 'Admin Role Test Updated'
   where id = '11111111-1111-1111-1111-111111111111'::uuid;

  if not found then
    raise exception 'admin own-profile update should succeed';
  end if;

  insert into public.entities (entity_type, source_record_id)
  values ('inspection', 'admin-role-matrix-insert')
  returning id into v_entity_id;

  if v_entity_id is null then
    raise exception 'admin direct entity insert returned null id';
  end if;

  update public.entities
     set source_record_id = 'admin-role-matrix-updated'
   where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid;

  if not found then
    raise exception 'admin direct entity update should succeed';
  end if;

  select source_record_id
    into v_updated_source
  from public.entities
  where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid;

  if v_updated_source <> 'admin-role-matrix-updated' then
    raise exception 'admin update expected source_record_id admin-role-matrix-updated, found %', v_updated_source;
  end if;

  v_caught := false;
  begin
    -- Direct profile inserts are never allowed through the authenticated table path;
    -- profile rows must originate from auth.users + the sync trigger.
    insert into public.profiles (id, display_name, role, tenant)
    values (gen_random_uuid(), 'admin-denied-insert', 'read_only', 'default');
  exception
    when insufficient_privilege then
      v_caught := true;
    when sqlstate '42501' then
      v_caught := true;
    when others then
      raise exception 'admin denied profile insert raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'admin profile insert unexpectedly succeeded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '22222222-2222-2222-2222-222222222222',
    'app_metadata', jsonb_build_object('role', 'branch_manager', 'tenant', 'default')
  )::text,
  true
);

do $$
declare
  v_profile_count int;
  v_self_profile_count int;
  v_entity_id uuid;
  v_updated_source text;
  v_caught bool;
begin
  select count(*), count(*) filter (where id = '22222222-2222-2222-2222-222222222222'::uuid)
    into v_profile_count, v_self_profile_count
  from public.profiles;

  if v_profile_count <> 1 or v_self_profile_count <> 1 then
    raise exception 'branch_manager profile read expected own row only, found total=% self=%', v_profile_count, v_self_profile_count;
  end if;

  update public.profiles
     set display_name = 'Manager Role Test Updated'
   where id = '22222222-2222-2222-2222-222222222222'::uuid;

  if not found then
    raise exception 'branch_manager own-profile update should succeed';
  end if;

  insert into public.entities (entity_type, source_record_id)
  values ('inspection', 'manager-role-matrix-insert')
  returning id into v_entity_id;

  if v_entity_id is null then
    raise exception 'branch_manager direct entity insert returned null id';
  end if;

  update public.entities
     set source_record_id = 'manager-role-matrix-updated'
   where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid;

  if not found then
    raise exception 'branch_manager direct entity update should succeed';
  end if;

  select source_record_id
    into v_updated_source
  from public.entities
  where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid;

  if v_updated_source <> 'manager-role-matrix-updated' then
    raise exception 'branch_manager update expected source_record_id manager-role-matrix-updated, found %', v_updated_source;
  end if;

  v_caught := false;
  begin
    -- Direct profile inserts are never allowed through the authenticated table path;
    -- profile rows must originate from auth.users + the sync trigger.
    insert into public.profiles (id, display_name, role, tenant)
    values (gen_random_uuid(), 'manager-denied-insert', 'read_only', 'default');
  exception
    when insufficient_privilege then
      v_caught := true;
    when sqlstate '42501' then
      v_caught := true;
    when others then
      raise exception 'branch_manager denied profile insert raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'branch_manager profile insert unexpectedly succeeded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '33333333-3333-3333-3333-333333333333',
    'app_metadata', jsonb_build_object('role', 'field_operator', 'tenant', 'default')
  )::text,
  true
);

do $$
declare
  v_profile_count int;
  v_self_profile_count int;
  v_entity_id uuid;
  v_caught bool;
begin
  select count(*), count(*) filter (where id = '33333333-3333-3333-3333-333333333333'::uuid)
    into v_profile_count, v_self_profile_count
  from public.profiles;

  if v_profile_count <> 1 or v_self_profile_count <> 1 then
    raise exception 'field_operator profile read expected own row only, found total=% self=%', v_profile_count, v_self_profile_count;
  end if;

  update public.profiles
     set display_name = 'Operator Role Test Updated'
   where id = '33333333-3333-3333-3333-333333333333'::uuid;

  if not found then
    raise exception 'field_operator own-profile update should succeed';
  end if;

  insert into public.entities (entity_type, source_record_id)
  values ('inspection', 'operator-role-matrix-insert')
  returning id into v_entity_id;

  if v_entity_id is null then
    raise exception 'field_operator direct entity insert returned null id';
  end if;

  v_caught := false;
  begin
    insert into public.relationships_v2 (relationship_type, parent_id, child_id, metadata)
    values (
      'branch_has_asset',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid,
      '{}'::jsonb
    );
  exception
    when insufficient_privilege then
      v_caught := true;
    when sqlstate '42501' then
      v_caught := true;
    when others then
      raise exception 'field_operator denied relationship insert raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'field_operator relationship insert unexpectedly succeeded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', '44444444-4444-4444-4444-444444444444',
    'app_metadata', jsonb_build_object('role', 'read_only', 'tenant', 'default')
  )::text,
  true
);

do $$
declare
  v_profile_count int;
  v_self_profile_count int;
  v_caught bool;
begin
  select count(*), count(*) filter (where id = '44444444-4444-4444-4444-444444444444'::uuid)
    into v_profile_count, v_self_profile_count
  from public.profiles;

  if v_profile_count <> 1 or v_self_profile_count <> 1 then
    raise exception 'read_only profile read expected own row only, found total=% self=%', v_profile_count, v_self_profile_count;
  end if;

  update public.profiles
     set display_name = 'Read Only Role Test Updated'
   where id = '44444444-4444-4444-4444-444444444444'::uuid;

  if not found then
    raise exception 'read_only own-profile update should succeed';
  end if;

  v_caught := false;
  begin
    insert into public.entities (entity_type, source_record_id)
    values ('branch', 'readonly-role-matrix-insert');
  exception
    when insufficient_privilege then
      v_caught := true;
    when sqlstate '42501' then
      v_caught := true;
    when others then
      raise exception 'read_only denied entity insert raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'read_only entity insert unexpectedly succeeded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

set local role anon;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'anon'
  )::text,
  true
);

do $$
declare
  v_caught bool;
begin
  v_caught := false;
  begin
    perform count(*) from public.profiles;
  exception
    when insufficient_privilege then
      v_caught := true;
    when sqlstate '42501' then
      v_caught := true;
    when others then
      raise exception 'anon denied profile read raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'anon profile read unexpectedly succeeded';
  end if;

  v_caught := false;
  begin
    insert into public.entities (entity_type, source_record_id)
    values ('branch', 'anon-role-matrix-insert');
  exception
    when insufficient_privilege then
      v_caught := true;
    when sqlstate '42501' then
      v_caught := true;
    when others then
      raise exception 'anon denied entity insert raised unexpected % "%"', sqlstate, sqlerrm;
  end;

  if not v_caught then
    raise exception 'anon entity insert unexpectedly succeeded';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);

rollback;
