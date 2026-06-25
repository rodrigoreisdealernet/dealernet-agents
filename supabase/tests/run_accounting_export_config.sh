#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_accounting_export_config_tests_$$}"
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

for _ in $(seq 1 30); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$repo_root"/supabase/tests/auth_stub.sql >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration" >/dev/null
done

echo "Running accounting export config SQL checks"
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$repo_root"/supabase/tests/accounting_export_config.sql >/dev/null

echo "Accounting export config checks passed"
