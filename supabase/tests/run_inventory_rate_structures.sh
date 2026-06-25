#!/usr/bin/env bash
# Runs inventory_rate_structures behavioral tests in a throwaway Postgres container.
#
# Usage (from repo root):
#   bash supabase/tests/run_inventory_rate_structures.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_inventory_rate_structures_$$}"
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

echo "Running inventory rate structures behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root"/supabase/tests/inventory_rate_structures.sql; then
  echo "inventory_rate_structures tests FAILED" >&2
  exit 1
fi

echo "inventory_rate_structures checks passed"
