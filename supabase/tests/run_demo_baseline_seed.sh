#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-demo-seed-tests-$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
psql_attempts="${PSQL_ATTEMPTS:-5}"
psql_retry_delay_seconds="${PSQL_RETRY_DELAY_SECONDS:-2}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

run_psql_file() {
  local sql_file="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 "$psql_attempts"); do
    if docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$sql_file" >/dev/null; then
      return 0
    fi
    if [ "$attempt" -lt "$psql_attempts" ]; then
      echo "psql failed for $label (attempt $attempt/$psql_attempts); retrying in ${psql_retry_delay_seconds}s" >&2
      sleep "$psql_retry_delay_seconds"
    fi
  done
  echo "psql failed for $label after $psql_attempts attempts" >&2
  return 1
}

docker run -d \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$postgres_image" >/dev/null

container_ready=false
for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    container_ready=true
    break
  fi
  sleep 1
done

if [ "$container_ready" != "true" ]; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

# Provision a minimal `auth` schema stub so migrations referencing auth.* compile
# against a bare Postgres (real Supabase has GoTrue; the test container does not).
run_psql_file "$repo_root/supabase/tests/auth_stub.sql" "auth_stub.sql"

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  run_psql_file "$migration" "$(basename "$migration")"
done

echo "Applying demo baseline seed (first pass)"
run_psql_file "$repo_root/supabase/seed.sql" "seed.sql first pass"

echo "Applying demo baseline seed (idempotency pass)"
run_psql_file "$repo_root/supabase/seed.sql" "seed.sql idempotency pass"

echo "Running demo baseline seed assertions"
run_psql_file "$repo_root/supabase/tests/demo_baseline_seed.sql" "demo_baseline_seed.sql"

echo "Running demo ops seed assertions"
run_psql_file "$repo_root/supabase/tests/demo_ops_seed.sql" "demo_ops_seed.sql"

echo "Preparing legacy catalog image fixtures"
run_psql_file "$repo_root/supabase/tests/catalog_image_backfill_scd2_setup.sql" "catalog_image_backfill_scd2_setup.sql"

echo "Re-running catalog image backfill migration"
run_psql_file "$repo_root/supabase/migrations/20260608093000_catalog_image_urls_local_assets.sql" "20260608093000_catalog_image_urls_local_assets.sql"

echo "Running catalog image backfill SCD2 assertions"
run_psql_file "$repo_root/supabase/tests/catalog_image_backfill_scd2_assert.sql" "catalog_image_backfill_scd2_assert.sql"

echo "Demo baseline seed checks passed"
