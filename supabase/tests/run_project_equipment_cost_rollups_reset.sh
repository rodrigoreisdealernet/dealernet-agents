#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# project equipment cost rollup migration (20260613200000_project_equipment_cost_rollups.sql)
# cleanly, then runs reset-path SQL assertions to ensure the rebuilt schema +
# seed still expose job-site budget/actual/variance and owned-vs-external cost context.
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

echo "Running project equipment rollup reset-path assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/project_equipment_cost_rollups_reset.sql" \
  >/dev/null

echo "Project equipment cost rollup reset checks passed"
