#!/usr/bin/env bash
# Reset-path validation for portal catalog requisition
# (migration 20260609140000_portal_catalog_requisition.sql).
#
# Runs `supabase db reset --config supabase/config.toml`, then executes
# supabase/tests/portal_catalog_requisition_reset.sql against the local
# Supabase stack to confirm:
#   - The migration applies cleanly through a full reset + seed.
#   - v_portal_catalog_assets, portal_get_catalog_assets, and
#     portal_submit_requisition exist with the expected signatures.
#   - Seeded available assets are returned by portal_get_catalog_assets.
#   - portal_submit_requisition persists a dispatch-ready requisition entity
#     with status=pending, source=portal_catalog, and all required handoff fields.
#   - Scope-token enforcement gates anon callers on both catalog browse and
#     requisition submission.
#
# Usage (from repo root):
#   bash supabase/tests/run_portal_catalog_requisition_reset.sh
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
  -f "$repo_root/supabase/tests/portal_catalog_requisition_reset.sql" \
  >/dev/null

echo "portal_catalog_requisition reset-path validation passed"
