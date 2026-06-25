-- Keycloak group → application role mapping
--
-- Extends the existing user/profile system (20260607120000_user_roles_profiles.sql) to
-- support Keycloak-federated sign-ins.  When GoTrue processes a Keycloak OIDC sign-in, it
-- stores the id_token claims in raw_user_meta_data (including a `groups` array) and sets
-- raw_app_meta_data->>'provider' / raw_app_meta_data->'providers' to identify the Keycloak
-- federation path.
--
-- This migration adds:
--   1. keycloak_groups_to_role() — deterministic, immutable group→role mapping function.
--   2. An updated handle_new_user() trigger that, for Keycloak-federated users, reads the
--      groups claim from raw_user_meta_data, maps it to an app_role, then backfills
--      raw_app_meta_data with `role` and `tenant` so the Supabase JWT carries correct claims
--      on next session refresh.  A pg_trigger_depth() guard prevents recursive invocation
--      when the UPDATE on auth.users fires the on_auth_user_updated trigger in turn.
--
-- Canonical Keycloak group → app_role mapping (precedence: most privileged wins):
--   dia-admin          → admin
--   dia-branch-manager → branch_manager
--   dia-field-operator → field_operator
--   dia-read-only      → read_only
--   (no matching group)  → read_only

-- ---------------------------------------------------------------------------
-- 1. keycloak_groups_to_role() — pure, immutable mapping
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.keycloak_groups_to_role(groups jsonb)
RETURNS public.app_role
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
AS $$
  SELECT CASE
    WHEN groups @> '["dia-admin"]'          THEN 'admin'::public.app_role
    WHEN groups @> '["dia-branch-manager"]' THEN 'branch_manager'::public.app_role
    WHEN groups @> '["dia-field-operator"]' THEN 'field_operator'::public.app_role
    ELSE                                           'read_only'::public.app_role
  END;
$$;

COMMENT ON FUNCTION public.keycloak_groups_to_role(jsonb) IS
  'Maps a Keycloak groups array to an app_role.  Most-privileged wins.  '
  'Groups checked: dia-admin > dia-branch-manager > dia-field-operator > read_only (default).';

-- ---------------------------------------------------------------------------
-- 2. Updated handle_new_user() trigger
--    Extends the existing trigger to handle Keycloak-federated users.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   public.app_role;
  v_tenant text;
  v_groups jsonb;
  v_providers jsonb;
  v_is_keycloak boolean;
BEGIN
  -- Detect Keycloak-federated sign-in.
  -- GoTrue sets either:
  --   raw_app_meta_data->>'provider' = 'keycloak'  (single-provider case), or
  --   raw_app_meta_data->'providers' @> '["keycloak"]'  (multi-provider case).
  v_providers   := COALESCE(NEW.raw_app_meta_data -> 'providers', '[]'::jsonb);
  v_is_keycloak := (
    NEW.raw_app_meta_data ->> 'provider' = 'keycloak'
    OR v_providers @> '["keycloak"]'
  );

  IF v_is_keycloak THEN
    -- Read the groups claim emitted by the Keycloak protocol mapper.
    v_groups := COALESCE(NEW.raw_user_meta_data -> 'groups', '[]'::jsonb);
    v_role   := public.keycloak_groups_to_role(v_groups);

    -- Tenant comes from a Keycloak custom attribute, falling back to app_metadata, then 'default'.
    v_tenant := COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'tenant', ''),
      NULLIF(NEW.raw_app_meta_data  ->> 'tenant', ''),
      'default'
    );

    -- Backfill raw_app_meta_data with role + tenant so the Supabase JWT carries them.
    -- Only run the UPDATE at trigger depth 1 (first invocation from the original INSERT/UPDATE).
    -- When this UPDATE fires the on_auth_user_updated trigger, handle_new_user re-enters at
    -- depth 2; skipping the UPDATE there prevents infinite recursion while still allowing the
    -- profile upsert below to run at every depth level.
    IF pg_trigger_depth() = 1 AND (
         NEW.raw_app_meta_data ->> 'role' IS DISTINCT FROM v_role::text
      OR NEW.raw_app_meta_data ->> 'tenant' IS DISTINCT FROM v_tenant
    ) THEN
      UPDATE auth.users
      SET raw_app_meta_data = raw_app_meta_data
            || jsonb_build_object('role', v_role::text, 'tenant', v_tenant)
      WHERE id = NEW.id;
    END IF;

  ELSE
    -- Standard GoTrue / non-Keycloak path: read role + tenant from app_metadata.
    v_role   := COALESCE(
      (NEW.raw_app_meta_data ->> 'role')::public.app_role,
      'read_only'
    );
    v_tenant := COALESCE(NEW.raw_app_meta_data ->> 'tenant', 'default');
  END IF;

  -- Upsert the profiles row (always, regardless of federation path).
  INSERT INTO public.profiles (id, display_name, role, tenant)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'display_name', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'name', ''),
      split_part(NEW.email, '@', 1)
    ),
    v_role,
    v_tenant
  )
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        role         = EXCLUDED.role,
        tenant       = EXCLUDED.tenant,
        updated_at   = now();

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Auto-creates or updates a profiles row on GoTrue INSERT/UPDATE.  '
  'For Keycloak-federated users, maps the groups claim to app_role and backfills '
  'raw_app_meta_data so the Supabase JWT carries the correct role and tenant.';
