#!/usr/bin/env bash
# Validates asset_category scoping in portal_get_financial_entities():
#   - anon role is denied via PostgreSQL grant
#   - authenticated customers only receive asset_category rows referenced by
#     authorized contract lines (both category_id and asset_category_id fields)
#   - unrelated categories are filtered out
#   - service_role receives all asset_category rows
#
# Usage (from repo root):
#   bash supabase/tests/run_portal_financials_asset_category_rls.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_portal_financials_category_rls_$$}"
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

echo "Running portal financials asset_category RLS behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root"/supabase/tests/portal_financials_asset_category_rls.sql; then
  echo "Portal financials asset_category RLS tests FAILED" >&2
  exit 1
fi

echo "Portal financials asset_category RLS checks passed"
