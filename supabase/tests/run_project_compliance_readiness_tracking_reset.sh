#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# project compliance readiness tracking migration
# (20260613212000_project_compliance_readiness_tracking.sql) cleanly, then runs
# reset-path assertions against the rebuilt database to confirm:
#   - project_assignment_readiness_audit table exists with RLS enabled
#   - v_project_equipment_readiness_current view exists and is queryable
#   - project_evaluate_assignment_readiness and
#     project_assign_asset_with_readiness_check RPCs are callable
#   - Requirement inheritance, assignment blocker evaluation, and
#     readiness-audit writes are coherent after a fresh reset
#
# Usage (from repo root):
#   bash supabase/tests/run_project_compliance_readiness_tracking_reset.sh
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
  -f "$repo_root/supabase/tests/project_compliance_readiness_tracking_reset.sql" \
  >/dev/null

echo "Project compliance readiness tracking reset checks passed"
