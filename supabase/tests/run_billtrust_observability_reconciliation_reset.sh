#!/usr/bin/env bash
# Validates that `supabase db reset` applies the Billtrust observability and
# reconciliation migration (20260612100000_billtrust_observability_reconciliation.sql)
# cleanly, then reruns the existing SQL regression assertions against the
# rebuilt database to confirm:
#   - observability and reconciliation views remain queryable after a reset
#   - operator quarantine/replay/disable controls still work after a reset
#   - diagnostic and reconciliation queries still return the expected rows
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
  -f "$repo_root/supabase/tests/billtrust_observability_reconciliation.sql" \
  >/dev/null

echo "Billtrust observability and reconciliation reset checks passed"
