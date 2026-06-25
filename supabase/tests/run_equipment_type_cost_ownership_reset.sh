#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# asset cost-of-ownership and profitability migration cleanly, then runs
# reset-path assertions for 20260613100000_asset_cost_ownership_profitability.sql
# against the rebuilt DB.
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
  -f "$repo_root/supabase/tests/equipment_type_cost_ownership_reset.sql" \
  >/dev/null

echo "Equipment-type cost-of-ownership and profitability reset-path checks passed"
