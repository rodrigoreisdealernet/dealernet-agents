#!/usr/bin/env bash
# run_seed_demo_users.sh — Integration tests for scripts/seed-demo-users.sh.
#
# Tests exercised:
#   1. Happy path: DEMO_TENANT is auto-detected from seeded demo-ops-* findings
#      when the environment variable is not set.
#   2. Auth stub compatibility: after seeding, auth.users and auth.identities hold
#      the expected rows, proving auth_stub.sql is structurally compatible with the
#      demo-user upsert path (ON CONFLICT partial index, identities FK, etc.).
#   3. Error path: when DEMO_TENANT is set to a slug that owns no findings,
#      the script exits non-zero with the targeted alignment-check error.
#
# Requirements: Docker (postgres image pulled automatically on first run).
# The seed script is mounted read-only via a Docker volume so no host psql is needed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-seed-demo-users-tests-$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
# Connection URL used inside the container (loopback). PGPASSWORD is supplied via
# -e to docker exec so the password is never embedded in the URL.
container_db_url="postgresql://postgres@localhost/postgres"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Mount the repo read-only so scripts/seed-demo-users.sh is reachable inside the
# container as /repo/scripts/seed-demo-users.sh without needing host psql.
docker run -d \
  --name "$container_name" \
  -v "$repo_root:/repo:ro" \
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

if [[ "$container_ready" != "true" ]]; then
  echo "Postgres test container did not become ready after 30 seconds" >&2
  exit 1
fi

# The official postgres Docker image starts postgres twice during first-time
# initialisation (once temporarily for initdb/CREATE DATABASE, once permanently).
# pg_isready can return OK during the temporary start; a brief stabilisation wait
# lets the permanent start complete before any psql commands are issued.
sleep 2

# Apply the shared auth stub so migrations that reference auth.* compile without GoTrue.
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$migration" >/dev/null
done

# seed.sql creates the demo-ops-* tenants and findings that the auto-detect query relies on.
echo "Applying seed.sql"
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/seed.sql" >/dev/null

# ── Test 1: Happy path — auto-detect DEMO_TENANT from seeded demo-ops-* findings ──────
echo "Test 1: auto-detect DEMO_TENANT (DEMO_TENANT unset)"
autodetect_output="$(
  docker exec \
    -e SUPABASE_DB_URL="$container_db_url" \
    -e PGPASSWORD=postgres \
    -e DEMO_ADMIN_PASS=test-admin-pass \
    -e DEMO_OPERATOR_PASS=test-operator-pass \
    "$container_name" \
    bash /repo/scripts/seed-demo-users.sh 2>&1
)"

if ! echo "$autodetect_output" | grep -q "Seeding demo users (tenant: demo-ops-"; then
  echo "FAIL Test 1: Expected auto-detected demo-ops-* tenant in output" >&2
  echo "$autodetect_output" >&2
  exit 1
fi
if ! echo "$autodetect_output" | grep -q "Demo user seed complete."; then
  echo "FAIL Test 1: Expected 'Demo user seed complete.' in output" >&2
  exit 1
fi
echo "PASS Test 1: $(echo "$autodetect_output" | grep 'Seeding demo users')"

# ── Test 2: Auth stub compatibility — auth.users and auth.identities rows present ──────
echo "Test 2: auth stub compatibility"
user_count="$(
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -At \
    -c "SELECT count(*) FROM auth.users WHERE email LIKE '%@wynne-rental.dev'"
)"
if [[ "$user_count" -lt 4 ]]; then
  echo "FAIL Test 2: Expected >= 4 rows in auth.users, got ${user_count}" >&2
  exit 1
fi
identity_count="$(
  docker exec "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -At \
    -c "SELECT count(*) FROM auth.identities i
        JOIN auth.users u ON u.id = i.user_id
        WHERE u.email LIKE '%@wynne-rental.dev' AND i.provider = 'email'"
)"
if [[ "$identity_count" -lt 4 ]]; then
  echo "FAIL Test 2: Expected >= 4 identity rows in auth.identities, got ${identity_count}" >&2
  exit 1
fi
echo "PASS Test 2: auth.users=${user_count} auth.identities=${identity_count}"

# ── Test 3: Error path — misaligned DEMO_TENANT yields targeted alignment error ─────────
echo "Test 3: misalignment error path (DEMO_TENANT=nonexistent-tenant)"
# Run with a tenant slug that has no findings so the inline alignment DO block fires.
# Temporarily disable errexit so we can capture the exit code.
set +e
error_output="$(
  docker exec \
    -e SUPABASE_DB_URL="$container_db_url" \
    -e PGPASSWORD=postgres \
    -e DEMO_ADMIN_PASS=test-admin-pass \
    -e DEMO_OPERATOR_PASS=test-operator-pass \
    -e DEMO_TENANT=nonexistent-tenant \
    "$container_name" \
    bash /repo/scripts/seed-demo-users.sh 2>&1
)"
seed_exit=$?
set -e

if [[ $seed_exit -eq 0 ]]; then
  echo "FAIL Test 3: Expected seed-demo-users.sh to exit non-zero for misaligned DEMO_TENANT" >&2
  exit 1
fi
if ! echo "$error_output" | grep -qi "Expected at least one demo user tenant claim"; then
  echo "FAIL Test 3: Expected targeted alignment error message, got:" >&2
  echo "$error_output" >&2
  exit 1
fi
echo "PASS Test 3: misalignment error detected (exit=${seed_exit})"

echo "Seed demo users checks passed"
