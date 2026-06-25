#!/usr/bin/env bash
# Validates that `supabase db reset` applies the SmartEquip delivery observability
# migration (20260611203000_smartequip_delivery_observability.sql) cleanly, then
# runs supabase/tests/smartequip_delivery_observability_reset.sql assertions
# against the rebuilt database to confirm:
#   - delivery-event tables exist with RLS enabled
#   - diagnostic views declare security_invoker = true
#   - operator RPCs (quarantine / replay / disable retry) exist
#   - delivery-event persistence and operator recovery controls work after reset
#   - failed-exchange, dashboard, and reconciliation queries return rows
#
# Usage (from repo root):
#   bash supabase/tests/run_smartequip_delivery_observability_reset.sh
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

supabase "${start_args[@]}" "${project_args[@]}"
run_supabase_reset_with_transient_retry 6

psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/smartequip_delivery_observability_reset.sql" \
  >/dev/null

echo "SmartEquip delivery observability reset checks passed"
