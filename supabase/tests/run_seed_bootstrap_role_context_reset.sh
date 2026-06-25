#!/usr/bin/env bash
# Reset-path validation for the seed write-RPC role context inside executable
# DO $$ bootstrap blocks (PR #2206 acceptance criterion).
#
# Runs `supabase db reset --config supabase/config.toml` to apply all migrations
# and seed.sql in a real Supabase stack, then executes the focused contract tests
# that verify the role-claim scoping invariants for DO block write RPCs.
#
# This proves the reset path: seed.sql DO $$ blocks that call write RPCs
# (rental_upsert_entity_current_state, create_entity_with_version,
# rental_upsert_relationship) succeed without write-RPC guard failures.
#
# Usage (from repo root):
#   bash supabase/tests/run_seed_bootstrap_role_context_reset.sh
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
  -f "$repo_root/supabase/tests/seed_bootstrap_role_context.sql" \
  >/dev/null

echo "seed_bootstrap_role_context reset-path validation passed"
