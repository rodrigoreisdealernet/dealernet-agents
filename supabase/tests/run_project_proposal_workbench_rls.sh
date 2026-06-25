#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_ppw_rls_tests_$$}"
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

i=0
while [ "$i" -lt 60 ]; do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    container_ready=true
    break
  fi
  sleep 2
  i=$((i + 1))
done

if [ "${container_ready:-false}" != "true" ]; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$repo_root"/supabase/tests/auth_stub.sql >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running project-proposal workbench RLS contract tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root"/supabase/tests/project_proposal_workbench_rls.sql; then
  echo "Project-proposal workbench RLS contract test failed" >&2
  exit 1
fi

echo "Project-proposal workbench RLS contract checks passed"