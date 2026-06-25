#!/usr/bin/env bash
# Validates that `supabase db reset --config supabase/config.toml` applies the
# project hierarchy + mixed-fleet allocation migration
# (20260614180000_project_hierarchy_mixed_fleet_allocation.sql) cleanly, then
# runs reset-path assertions against the rebuilt database to confirm:
#   - project_upsert_hierarchy_node and project_allocate_equipment RPCs exist
#     with correct grants after reset.
#   - v_project_equipment_allocations_current view exists and is accessible
#     only by authenticated/service_role after reset.
#   - Project hierarchy upsert creates branch_has_project and
#     project_inherits_requirements_from_project relationships coherently.
#   - Equipment allocation writes produce project_equipment_assignment entities
#     with correct allocation_source for owned vs leased assets.
#   - Current-allocation reads via the view are coherent with project, branch,
#     yard, status, and planned-date context after a fresh reset.
#   - Cross-tenant RLS prevents tenant-b claims from reading tenant-a data.
#
# Usage (from repo root):
#   bash supabase/tests/run_project_hierarchy_mixed_fleet_allocation_reset.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/supabase/tests/reset_validation_lib.sh"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required for reset validation" >&2
  exit 127
fi

db_port="${SUPABASE_DB_PORT:-54322}"
validation_root="$repo_root"
validation_tmp_root=""

if ! python - "$db_port" <<'PY' >/dev/null 2>&1
import socket
import sys

port = int(sys.argv[1])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", port))
PY
then
  db_port="$(python - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
  validation_tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/wynne-project-hierarchy-mixed-fleet-reset.XXXXXX")"
  cp -R "$repo_root/supabase" "$validation_tmp_root/supabase"
  python - "$validation_tmp_root/supabase/config.toml" "$db_port" <<'PY'
import re
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
port = sys.argv[2]
content = config_path.read_text()
updated, count = re.subn(
    r"(?ms)(^\[db\]\s*$.*?^\s*port\s*=\s*)([^#\r\n]+)(\s*(?:#.*)?$)",
    rf"\g<1>{port}\g<3>",
    content,
    count=1,
)
if count != 1:
    raise SystemExit("Unable to update [db] port in Supabase config.toml")
config_path.write_text(updated)
PY
  validation_root="$validation_tmp_root"
fi

setup_supabase_reset_validation "$validation_root"

cleanup() {
  cleanup_supabase_reset_validation
  if [[ -n "$validation_tmp_root" ]]; then
    rm -rf "$validation_tmp_root"
  fi
}

trap cleanup EXIT

run_supabase_start_with_transient_retry 6
run_supabase_reset_with_transient_retry 6

psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -p "${SUPABASE_DB_PORT:-$db_port}" \
  -U postgres \
  -d postgres \
  -f "$validation_root/supabase/tests/project_hierarchy_mixed_fleet_allocation_reset.sql" \
  >/dev/null

echo "Project hierarchy + mixed-fleet allocation reset checks passed"
