#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# outbound owned-asset assignment guards migration
# (20260617023000_outbound_owned_asset_assignment_guards.sql) cleanly, then
# runs reset-path assertions to confirm:
#   - project_allocate_equipment exists with authenticated EXECUTE and anon denied.
#   - Fixtures seed cleanly for one idle asset, seven blocked-status assets, and two projects.
#   - An idle/available owned asset allocates successfully.
#   - Each blocked status raises SQLSTATE 23514.
#   - Cross-project double-booking of an active owned asset raises SQLSTATE 23514.
#   - Same-project re-upsert with the same source_record_id is allowed.
#
# Closes #2030. Re-kick of PR #2018.
#
# Usage (from repo root):
#   bash supabase/tests/run_outbound_owned_asset_assignment_guards_reset.sh
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

echo "Running outbound owned-asset assignment guards reset-path assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/outbound_owned_asset_assignment_guards_reset.sql" \
  >/dev/null

echo "Outbound owned-asset assignment guards reset checks passed"
