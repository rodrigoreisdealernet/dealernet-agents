#!/usr/bin/env bash
# Reset-path validation for logistics_compliance_surface
# (migration 20260609143000_logistics_compliance_surface.sql).
#
# Runs `supabase db reset --config supabase/config.toml`, then executes
# logistics_compliance_surface_reset.sql against the local stack to confirm:
#   - the migration applies cleanly through a full reset
#   - the dispatcher + driver query paths are intact
#
# Usage:
#   bash supabase/tests/run_logistics_compliance_surface_reset.sh
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
  -f "$repo_root/supabase/tests/logistics_compliance_surface_reset.sql" \
  >/dev/null

echo "Logistics compliance surface reset checks passed"
