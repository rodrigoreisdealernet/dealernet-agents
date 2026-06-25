#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_inbound_rerental_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_psql() {
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"
}

docker run -d \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$postgres_image" >/dev/null

container_ready=false
for _ in $(seq 1 60); do
  if docker_psql -c 'select 1' >/dev/null 2>&1; then
    container_ready=true
    break
  fi
  sleep 1
done

if [ "${container_ready:-false}" != "true" ]; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

docker_psql < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  docker_psql < "$migration" >/dev/null
done

docker_psql < "$repo_root/supabase/tests/inbound_rerental_fleet_sourcing.sql"

echo "Inbound rerental fleet sourcing checks passed"
