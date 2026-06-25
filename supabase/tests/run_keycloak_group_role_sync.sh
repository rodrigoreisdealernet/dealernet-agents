#!/usr/bin/env bash
# Runs the Keycloak group→role sync migration smoke tests.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_keycloak_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker run -d \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$postgres_image" >/dev/null

container_ready=false
for _ in $(seq 1 30); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    container_ready=true
    break
  fi
  sleep 1
done

if [ "${container_ready:-false}" != "true" ]; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

# Create a minimal auth.users stub so the FK and triggers compile.
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id         uuid,
  aud                 text,
  role                text,
  email               text UNIQUE,
  encrypted_password  text,
  email_confirmed_at  timestamptz,
  raw_app_meta_data   jsonb,
  raw_user_meta_data  jsonb,
  created_at          timestamptz,
  updated_at          timestamptz
);
CREATE OR REPLACE FUNCTION auth.uid()   RETURNS uuid  LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt()   RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
SQL

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running keycloak_group_role_sync smoke tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$repo_root"/supabase/tests/keycloak_group_role_sync.sql; then
  echo "keycloak_group_role_sync smoke tests FAILED" >&2
  exit 1
fi

echo "keycloak_group_role_sync checks passed"
