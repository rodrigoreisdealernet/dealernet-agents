#!/usr/bin/env bash
# Validates that `supabase db reset` applies the Descartes sync observability
# controls migration (20260611161000_descartes_sync_observability_controls.sql)
# cleanly, then reruns the existing SQL regression assertions against the
# rebuilt database to confirm sync observability, recovery controls, and drift
# diagnostics still query correctly after a fresh migration + seed rebuild.
#
# Usage (from repo root):
#   bash supabase/tests/run_descartes_sync_controls_reset.sh
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
  -f "$repo_root/supabase/tests/descartes_sync_controls.sql" \
  >/dev/null

echo "Descartes sync controls reset checks passed"
