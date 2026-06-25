#!/usr/bin/env bash
# Validates the 20260610190000_quote_conversion_direct_book_idempotency.sql
# migration via a full `supabase db reset --config supabase/config.toml`, then
# runs supabase/tests/quote_conversion_direct_book_idempotency_reset.sql against
# the resulting database.
#
# Confirms:
#   - The migration applies cleanly through a fresh reset.
#   - rental_convert_quote_to_reservation exists with correct permissions.
#   - The direct-book conversion path succeeds on a draft order.
#   - Re-calling conversion on an already-converted order is idempotent.
#   - The audit snapshot trail is preserved on both the converted order and the
#     resulting reservation contract.
#
# Usage (from repo root):
#   bash supabase/tests/run_quote_conversion_direct_book_idempotency_reset.sh
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
  -f "$repo_root/supabase/tests/quote_conversion_direct_book_idempotency_reset.sql" \
  >/dev/null

echo "Quote/direct-book conversion idempotency reset checks passed"
