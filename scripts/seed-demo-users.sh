#!/usr/bin/env bash
# seed-demo-users.sh — provision known demo users in a Dealernet Supabase environment.
#
# Requires Postgres access with enough privilege to write to auth.users
# (e.g. the Supabase service-role connection or a direct superuser connection).
#
# Usage:
#   PGPASSWORD=<postgres-password> \
#   SUPABASE_DB_URL=postgresql://postgres:<pass>@<host>:5432/postgres \
#   bash scripts/seed-demo-users.sh
#
# Environment variables (all required unless a default is shown):
#   SUPABASE_DB_URL     – Postgres DSN with superuser or service-role credentials.
#   DEMO_ADMIN_PASS     – Password for admin@dia-rental.dev  (required)
#   DEMO_OPERATOR_PASS  – Password for operator@dia-rental.dev (required)
#   DEMO_TENANT         – Tenant slug (default: auto-detect from seeded demo ops findings)
#
# Passwords are consumed from environment variables only — they are NEVER
# committed to the repository.  Rotate them via the secrets workflow (#125).
#
# Demo users created:
#   admin@dia-rental.dev      role=admin          (also sets up the legacy demo@ account)
#   operator@dia-rental.dev   role=field_operator
#   manager@dia-rental.dev    role=branch_manager
#   readonly@dia-rental.dev   role=read_only
#
# The legacy demo@dia-rental.dev account has its role promoted to admin if it
# already exists.
set -euo pipefail

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL must be set to a Postgres DSN}"
: "${DEMO_ADMIN_PASS:?DEMO_ADMIN_PASS must be set (password for admin@dia-rental.dev)}"
: "${DEMO_OPERATOR_PASS:?DEMO_OPERATOR_PASS must be set (password for operator@dia-rental.dev)}"

DEMO_TENANT="${DEMO_TENANT:-}"
DEMO_MANAGER_PASS="${DEMO_MANAGER_PASS:-${DEMO_OPERATOR_PASS}}"
DEMO_READONLY_PASS="${DEMO_READONLY_PASS:-${DEMO_OPERATOR_PASS}}"

if [[ -z "${DEMO_TENANT}" ]]; then
  DEMO_TENANT="$(
    psql "${SUPABASE_DB_URL}" -v ON_ERROR_STOP=1 -At <<'SQL'
-- Auto-detect the primary demo ops tenant from seeded findings so demo-user
-- tenant claims stay aligned with ops seed data without hardcoding the key.
-- This intentionally depends on the demo-ops fingerprint namespace created by
-- supabase/seed.sql; set DEMO_TENANT explicitly when running without that seed.
SELECT t.tenant_key
FROM public.tenants t
JOIN public.finding f
  ON f.tenant_id = t.id
WHERE f.fingerprint LIKE 'demo-ops-%'
GROUP BY t.tenant_key
ORDER BY count(*) DESC, t.tenant_key
LIMIT 1;
SQL
  )"

  if [[ -z "${DEMO_TENANT}" ]]; then
    echo "Unable to auto-detect DEMO_TENANT from seeded demo ops findings. Set DEMO_TENANT explicitly." >&2
    exit 1
  fi
fi

echo "Seeding demo users (tenant: ${DEMO_TENANT})"

# Passwords and tenant are passed as psql variables (:'varname' syntax) so that
# special characters in values are automatically quoted — no shell interpolation
# into the SQL string.
psql "${SUPABASE_DB_URL}" \
  -v ON_ERROR_STOP=1 \
  -v demo_admin_pass="${DEMO_ADMIN_PASS}" \
  -v demo_operator_pass="${DEMO_OPERATOR_PASS}" \
  -v demo_manager_pass="${DEMO_MANAGER_PASS}" \
  -v demo_readonly_pass="${DEMO_READONLY_PASS}" \
  -v demo_tenant="${DEMO_TENANT}" \
  <<'SQL'
-- ── Demo user seed ────────────────────────────────────────────────────────────
-- Each INSERT uses ON CONFLICT (email) DO UPDATE so re-running is safe.
-- Passwords are crypt-hashed using bcrypt (pgcrypto extension required).
-- GoTrue reads the hashed_password column directly from auth.users.
--
-- All runtime values are passed through psql :'variable' substitution so that
-- special characters in passwords cannot break the SQL statement.
-- ─────────────────────────────────────────────────────────────────────────────

-- Ensure pgcrypto is available
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO auth.users (
  instance_id,
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
VALUES
  -- admin@dia-rental.dev  (role: admin)
  (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'admin@dia-rental.dev',
    crypt(:'demo_admin_pass', gen_salt('bf')),
    now(),
    jsonb_build_object('provider', 'email', 'providers', array['email'], 'role', 'admin', 'tenant', :'demo_tenant'),
    jsonb_build_object('display_name', 'Demo Admin'),
    now(),
    now()
  ),
  -- operator@dia-rental.dev  (role: field_operator)
  (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'operator@dia-rental.dev',
    crypt(:'demo_operator_pass', gen_salt('bf')),
    now(),
    jsonb_build_object('provider', 'email', 'providers', array['email'], 'role', 'field_operator', 'tenant', :'demo_tenant'),
    jsonb_build_object('display_name', 'Demo Operator'),
    now(),
    now()
  ),
  -- manager@dia-rental.dev  (role: branch_manager)
  (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'manager@dia-rental.dev',
    crypt(:'demo_manager_pass', gen_salt('bf')),
    now(),
    jsonb_build_object('provider', 'email', 'providers', array['email'], 'role', 'branch_manager', 'tenant', :'demo_tenant'),
    jsonb_build_object('display_name', 'Demo Manager'),
    now(),
    now()
  ),
  -- readonly@dia-rental.dev  (role: read_only)
  (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'readonly@dia-rental.dev',
    crypt(:'demo_readonly_pass', gen_salt('bf')),
    now(),
    jsonb_build_object('provider', 'email', 'providers', array['email'], 'role', 'read_only', 'tenant', :'demo_tenant'),
    jsonb_build_object('display_name', 'Demo Read-Only'),
    now(),
    now()
  )
-- GoTrue's only unique email index is PARTIAL: users_email_partial_key (email)
-- WHERE is_sso_user = false. A bare `ON CONFLICT (email)` can't match a partial
-- index and errors ("no unique or exclusion constraint matching"), so the conflict
-- target must repeat the predicate (#286). Inserted rows are non-SSO (default), so
-- this arbitrates correctly.
ON CONFLICT (email) WHERE (is_sso_user = false) DO UPDATE
  SET encrypted_password = EXCLUDED.encrypted_password,
      raw_app_meta_data  = EXCLUDED.raw_app_meta_data,
      raw_user_meta_data = EXCLUDED.raw_user_meta_data,
      updated_at         = now(),
      email_confirmed_at = COALESCE(auth.users.email_confirmed_at, now());

-- GoTrue (some versions, incl. the self-hosted chart used for UAT) scans these token
-- columns as non-null strings; a direct INSERT leaves them NULL and login then fails with
-- "converting NULL to string is unsupported" / 500 "Database error querying schema".
-- Normalise NULL → '' for the seeded rows so password grant works on every GoTrue version.
UPDATE auth.users SET
  confirmation_token         = COALESCE(confirmation_token, ''),
  recovery_token             = COALESCE(recovery_token, ''),
  email_change_token_new     = COALESCE(email_change_token_new, ''),
  email_change               = COALESCE(email_change, ''),
  email_change_token_current = COALESCE(email_change_token_current, ''),
  phone_change               = COALESCE(phone_change, ''),
  phone_change_token         = COALESCE(phone_change_token, ''),
  reauthentication_token     = COALESCE(reauthentication_token, '')
WHERE email LIKE '%@dia-rental.dev';

-- GoTrue requires a matching auth.identities row (provider 'email') or password
-- login fails with "Invalid login credentials" even though auth.users has the hash.
-- The `email` column is GENERATED ALWAYS, so it is omitted here.
INSERT INTO auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT
  gen_random_uuid(),
  u.id::text,
  u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email',
  now(), now(), now()
FROM auth.users u
WHERE u.email IN (
  'admin@dia-rental.dev',
  'operator@dia-rental.dev',
  'manager@dia-rental.dev',
  'readonly@dia-rental.dev'
)
AND NOT EXISTS (
  SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider = 'email'
);

-- Promote the legacy demo@ account to admin if it exists.
UPDATE auth.users
SET
  raw_app_meta_data = raw_app_meta_data
    || jsonb_build_object('role', 'admin', 'tenant', :'demo_tenant'),
  updated_at = now()
WHERE email = 'demo@dia-rental.dev';

-- Sync profiles table (trigger covers new rows, but UPDATE above won't fire it).
-- is_active is set true so seeded demo users are always usable (column added in
-- 20260625140000_user_management_crud.sql).
INSERT INTO public.profiles (id, display_name, role, tenant, is_active)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data ->> 'display_name', split_part(u.email, '@', 1)),
  (u.raw_app_meta_data ->> 'role')::public.app_role,
  COALESCE(u.raw_app_meta_data ->> 'tenant', :'demo_tenant'),
  true
FROM auth.users u
WHERE u.email IN (
  'admin@dia-rental.dev',
  'operator@dia-rental.dev',
  'manager@dia-rental.dev',
  'readonly@dia-rental.dev',
  'demo@dia-rental.dev'
)
ON CONFLICT (id) DO UPDATE
  SET role         = EXCLUDED.role,
      tenant       = EXCLUDED.tenant,
      display_name = EXCLUDED.display_name,
      is_active    = true,
      updated_at   = now();

DO $$
DECLARE
  v_matching_demo_users int;
  v_demo_user_tenants text;
BEGIN
  SELECT
    count(*),
    coalesce(string_agg(distinct u.raw_app_meta_data ->> 'tenant', ','), '')
    INTO v_matching_demo_users, v_demo_user_tenants
  FROM auth.users u
  JOIN public.tenants t
    ON t.tenant_key = u.raw_app_meta_data ->> 'tenant'
  WHERE u.email IN (
    'admin@dia-rental.dev',
    'operator@dia-rental.dev',
    'manager@dia-rental.dev',
    'readonly@dia-rental.dev'
  )
    AND EXISTS (
      SELECT 1
      FROM public.finding f
      WHERE f.tenant_id = t.id
    );

  IF v_matching_demo_users < 1 THEN
    RAISE EXCEPTION
      'Expected at least one demo user tenant claim to match a seeded tenant with findings (matched_users=% demo_user_tenants=%)',
      v_matching_demo_users,
      v_demo_user_tenants;
  END IF;
END
$$;

SELECT email, raw_app_meta_data ->> 'role' AS role
FROM auth.users
WHERE email LIKE '%@dia-rental.dev'
ORDER BY email;
SQL

echo "Demo user seed complete."
