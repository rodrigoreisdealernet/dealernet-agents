#!/usr/bin/env bash
# Reset-path validation for portal authenticated service requests
# (migration 20260617230000_portal_authenticated_service_requests.sql).
#
# Runs `supabase db reset --config supabase/config.toml`, then executes
# supabase/tests/portal_authenticated_service_requests_reset.sql against the
# local Supabase stack to confirm:
#   - portal_customer_access_grant table exists with RLS enabled and no
#     public/anon/authenticated table grants.
#   - portal_get_authenticated_rentals(), portal_submit_authenticated_service_request(...),
#     and portal_list_authenticated_service_requests() exist as SECURITY DEFINER
#     functions with the expected signatures.
#   - Anon callers are rejected by the get-rentals and submit-request RPCs
#     (fail-closed check).
#   - service_role can invoke portal_get_authenticated_rentals without error.
#
# Usage (from repo root):
#   bash supabase/tests/run_portal_authenticated_service_requests_reset.sh
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
  -p 54322 \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/portal_authenticated_service_requests_reset.sql" \
  >/dev/null

echo "portal_authenticated_service_requests reset-path validation passed"
