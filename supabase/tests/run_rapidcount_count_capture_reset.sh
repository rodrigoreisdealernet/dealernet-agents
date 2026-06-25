#!/usr/bin/env bash
# Reset-path validation for the renamed RapidCount count-capture migration
# (20260613021000_rapidcount_count_capture.sql).
#
# Validates that `supabase db reset --config supabase/config.toml` applies
# the full migration sequence cleanly — with the renamed timestamp sitting
# immediately after 20260613020000_procurement_receiving_po_match_warranty.sql
# — and that no duplicate-version ordering collision occurs, then runs
# reset-path assertions confirming:
#   - migration versions 20260613020000 and 20260613021000 are distinct rows
#   - the rapidcount_count_capture_line fact type, idempotency index, offline
#     queue table, count-lines view, and RPCs are all present after reset
#   - a functional create → start → capture → idempotent-replay round-trip
#     succeeds on the rebuilt schema
#
# Usage (from repo root):
#   bash supabase/tests/run_rapidcount_count_capture_reset.sh
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
  -f "$repo_root/supabase/tests/rapidcount_count_capture_reset.sql" \
  >/dev/null

echo "rapidcount_count_capture reset-path validation passed"
