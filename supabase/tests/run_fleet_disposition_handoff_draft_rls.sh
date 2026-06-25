#!/usr/bin/env bash
# Validates RLS/GRANT behavior for public.fleet_disposition_handoff_draft
# (migration 20260620051000_fleet_disposition_handoff_draft.sql) in a throwaway
# Postgres container.
#
# Usage (from repo root):
#   bash supabase/tests/run_fleet_disposition_handoff_draft_rls.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_fleet_handoff_draft_rls_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
target_migration="20260620083000_fleet_disposition_handoff_draft_idempotency.sql"

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
  if [[ "$(basename "$migration")" == "$target_migration" ]]; then
    break
  fi
done

echo "Running fleet disposition handoff draft RLS behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root"/supabase/tests/fleet_disposition_handoff_draft_rls.sql; then
  echo "Fleet disposition handoff draft RLS tests FAILED" >&2
  exit 1
fi

echo "Fleet disposition handoff draft RLS checks passed"
