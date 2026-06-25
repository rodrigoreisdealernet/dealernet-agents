#!/usr/bin/env bash
# Validates that `supabase db reset` applies
# 20260615210000_billing_update_request_approval_flow.sql cleanly, then runs
# the full behavioral access-contract assertions against the rebuilt database.
#
# Assertions verified:
#   - Tables, view, RPCs created correctly after reset.
#   - Structural grant chain (anon/authenticated revoked from tables and view;
#     ops_get_billing_update_queue and portal RPCs carry correct grants).
#   - v_billing_update_request_queue is service_role-only (NOT accessible to
#     authenticated; browser ops callers use ops_get_billing_update_queue RPC).
#   - anon with valid token can submit and read status.
#   - Invalid, revoked, and expired tokens are rejected.
#   - Direct table reads denied to anon and authenticated.
#   - Non-ops authenticated callers denied ops decision, apply, and queue RPC.
#   - Ops admin can read own-tenant queue via RPC and record a decision.
#   - Cross-tenant ops callers denied decision and apply for other tenant.
#   - portal_issue_billing_update_token denied for anon, non-admin, and
#     cross-tenant authenticated callers.
#
# Usage (from repo root):
#   bash supabase/tests/run_billing_update_request_approval_flow_reset.sh
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
  -f "$repo_root/supabase/tests/billing_update_request_approval_flow.sql" \
  >/dev/null

echo "Billing update request approval flow reset checks passed"
