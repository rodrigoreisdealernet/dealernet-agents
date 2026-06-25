#!/usr/bin/env bash
# shellcheck shell=bash
# Validates pricing signal snapshot + guardrail input behavior
# (migration 20260620101500_pricing_signal_guardrail_inputs.sql).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suffix="$(date +%s%N)"
container_name="${CONTAINER_NAME:-dia_pricing_tests_${suffix}_$$}"
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
    break
  fi
  sleep 1
done

if ! docker exec "$container_name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "Postgres test container did not become ready" >&2
  exit 1
fi

# Provision auth schema stub so migrations referencing auth.* compile.
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

echo "Running pricing signal + guardrail behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$repo_root"/supabase/tests/pricing_signal_guardrail_inputs.sql; then
  echo "Pricing signal + guardrail tests FAILED" >&2
  exit 1
fi

echo "Pricing signal + guardrail checks passed"
