#!/usr/bin/env bash
# Validates that DO $$ executable bootstrap blocks in seed.sql correctly
# scope the write-RPC role claim (request.jwt.claim.role = 'service_role')
# inside the block, as required by PR #2206.
#
# Contract tests run (supabase/tests/seed_bootstrap_role_context.sql):
#   A. DO block with inner set_config only (no outer SET LOCAL): all three
#      hardened write RPCs (create_entity_with_version,
#      rental_upsert_entity_current_state, rental_upsert_relationship) succeed.
#      Proves the seed.sql self-contained block pattern.
#   B. DO block with no role claim: write RPCs are blocked (SQLSTATE 42501).
#      Proves the guard fires at execution time inside a DO block.
#   C. Outer SET LOCAL + inner set_config (exact seed.sql layout): write RPCs
#      succeed — both claim paths cooperate as documented.
#   D. Outer SET LOCAL visible inside DO block: PostgreSQL transaction-level
#      GUC propagates into nested DO block scope.
#
# Usage (from repo root):
#   bash supabase/tests/run_seed_bootstrap_role_context.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_seed_role_ctx_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-60}"
docker_run_attempts="${DOCKER_RUN_ATTEMPTS:-4}"
docker_run_retry_delay_seconds="${DOCKER_RUN_RETRY_DELAY_SECONDS:-5}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

container_started=false
for attempt in $(seq 1 "$docker_run_attempts"); do
  if docker run -d \
      --name "$container_name" \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=postgres \
      "$postgres_image" >/dev/null; then
    container_started=true
    break
  fi
  if [ "$attempt" -lt "$docker_run_attempts" ]; then
    echo "docker run failed for $postgres_image (attempt $attempt/$docker_run_attempts); retrying in ${docker_run_retry_delay_seconds}s" >&2
    sleep "$docker_run_retry_delay_seconds"
  fi
done

if [ "$container_started" != "true" ]; then
  echo "Failed to start Postgres test container after $docker_run_attempts attempts; check Docker Hub connectivity or increase DOCKER_RUN_ATTEMPTS/DOCKER_RUN_RETRY_DELAY_SECONDS" >&2
  exit 1
fi

container_ready=false
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

# Provision the minimal auth schema stub so migrations referencing auth.*
# compile against a bare Postgres (no GoTrue in the test container).
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
      < "$migration" >/dev/null; then
    echo "Failed applying migration: $(basename "$migration")" >&2
    exit 1
  fi
done

echo "Running seed bootstrap role-context contract tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$repo_root/supabase/tests/seed_bootstrap_role_context.sql"; then
  echo "seed_bootstrap_role_context contract tests FAILED" >&2
  exit 1
fi

echo "seed_bootstrap_role_context contract tests passed"
