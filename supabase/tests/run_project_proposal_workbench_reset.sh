#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# project proposal and rate-approval workbench migration
# (20260615120000_project_proposal_workbench.sql) cleanly, then runs focused
# reset-path SQL assertions to confirm:
#   - Both workbench views are present and queryable.
#   - The ops_output_schema_registry entry for project_proposal_v1 is seeded.
#   - The staff_submit_project_proposal_for_approval RPC exists and enforces
#     the assist-only approval boundary (creates pending_approval findings).
#   - Grant coverage: authenticated can SELECT both views; anon cannot.
#   - Role guard: read_only and field_operator callers are denied the RPC.
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

echo "Running project proposal workbench reset-path assertions"
psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-54322}" \
  -U postgres \
  -d postgres \
  -f "$repo_root/supabase/tests/project_proposal_workbench_reset.sql" \
  >/dev/null

echo "Project proposal workbench reset checks passed"
