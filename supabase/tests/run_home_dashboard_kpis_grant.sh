#!/usr/bin/env bash
# Validates the 20260616052000_home_dashboard_kpis_grant.sql migration by
# applying all migrations against a temporary Postgres container and then
# running supabase/tests/home_dashboard_kpis_grant.sql.
#
# Asserts:
#   - authenticated and service_role hold SELECT on v_home_dashboard_kpis and
#     ops_finding_kpis; anon is denied.
#   - Both views declare security_invoker = true.
#   - SET LOCAL ROLE behavioral checks pass for anon (denied) and
#     authenticated/service_role (allowed).
#
# Usage (from repo root):
#   bash supabase/tests/run_home_dashboard_kpis_grant.sh
#
# Requirements: Docker running, psql available inside the postgres image.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-wynne_lvl3_home_dashboard_kpis_grant_$$}"
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

docker exec -i "$container_name" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" \
      psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running home dashboard KPI grant behavioral tests"
if ! docker exec -i "$container_name" \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$repo_root/supabase/tests/home_dashboard_kpis_grant.sql" >/dev/null; then
  echo "Home dashboard KPI grant SQL tests failed" >&2
  exit 1
fi

echo "Home dashboard KPI grant checks passed"
