#!/usr/bin/env bash
# Validates that `supabase db reset` applies the shared integration_config
# migrations (including 20260611170000_descartes_integration_config.sql)
# cleanly, then runs reset-path assertions for schema + RLS + tenant-scoped
# Descartes configuration reads/writes.
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
  -f "$repo_root/supabase/tests/integration_config_reset.sql" \
  >/dev/null

echo "integration_config reset SQL assertions passed"
echo "integration_config reset checks passed"
