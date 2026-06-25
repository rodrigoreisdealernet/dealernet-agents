#!/usr/bin/env bash
# Validates portal schedule access controls (including
# 20260613222000_portal_schedule_public_read.sql) and the portal scope token seeded
# in seed.sql via a full `supabase db reset --config supabase/config.toml`, then
# runs supabase/tests/portal_schedule_access.sql against the resulting database.
#
# This script provides the reset-path guardrail required by the acceptance criteria
# for the portal schedule anon access fix (PR #908): any seed/migration drift that
# breaks the scope-token → contract binding or the portal_get_contract_schedule /
# portal_get_demo_portal_url function signatures will fail here rather than being
# caught during a live portal session.
#
# Usage (from repo root):
#   bash supabase/tests/run_portal_schedule_access_reset.sh
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
  -f "$repo_root/supabase/tests/portal_schedule_access.sql" \
  >/dev/null

echo "portal_schedule_access reset-path validation passed"
