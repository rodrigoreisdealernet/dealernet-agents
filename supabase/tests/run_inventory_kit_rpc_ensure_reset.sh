#!/usr/bin/env bash
# Reset-path validation for 20260618235000_inventory_kit_rpc_ensure.sql.
#
# Runs `supabase db reset` (full migration replay) and then executes the
# inventory_kit_rpc_ensure_reset.sql assertions against the rebuilt schema.
#
# Usage:
#   bash supabase/tests/run_inventory_kit_rpc_ensure_reset.sh
#
# Requires: supabase CLI, docker
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/supabase/tests/reset_validation_lib.sh"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required for reset validation" >&2
  exit 127
fi

setup_supabase_reset_validation "$repo_root"

cleanup() {
  cleanup_supabase_reset_validation
}

trap cleanup EXIT

run_supabase_start_with_transient_retry 6
run_supabase_reset_with_transient_retry 6

psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/inventory_kit_rpc_ensure_reset.sql" \
  >/dev/null

echo "Inventory kit RPC ensure reset-path checks passed"
