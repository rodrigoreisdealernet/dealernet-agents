#!/usr/bin/env bash
# Validates the RLS behavioral guarantees of the integration connector foundation tables
# (migration 20260611090000_integration_connector_foundation.sql) in a throwaway
# Postgres container.
#
# Usage (from repo root):
#   bash supabase/tests/run_integration_connector_foundation_rls.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_intg_connector_rls_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
target_migration="20260611090000_integration_connector_foundation.sql"

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
  if [[ "$(basename "$migration")" == "$target_migration" ]]; then
    break
  fi
done

echo "Running integration connector foundation RLS behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root"/supabase/tests/integration_connector_foundation_rls.sql; then
  echo "Integration connector foundation RLS tests FAILED" >&2
  exit 1
fi

echo "Integration connector foundation RLS checks passed"
