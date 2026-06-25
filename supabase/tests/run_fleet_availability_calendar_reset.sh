#!/usr/bin/env bash
# Validates that `supabase db reset` applies the fleet availability calendar
# migration (20260610191000_fleet_availability_calendar.sql) cleanly and that
# the availability/conflict/maintenance-status assertions in
# fleet_availability_calendar_reset.sql pass against a fully-reset database.
#
# Usage (from repo root):
#   bash supabase/tests/run_fleet_availability_calendar_reset.sh
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

echo "Running fleet availability calendar reset-path assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/fleet_availability_calendar_reset.sql" \
  >/dev/null

echo "Fleet availability calendar reset checks passed"
