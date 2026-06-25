#!/usr/bin/env bash
# Validates that `supabase db reset` replays the driver run-sheet contact-field
# migration cleanly, then reruns the existing behavioral assertions from
# driver_runsheet_contact_fields.sql against the rebuilt schema.
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
  -f "$repo_root/supabase/tests/driver_runsheet_contact_fields.sql" \
  >/dev/null

echo "driver_runsheet_contact_fields reset SQL assertions passed"
echo "driver_runsheet_contact_fields reset checks passed"
