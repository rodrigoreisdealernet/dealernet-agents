#!/usr/bin/env bash
# Validates that `supabase db reset` applies the quote fee engine + tax presets
# migration (20260610130000_quote_fee_engine_tax_presets.sql) cleanly and that
# the quote totals, fee/tax preset precedence, and staff quote-builder assertions
# in quote_fee_engine.sql pass against a fully-reset local database.
#
# Usage (from repo root):
#   bash supabase/tests/run_quote_fee_engine_reset.sh
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

echo "Running quote fee engine + tax preset behavioral tests against reset database"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/quote_fee_engine.sql" \
  >/dev/null

echo "Quote fee engine reset checks passed"
