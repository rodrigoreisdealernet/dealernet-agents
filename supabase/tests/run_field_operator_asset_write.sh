#!/usr/bin/env bash
# Reset-path behavioral tests for the field_operator asset write boundary
# (migration 20260616080000_field_operator_asset_status_write.sql).
#
# Validates in a throwaway Postgres container that all migrations replay cleanly
# and then runs the authorization contract tests covering:
#   - anon denied (42501)
#   - authenticated with no app-role claim denied (42501)
#   - read_only app-role denied (42501)
#   - field_operator denied for disallowed entity type (customer → 42501)
#   - field_operator allowed for asset; entity + entity_version persisted
#   - admin allowed for asset
#   - branch_manager allowed for asset
#   - service_role allowed for asset (bypasses app-role guard)
#
# Usage (from repo root):
#   bash supabase/tests/run_field_operator_asset_write.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_field_op_asset_write_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-120}"
psql_retry_attempts="${PSQL_RETRY_ATTEMPTS:-5}"

# run_psql_file_with_retry <sql_file> <context>
# Retries on transient "database system is starting up" errors so the script
# stays robust when pg_isready passes before system catalogs are fully ready.
run_psql_file_with_retry() {
  local sql_file="$1"
  local context="$2"
  local attempt=1
  local err_file
  err_file="$(mktemp)"

  if [[ ! -f "$sql_file" ]]; then
    echo "SQL file not found for $context: $sql_file" >&2
    rm -f "$err_file"
    return 1
  fi

  while true; do
    if docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$sql_file" >"$err_file" 2>&1; then
      rm -f "$err_file"
      return 0
    fi

    if [[ "$attempt" -ge "$psql_retry_attempts" ]]; then
      cat "$err_file" >&2
      rm -f "$err_file"
      echo "Failed during $context after $attempt attempt(s)" >&2
      return 1
    fi

    if grep -Eq "connection to server on socket \"/var/run/postgresql/.s.PGSQL.5432\" failed|the database system is starting up|the database system is not yet accepting connections" "$err_file"; then
      echo "Postgres not ready during $context. Retrying (attempt $attempt of $psql_retry_attempts)..." >&2
      attempt=$((attempt + 1))
      sleep 1
      continue
    fi

    cat "$err_file" >&2
    rm -f "$err_file"
    echo "Failed during $context" >&2
    return 1
  done
}

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker run -d \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$postgres_image" >/dev/null

elapsed=0
until docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; do
  if [[ "$elapsed" -ge "$readiness_timeout_seconds" ]]; then
    echo "Postgres test container did not become ready after ${readiness_timeout_seconds}s" >&2
    echo "--- container logs ---" >&2
    docker logs "$container_name" >&2 || true
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
echo "Postgres ready after ${elapsed}s"

# Provision the minimal auth schema stub so migrations referencing auth.*
# compile against a bare Postgres (no GoTrue in the test container).
run_psql_file_with_retry "$repo_root/supabase/tests/auth_stub.sql" "auth schema bootstrap"

migration_count=0
echo "Applying all migrations (reset-path validation)"
for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "  Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
       < "$migration" >/dev/null 2>&1; then
    echo "FAIL: migration $(basename "$migration") did not apply cleanly" >&2
    echo "--- container logs ---" >&2
    docker logs "$container_name" >&2 || true
    exit 1
  fi
  migration_count=$((migration_count + 1))
done
echo "Applied ${migration_count} migration(s)"

echo "Running field_operator asset write behavioral tests"
run_psql_file_with_retry \
  "$repo_root/supabase/tests/field_operator_asset_write.sql" \
  "field_operator_asset_write assertions"

echo "field_operator_asset_write checks passed"
