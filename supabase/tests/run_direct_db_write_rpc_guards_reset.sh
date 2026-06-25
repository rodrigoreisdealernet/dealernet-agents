#!/usr/bin/env bash
# Validates the direct-DB write-RPC guard widening (PR #291) via a full
# `supabase db reset --config supabase/config.toml`, then runs the contract
# tests against the resulting local Supabase database.
#
# This script documents and exercises the acceptance criterion from the issue:
#   "Run and document `supabase db reset --config supabase/config.toml` for
#   the migration path that includes PR #264 and PR #291."
#
# Usage (from repo root):
#   bash supabase/tests/run_direct_db_write_rpc_guards_reset.sh
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
run_supabase_reset_with_transient_retry 4

psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/direct_db_write_rpc_guards.sql" \
  >/dev/null

echo "direct_db_write_rpc_guards reset validation passed"
