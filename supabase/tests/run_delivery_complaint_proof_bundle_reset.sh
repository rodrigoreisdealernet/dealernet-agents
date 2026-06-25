#!/usr/bin/env bash
# Validates 20260617130000_delivery_complaint_proof_bundle.sql via a full
# supabase db reset, then runs schema-object and fixture assertions to confirm
# the complaint proof-bundle read model, recovery-routing fields, and
# tenant-scoped access remain intact.
#
# Usage (from repo root):
#   bash supabase/tests/run_delivery_complaint_proof_bundle_reset.sh
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
  -f "$repo_root/supabase/tests/delivery_complaint_proof_bundle_reset.sql" \
  >/dev/null

echo "delivery_complaint_proof_bundle reset SQL assertions passed"
echo "delivery_complaint_proof_bundle reset checks passed"
