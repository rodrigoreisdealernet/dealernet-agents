#!/usr/bin/env bash
# Reset-path validation for 20260612180500_rapidcount_count_scheduling.sql.
#
# Validates that `supabase db reset --config supabase/config.toml` applies
# the full migration sequence cleanly and that:
#   - migration version 20260612180500 is present in schema_migrations
#   - the rapidcount_count_task_audit_event fact type exists
#   - the uq_relationships_current_branch_has_count_task partial unique index
#     exists on relationships_v2
#   - all three read views (rapidcount_count_tasks_current,
#     rapidcount_count_branch_progress, rapidcount_count_task_audit_history)
#     are queryable after reset
#   - all three RPCs are present and SECURITY DEFINER
#   - a functional create → transition → audit-history round-trip succeeds
#
# Usage (from repo root):
#   bash supabase/tests/run_rapidcount_count_scheduling_reset.sh
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

psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/rapidcount_count_scheduling_reset.sql" \
  >/dev/null

echo "rapidcount_count_scheduling reset-path validation passed"
