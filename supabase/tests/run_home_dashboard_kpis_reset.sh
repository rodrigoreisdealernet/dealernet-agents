#!/usr/bin/env bash
# Validates the 20260606152000_home_dashboard_kpis.sql migration via a full
# supabase db reset, then runs supabase/tests/home_dashboard_kpis.sql against
# the resulting database.
#
# Usage (from repo root):
#   bash supabase/tests/run_home_dashboard_kpis_reset.sh
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
run_supabase_reset_with_transient_retry 4

psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/home_dashboard_kpis.sql" \
  >/dev/null

echo "Home dashboard KPIs migration reset checks passed"
