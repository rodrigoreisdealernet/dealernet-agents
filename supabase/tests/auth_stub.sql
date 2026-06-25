-- Minimal GoTrue `auth` schema stub for migration test harnesses.
--
-- Real (self-hosted) Supabase provisions the `auth` schema, `auth.users`, and the
-- `auth.uid()` / `auth.jwt()` helpers via GoTrue. Test harnesses that apply
-- `supabase/migrations/*.sql` against a bare Postgres container do NOT have GoTrue,
-- so any migration referencing `auth.*` (e.g. 20260607120000_user_roles_profiles.sql:
-- FK to auth.users, triggers on auth.users, auth.uid()/auth.jwt() in policies) aborts
-- with `schema "auth" does not exist` under `ON_ERROR_STOP=1`.
--
-- Apply this stub BEFORE applying migrations so those objects compile. It is
-- idempotent and uses IF NOT EXISTS / OR REPLACE so it is a harmless no-op against
-- a real Supabase database.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id         uuid,
  aud                 text,
  role                text,
  email               text,
  is_sso_user         boolean     NOT NULL DEFAULT false,
  encrypted_password  text,
  confirmation_token         text,
  recovery_token             text,
  email_change_token_new     text,
  email_change               text,
  email_change_token_current text,
  phone_change               text,
  phone_change_token         text,
  reauthentication_token     text,
  email_confirmed_at  timestamptz,
  raw_app_meta_data   jsonb,
  raw_user_meta_data  jsonb,
  created_at          timestamptz,
  updated_at          timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key
  ON auth.users (email)
  -- Match GoTrue's partial unique-email behavior for non-SSO users so
  -- ON CONFLICT (email) WHERE (is_sso_user = false) works in test harnesses.
  WHERE is_sso_user = false;

CREATE TABLE IF NOT EXISTS auth.identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     text,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data   jsonb,
  provider        text,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz
);
-- GoTrue helpers used by our functions/policies. The bare-Postgres harness drives
-- RLS behavior by setting the same request.jwt.claims / request.jwt.claim.* GUCs
-- that PostgREST uses, so expose those through auth.jwt()/auth.uid(). Prefer the
-- modern request.jwt.claims JSON payload, but keep the legacy per-claim fallback
-- because older guard tests still exercise direct GUC writes.
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH request_claims AS (
    SELECT nullif(current_setting('request.jwt.claims', true), '') AS claims_text
  )
  SELECT COALESCE(
    request_claims.claims_text::jsonb,
    jsonb_strip_nulls(
      jsonb_build_object(
        'role', nullif(current_setting('request.jwt.claim.role', true), ''),
        'sub', nullif(current_setting('request.jwt.claim.sub', true), '')
      )
    ),
    '{}'::jsonb
  )
  FROM request_claims;
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    nullif(auth.jwt() ->> 'sub', '')::uuid,
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  );
$$;
