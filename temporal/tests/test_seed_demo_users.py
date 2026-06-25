from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_SCRIPT = REPO_ROOT / "scripts" / "seed-demo-users.sh"
AUTH_STUB = REPO_ROOT / "supabase" / "tests" / "auth_stub.sql"
HARNESS = REPO_ROOT / "supabase" / "tests" / "run_seed_demo_users.sh"
SEED_HARNESS_TRANSIENT_ERROR_RE = re.compile(
    r'connection to server on socket ".*/\.s\.PGSQL\.5432" failed: No such file or directory|'
    r"accepting connections on that socket|connection refused|the database system is starting up|"
    r"the database system is shutting down",
    re.IGNORECASE,
)


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def _run_seed_script(
    fake_bin: Path,
    *,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run seed-demo-users.sh with a fake psql in PATH."""
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
        "SUPABASE_DB_URL": "postgresql://postgres@localhost/postgres",
        "DEMO_ADMIN_PASS": "test-admin-pass",
        "DEMO_OPERATOR_PASS": "test-operator-pass",
        **(extra_env or {}),
    }
    return subprocess.run(
        ["bash", str(SEED_SCRIPT)],
        text=True,
        capture_output=True,
        env=env,
        timeout=30.0,
    )


def _run_seed_harness_with_transient_retry(*, max_attempts: int = 3) -> subprocess.CompletedProcess[str]:
    attempt = 0
    while True:
        result = subprocess.run(
            ["bash", str(HARNESS)],
            text=True,
            capture_output=True,
            timeout=120.0,
        )
        if result.returncode == 0:
            return result

        attempt += 1
        output = f"{result.stdout}\n{result.stderr}"
        if attempt >= max_attempts or not SEED_HARNESS_TRANSIENT_ERROR_RE.search(output):
            return result

        # Keep retries short and bounded for CI while giving Postgres time to settle.
        time.sleep(attempt * 2)


# ── Integration smoke test (requires Docker) ─────────────────────────────────────────────

def test_seed_demo_users_smoke_validation() -> None:
    """End-to-end harness: all three behavioral tests (auto-detect, auth stub compat,
    misalignment error path) pass against a real Postgres container with seed data."""
    result = _run_seed_harness_with_transient_retry()
    assert result.returncode == 0, (
        f"Harness exited {result.returncode}.\n"
        f"stdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )
    assert "Seed demo users checks passed" in result.stdout


def test_seed_harness_retry_retries_postgres_socket_startup_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}

    def fake_run(command: list[str], text: bool, capture_output: bool, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        if attempts["count"] < 3:
            return subprocess.CompletedProcess(
                command,
                2,
                stdout="",
                stderr=(
                    'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" '
                    "failed: No such file or directory\n"
                    "\tIs the server running locally and accepting connections on that socket?\n"
                ),
            )
        return subprocess.CompletedProcess(command, 0, stdout="Seed demo users checks passed", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    result = _run_seed_harness_with_transient_retry(max_attempts=4)

    assert result.returncode == 0
    assert attempts["count"] == 3


# ── Unit tests via fake psql (no Docker required) ────────────────────────────────────────

def test_seed_demo_users_exits_when_auto_detect_returns_empty(tmp_path: Path) -> None:
    """When DEMO_TENANT is unset and the auto-detect psql query returns nothing (no
    demo-ops-* findings seeded), the script must exit non-zero with a clear message
    pointing operators to the explicit DEMO_TENANT variable."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    # Fake psql that always returns empty stdout and exits 0 — simulates a database
    # where no demo-ops-* findings exist yet.
    _write_executable(
        fake_bin / "psql",
        "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n",
    )

    result = _run_seed_script(fake_bin)

    assert result.returncode != 0, (
        "Expected non-zero exit when auto-detect returns empty; "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert "Unable to auto-detect DEMO_TENANT" in result.stderr, (
        f"Expected clear error message; stderr={result.stderr!r}"
    )


def test_seed_demo_users_uses_auto_detected_tenant_in_output(tmp_path: Path) -> None:
    """When DEMO_TENANT is unset and the auto-detect query returns a tenant key,
    the script logs 'Seeding demo users (tenant: <detected>)' and completes
    successfully with the detected tenant passed through the main seed call."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    # Fake psql: first call (auto-detect, uses -At flag) returns a tenant key;
    # subsequent calls (main seed SQL) exit 0 silently.
    _write_executable(
        fake_bin / "psql",
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "if '-At' in sys.argv:\n"
        "    print('demo-ops-test-tenant')\n"
        "sys.exit(0)\n",
    )

    result = _run_seed_script(fake_bin)

    assert result.returncode == 0, (
        f"Expected zero exit; stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert "Seeding demo users (tenant: demo-ops-test-tenant)" in result.stdout, (
        f"Expected auto-detected tenant in output; stdout={result.stdout!r}"
    )
    assert "Demo user seed complete." in result.stdout


def test_seed_demo_users_explicit_tenant_bypasses_auto_detect(tmp_path: Path) -> None:
    """When DEMO_TENANT is set explicitly, the script skips the auto-detect query
    and logs the explicit tenant without making a first psql call for detection."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    call_log = tmp_path / "psql-calls.jsonl"
    # Record every psql invocation so we can assert the auto-detect query is skipped.
    _write_executable(
        fake_bin / "psql",
        f"#!/usr/bin/env python3\n"
        f"import json, sys\n"
        f"from pathlib import Path\n"
        f"Path({str(call_log)!r}).open('a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
        f"sys.exit(0)\n",
    )

    result = _run_seed_script(fake_bin, extra_env={"DEMO_TENANT": "my-explicit-tenant"})

    assert result.returncode == 0, (
        f"Expected zero exit; stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert "Seeding demo users (tenant: my-explicit-tenant)" in result.stdout

    calls = [line for line in call_log.read_text().splitlines() if line]
    # With explicit DEMO_TENANT the auto-detect branch is skipped → exactly one
    # psql call (the main seed), not two.
    assert len(calls) == 1, (
        f"Expected exactly one psql call when DEMO_TENANT is explicit, got {calls}"
    )


# ── Static regression: auth_stub.sql DDL compatibility with demo-user upsert ────────────


def test_auth_stub_has_required_ddl_for_demo_user_upsert() -> None:
    """Regression: auth_stub.sql must declare every column and constraint that
    scripts/seed-demo-users.sh relies on so bare-Postgres test harnesses remain
    compatible with the seed upsert path.

    Specifically:
      - auth.users.is_sso_user (used in ON CONFLICT partial-index predicate)
      - users_email_partial_key partial index with WHERE is_sso_user = false
      - auth.identities table (seeded by the identities INSERT)
      - provider_id column on auth.identities (needed by seed INSERT columns)

    String matching is intentional here: the file is small and well-structured,
    and the assertions target distinctive token sequences that cannot appear only
    in comments (e.g., the full partial-index predicate).  The integration smoke
    test provides behavioral coverage; this test catches accidental DDL removal.
    """
    stub_sql = AUTH_STUB.read_text()

    # is_sso_user must appear as a column definition (not just a comment reference).
    # Matches "is_sso_user" followed by whitespace and a type keyword.
    assert re.search(r"is_sso_user\s+boolean", stub_sql), (
        "auth_stub.sql must declare is_sso_user boolean on auth.users; "
        "seed-demo-users.sh uses ON CONFLICT (email) WHERE (is_sso_user = false)"
    )
    assert "users_email_partial_key" in stub_sql, (
        "auth_stub.sql must declare the partial email unique index "
        "(users_email_partial_key) that the ON CONFLICT clause targets"
    )
    # The WHERE predicate in the index definition must exactly match the ON CONFLICT
    # predicate in the seed script so Postgres resolves the conflict correctly.
    assert "WHERE is_sso_user = false" in stub_sql, (
        "The partial index in auth_stub.sql must filter by is_sso_user = false "
        "to match GoTrue behaviour and the seed script ON CONFLICT predicate"
    )
    # auth.identities table definition (CREATE TABLE IF NOT EXISTS auth.identities)
    assert re.search(r"CREATE TABLE IF NOT EXISTS auth\.identities", stub_sql), (
        "auth_stub.sql must declare auth.identities for the identities INSERT "
        "in seed-demo-users.sh"
    )
    # provider_id column must appear inside the auth.identities block
    assert "provider_id" in stub_sql, (
        "auth.identities in auth_stub.sql must declare the provider_id column "
        "used in the seed script INSERT INTO auth.identities"
    )
