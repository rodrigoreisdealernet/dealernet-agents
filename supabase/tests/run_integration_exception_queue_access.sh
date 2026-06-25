#!/usr/bin/env bash
# Validates the access-boundary behavior of v_integration_exception_queue_scope
# (migration 20260615210000_integration_exception_queue.sql) in a throwaway
# Postgres container.
#
# Checks that:
#   * security_invoker = true is declared on the view
#   * service_role has SELECT (Temporal worker read path)
#   * authenticated is denied SELECT (entities/entity_versions RLS chain
#     is incomplete until #120 lands)
#   * anon is denied SELECT
#   * authenticated SELECT raises insufficient_privilege at execution time
#
# Usage (from repo root):
#   bash supabase/tests/run_integration_exception_queue_access.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_intq_access_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-60}"
psql_retry_attempts="${PSQL_RETRY_ATTEMPTS:-5}"

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

for _ in $(seq 1 "$readiness_timeout_seconds"); do
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

# Provision a minimal auth schema stub so migrations referencing auth.* compile
# against a bare Postgres (real Supabase has GoTrue; the test container does not).
run_psql_file_with_retry "$repo_root/supabase/tests/auth_stub.sql" "auth schema bootstrap"

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
       < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running v_integration_exception_queue_scope access-boundary tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root"/supabase/tests/integration_exception_queue_access.sql; then
  echo "v_integration_exception_queue_scope access tests FAILED" >&2
  exit 1
fi

echo "v_integration_exception_queue_scope access checks passed"
