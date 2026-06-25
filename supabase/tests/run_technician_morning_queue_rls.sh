#!/usr/bin/env bash
# Validates the RLS / access-control chain for v_technician_morning_queue_scope
# (migration 20260619010000_technician_morning_queue.sql) in a throwaway
# Postgres container.
#
# Usage (from repo root):
#   bash supabase/tests/run_technician_morning_queue_rls.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_technician_morning_queue_rls_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-30}"

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
for _ in $(seq 1 "$readiness_timeout_seconds"); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    container_ready=true
    break
  fi
  sleep 1
done

if [ "$container_ready" != "true" ]; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

# Provision auth stub so migrations referencing auth.* compile in bare Postgres.
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

echo "Running technician_morning_queue_rls behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$repo_root"/supabase/tests/technician_morning_queue_rls.sql; then
  echo "technician_morning_queue_rls tests FAILED" >&2
  exit 1
fi

echo "technician_morning_queue_rls checks passed"
