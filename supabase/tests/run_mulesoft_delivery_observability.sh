#!/usr/bin/env bash
# RLS / role-gating behavioral tests for the MuleSoft delivery observability surface
# (migration 20260611085000_mulesoft_delivery_observability.sql).
#
# Runs a full migration stack against a throwaway Postgres container and then
# executes mulesoft_delivery_observability.sql to confirm:
#   - views declare security_invoker = true
#   - anon denied SELECT on base tables and all views
#   - anon denied EXECUTE on operator RPCs
#   - authenticated (no app_role / read_only) sees 0 rows via RLS
#   - authenticated (admin / branch_manager) sees only own-tenant rows
#   - cross-tenant isolation: admin of tenant-A cannot see or quarantine tenant-B events
#   - mulesoft_quarantine_exchange RPC: admin happy path, read_only denied, cross-tenant denied
#   - mulesoft_mark_replayed RPC: admin happy path, read_only denied
#   - service_role policy effective: sees rows from all tenants
#
# Usage (from repo root):
#   bash supabase/tests/run_mulesoft_delivery_observability.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_mulesoft_obs_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-60}"

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

echo "Running MuleSoft delivery observability smoke tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$repo_root"/supabase/tests/mulesoft_delivery_observability.sql; then
  echo "mulesoft_delivery_observability tests FAILED" >&2
  exit 1
fi

echo "mulesoft_delivery_observability checks passed"
