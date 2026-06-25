#!/usr/bin/env bash
# Validates that `supabase db reset` applies the Coupa observability and
# reconciliation migration (20260611113000_coupa_observability_reconciliation.sql)
# cleanly, then runs the Coupa SQL assertions against the rebuilt database to
# confirm:
#   - observability and reconciliation views remain queryable after a reset
#   - recovery queue and replay/disable controls still work after a reset
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
  -f "$repo_root/supabase/tests/coupa_observability_reconciliation.sql" \
  >/dev/null

echo "Coupa observability and reconciliation reset checks passed"
