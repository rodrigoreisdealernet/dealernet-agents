#!/usr/bin/env bash

supabase_reset_stage_root=""
supabase_db_port=""
supabase_db_shadow_port=""
_supabase_slot_fd=""
_supabase_slot_lock_file=""
_supabase_acquired_slot=""

setup_supabase_reset_validation() {
  local repo_root="$1"

  export PGPASSWORD="${PGPASSWORD:-postgres}"

  start_args=(start)
  stop_args=(stop --no-backup)
  reset_args=(db reset)

  local supabase_start_help
  local supabase_stop_help
  local supabase_reset_help
  supabase_start_help="$(supabase start --help 2>&1 || true)"
  supabase_stop_help="$(supabase stop --help 2>&1 || true)"
  supabase_reset_help="$(supabase db reset --help 2>&1 || true)"

  if grep -q -- '--yes' <<<"$supabase_start_help"; then
    start_args+=(--yes)
  fi

  if grep -q -- '--yes' <<<"$supabase_stop_help"; then
    stop_args+=(--yes)
  fi

  if grep -q -- '--yes' <<<"$supabase_reset_help"; then
    reset_args+=(--yes)
  fi

  supabase_reset_stage_root="$(mktemp -d "${TMPDIR:-/tmp}/wynne-supabase-reset.XXXXXX")"
  _supabase_reset_stage_project "$repo_root" "$supabase_reset_stage_root"
  _supabase_reset_disable_edge_runtime "$supabase_reset_stage_root"
  local project_root="$supabase_reset_stage_root"
  echo "Staged Supabase reset project at $supabase_reset_stage_root" >&2
  echo "Disabled Supabase edge runtime for reset validation" >&2

  if ! _supabase_reset_acquire_slot; then
    echo "Supabase slot acquisition failed" >&2
    return 1
  fi
  local base=$(( 55000 + _supabase_acquired_slot * 6 ))
  read -r supabase_db_port supabase_db_shadow_port < <(
    _supabase_reset_rewrite_all_ports "$project_root" "$base"
  )
  echo "Assigned isolated Supabase ports slot=$_supabase_acquired_slot base=$base db=$supabase_db_port shadow=$supabase_db_shadow_port" >&2

  export SUPABASE_DB_PORT="$supabase_db_port"
  export SUPABASE_DB_SHADOW_PORT="$supabase_db_shadow_port"

  if grep -q -- '--config' <<<"$supabase_reset_help"; then
    project_args=(--config "$project_root/supabase/config.toml")
    reset_project_args=("${project_args[@]}")
  else
    project_args=(--workdir "$project_root")
    reset_project_args=(--local "${project_args[@]}")
  fi
}

cleanup_supabase_reset_validation() {
  timeout 60 supabase "${stop_args[@]}" "${project_args[@]}" >/dev/null 2>&1 || true
  if [[ -n "${_supabase_slot_fd:-}" ]]; then
    exec {_supabase_slot_fd}>&- 2>/dev/null || true
    _supabase_slot_fd=""
  fi
  # Do NOT unlink the slot lock file.  Removing the path after closing the fd
  # creates an unlink/recreate race: a successor job acquires the flock on the
  # original inode, cleanup unlinks the path, and then a third job can create a
  # fresh inode at the same path and flock it — giving two concurrent holders of
  # the same slot.  Leaving the file in place keeps the path stable so every
  # opener sees the same inode and the flock exclusion is always respected.
  _supabase_slot_lock_file=""
  _supabase_acquired_slot=""
  if [[ -n "$supabase_reset_stage_root" ]]; then
    rm -rf "$supabase_reset_stage_root"
    supabase_reset_stage_root=""
  fi
}

run_supabase_start_with_transient_retry() {
  local max_attempts="${1:-6}"
  local output
  local attempts=0
  local transient_re='Error status 50[0-9]|invalid response was received from the upstream server|context deadline exceeded|connection refused|connection reset|i/o timeout|: EOF$|: EOF |unexpected EOF|error during connect|server closed the connection|TLS handshake timeout|timeout exceeded while awaiting headers|the input device is not a TTY|error running container: exit 1|failed to start docker container|failed to set up container networking|driver failed programming external connectivity|failed to bind host port|address already in use'

  timeout 60 supabase "${stop_args[@]}" "${project_args[@]}" >/dev/null 2>&1 || true
  docker ps -a --filter "name=supabase_" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true

  while true; do
    if output="$(timeout 300 supabase "${start_args[@]}" "${project_args[@]}" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ] || ! grep -qE "$transient_re" <<<"$output"; then
      printf '%s\n' "$output" >&2
      return 1
    fi

    echo "Supabase start returned a transient infra error. Retrying (attempt $attempts of $((max_attempts - 1)))..." >&2
    timeout 60 supabase "${stop_args[@]}" "${project_args[@]}" >/dev/null 2>&1 || true
    docker ps -a --filter "name=supabase_" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
    sleep $((attempts * 5))
  done
}

run_supabase_reset_with_transient_retry() {
  local max_attempts="${1:-6}"
  local output
  local attempts=0
  local transient_re='Error status 50[0-9]|invalid response was received from the upstream server|context deadline exceeded|connection refused|connection reset|i/o timeout|: EOF$|: EOF |unexpected EOF|error during connect|server closed the connection|TLS handshake timeout|timeout exceeded while awaiting headers|the input device is not a TTY|error running container: exit 1|failed to start docker container|failed to set up container networking|driver failed programming external connectivity|container .* is not ready: unhealthy|ERROR: deadlock detected \(SQLSTATE 40P01\)|failed to bind host port|address already in use'

  while true; do
    if output="$(timeout 300 supabase "${reset_args[@]}" "${reset_project_args[@]}" 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi

    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ] || ! grep -qE "$transient_re" <<<"$output"; then
      printf '%s\n' "$output" >&2
      return 1
    fi

    echo "Supabase reset returned a transient infra error. Retrying (attempt $attempts of $((max_attempts - 1)))..." >&2
    # Stop the stack and clear any stuck containers before retrying so a wedged
    # Kong/PostgREST that causes the 502 is fully restarted, not just waited out.
    timeout 60 supabase "${stop_args[@]}" "${project_args[@]}" >/dev/null 2>&1 || true
    docker ps -a --filter "name=supabase_" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
    sleep $((attempts * 5))
    timeout 300 supabase "${start_args[@]}" "${project_args[@]}" >/dev/null 2>&1 || true
  done
}

_supabase_reset_has_duplicate_versions() {
  local repo_root="$1"
  python - "$repo_root" <<'PY'
from collections import Counter
from pathlib import Path
import sys

migrations = Path(sys.argv[1]) / "supabase" / "migrations"
versions = [path.name.split("_", 1)[0] for path in migrations.glob("*.sql")]
print("1" if any(count > 1 for count in Counter(versions).values()) else "0")
PY
}

_supabase_reset_stage_project() {
  local repo_root="$1"
  local stage_root="$2"
  python - "$repo_root" "$stage_root" <<'PY'
from datetime import datetime, timedelta
from pathlib import Path
import shutil
import sys

repo_root = Path(sys.argv[1])
stage_root = Path(sys.argv[2])
source_dir = repo_root / "supabase"
target_dir = stage_root / "supabase"

shutil.copytree(source_dir, target_dir, dirs_exist_ok=True)

previous_timestamp = None
for migration_path in sorted((target_dir / "migrations").glob("*.sql")):
    version, remainder = migration_path.name.split("_", 1)
    assigned_timestamp = datetime.strptime(version, "%Y%m%d%H%M%S")
    if previous_timestamp is not None and assigned_timestamp <= previous_timestamp:
        assigned_timestamp = previous_timestamp + timedelta(seconds=1)
        migration_path.rename(
            migration_path.with_name(f"{assigned_timestamp.strftime('%Y%m%d%H%M%S')}_{remainder}")
        )
    previous_timestamp = assigned_timestamp
PY
}

_supabase_reset_disable_edge_runtime() {
  local project_root="$1"
  python - "$project_root" <<'PY'
from pathlib import Path
import sys

config_path = Path(sys.argv[1]) / "supabase" / "config.toml"
lines = config_path.read_text().splitlines()
section = ""

for index, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped
        continue
    if section == "[edge_runtime]" and stripped.startswith("enabled ="):
        lines[index] = "enabled = false"
        break

config_path.write_text("\n".join(lines) + "\n")
PY
}

# Returns 0 if every port in [base, base+6) is free to bind on loopback, 1 if
# any port is already occupied by another process on the host.
# Called by _supabase_reset_acquire_slot before committing to a slot so port
# assignment in _supabase_reset_rewrite_all_ports never spills into a
# neighbouring slot's window.
_supabase_reset_all_slot_ports_free() {
  local base="$1"
  python - "$base" <<'PY'
import socket, sys
base = int(sys.argv[1])
for port in range(base, base + 6):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            sys.exit(1)
sys.exit(0)
PY
}

# Atomically claims one of 1333 6-port slots by holding an exclusive flock on a
# per-slot lock file for the lifetime of the calling bash process.  Because flock
# is an OS-level advisory lock, no two processes on the same host can hold the
# same slot simultaneously.  Additionally, every port in the chosen slot's 6-port
# window must be free before the slot is committed — if any port is occupied by
# an unrelated host process the slot is released and the scan continues, so port
# assignment in _supabase_reset_rewrite_all_ports can never spill into a
# neighbouring slot's window.
#
# The acquired slot number is stored in the global _supabase_acquired_slot; the
# open fd is stored in _supabase_slot_fd.  Call cleanup_supabase_reset_validation
# to release.
#
# Environment variables:
#   SUPABASE_SLOT_DIR   - directory for slot lock files (default: /tmp/wynne-supabase-slots)
#   SUPABASE_SLOT_START - slot index to start scanning from (0–1332); override for tests
_supabase_reset_acquire_slot() {
  local lock_dir="${SUPABASE_SLOT_DIR:-/tmp/wynne-supabase-slots}"
  mkdir -p "$lock_dir"
  local start_slot
  if [[ -n "${SUPABASE_SLOT_START:-}" ]]; then
    start_slot="$SUPABASE_SLOT_START"
  else
    # shuf avoids the 32-bit overflow and modulo bias that affect RANDOM*RANDOM.
    start_slot=$(shuf -i 0-1332 -n 1)
  fi
  local i slot lock_file base
  for (( i = 0; i < 1333; i++ )); do
    slot=$(( (start_slot + i) % 1333 ))
    lock_file="$lock_dir/slot-${slot}.lock"
    # exec {varname}>file opens a new file descriptor (bash 4.1+) and stores
    # its number in varname.  The fd stays open in the calling shell's fd table
    # until closed explicitly, keeping the flock alive for the job's lifetime.
    exec {_supabase_slot_fd}>"$lock_file"
    if flock -n "$_supabase_slot_fd" 2>/dev/null; then
      base=$(( 55000 + slot * 6 ))
      # Before committing, verify every port in this slot's 6-port window is
      # bindable.  If any port is occupied by an unrelated host process, release
      # the flock and try the next slot — this prevents _supabase_reset_rewrite_all_ports
      # from ever scanning beyond [base, base+6) into a neighbouring slot's window.
      if ! _supabase_reset_all_slot_ports_free "$base"; then
        exec {_supabase_slot_fd}>&-
        _supabase_slot_fd=""
        continue
      fi
      _supabase_slot_lock_file="$lock_file"
      _supabase_acquired_slot="$slot"
      return 0
    fi
    exec {_supabase_slot_fd}>&-
    _supabase_slot_fd=""
  done
  echo "supabase slot acquisition: all 1333 slots are locked or have occupied ports, cannot allocate" >&2
  return 1
}

_supabase_reset_rewrite_all_ports() {
  local project_root="$1"
  local base="$2"
  python - "$project_root" "$base" <<'PY'
from pathlib import Path
import socket
import sys
import uuid

project_root = Path(sys.argv[1])
# Base port window is passed in by the bash caller, which holds an exclusive
# flock on the slot file and has already verified every port in [base, base+6)
# is free (_supabase_reset_all_slot_ports_free).  Assign each service to its
# fixed offset within the window — no scan-forward — so assignment can never
# spill into a neighbouring slot's window.
base = int(sys.argv[2])


def can_bind(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


# Assign each service to its fixed offset; raise if a port became occupied
# between slot acquisition and this assignment (TOCTOU safety net).
for offset, label in enumerate(("api", "db", "shadow", "studio", "inbucket", "analytics")):
    port = base + offset
    if not can_bind(port):
        raise SystemExit(
            f"Port {port} (slot offset {offset}, service={label}) became occupied "
            f"after slot acquisition. Re-run to acquire a fresh slot."
        )

api_port = base + 0
db_port = base + 1
shadow_port = base + 2
studio_port = base + 3
inbucket_port = base + 4
analytics_port = base + 5

# Generate a unique project_id for this run so Docker container names
# derived from project_id never collide across concurrent jobs.
run_id = uuid.uuid4()
project_id = f"ci-{run_id.hex[:12]}"

config_path = project_root / "supabase" / "config.toml"
lines = config_path.read_text().splitlines()
section = ""
for index, line in enumerate(lines):
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped
        continue
    if stripped.startswith("project_id ="):
        lines[index] = f'project_id = "{project_id}"'
    elif section == "[api]" and stripped.startswith("port ="):
        lines[index] = f"port = {api_port}"
    elif section == "[db]" and stripped.startswith("port ="):
        lines[index] = f"port = {db_port}"
    elif section == "[db]" and stripped.startswith("shadow_port ="):
        lines[index] = f"shadow_port = {shadow_port}"
    elif section == "[studio]" and stripped.startswith("port ="):
        lines[index] = f"port = {studio_port}"
    elif section == "[inbucket]" and stripped.startswith("port ="):
        lines[index] = f"port = {inbucket_port}"
    elif section == "[analytics]" and stripped.startswith("port ="):
        lines[index] = f"port = {analytics_port}"

config_path.write_text("\n".join(lines) + "\n")
print(f"{db_port} {shadow_port}")
PY
}
