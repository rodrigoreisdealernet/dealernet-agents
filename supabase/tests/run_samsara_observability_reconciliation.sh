#!/usr/bin/env bash
# Behavioral tests for Samsara observability/reconciliation controls.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_samsara_obs_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-90}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

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

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root"/supabase/tests/auth_stub.sql >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
        < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running Samsara observability and reconciliation smoke tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$repo_root"/supabase/tests/samsara_observability_reconciliation.sql; then
  echo "samsara_observability_reconciliation tests FAILED" >&2
  exit 1
fi

echo "samsara_observability_reconciliation checks passed"
