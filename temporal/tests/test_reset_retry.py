"""Deterministic tests for the Supabase reset retry/backoff logic.

These tests exercise the ``run_reset_with_transient_retry`` shell function
used by both reset harness scripts without requiring a real Supabase
installation.  A mock ``supabase`` binary is injected via PATH so the
function can be driven to each interesting code-path:

- Immediate success (no 502 at all).
- Transient 502 / container-exit startup failures on the first N attempts, then success.
- Persistent 502 – all attempts exhausted → non-zero exit.
- Non-transient failure (different error text) → fails immediately.
"""

from __future__ import annotations

import fcntl
import os
import socket
import stat
import subprocess
import textwrap
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# The shell snippet that contains the retry function plus a minimal
# caller.  We inline reset_args and reset_project_args so the function
# calls our mock supabase with no extra complexity.
_HARNESS_TMPL = textwrap.dedent("""\
    #!/usr/bin/env bash
    set -euo pipefail

    reset_args=(db reset)
    reset_project_args=()

    run_reset_with_transient_retry() {{
      local output
      local attempts=0
      local max_attempts=4
      local transient_error='Error status 50[0-9]|invalid response was received from the upstream server|error running container: exit 1'

      while true; do
        if output="$(supabase "${{reset_args[@]}}" "${{reset_project_args[@]}}" 2>&1)"; then
          printf '%s\\n' "$output"
          return 0
        fi

        attempts=$(( attempts + 1 ))
        if [ "$attempts" -ge "$max_attempts" ] || ! grep -qE "$transient_error" <<<"$output"; then
          printf '%s\\n' "$output" >&2
          return 1
        fi

        echo "Supabase reset returned transient 502. Retrying (attempt $attempts of $(( max_attempts - 1 )))..." >&2
        sleep {sleep_cmd}
      done
    }}

    run_reset_with_transient_retry
""")


def _write_mock_supabase(tmp_path: Path, *, fail_times: int, error_text: str) -> None:
    """Write a mock ``supabase`` executable to *tmp_path*.

    The mock fails with *error_text* for the first *fail_times* invocations
    of ``supabase db reset``, then succeeds.  Invocations with any other
    sub-command (help, start, stop, …) succeed silently so callers that
    probe help flags are not disturbed.
    """
    counter_file = tmp_path / "call_count"
    counter_file.write_text("0")

    script = textwrap.dedent(f"""\
        #!/usr/bin/env bash
        # Only intercept "supabase db reset …"
        if [ "$1" = "db" ] && [ "$2" = "reset" ]; then
          count=$(cat {counter_file})
          count=$(( count + 1 ))
          printf '%s' "$count" > {counter_file}
          if [ "$count" -le {fail_times} ]; then
            echo "{error_text}"
            exit 1
          fi
        fi
        exit 0
    """)
    mock = tmp_path / "supabase"
    mock.write_text(script)
    mock.chmod(mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _run_harness(tmp_path: Path, *, sleep_cmd: str = "0") -> subprocess.CompletedProcess[str]:
    harness = tmp_path / "harness.sh"
    harness.write_text(_HARNESS_TMPL.format(sleep_cmd=sleep_cmd))
    harness.chmod(harness.stat().st_mode | stat.S_IEXEC)

    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env.get("PATH", "")

    return subprocess.run(
        ["bash", str(harness)],
        text=True,
        capture_output=True,
        env=env,
        timeout=30.0,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_retry_succeeds_immediately_when_no_error(tmp_path: Path) -> None:
    """Function returns 0 when supabase db reset succeeds on the first try."""
    _write_mock_supabase(tmp_path, fail_times=0, error_text="")
    result = _run_harness(tmp_path)
    assert result.returncode == 0


def test_retry_recovers_after_one_transient_502(tmp_path: Path) -> None:
    """Function succeeds when the first attempt is a transient 502."""
    _write_mock_supabase(
        tmp_path,
        fail_times=1,
        error_text="Error status 502: An invalid response was received from the upstream server",
    )
    result = _run_harness(tmp_path)
    assert result.returncode == 0
    assert "Retrying (attempt 1 of 3)" in result.stderr


def test_retry_recovers_after_three_transient_502s(tmp_path: Path) -> None:
    """Function succeeds when the first three attempts are transient 502s (max_attempts=4)."""
    _write_mock_supabase(
        tmp_path,
        fail_times=3,
        error_text="Error status 502: An invalid response was received from the upstream server",
    )
    result = _run_harness(tmp_path)
    assert result.returncode == 0
    assert "Retrying (attempt 3 of 3)" in result.stderr


def test_retry_recovers_after_container_startup_exit(tmp_path: Path) -> None:
    """Function succeeds when the first attempt exits during schema init container startup."""
    _write_mock_supabase(
        tmp_path,
        fail_times=1,
        error_text="Initialising schema...\nerror running container: exit 1",
    )
    result = _run_harness(tmp_path)
    assert result.returncode == 0
    assert "Retrying (attempt 1 of 3)" in result.stderr


def test_retry_fails_after_max_attempts_exhausted(tmp_path: Path) -> None:
    """Function fails when all four attempts return a transient 502."""
    _write_mock_supabase(
        tmp_path,
        fail_times=10,
        error_text="Error status 502: An invalid response was received from the upstream server",
    )
    result = _run_harness(tmp_path)
    assert result.returncode != 0
    assert "Error status 502" in result.stderr


def test_retry_fails_immediately_on_non_transient_error(tmp_path: Path) -> None:
    """Function fails without retrying when the error is not a known transient 502."""
    _write_mock_supabase(
        tmp_path,
        fail_times=1,
        error_text="fatal: database connection refused",
    )
    result = _run_harness(tmp_path)
    assert result.returncode != 0
    # No retry message in stderr — the function should bail out immediately.
    assert "Retrying" not in result.stderr


# ---------------------------------------------------------------------------
# Start-retry tests – source the real reset_validation_lib.sh
# ---------------------------------------------------------------------------

# Harness that sources the real library so the test exercises the live code.
_START_HARNESS_TMPL = textwrap.dedent("""\
    #!/usr/bin/env bash
    set -euo pipefail

    # Source the real library; wire the variables the function reads directly
    # so we do not need a full repo root or a live Supabase CLI.
    # shellcheck source=supabase/tests/reset_validation_lib.sh
    source "{lib_path}"

    start_args=(start)
    stop_args=(stop --no-backup)
    project_args=()

    run_supabase_start_with_transient_retry 3
""")


def _write_start_mock_supabase(tmp_path: Path, *, fail_times: int, error_text: str) -> None:
    """Write a mock ``supabase`` and a no-op ``sleep`` to *tmp_path*.

    The mock fails ``supabase start`` with *error_text* for the first
    *fail_times* invocations, then succeeds.  All other sub-commands succeed
    silently.  The no-op ``sleep`` keeps test duration short.
    """
    counter_file = tmp_path / "start_call_count"
    counter_file.write_text("0")

    supabase_script = textwrap.dedent(f"""\
        #!/usr/bin/env bash
        if [ "$1" = "start" ]; then
          count=$(cat {counter_file})
          count=$(( count + 1 ))
          printf '%s' "$count" > {counter_file}
          if [ "$count" -le {fail_times} ]; then
            echo "{error_text}"
            exit 1
          fi
        fi
        exit 0
    """)
    mock = tmp_path / "supabase"
    mock.write_text(supabase_script)
    mock.chmod(mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # Override sleep so the retry backoff does not slow down the test suite.
    sleep_mock = tmp_path / "sleep"
    sleep_mock.write_text("#!/usr/bin/env bash\n")
    sleep_mock.chmod(sleep_mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _run_start_harness(tmp_path: Path, lib_path: Path) -> subprocess.CompletedProcess[str]:
    harness = tmp_path / "start_harness.sh"
    harness.write_text(_START_HARNESS_TMPL.format(lib_path=lib_path))
    harness.chmod(harness.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env.get("PATH", "")

    return subprocess.run(
        ["bash", str(harness)],
        text=True,
        capture_output=True,
        env=env,
        timeout=30.0,
    )


def test_start_retry_on_port_conflict(tmp_path: Path) -> None:
    """run_supabase_start_with_transient_retry retries when 'address already in use' is seen.

    Regression guard: if the 'address already in use' entry is removed or
    misspelled in the transient_re pattern inside reset_validation_lib.sh,
    this test fails — ensuring the port-collision reliability fix cannot
    regress silently while CI stays green.
    """
    lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
    _write_start_mock_supabase(
        tmp_path,
        fail_times=1,
        error_text=(
            "failed to bind host port for 0.0.0.0:54324 on container "
            "'supabase_inbucket': address already in use"
        ),
    )
    result = _run_start_harness(tmp_path, lib_path)
    assert result.returncode == 0, f"Expected success after retry; stderr: {result.stderr}"
    assert "Retrying (attempt 1 of" in result.stderr


# ---------------------------------------------------------------------------
# Reset-retry tests – source the real reset_validation_lib.sh
#
# These tests verify that run_supabase_reset_with_transient_retry stops and
# restarts Supabase between retry attempts when a transient 502 is detected,
# so a stuck Kong/PostgREST is fully recycled rather than just waited out.
# ---------------------------------------------------------------------------

# Harness that sources the real library and wires the variables the reset
# function reads without requiring a real Supabase installation.
_RESET_LIB_HARNESS_TMPL = textwrap.dedent("""\
    #!/usr/bin/env bash
    set -euo pipefail
    # shellcheck source=supabase/tests/reset_validation_lib.sh
    source "{lib_path}"

    reset_args=(db reset)
    reset_project_args=()
    start_args=(start)
    stop_args=(stop --no-backup)
    project_args=()

    run_supabase_reset_with_transient_retry 3
""")


def _write_reset_lib_mock_supabase(
    tmp_path: Path,
    *,
    fail_times: int,
    error_text: str,
    log_file: Path,
) -> None:
    """Write a mock ``supabase`` and no-op ``sleep`` to *tmp_path*.

    The mock records the first positional argument of every invocation to
    *log_file* (one entry per line) and fails ``supabase db reset`` with
    *error_text* for the first *fail_times* invocations.  All other
    sub-commands succeed silently.  The no-op ``sleep`` keeps tests fast.
    """
    counter_file = tmp_path / "reset_lib_call_count"
    counter_file.write_text("0")

    supabase_script = textwrap.dedent(f"""\
        #!/usr/bin/env bash
        printf '%s\\n' "$1" >> {log_file}
        if [ "$1" = "db" ] && [ "$2" = "reset" ]; then
          count=$(cat {counter_file})
          count=$(( count + 1 ))
          printf '%s' "$count" > {counter_file}
          if [ "$count" -le {fail_times} ]; then
            echo "{error_text}"
            exit 1
          fi
        fi
        exit 0
    """)
    mock = tmp_path / "supabase"
    mock.write_text(supabase_script)
    mock.chmod(mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    sleep_mock = tmp_path / "sleep"
    sleep_mock.write_text("#!/usr/bin/env bash\n")
    sleep_mock.chmod(sleep_mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _run_reset_lib_harness(tmp_path: Path, lib_path: Path) -> subprocess.CompletedProcess[str]:
    harness = tmp_path / "reset_lib_harness.sh"
    harness.write_text(_RESET_LIB_HARNESS_TMPL.format(lib_path=lib_path))
    harness.chmod(harness.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env.get("PATH", "")

    return subprocess.run(
        ["bash", str(harness)],
        text=True,
        capture_output=True,
        env=env,
        timeout=30.0,
    )


def test_reset_retry_calls_stop_and_start_on_transient_502(tmp_path: Path) -> None:
    """run_supabase_reset_with_transient_retry stops and restarts Supabase on a transient 502.

    Regression guard: ensures the stop/start recovery path is executed when
    ``supabase db reset`` hits a transient 502, so stuck Kong/PostgREST
    containers are cleared before the next attempt rather than merely waited
    out.  If the stop+start block is ever removed from the retry path in
    reset_validation_lib.sh this test fails deterministically.
    """
    lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
    log_file = tmp_path / "commands.log"
    log_file.write_text("")

    _write_reset_lib_mock_supabase(
        tmp_path,
        fail_times=1,
        error_text="Error status 502: An invalid response was received from the upstream server",
        log_file=log_file,
    )
    result = _run_reset_lib_harness(tmp_path, lib_path)
    assert result.returncode == 0, f"Expected success after retry; stderr: {result.stderr}"
    assert "Retrying (attempt 1 of" in result.stderr

    commands = log_file.read_text().splitlines()
    assert "stop" in commands, (
        f"supabase stop not called during retry; recorded commands: {commands}"
    )
    assert "start" in commands, (
        f"supabase start not called during retry; recorded commands: {commands}"
    )

    # Order check: stop → start → second db reset.
    db_indices = [i for i, c in enumerate(commands) if c == "db"]
    assert len(db_indices) >= 2, (
        f"Expected at least 2 'db reset' calls (one fail, one success); "
        f"recorded commands: {commands}"
    )
    stop_idx = commands.index("stop")
    start_idx = commands.index("start")
    second_db_idx = db_indices[1]
    assert stop_idx > db_indices[0], (
        f"stop should come after the first failed db reset; "
        f"recorded commands: {commands}"
    )
    assert start_idx > stop_idx, (
        f"start should come after stop in the recovery sequence; "
        f"recorded commands: {commands}"
    )
    assert stop_idx < second_db_idx, (
        f"stop should come before the second (successful) db reset retry; "
        f"recorded commands: {commands}"
    )


# ---------------------------------------------------------------------------
# Alternate-port end-to-end tests
#
# These tests verify that when port 54322 is occupied the reset harness assigns
# an alternate SUPABASE_DB_PORT *and* that the psql invocations inside reset
# scripts actually use that alternate port instead of the hardcoded 54322.
# The tests use:
#   - a Python socket held open on 54322 to simulate a conflicting process
#   - a mock `supabase` binary that exits 0 for every sub-command
#   - a recording mock `psql` that captures the -p argument to a file
# ---------------------------------------------------------------------------

# Timeout for the inline harness test (no real Docker/Supabase involved).
_HARNESS_TIMEOUT_SECONDS = 30.0
# Longer timeout for the full outlier scripts, which stage a project dir.
_OUTLIER_SCRIPT_TIMEOUT_SECONDS = 60.0


def _bind_port_or_none(port: int) -> "socket.socket | None":
    """Return a socket bound to *port* on loopback, or None if already in use.

    The caller is responsible for closing the returned socket when the test
    is done so the OS releases the port.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        return None
    return sock


def _write_silent_supabase(tmp_path: Path) -> None:
    """Write a mock `supabase` binary that exits 0 for every sub-command."""
    script = "#!/usr/bin/env bash\nexit 0\n"
    mock = tmp_path / "supabase"
    mock.write_text(script)
    mock.chmod(mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _write_port_recording_psql(tmp_path: Path) -> Path:
    """Write a mock `psql` that records the -p port argument to a file and exits 0.

    Returns the path of the port-capture file.
    """
    port_file = tmp_path / "psql_port_seen"
    script = textwrap.dedent(f"""\
        #!/usr/bin/env bash
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "-p" ]]; then
            printf '%s' "$2" > {port_file}
            shift 2
          else
            shift
          fi
        done
        exit 0
    """)
    mock = tmp_path / "psql"
    mock.write_text(script)
    mock.chmod(mock.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return port_file


def _write_noop_sleep(tmp_path: Path) -> None:
    """Write a no-op `sleep` so retry backoff does not slow tests."""
    noop = tmp_path / "sleep"
    noop.write_text("#!/usr/bin/env bash\n")
    noop.chmod(noop.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _make_env(tmp_path: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env.get("PATH", "")
    return env


def _make_minimal_supabase_project(root: Path) -> None:
    """Create the minimal supabase tree needed for setup_supabase_reset_validation."""
    (root / "supabase" / "migrations").mkdir(parents=True)
    (root / "supabase" / "config.toml").write_text(
        "[db]\nport = 54322\nshadow_port = 54320\n\n[edge_runtime]\nenabled = true\n"
    )


# Harness that sources the real library, runs setup, start, reset, then invokes
# psql with the env-var port so we can assert it matches the alternate value.
_PORT_FALLBACK_HARNESS_TMPL = textwrap.dedent("""\
    #!/usr/bin/env bash
    set -euo pipefail
    source "{lib_path}"
    setup_supabase_reset_validation "{repo_root}"
    cleanup() {{ cleanup_supabase_reset_validation; }}
    trap cleanup EXIT
    run_supabase_start_with_transient_retry 3
    run_supabase_reset_with_transient_retry 3
    psql -h 127.0.0.1 -p "${{SUPABASE_DB_PORT:-54322}}" -U postgres -d postgres -c "SELECT 1"
""")


def test_psql_follows_alternate_port_when_54322_occupied(tmp_path: Path) -> None:
    """When 54322 is in use, setup_supabase_reset_validation picks an alternate port
    and the psql -p argument reflects that alternate, not the hardcoded 54322.

    This is the core regression guard: the test actually binds port 54322 during
    the run so the lib's port-probing code is forced down the alternate-port path,
    and a recording mock psql captures the port argument to verify it end-to-end.
    """
    occupier = _bind_port_or_none(54322)
    if occupier is None:
        import pytest

        pytest.skip("port 54322 already in use before test started")

    try:
        fake_repo = tmp_path / "repo"
        _make_minimal_supabase_project(fake_repo)
        _write_silent_supabase(tmp_path)
        _write_noop_sleep(tmp_path)
        port_file = _write_port_recording_psql(tmp_path)

        lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
        harness = tmp_path / "harness.sh"
        harness.write_text(
            _PORT_FALLBACK_HARNESS_TMPL.format(lib_path=lib_path, repo_root=fake_repo)
        )
        harness.chmod(harness.stat().st_mode | stat.S_IEXEC)

        result = subprocess.run(
            ["bash", str(harness)],
            text=True,
            capture_output=True,
            env=_make_env(tmp_path),
            timeout=_HARNESS_TIMEOUT_SECONDS,
        )
        assert result.returncode == 0, f"Harness failed; stderr: {result.stderr}"

        assert port_file.exists(), "mock psql was not called (no port file written)"
        port_used = port_file.read_text().strip()
        assert port_used != "54322", (
            f"psql was called with hardcoded 54322 even though the port was occupied; "
            f"SUPABASE_DB_PORT was not propagated correctly"
        )
        assert port_used != "", "psql port argument was empty"
    finally:
        occupier.close()


def _run_reset_script(
    script_path: Path, tmp_path: Path
) -> tuple[subprocess.CompletedProcess[str], Path]:
    """Run an outlier reset script with mock binaries injected via PATH.

    Returns (CompletedProcess, port_file_path).  port_file_path may not exist
    if psql was never reached.
    """
    _write_silent_supabase(tmp_path)
    _write_noop_sleep(tmp_path)
    port_file = _write_port_recording_psql(tmp_path)

    result = subprocess.run(
        ["bash", str(script_path)],
        text=True,
        capture_output=True,
        env=_make_env(tmp_path),
        timeout=_OUTLIER_SCRIPT_TIMEOUT_SECONDS,
    )
    return result, port_file


def test_enterprise_reporting_outlier_routes_psql_to_lib_alternate_port(
    tmp_path: Path,
) -> None:
    """run_enterprise_reporting_org_hierarchy_reset.sh sources reset_validation_lib.sh
    and passes SUPABASE_DB_PORT to psql when 54322 is occupied.

    If the script no longer sources the lib, setup_supabase_reset_validation is
    undefined and the script exits non-zero before reaching psql.  If psql still
    receives 54322, the alternate-port wiring is broken.
    """
    occupier = _bind_port_or_none(54322)
    if occupier is None:
        import pytest

        pytest.skip("port 54322 already in use before test started")

    try:
        script = REPO_ROOT / "supabase" / "tests" / "run_enterprise_reporting_org_hierarchy_reset.sh"
        result, port_file = _run_reset_script(script, tmp_path)

        assert result.returncode == 0, (
            f"Script failed (likely setup_supabase_reset_validation undefined "
            f"or psql error); stderr: {result.stderr}"
        )
        assert port_file.exists(), "mock psql was not called — script never reached psql"
        port_used = port_file.read_text().strip()
        assert port_used != "54322", (
            f"psql received hardcoded 54322 even though port was occupied; "
            f"SUPABASE_DB_PORT not forwarded"
        )
    finally:
        occupier.close()


def test_storefront_availability_outlier_routes_psql_to_lib_alternate_port(
    tmp_path: Path,
) -> None:
    """run_storefront_availability_quote_reset.sh sources reset_validation_lib.sh
    and passes SUPABASE_DB_PORT to psql when 54322 is occupied.

    Same structural guarantee as the enterprise-reporting test above.
    """
    occupier = _bind_port_or_none(54322)
    if occupier is None:
        import pytest

        pytest.skip("port 54322 already in use before test started")

    try:
        script = REPO_ROOT / "supabase" / "tests" / "run_storefront_availability_quote_reset.sh"
        result, port_file = _run_reset_script(script, tmp_path)

        assert result.returncode == 0, (
            f"Script failed (likely setup_supabase_reset_validation undefined "
            f"or psql error); stderr: {result.stderr}"
        )
        assert port_file.exists(), "mock psql was not called — script never reached psql"
        port_used = port_file.read_text().strip()
        assert port_used != "54322", (
            f"psql received hardcoded 54322 even though port was occupied; "
            f"SUPABASE_DB_PORT not forwarded"
        )
    finally:
        occupier.close()


def test_standard_reset_runner_routes_psql_to_lib_alternate_port(
    tmp_path: Path,
) -> None:
    """A representative standard reset runner (run_rental_master_data_foundation_reset.sh)
    passes SUPABASE_DB_PORT to psql when 54322 is occupied.

    This is the regression guard for the ~61 non-outlier run_*_reset.sh scripts whose
    only change was replacing -p 54322 with -p "${SUPABASE_DB_PORT:-54322}".  If any
    of those scripts were reverted to the hardcoded port, the recording mock psql
    would capture "54322" and this assertion would fail.
    """
    occupier = _bind_port_or_none(54322)
    if occupier is None:
        import pytest

        pytest.skip("port 54322 already in use before test started")

    try:
        script = REPO_ROOT / "supabase" / "tests" / "run_rental_master_data_foundation_reset.sh"
        result, port_file = _run_reset_script(script, tmp_path)

        assert result.returncode == 0, (
            f"Script failed (likely setup_supabase_reset_validation undefined "
            f"or psql error); stderr: {result.stderr}"
        )
        assert port_file.exists(), "mock psql was not called — script never reached psql"
        port_used = port_file.read_text().strip()
        assert port_used != "54322", (
            f"psql received hardcoded 54322 even though port was occupied; "
            f"SUPABASE_DB_PORT not forwarded"
        )
    finally:
        occupier.close()


# ---------------------------------------------------------------------------
# Slot acquisition isolation tests
#
# These tests verify that _supabase_reset_acquire_slot uses OS-level flock to
# exclusively claim port slots, so two concurrent jobs on the same runner can
# never stage the same port set.  Each test is fully deterministic: no random
# sampling — the lock state is forced before the allocator is invoked.
# ---------------------------------------------------------------------------

# Minimal config.toml understood by _supabase_reset_rewrite_all_ports.
_MINIMAL_TOML_FOR_SLOT_TESTS = """\
project_id = "project-template"

[api]
enabled = true
port = 54321

[db]
port = 54322
shadow_port = 54320

[studio]
enabled = true
port = 54323

[inbucket]
enabled = true
port = 54324

[analytics]
enabled = true
port = 54327

[edge_runtime]
enabled = true
"""


def _make_slot_test_project(root: Path) -> None:
    (root / "supabase" / "migrations").mkdir(parents=True)
    (root / "supabase" / "config.toml").write_text(_MINIMAL_TOML_FOR_SLOT_TESTS)


def _write_acquire_harness(harness_path: Path, lib_path: Path) -> None:
    """Write a bash harness that acquires a slot and prints the slot number."""
    harness_path.write_text(
        textwrap.dedent(f"""\
            #!/usr/bin/env bash
            set -euo pipefail
            source "{lib_path}"
            # Brief pause after acquiring so concurrent processes overlap in time.
            if ! _supabase_reset_acquire_slot; then
                echo "FAILED" >&2
                exit 1
            fi
            sleep 0.15
            echo "$_supabase_acquired_slot"
        """)
    )
    harness_path.chmod(harness_path.stat().st_mode | stat.S_IEXEC)


def _run_acquire(harness_path: Path, slot_dir: Path, start_slot: int = 0) -> int:
    """Run the acquire harness and return the acquired slot number."""
    env = os.environ.copy()
    env["SUPABASE_SLOT_DIR"] = str(slot_dir)
    env["SUPABASE_SLOT_START"] = str(start_slot)
    result = subprocess.run(
        ["bash", str(harness_path)],
        text=True,
        capture_output=True,
        env=env,
        timeout=15.0,
    )
    assert result.returncode == 0, (
        f"Acquire harness failed; stderr: {result.stderr!r}"
    )
    return int(result.stdout.strip())


def test_slot_acquisition_skips_locked_slot(tmp_path: Path) -> None:
    """_supabase_reset_acquire_slot skips a slot whose lock file is already held.

    Slot 0's lock file is pre-locked by a background flock process before the
    harness runs.  Starting from SUPABASE_SLOT_START=0 the allocator must scan
    forward and claim slot 1 (or higher) — never slot 0.

    This is a deterministic proof: the lock is forced, not a probabilistic
    sample, so the test cannot pass spuriously.
    """
    slot_dir = tmp_path / "slots"
    slot_dir.mkdir()
    slot_0_lock = slot_dir / "slot-0.lock"
    slot_0_lock.touch()

    lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
    harness_path = tmp_path / "acquire.sh"
    _write_acquire_harness(harness_path, lib_path)

    holder = subprocess.Popen(
        ["flock", "--exclusive", str(slot_0_lock), "sleep", "30"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.3)  # Let flock acquire before the harness starts

    try:
        slot = _run_acquire(harness_path, slot_dir, start_slot=0)
        assert slot != 0, (
            f"Allocator returned slot 0 even though it was locked; "
            f"flock-based skip is broken"
        )
    finally:
        holder.terminate()
        holder.wait(timeout=5)


def test_concurrent_slot_acquisitions_assign_distinct_slots(tmp_path: Path) -> None:
    """Two concurrent flock acquisitions both starting at slot 0 get different slots.

    Both harnesses are forced to start scanning from slot 0 via SUPABASE_SLOT_START.
    The OS flock ensures only one process can hold slot 0 at a time; the other
    must move to slot 1 (or higher).  The assertions prove that the collision path
    is resolved by the locking mechanism, not by random slot distribution.
    """
    import concurrent.futures

    slot_dir = tmp_path / "slots"
    slot_dir.mkdir()

    lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
    harness_path = tmp_path / "acquire.sh"
    _write_acquire_harness(harness_path, lib_path)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(_run_acquire, harness_path, slot_dir, 0)
        f2 = ex.submit(_run_acquire, harness_path, slot_dir, 0)
        slot1 = f1.result()
        slot2 = f2.result()

    assert slot1 != slot2, (
        f"Both concurrent jobs acquired the same slot {slot1}; "
        f"flock-based exclusion is broken"
    )


# ---------------------------------------------------------------------------
# Cleanup unlink/recreate race tests
#
# These tests cover the specific path described in the unlink/recreate race:
# cleanup closes the fd (releasing the flock), a successor job acquires the
# same slot on the stable inode, and then if cleanup removes the path a third
# job can create a fresh inode at the same path and flock it — giving two
# concurrent "owners" of the same slot.
#
# The existing tests above prove flock exclusion on a stable path but would
# still pass even if cleanup removed the pathname and the allocator reopened
# the same slot on a fresh inode (because those tests never call cleanup).
# The tests below fill that gap.
# ---------------------------------------------------------------------------

_CLEANUP_HARNESS_TMPL = textwrap.dedent("""\
    #!/usr/bin/env bash
    set -euo pipefail
    source "{lib_path}"

    # Minimal stubs so cleanup's supabase-stop call exits 0.
    start_args=(start)
    stop_args=(stop)
    project_args=()
    reset_args=(db reset)
    reset_project_args=()
    supabase_reset_stage_root=""

    if ! _supabase_reset_acquire_slot; then
        echo "FAILED: could not acquire slot" >&2
        exit 1
    fi
    acquired_lock="$_supabase_slot_lock_file"
    cleanup_supabase_reset_validation
    # After cleanup the lock file must still exist so the path/inode is stable.
    if [[ ! -f "$acquired_lock" ]]; then
        echo "FAIL: cleanup removed slot lock file: $acquired_lock" >&2
        exit 2
    fi
    echo "$acquired_lock"
""")


def test_cleanup_preserves_slot_lock_file(tmp_path: Path) -> None:
    """cleanup_supabase_reset_validation must not remove the slot lock file.

    After a job calls cleanup (closes fd, releases flock), the lock-file path
    must remain on disk pointing to the same inode.  If the path is removed,
    the next acquire opens a fresh inode at the same path, breaking the
    exclusion guarantee for any concurrent holder on the old inode.

    This is a deterministic regression guard for the unlink/recreate race: if
    the rm -f line is ever re-added to cleanup, this test exits with code 2.
    """
    slot_dir = tmp_path / "slots"
    slot_dir.mkdir()

    lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
    harness = tmp_path / "cleanup_harness.sh"
    harness.write_text(_CLEANUP_HARNESS_TMPL.format(lib_path=lib_path))
    harness.chmod(harness.stat().st_mode | stat.S_IEXEC)

    # A no-op supabase mock so the stop call inside cleanup exits 0.
    _write_silent_supabase(tmp_path)

    env = os.environ.copy()
    env["PATH"] = str(tmp_path) + os.pathsep + env.get("PATH", "")
    env["SUPABASE_SLOT_DIR"] = str(slot_dir)
    env["SUPABASE_SLOT_START"] = "0"

    result = subprocess.run(
        ["bash", str(harness)],
        text=True,
        capture_output=True,
        env=env,
        timeout=15.0,
    )
    assert result.returncode == 0, (
        f"Harness failed (rc={result.returncode}); "
        f"stdout: {result.stdout!r}; stderr: {result.stderr!r}"
    )
    lock_path = Path(result.stdout.strip())
    assert lock_path.exists(), (
        f"cleanup removed slot lock file {lock_path}; "
        f"this enables the unlink/recreate slot-collision race"
    )


def test_unlink_recreate_enables_slot_collision(tmp_path: Path) -> None:
    """Removing the slot lock file after closing the fd enables a same-slot collision.

    This is a pure-Python proof of the race mechanism that cleanup must prevent:

    Scenario (bad — old cleanup behaviour):
      Job A closes fd on inode I1 → flock released.
      Job B opens slot-0.lock (same I1) and flocks it → B owns slot 0.
      Old cleanup unlinks slot-0.lock → I1 still exists in B's fd, but path is gone.
      Job C creates slot-0.lock → new inode I2 at same path.
      Job C flocks I2 → succeeds (I2 has no holder).
      Both B and C now believe they own slot 0 → collision.

    Scenario (good — new cleanup behaviour, no unlink):
      Job B opens slot-0.lock (I1) and flocks it → B owns slot 0.
      No unlink: slot-0.lock still points to I1.
      Job C opens slot-0.lock → same I1.
      Job C's flock attempt on I1 raises BlockingIOError → C must try slot 1.
      Exclusion maintained.
    """
    slot_file = tmp_path / "slot-0.lock"
    slot_file.touch()

    # ---- Bad path: unlink enables the race ----
    fd_b = os.open(str(slot_file), os.O_WRONLY)
    collision_occurred = False
    try:
        fcntl.flock(fd_b, fcntl.LOCK_EX | fcntl.LOCK_NB)  # B acquires slot 0
        os.unlink(str(slot_file))  # simulate old cleanup unlinking the path
        slot_file.touch()  # C creates new inode at same path
        fd_c = os.open(str(slot_file), os.O_WRONLY)
        try:
            # C flocks the new inode — no conflict with B's old inode.
            # Both B and C now "own" slot 0: the collision the fix prevents.
            fcntl.flock(fd_c, fcntl.LOCK_EX | fcntl.LOCK_NB)
            collision_occurred = True  # Flock succeeded: collision proven.
        except BlockingIOError:
            pass  # Would mean same inode — not expected here after unlink.
        finally:
            os.close(fd_c)
    finally:
        os.close(fd_b)

    assert collision_occurred, (
        "Expected flock to succeed on the fresh inode after unlink, "
        "demonstrating the same-slot collision; if this fails the OS "
        "flock semantics have changed and the test needs updating"
    )

    # ---- Good path: stable path blocks the third job ----
    slot_file_stable = tmp_path / "slot-1.lock"
    slot_file_stable.touch()

    fd_b2 = os.open(str(slot_file_stable), os.O_WRONLY)
    try:
        fcntl.flock(fd_b2, fcntl.LOCK_EX | fcntl.LOCK_NB)  # B2 acquires slot 1
        # No unlink: path still points to the same inode.
        fd_c2 = os.open(str(slot_file_stable), os.O_WRONLY)
        try:
            fcntl.flock(fd_c2, fcntl.LOCK_EX | fcntl.LOCK_NB)
            raise AssertionError(
                "flock on stable slot-1.lock should have raised BlockingIOError "
                "while B2 holds the lock; exclusion is broken"
            )
        except BlockingIOError:
            pass  # Correct: C2 is blocked by B2 on the same stable inode.
        finally:
            try:
                os.close(fd_c2)
            except OSError:
                pass
    finally:
        os.close(fd_b2)


# ---------------------------------------------------------------------------
# Cross-slot spillover test
#
# This test proves that when a port inside slot N's 6-port window is occupied
# by an unrelated host process, the allocator skips slot N entirely rather than
# scanning forward into slot N+1's window.  It fails with the old scan-forward
# code and passes only once cross-slot spillover is eliminated.
# ---------------------------------------------------------------------------

_SLOT_SPILLOVER_HARNESS_TMPL = textwrap.dedent("""\
    #!/usr/bin/env bash
    set -euo pipefail
    source "{lib_path}"

    if ! _supabase_reset_acquire_slot; then
        echo "FAILED: could not acquire slot" >&2
        exit 1
    fi
    _base=$(( 55000 + _supabase_acquired_slot * 6 ))
    _supabase_reset_rewrite_all_ports "{project_root}" "$_base" >/dev/null
    echo "SLOT=$_supabase_acquired_slot"
    echo "BASE=$_base"
""")


def test_occupied_port_in_slot_causes_slot_skip_not_spillover(tmp_path: Path) -> None:
    """An occupied port inside slot N's window causes the whole slot to be skipped.

    OLD spillover behavior: if port 55001 (slot 0, offset 1) is pre-bound, the
    scan-forward inside _supabase_reset_rewrite_all_ports keeps api=55000 then
    scans db past 55001 → db=55002, shadow=55003, studio=55004, inbucket=55005,
    analytics=55006.  Port 55006 is the first port of slot 1's window, so a
    concurrent job legitimately holding slot 1 would stage the same port.

    NEW behavior: _supabase_reset_acquire_slot checks all 6 ports before
    committing to a slot.  If any port is occupied, the slot is released and
    skipped.  _supabase_reset_rewrite_all_ports assigns ports strictly as
    base+0 … base+5 with no scan-forward.  The assigned ports therefore always
    lie within [base, base+6) — never in a neighbouring slot's window.

    This test fails with the old scan-forward code (slot=0 is acquired and
    analytics spills to 55006) and passes only once cross-slot spillover is
    eliminated (slot 0 is skipped because 55001 is occupied, slot 1 is skipped
    because its flock is held, and the allocator lands on slot 2+).
    """
    import re

    slot_dir = tmp_path / "slots"
    slot_dir.mkdir()

    # Pre-bind port 55001 — the second port of slot 0's 6-port window [55000, 55006).
    # This is the port whose occupancy triggers the old scan-forward spillover into
    # slot 1's window (55006-55011).
    occupier = _bind_port_or_none(55001)
    if occupier is None:
        import pytest

        pytest.skip("port 55001 already in use before test started")

    # Pre-lock slot 1 with a background flock so the allocator must skip it too.
    # This confirms the job cannot silently fall through to slot 1 (which would
    # include the spilled port 55006 in its own window).
    slot_1_lock = slot_dir / "slot-1.lock"
    slot_1_lock.touch()
    holder = subprocess.Popen(
        ["flock", "--exclusive", str(slot_1_lock), "sleep", "30"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.3)  # Let flock acquire before the harness starts

    try:
        fake_repo = tmp_path / "repo"
        _make_slot_test_project(fake_repo)
        lib_path = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
        harness = tmp_path / "spillover_harness.sh"
        harness.write_text(
            _SLOT_SPILLOVER_HARNESS_TMPL.format(
                lib_path=lib_path,
                project_root=fake_repo,
            )
        )
        harness.chmod(harness.stat().st_mode | stat.S_IEXEC)

        env = os.environ.copy()
        env["SUPABASE_SLOT_DIR"] = str(slot_dir)
        env["SUPABASE_SLOT_START"] = "0"

        result = subprocess.run(
            ["bash", str(harness)],
            text=True,
            capture_output=True,
            env=env,
            timeout=15.0,
        )
        assert result.returncode == 0, (
            f"Harness failed (rc={result.returncode}); stderr: {result.stderr}"
        )

        lines_out = result.stdout.splitlines()
        slot = int(next(ln.split("=", 1)[1] for ln in lines_out if ln.startswith("SLOT=")))
        base = int(next(ln.split("=", 1)[1] for ln in lines_out if ln.startswith("BASE=")))

        # Slot 0 must have been skipped (55001 occupied), slot 1 must have been
        # skipped (flock held), so the allocator must have landed on slot ≥ 2.
        assert slot not in (0, 1), (
            f"Expected slot ≥ 2 (slot 0 has an occupied port, slot 1 is flock-locked), "
            f"but got slot {slot}; the allocator did not skip the slot with an occupied port"
        )

        # All port values written into config.toml must lie strictly within the
        # acquired slot's 6-port window [base, base+6).  If any scan-forward
        # spillover is present, at least one port will be ≥ base+6.
        config_text = (fake_repo / "supabase" / "config.toml").read_text()
        port_values = [
            int(m)
            for m in re.findall(r"^\s*(?:shadow_)?port\s*=\s*(\d+)", config_text, re.MULTILINE)
        ]
        spilled = [p for p in port_values if not (base <= p < base + 6)]
        assert not spilled, (
            f"Ports {spilled} are outside slot {slot}'s window [{base}, {base + 6}); "
            f"cross-slot spillover detected — port assignment must not scan beyond the window"
        )
    finally:
        occupier.close()
        holder.terminate()
        holder.wait(timeout=5)
