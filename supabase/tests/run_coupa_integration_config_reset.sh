#!/usr/bin/env bash
# Validates that `supabase db reset` applies the Coupa integration config
# migration (20260614143000_coupa_integration_config.sql) cleanly, then runs
# the Coupa reset-path assertions against the rebuilt database to confirm:
#   - Migration 20260614143000 is recorded in supabase_migrations
#   - idx_integration_config_coupa_tenant index exists with correct predicate
#   - integration_config table comment includes 'coupa' and secret_refs note
#   - service_role can insert tenant-scoped Coupa config with all supported scopes
#   - Secret refs are isolated to secret_refs column (not visible in settings)
#   - Mapping profiles land in the mappings column
#   - Tenant admin sees only own tenant's Coupa row (tenant isolation via RLS)
#   - Cross-tenant Coupa row is not visible to another tenant's admin
#   - Admin can disable/re-enable and rotate Coupa credential refs
#   - read_only role cannot write integration_config
#
# Usage (from repo root):
#   bash supabase/tests/run_coupa_integration_config_reset.sh
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
  -f "$repo_root/supabase/tests/coupa_integration_config_reset.sql"

echo "Coupa integration config reset checks passed"
