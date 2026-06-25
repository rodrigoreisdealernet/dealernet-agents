#!/usr/bin/env bash
set -euo pipefail

# Inventory item-type model test runner
# Spins up a throwaway Postgres container, applies all migrations in order,
# then runs the inventory_item_type_model.sql assertion suite.
#
# Usage: bash supabase/tests/run_inventory_item_type_model.sh
#
# Requires: docker

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-inventory-item-type-tests-$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting Postgres test container..."
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

echo "Applying auth stub..."
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

echo "Applying all migrations..."
for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "  $(basename "$migration")"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$migration" >/dev/null
done

echo "Running inventory_item_type_model assertions..."
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/inventory_item_type_model.sql"

echo "inventory_item_type_model tests passed"
