#!/usr/bin/env bash
# Validates the 20260615191000_quote_conversion_require_quote_gate.sql
# migration via a full `supabase db reset --config supabase/config.toml`, then
# runs supabase/tests/quote_conversion_require_quote_gate_reset.sql against
# the resulting database.
#
# Confirms:
#   - The migration applies cleanly through a fresh reset.
#   - rental_convert_quote_to_reservation exists with correct ACL:
#     PUBLIC and anon are denied execute (revoke all … from public);
#     authenticated and service_role are granted execute.
#   - A draft-status order is rejected at the status gate.
#   - A quoted-status order converts to a reservation successfully.
#   - An approved-status order converts to a reservation successfully.
#   - Re-converting an already-converted order is idempotent (success=true,
#     same reservation id, no conflicts).
#
# Usage (from repo root):
#   bash supabase/tests/run_quote_conversion_require_quote_gate_reset.sh
#
# Exit codes:
#   0  — all checks passed
#   1  — a SQL assertion failed (psql ON_ERROR_STOP)
#   127 — supabase CLI not found
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
  -f "$repo_root/supabase/tests/quote_conversion_require_quote_gate_reset.sql" \
  >/dev/null

echo "Quote-gate reset-path checks passed"
