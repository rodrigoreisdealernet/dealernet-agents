-- User management CRUD (issue #6)
-- Created: 2026-06-25
--
-- Adds the deactivation flag + a hardened admin-only write path for profiles,
-- mirroring the SECURITY DEFINER + pinned search_path + role-guard pattern from
-- 20260607133000_authenticated_write_rpc_hardening.sql.
--
--   1. profiles.is_active boolean (NOT NULL DEFAULT true) — soft deactivation.
--   2. admin_update_profile() — SECURITY DEFINER RPC letting service_role or an
--      authenticated admin edit display_name / role / is_active of any profile.
--      read_only / branch_manager / field_operator are denied with errcode 42501.
--
-- Existing RLS policies on public.profiles (select_own, select_admin, update_own,
-- admin_all) are intentionally left untouched: is_active is just a column and the
-- admin write path goes through the RPC, not direct UPDATE.

-- ---------------------------------------------------------------------------
-- 1. Deactivation flag
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_active boolean not null default true;

comment on column public.profiles.is_active is
  'Soft-deactivation flag; false hides the user from active operations without deleting data.';

-- ---------------------------------------------------------------------------
-- 2. Admin-only UPDATE RPC for profiles
--    Guard mirrors create_entity_with_version / dia_assert_vehicle_writer:
--      service_role OR (authenticated AND get_my_role() = 'admin').
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_profile(
  p_user_id      uuid,
  p_display_name text,
  p_role         public.app_role,
  p_is_active    boolean
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_role text;
  v_row          public.profiles;
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
      and public.get_my_role() = 'admin'
    )
  ) then
    raise exception 'admin_update_profile requires an admin (got role=%, app_role=%)',
      v_request_role, public.get_my_role()
      using errcode = '42501';
  end if;

  update public.profiles
     set display_name = p_display_name,
         role         = p_role,
         is_active    = p_is_active,
         updated_at   = now()
   where id = p_user_id
  returning * into v_row;

  if not found then
    raise exception 'Profile % not found', p_user_id
      using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke execute on function public.admin_update_profile(uuid, text, public.app_role, boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, public.app_role, boolean) to authenticated, service_role;
