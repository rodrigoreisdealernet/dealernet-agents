#!/usr/bin/env bash
# Validates that `supabase db reset` applies the Sage observability, reconciliation,
# and recovery-audit migration (20260613092645_sage_observability_reconciliation.sql)
# cleanly, then runs supabase/tests/sage_observability_reconciliation_reset.sql
# assertions against the rebuilt database to confirm:
#   - All five Sage tables exist with RLS enabled after a fresh reset
#   - All five diagnostic views declare security_invoker = true
#   - All operator RPCs exist and are callable
#   - Telemetry event persistence (INSERT + SELECT) works via service_role
#   - DLQ quarantine flow (sage_quarantine_sync_event) works end-to-end
#   - DLQ replay flow (sage_mark_replayed) and recovery-audit lookup work
#   - v_sage_reconciliation_drift returns rows for a freshly inserted drift result
#   - v_sage_sync_dashboard and v_sage_sync_audit_history return rows after reset
#
# Usage (from repo root):
#   bash supabase/tests/run_sage_observability_reconciliation_reset.sh
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
  -f "$repo_root/supabase/tests/sage_observability_reconciliation_reset.sql" \
  >/dev/null

echo "Sage observability reconciliation reset checks passed"
