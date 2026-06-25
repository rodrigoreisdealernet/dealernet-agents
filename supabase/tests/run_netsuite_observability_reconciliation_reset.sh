#!/usr/bin/env bash
# Validates that `supabase db reset` applies the NetSuite observability and
# reconciliation migration (20260612200000_netsuite_observability_reconciliation.sql)
# cleanly, then runs supabase/tests/netsuite_observability_reconciliation_reset.sql
# assertions against the rebuilt database to confirm:
#   - All four NetSuite tables exist with RLS enabled after a fresh reset
#   - All four diagnostic views declare security_invoker = true
#   - All operator RPCs exist and are callable
#   - Telemetry event persistence (INSERT + SELECT) works via service_role
#   - DLQ quarantine flow (netsuite_quarantine_sync_event) works end-to-end
#   - DLQ replay flow (netsuite_mark_replayed) works end-to-end
#   - v_netsuite_reconciliation_drift returns rows for a freshly inserted drift result
#   - v_netsuite_sync_dashboard returns rows after reset
#
# Usage (from repo root):
#   bash supabase/tests/run_netsuite_observability_reconciliation_reset.sh
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
  -f "$repo_root/supabase/tests/netsuite_observability_reconciliation_reset.sql" \
  >/dev/null

echo "NetSuite observability and reconciliation reset checks passed"
