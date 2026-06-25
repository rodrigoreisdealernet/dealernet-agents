#!/usr/bin/env bash
# Behavioral authorization tests for staff_save_quote_order RPC
# (20260611000000_quote_builder_order_rpc.sql) in a throwaway Postgres container.
#
# Tests run (supabase/tests/quote_builder_rpc_auth.sql):
#   - anon role denied execute (grant revoked from anon)
#   - authenticated with no app-role claim denied (42501)
#   - authenticated with read_only app-role denied (42501)
#   - authenticated with field_operator app-role denied (42501)
#   - authenticated with admin app-role can create a draft order with lines
#   - admin save persists rental_order entity + rental_order_line entities
#   - authenticated with branch_manager app-role can create a draft order
#   - re-save (update) path: existing order_id accepted; order_number preserved
#   - soft-cancel: lines in p_cancel_line_ids become status='cancelled'
#   - stale cancel ID does not abort the save
#
# Usage (from repo root):
#   bash supabase/tests/run_quote_builder_rpc_auth.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container_name="${CONTAINER_NAME:-dia_quote_builder_rpc_auth_$$}"
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

echo "Running quote_builder_rpc_auth behavioral tests"
if ! docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < "$repo_root/supabase/tests/quote_builder_rpc_auth.sql"; then
  echo "quote_builder_rpc_auth tests FAILED" >&2
  exit 1
fi

echo "quote_builder_rpc_auth tests passed"
