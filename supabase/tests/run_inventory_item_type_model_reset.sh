#!/usr/bin/env bash
set -euo pipefail

# Inventory item-type model reset-path validation
# Runs supabase db reset then exercises the inventory_item_type_model_reset.sql
# assertions against a fresh schema rebuild.
#
# Usage: bash supabase/tests/run_inventory_item_type_model_reset.sh
#
# Requires: supabase CLI, docker

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
  -f "$repo_root/supabase/tests/inventory_item_type_model_reset.sql" \
  >/dev/null

echo "Inventory item-type model reset-path checks passed"
