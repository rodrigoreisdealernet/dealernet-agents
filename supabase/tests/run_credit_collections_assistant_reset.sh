#!/usr/bin/env bash
# Validates the 20260614221500_credit_collections_assistant.sql migration via a
# full supabase db reset, then runs the credit_collections_assistant.sql
# assertions against the resulting database.
#
# Usage (from repo root):
#   bash supabase/tests/run_credit_collections_assistant_reset.sh
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
  -f "$repo_root/supabase/tests/credit_collections_assistant.sql" \
  >/dev/null

echo "credit_collections_assistant reset-path checks passed"
