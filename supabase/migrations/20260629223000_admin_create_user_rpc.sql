-- admin_create_user — privileged user creation via SECURITY DEFINER RPC.
--
-- Replaces the `admin-create-user` Edge Function for environments where the
-- Supabase edge runtime is NOT served (e.g. the local demo stack, where
-- config.toml has [edge_runtime] enabled = false). Without the runtime the
-- browser's supabase.functions.invoke('admin-create-user') returns 503
-- ("Edge Function returned a non-2xx status code").
--
-- Security: identical guarantee to the Edge Function — the browser never holds
-- the service_role key; privilege stays in the database. The caller sends only
-- its own JWT and must resolve to an admin (get_my_role() = 'admin'). Mirrors
-- the proven auth.users + auth.identities insert used by
-- scripts/seed-demo-users.sh so GoTrue password login works for created users.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_create_user(
  p_email        text,
  p_password     text,
  p_display_name text default null,
  p_role         text default null,
  p_tenant       text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_email        text := lower(btrim(p_email));
  v_display      text;
  v_tenant       text;
  v_user_id      uuid := gen_random_uuid();
begin
  -- 1. Authorize: service_role OR an authenticated admin (mirrors admin_update_profile).
  v_request_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role',
    ''
  );
  if not (
    v_request_role = 'service_role'
    or (v_request_role = 'authenticated' and public.get_my_role() = 'admin')
  ) then
    raise exception 'Only admins can create users (role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;

  -- 2. Validate input.
  if v_email is null or v_email = '' then
    raise exception 'email is required' using errcode = '22023';
  end if;
  if p_password is null or length(p_password) < 6 then
    raise exception 'password must have at least 6 characters' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('admin', 'branch_manager', 'field_operator', 'read_only') then
    raise exception 'role must be one of admin, branch_manager, field_operator, read_only'
      using errcode = '22023';
  end if;

  v_display := coalesce(nullif(btrim(p_display_name), ''), split_part(v_email, '@', 1));
  v_tenant  := coalesce(nullif(btrim(p_tenant), ''), public.get_my_tenant(), 'default');

  if exists (select 1 from auth.users where email = v_email and is_sso_user = false) then
    raise exception 'A user with email % already exists', v_email using errcode = '23505';
  end if;

  -- 3. Create the GoTrue auth user. Token columns are normalised to '' because
  --    some GoTrue versions scan them as non-null strings and a NULL breaks the
  --    password grant ("converting NULL to string is unsupported").
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', array['email'], 'role', p_role, 'tenant', v_tenant),
    jsonb_build_object('display_name', v_display),
    now(), now(),
    '', '', '', '', '', '', '', ''
  );

  -- 4. Matching identity row (GoTrue requires it for password login). The
  --    `email` column is GENERATED ALWAYS, so it is omitted.
  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_user_id::text, v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  -- 5. Ensure the profile reflects the chosen values (the on_auth_user_created
  --    trigger may have synced from app_metadata already; upsert + is_active to be safe).
  insert into public.profiles (id, display_name, role, tenant, is_active)
  values (v_user_id, v_display, p_role::public.app_role, v_tenant, true)
  on conflict (id) do update
    set display_name = excluded.display_name,
        role         = excluded.role,
        tenant       = excluded.tenant,
        is_active    = true,
        updated_at   = now();

  return v_user_id;
end;
$$;

revoke all on function public.admin_create_user(text, text, text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, text, text) to authenticated, service_role;
