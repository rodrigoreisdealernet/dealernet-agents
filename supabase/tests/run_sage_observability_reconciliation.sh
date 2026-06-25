#!/usr/bin/env bash
# RLS / role-gating behavioral tests for the Sage observability and
# reconciliation surface (migration 20260613092645_sage_observability_reconciliation.sql).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_sage_obs_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-90}"
psql_attempts="${PSQL_ATTEMPTS:-5}"
psql_retry_delay_seconds="${PSQL_RETRY_DELAY_SECONDS:-2}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

run_psql_file() {
  local sql_file="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 "$psql_attempts"); do
    if docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$sql_file" >/dev/null; then
      return 0
    fi
    if [ "$attempt" -lt "$psql_attempts" ]; then
      echo "psql failed for $label (attempt $attempt/$psql_attempts); retrying in ${psql_retry_delay_seconds}s" >&2
      sleep "$psql_retry_delay_seconds"
    fi
  done
  echo "psql failed for $label after $psql_attempts attempts" >&2
  return 1
}

docker run -d \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$postgres_image" >/dev/null

ready_streak=0
for _ in $(seq 1 "$readiness_timeout_seconds"); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready_streak=$((ready_streak + 1))
    if [ "$ready_streak" -ge 2 ]; then
      break
    fi
  else
    ready_streak=0
  fi
  sleep 1
done

if [ "$ready_streak" -lt 2 ]; then
  echo "Postgres test container did not become ready" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

run_psql_file "$repo_root/supabase/tests/auth_stub.sql" "auth_stub.sql"

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! run_psql_file "$migration" "$(basename "$migration")"; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running Sage observability and reconciliation smoke tests"
if ! run_psql_file "$repo_root/supabase/tests/sage_observability_reconciliation.sql" "sage_observability_reconciliation.sql"; then
  echo "sage_observability_reconciliation tests FAILED" >&2
  exit 1
fi

echo "sage_observability_reconciliation checks passed"
