#!/usr/bin/env bash
# Validates that `supabase db reset` applies the inventory rate structures
# migration (20260613001000_inventory_rate_structures.sql) cleanly and that
# effective-dated rate-plan resolution, deterministic precedence selection,
# and quote-line pricing snapshot persistence pass against a fully-reset
# local database.
#
# Usage (from repo root):
#   bash supabase/tests/run_inventory_rate_structures_reset.sh
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

echo "Running inventory rate structures reset-path behavioral tests"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/inventory_rate_structures_reset.sql" \
  >/dev/null

echo "Inventory rate structures reset checks passed"
