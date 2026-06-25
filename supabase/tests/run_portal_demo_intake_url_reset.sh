#!/usr/bin/env bash
# Validates that `supabase db reset` applies the portal intake demo URL
# migration (20260618120000_portal_demo_intake_url.sql) cleanly, then runs
# supabase/tests/portal_demo_intake_url_reset.sql against the rebuilt database
# to confirm:
#   - portal_get_demo_intake_url() exists as a SECURITY DEFINER function
#   - the demo intake token is seeded correctly in portal_intake_scope_tokens
#   - portal_get_demo_intake_url() returns a non-empty /portal/intake/<id>#token=<raw>
#     URL (the exact format exported as E2E_PORTAL_INTAKE_SCOPED_URL)
#   - anon cannot call portal_get_demo_intake_url()
#
# Usage (from repo root):
#   bash supabase/tests/run_portal_demo_intake_url_reset.sh
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
  -f "$repo_root/supabase/tests/portal_demo_intake_url_reset.sql" \
  >/dev/null

echo "portal_demo_intake_url reset-path validation passed"
