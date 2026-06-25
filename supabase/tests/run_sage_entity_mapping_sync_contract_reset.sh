#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# Sage entity mapping and sync-contract migration chain cleanly, then runs
# focused SQL assertions for the 20260613092641_sage_entity_mapping_sync_contract.sql
# objects against the rebuilt database to confirm:
#   - sage_supported_entity_contract() function exists and returns expected shape
#   - v_sage_entity_mapping_contract view exists with security_invoker = true
#   - external_id_map_sage_external_id_guard trigger exists
#   - integration_delivery_log Sage check constraint is present and enforced
#   - replay-safe mapping reads/writes work after a fresh reset
#
# Usage (from repo root):
#   bash supabase/tests/run_sage_entity_mapping_sync_contract_reset.sh
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
  -f "$repo_root/supabase/tests/sage_entity_mapping_sync_contract_reset.sql" \
  >/dev/null

echo "Sage entity mapping sync contract reset checks passed"
