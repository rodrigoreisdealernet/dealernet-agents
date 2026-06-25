#!/usr/bin/env bash
# Validates the RLS / security-invoker behavior of the maintenance_cost_lines
# table and related views (migration 20260610070000_maintenance_costing_invoice.sql)
# in a throwaway Postgres container.
#
# Usage (from repo root):
#   bash supabase/tests/run_maintenance_costing_rls.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_maintenance_costing_rls_$$}"
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

# Provision a minimal auth schema stub so migrations referencing auth.* compile
# against a bare Postgres (real Supabase has GoTrue; the test container does not).
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

echo "Running maintenance costing RLS behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root"/supabase/tests/maintenance_costing_rls.sql; then
  echo "Maintenance costing RLS tests FAILED" >&2
  exit 1
fi

echo "Maintenance costing RLS checks passed"
