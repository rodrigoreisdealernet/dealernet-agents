#!/usr/bin/env bash
# Validates the direct-DB / superuser write-RPC guard widening from PR #291
# (20260607140000_allow_direct_db_writes_in_rpc_guards.sql) in a throwaway
# Postgres container.
#
# Contract tests run:
#   - supabase/tests/direct_db_write_rpc_guards.sql
#   - Direct DB context (request.jwt.claim.role = '') can call all three
#     hardened write RPCs: create_entity_with_version,
#     rental_upsert_entity_current_state, rental_upsert_relationship.
#   - service_role context can call all three RPCs.
#   - anon API context (request.jwt.claim.role = 'anon') is blocked with
#     SQLSTATE 42501 on all three RPCs.
#   - Dedicated portal off-rent RPCs require a valid scoped portal token.
#   - Demo seed / temporal harness regression: service_role path still works and
#     anon write boundary remains intact.
#   - supabase/tests/asset_analytics_access_contract.sql
#   - Asset analytics read/write surfaces enforce least privilege and tenant
#     boundaries (including cross-tenant denial through
#     v_asset_analytics_current).
#
# Usage (from repo root):
#   bash supabase/tests/run_direct_db_write_rpc_guards.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_rpc_guard_tests_$$}"
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

# Provision the minimal auth schema stub so migrations referencing auth.*
# compile against a bare Postgres (no GoTrue in the test container).
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running direct-DB write-RPC guard contract tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$repo_root/supabase/tests/direct_db_write_rpc_guards.sql"; then
  echo "direct_db_write_rpc_guards contract tests FAILED" >&2
  exit 1
fi

echo "direct_db_write_rpc_guards contract tests passed"

echo "Running asset analytics access-contract tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$repo_root/supabase/tests/asset_analytics_access_contract.sql"; then
  echo "asset_analytics_access_contract tests FAILED" >&2
  exit 1
fi

echo "asset_analytics_access_contract tests passed"
