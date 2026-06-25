-- admin_update_profile: sync auth.users metadata (issue #6, review follow-up)
-- Created: 2026-06-25
--
-- Follow-up to 20260625140000_user_management_crud.sql (PR #25 review finding).
--
-- PROBLEM
--   The original admin_update_profile() only wrote public.profiles.role. But
--   effective authorization derives from the JWT, which is sourced from
--   auth.users.raw_app_meta_data->'role' (see get_my_role() + every RLS policy
--   in 20260607120000_user_roles_profiles.sql). So a role change made through
--   the admin screen never reached the JWT and could be silently reverted by the
--   on_auth_user_updated trigger (handle_new_user) the next time app_metadata
--   was touched, because that trigger copies app_metadata.role INTO profiles.
--
-- FIX (dual-write)
--   After updating public.profiles, also update auth.users so the JWT-derived
--   role stays in sync. We mirror handle_new_user()'s SECURITY DEFINER pattern
--   (it already reads/writes across the public<->auth boundary), keeping the
--   same signature, request-role guard, pinned search_path and grants as the
--   original so this definition is fully self-contained.
--
-- NO FLIP-FLOP
--   on_auth_user_updated is AFTER UPDATE ON auth.users and runs handle_new_user,
--   which DO UPDATEs profiles SET role = NEW.raw_app_meta_data->>'role',
--   tenant = NEW.raw_app_meta_data->>'tenant', display_name =
--   NEW.raw_user_meta_data->>'display_name'. We therefore write the SAME role
--   (p_role) into raw_app_meta_data AND the same display_name (p_display_name)
--   into raw_user_meta_data, while preserving tenant. The trigger then re-syncs
--   profiles to identical values -> consistent, no oscillation. is_active is
--   never touched by the trigger, so it is unaffected.

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

  -- Dual-write: keep the JWT-derived authz in sync. get_my_role() and all RLS
  -- read auth.users.raw_app_meta_data->'role', so a profiles-only write would
  -- never change effective permissions. We set role in app_metadata and
  -- display_name in user_metadata, preserving any other keys (e.g. tenant), so
  -- the on_auth_user_updated trigger re-syncs profiles to the SAME values.
  update auth.users
     set raw_app_meta_data  = coalesce(raw_app_meta_data, '{}'::jsonb)
                                || jsonb_build_object('role', p_role::text),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                                || jsonb_build_object('display_name', p_display_name)
   where id = p_user_id;

  return v_row;
end;
$$;

revoke execute on function public.admin_update_profile(uuid, text, public.app_role, boolean) from public, anon;
grant execute on function public.admin_update_profile(uuid, text, public.app_role, boolean) to authenticated, service_role;
