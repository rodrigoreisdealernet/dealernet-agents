#!/usr/bin/env bash
# Reset-path validation for portal financials asset_category extension
# (migration 20260619010000_portal_financials_asset_category.sql).
#
# Runs `supabase db reset --config supabase/config.toml`, then executes
# supabase/tests/portal_financials_asset_category_reset.sql against the
# local Supabase stack to confirm:
#   - portal_get_financial_entities() exists as a SECURITY DEFINER function
#     with EXECUTE granted to authenticated and service_role but not anon.
#   - A customer-scoped authenticated JWT only receives asset_category rows
#     referenced by its authorized contract lines, via both the current
#     'category_id' and the legacy 'asset_category_id' fields.
#   - Cross-customer categories are filtered out for portal-scoped callers.
#   - service_role bypasses customer scope and receives all asset_category rows.
#
# Usage (from repo root):
#   bash supabase/tests/run_portal_financials_asset_category_reset.sh
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
  -f "$repo_root/supabase/tests/portal_financials_asset_category_reset.sql" \
  >/dev/null

echo "portal_financials_asset_category reset-path validation passed"
