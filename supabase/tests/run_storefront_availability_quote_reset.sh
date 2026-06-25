#!/usr/bin/env bash
# Validates that `supabase db reset` applies the storefront availability + quote
# migration (20260609010000_storefront_availability_quote.sql) cleanly and that
# the behavioural / RLS assertions in storefront_availability_quote.sql pass
# against a fully-reset local database.
#
# Usage (from repo root):
#   bash supabase/tests/run_storefront_availability_quote_reset.sh
#
# Requires the Supabase CLI to be installed and Docker to be running.
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

echo "Running storefront availability + quote RLS behavioral tests against reset database"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/storefront_availability_quote.sql" \
  >/dev/null

echo "Storefront availability + quote reset checks passed"
