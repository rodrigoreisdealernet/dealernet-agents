#!/usr/bin/env bash
# Validates the 20260610100000_maintenance_service_history_analytics.sql migration
# via a full supabase db reset, then verifies that:
#   - v_asset_service_history, v_asset_downtime_analytics, and
#     v_asset_category_downtime_summary are populated after a clean seed rebuild.
#   - Setting completed_at on a maintenance record (explicit pool restoration)
#     removes the asset from v_asset_active_down_state.
#
# Usage (from repo root):
#   bash supabase/tests/run_maintenance_service_history_analytics_reset.sh
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

echo "Running maintenance service-history analytics reset-path assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/maintenance_service_history_analytics.sql" \
  >/dev/null

echo "Maintenance service-history analytics reset checks passed"
