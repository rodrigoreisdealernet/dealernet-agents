#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# fleet idle-rebalancing view migration (20260613060000_fleet_idle_rebalancing_view.sql)
# cleanly, and that the reset-path assertions in fleet_idle_rebalancing_reset.sql
# pass against a fully-rebuilt database.
#
# Usage (from repo root):
#   bash supabase/tests/run_fleet_idle_rebalancing_reset.sh
#
# Requirements:
#   - Supabase CLI installed (https://supabase.com/docs/guides/cli)
#   - Docker running (Supabase local stack uses Docker)
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

echo "Running fleet idle-rebalancing reset-path assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/fleet_idle_rebalancing_reset.sql" \
  >/dev/null

echo "Fleet idle-rebalancing reset checks passed"
