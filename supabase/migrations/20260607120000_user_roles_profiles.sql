-- User roles and profiles
--
-- Establishes:
--   1. app_role enum  (admin | branch_manager | field_operator | read_only)
--   2. profiles table (one row per auth user; carries display_name, role, tenant)
--   3. Trigger to auto-create a profile row on new GoTrue user signup
--   4. Helper functions: get_my_role(), get_my_tenant()
--   5. RLS on profiles
--   6. Authenticated write policies on core entity tables (admin + branch_manager)

-- ---------------------------------------------------------------------------
-- 1. Role enum
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM (
      'admin',
      'branch_manager',
      'field_operator',
      'read_only'
    );
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Profiles table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id            uuid        NOT NULL,
  display_name  text,
  role          public.app_role NOT NULL DEFAULT 'read_only',
  tenant        text        NOT NULL DEFAULT 'default',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE
);

COMMENT ON TABLE  public.profiles IS 'One row per authenticated user; role + tenant are the authorization anchors.';
COMMENT ON COLUMN public.profiles.role   IS 'App-level role stored in app_metadata and surfaced here for UI queries.';
COMMENT ON COLUMN public.profiles.tenant IS 'Tenant slug; matches app_metadata.tenant in the JWT.';

-- ---------------------------------------------------------------------------
-- 3. Trigger: auto-create profile on new signup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, role, tenant)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)),
    COALESCE(
      (NEW.raw_app_meta_data ->> 'role')::public.app_role,
      'read_only'
    ),
    COALESCE(NEW.raw_app_meta_data ->> 'tenant', 'default')
  )
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        role         = EXCLUDED.role,
        tenant       = EXCLUDED.tenant,
        updated_at   = now();

  RETURN NEW;
END;
$$;

-- Re-create trigger idempotently
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Also fire on UPDATE so that updating app_metadata (e.g. role promotion) syncs the profile.
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 4. Helper functions
-- ---------------------------------------------------------------------------

-- Returns the app_role of the calling user drawn from the live JWT claim.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'app_metadata' ->> 'role')::public.app_role,
    'read_only'
  );
$$;

-- Returns the tenant slug of the calling user drawn from the live JWT claim.
CREATE OR REPLACE FUNCTION public.get_my_tenant()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(
    auth.jwt() -> 'app_metadata' ->> 'tenant',
    'default'
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS on profiles
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Ensure roles exist (mirror pattern from enable_rls migration)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;
REVOKE ALL ON TABLE public.profiles FROM anon;

-- Users can read their own profile; admins can read all.
DROP POLICY IF EXISTS profiles_select_own   ON public.profiles;
DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own   ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_all    ON public.profiles;

CREATE POLICY profiles_select_own
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY profiles_select_admin
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.get_my_role() = 'admin');

CREATE POLICY profiles_update_own
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    -- Users cannot escalate their own role; only admins can change roles.
    role = (SELECT role FROM public.profiles WHERE id = auth.uid())
    OR public.get_my_role() = 'admin'
  );

CREATE POLICY profiles_admin_all
  ON public.profiles
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Authenticated write policies on core entity tables
--
-- admin / branch_manager roles may INSERT + UPDATE via authenticated JWT;
-- field_operator may insert operational records (inspections, maintenance);
-- read_only stays read-only for authenticated users too.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_rw_tables constant text[] := ARRAY[
    'entities', 'entity_versions', 'relationships_v2',
    'fact_types', 'entity_facts', 'time_series_points'
  ];
  v_field_tables constant text[] := ARRAY[
    'entities', 'entity_versions', 'entity_facts'
  ];
BEGIN
  -- Admin + branch_manager: full write on core tables
  FOREACH v_table IN ARRAY v_rw_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS authenticated_manager_write ON public.%I', v_table);
    EXECUTE format(
      $p$
      CREATE POLICY authenticated_manager_write
        ON public.%I
        FOR ALL
        TO authenticated
        USING (public.get_my_role() IN ('admin', 'branch_manager'))
        WITH CHECK (public.get_my_role() IN ('admin', 'branch_manager'))
      $p$,
      v_table
    );
  END LOOP;

  -- Field operator: insert-only on operational entity tables
  FOREACH v_table IN ARRAY v_field_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS authenticated_field_insert ON public.%I', v_table);
    EXECUTE format(
      $p$
      CREATE POLICY authenticated_field_insert
        ON public.%I
        FOR INSERT
        TO authenticated
        WITH CHECK (public.get_my_role() IN ('admin', 'branch_manager', 'field_operator'))
      $p$,
      v_table
    );
  END LOOP;

  -- Authenticated read (all roles can read)
  FOREACH v_table IN ARRAY v_rw_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS authenticated_read ON public.%I', v_table);
    EXECUTE format(
      $p$
      CREATE POLICY authenticated_read
        ON public.%I
        FOR SELECT
        TO authenticated
        USING (true)
      $p$,
      v_table
    );
  END LOOP;
END;
$$;
