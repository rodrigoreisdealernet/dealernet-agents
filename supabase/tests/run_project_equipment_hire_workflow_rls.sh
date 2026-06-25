#!/usr/bin/env bash
# Reset-path behavioral tests for the project equipment hire workflow
# (migration 20260614160000_project_equipment_hire_workflow.sql).
#
# Validates in a throwaway Postgres container that all migrations replay cleanly
# and then runs the contract / behavioral test suite covering:
#   - RLS enabled; anon denied; authenticated denied direct INSERT; service_role all-access
#   - security_invoker = true on v_project_equipment_lifecycle_current
#   - Direct authenticated INSERT blocked (bypass closed)
#   - project_equipment_transition() happy-path (admin → on_order)
#   - First-entry guard (non-on_order rejected, errcode 23514)
#   - Invalid state-machine edge rejected (errcode 23514)
#   - Terminal state blocks further transitions (errcode 23514)
#   - Cross-tenant access denied (errcode 42501)
#   - read_only role blocked by the RPC (errcode 42501)
#   - Same-tenant SELECT allowed; cross-tenant rows filtered
#   - vendor_ref masked for field_operator in the view
#
# Usage (from repo root):
#   bash supabase/tests/run_project_equipment_hire_workflow_rls.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_hire_wf_rls_tests_$$}"
postgres_image="${POSTGRES_IMAGE:-postgres:17}"
readiness_timeout_seconds="${READINESS_TIMEOUT_SECONDS:-60}"

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

# Provision the minimal auth schema stub so migrations referencing auth.*
# compile against a bare Postgres (no GoTrue in the test container).
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < "$repo_root/supabase/tests/auth_stub.sql" >/dev/null

echo "Applying all migrations (reset-path validation)"
for migration in "$repo_root"/supabase/migrations/*.sql; do
  echo "  Applying $(basename "$migration")"
  if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
       < "$migration" >/dev/null; then
    echo "FAIL: migration $(basename "$migration") did not apply cleanly" >&2
    exit 1
  fi
done

echo "Running project equipment hire workflow RLS behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
     < "$repo_root/supabase/tests/project_equipment_hire_workflow_rls.sql"; then
  echo "project_equipment_hire_workflow_rls tests FAILED" >&2
  exit 1
fi

echo "Project equipment hire workflow RLS checks passed"
