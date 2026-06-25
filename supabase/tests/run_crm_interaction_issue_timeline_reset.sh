#!/usr/bin/env bash
# Validates the CRM transactional-record migration bundle via a full
# supabase db reset, then runs CRM auto-population plus timeline/payment-issue
# projection assertions against the reset database.
#
# Usage (from repo root):
#   bash supabase/tests/run_crm_interaction_issue_timeline_reset.sh
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

echo "Running CRM auto-populate reset assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/crm_auto_populate_from_transactional.sql" \
  >/dev/null

echo "Running CRM interaction timeline + payment issue reset assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/crm_interaction_issue_timeline_reset.sql" \
  >/dev/null

echo "Running CRM profile last-interaction projection reset assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/crm_profile_last_interaction_projection_reset.sql" \
  >/dev/null

echo "CRM transactional reset checks passed"
