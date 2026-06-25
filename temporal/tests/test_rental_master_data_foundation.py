from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import textwrap
import time
import uuid
from collections import Counter
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"
DEFAULT_POSTGRES_IMAGE = "postgres:17"
POSTGRES_READY_TIMEOUT_SECONDS = 30
# Ops schema validation shells directly into Docker/psql rather than `supabase db reset`,
# so this matcher includes the shared reset transient fragments plus Docker transport/
# image-pull errors observed in CI.
OPS_SCHEMA_TRANSIENT_ERROR_RE = re.compile(
    r"Error status 50[0-9]|invalid response was received from the upstream server|context deadline exceeded|"
    r"connection refused|connection reset|i/o timeout|: EOF$|: EOF |unexpected EOF|error during connect|"
    r"server closed the connection|TLS handshake timeout|timeout exceeded while awaiting headers|"
    r"the input device is not a TTY|error running container: exit 1|Cannot connect to the Docker daemon|"
    r"error response from daemon|toomanyrequests|"
    r"connection to server on socket .*\.s\.PGSQL\.5432.*No such file or directory|"
    r"accepting connections on that socket",
    re.IGNORECASE,
)
POSTGRES_CONTAINER_TRANSIENT_ERROR_RE = re.compile(
    # Bare-Postgres container startup can briefly report socket/startup availability
    # errors even after pg_isready first flips green on shared CI runners.
    # Docker Hub rate-limit and daemon errors are also transient on shared CI runners
    # where many parallel jobs compete for image pulls simultaneously.
    # "Postgres test container did not become ready" is emitted by the shell harness
    # when pg_isready exhausts its 30-second polling loop on a slow CI runner.
    r"connection to server on socket .*\.s\.PGSQL\.5432.*No such file or directory|"
    r"accepting connections on that socket|the database system is starting up|"
    r"the database system is shutting down|connection refused|"
    r"toomanyrequests|error running container: exit 1|"
    r"Cannot connect to the Docker daemon|error response from daemon|"
    r"Postgres test container did not become ready",
    re.IGNORECASE,
)


def _run_command(
    command: list[str],
    *,
    input_text: str | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
        timeout=timeout,
    )


def _run_sql(container_name: str, sql: str) -> list[str]:
    # The hardened write RPCs (create_entity_with_version, rental_upsert_*) require
    # a service_role / authenticated-write-role claim. These foundation tests drive
    # the RPCs directly as the trusted setup context, so set the service_role claim
    # for the session (mirrors supabase/seed.sql and the .sh reset harness). Without
    # it the guard correctly denies the writes and the tests fail.
    sql_with_role_claim = "set request.jwt.claim.role = 'service_role';\n" + textwrap.dedent(sql).strip() + "\n"
    result = _run_command_with_transient_retry(
        [
            "docker",
            "exec",
            "-i",
            container_name,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-qAt",
            "-F",
            "\t",
        ],
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        max_attempts=4,
        input_text=sql_with_role_claim,
        timeout=60.0,
    )
    return [line for line in result.stdout.splitlines() if line]


def _run_reset_validation_lib(function_name: str, *args: str) -> subprocess.CompletedProcess[str]:
    reset_validation_lib = REPO_ROOT / "supabase" / "tests" / "reset_validation_lib.sh"
    quoted_args = " ".join(shlex.quote(arg) for arg in args)
    return _run_command(
        [
            "bash",
            "-lc",
            f"source {shlex.quote(str(reset_validation_lib))}; {function_name} {quoted_args}",
        ],
        timeout=60.0,
    )


def _run_command_with_transient_retry(
    command: list[str],
    *,
    transient_error_re: re.Pattern[str],
    max_attempts: int = 3,
    input_text: str | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    attempt = 0
    while True:
        try:
            return _run_command(command, input_text=input_text, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Do NOT retry on timeout. When subprocess.run kills the subprocess
            # after a timeout it sends SIGKILL, so the subprocess's EXIT trap
            # never runs and any child processes it spawned (Docker containers,
            # Supabase instances) remain as orphans. Retrying while those orphans
            # hold ports / consume memory causes the next attempt to also hang,
            # leading to cascading resource exhaustion on the CI runner. Fail
            # immediately with a clear TimeoutExpired so the caller gets
            # actionable diagnostics rather than a wedged lane.
            raise
        except subprocess.CalledProcessError as exc:
            attempt += 1
            output = f"{exc.stdout or ''}\n{exc.stderr or ''}"
            if attempt >= max_attempts or not transient_error_re.search(output):
                raise
            time.sleep(attempt * 2)


def _run_validation_script(
    script_name: str,
    *,
    transient_error_re: re.Pattern[str] = OPS_SCHEMA_TRANSIENT_ERROR_RE,
    max_attempts: int = 3,
    timeout: float = 360.0,
    label: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a Supabase smoke-test shell script with bounded runtime and explicit diagnostics.

    Raises pytest.fail() on both CalledProcessError and TimeoutExpired so that
    failing tests always report a clear, human-readable message rather than
    propagating a raw exception or silently hanging.
    """
    script = REPO_ROOT / "supabase" / "tests" / script_name
    description = label or script_name
    try:
        return _run_command_with_transient_retry(
            ["bash", str(script)],
            transient_error_re=transient_error_re,
            max_attempts=max_attempts,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        pytest.fail(
            f"{description} timed out after {exc.timeout:.0f}s.\n"
            "The subprocess was killed (SIGKILL). Orphaned Docker/Supabase containers "
            "may remain on the runner — inspect with `docker ps -a` and "
            "`supabase status`.\n"
            f"cmd: {exc.cmd}"
        )
    except subprocess.CalledProcessError as exc:
        pytest.fail(
            f"{description} failed (exit {exc.returncode}).\n"
            f"stdout:\n{exc.stdout}\n"
            f"stderr:\n{exc.stderr}"
        )


def _run_reset_validation_script(
    script_name: str,
    *,
    label: str | None = None,
    timeout: float = 600.0,
) -> subprocess.CompletedProcess[str]:
    """Run a Supabase reset-path validation shell script with bounded runtime and diagnostics.

    * TimeoutExpired → always pytest.fail(). A timed-out subprocess was killed;
      orphaned Docker/Supabase containers may remain. This should never be skipped
      because it indicates the runner is stuck, not that the environment is missing.
    * CalledProcessError → pytest.fail() when REQUIRE_SUPABASE_RESET_VALIDATION=1,
      otherwise pytest.skip() (environment does not have Supabase CLI / Docker).
    """
    script = REPO_ROOT / "supabase" / "tests" / script_name
    description = label or script_name
    try:
        return _run_command_with_transient_retry(
            ["bash", str(script)],
            transient_error_re=OPS_SCHEMA_TRANSIENT_ERROR_RE,
            max_attempts=3,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        pytest.fail(
            f"{description} timed out after {exc.timeout:.0f}s.\n"
            "The subprocess was killed (SIGKILL). Orphaned Docker/Supabase containers "
            "may remain on the runner — inspect with `docker ps -a` and "
            "`supabase status`.\n"
            f"cmd: {exc.cmd}"
        )
    except subprocess.CalledProcessError as exc:
        if os.environ.get("REQUIRE_SUPABASE_RESET_VALIDATION") == "1":
            pytest.fail(
                f"{description} failed (exit {exc.returncode}).\n"
                f"stdout:\n{exc.stdout}\n"
                f"stderr:\n{exc.stderr}"
            )
        pytest.skip(
            f"{description} could not run in this environment.\n"
            f"stdout:\n{exc.stdout}\n"
            f"stderr:\n{exc.stderr}"
        )


def _has_duplicate_migration_versions(migrations_dir: Path) -> bool:
    versions = [path.name.split("_", 1)[0] for path in migrations_dir.glob("*.sql")]
    return any(count > 1 for count in Counter(versions).values())


def test_run_command_with_transient_retry_retries_transient_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}

    def fake_run_command(
        command: list[str], *, input_text: str | None = None, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise subprocess.CalledProcessError(
                returncode=1,
                cmd=command,
                output="",
                stderr="Error response from daemon: context deadline exceeded",
            )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(f"{__name__}._run_command", fake_run_command)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    result = _run_command_with_transient_retry(["bash", "dummy.sh"], transient_error_re=OPS_SCHEMA_TRANSIENT_ERROR_RE)

    assert result.stdout == "ok"
    assert attempts["count"] == 3


def test_run_sql_passes_timeout_to_retry_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, float | None] = {"timeout": None}

    def fake_retry(
        command: list[str],
        *,
        transient_error_re: re.Pattern[str],
        max_attempts: int = 3,
        input_text: str | None = None,
        timeout: float | None = None,
    ) -> subprocess.CompletedProcess[str]:
        captured["timeout"] = timeout
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(f"{__name__}._run_command_with_transient_retry", fake_retry)

    _run_sql("container-name", "select 1;")

    assert captured["timeout"] == 60.0


def test_run_reset_validation_lib_passes_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, float | None] = {"timeout": None}

    def fake_run_command(
        command: list[str],
        *,
        input_text: str | None = None,
        timeout: float | None = None,
    ) -> subprocess.CompletedProcess[str]:
        captured["timeout"] = timeout
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(f"{__name__}._run_command", fake_run_command)

    _run_reset_validation_lib("_supabase_reset_has_duplicate_versions", str(REPO_ROOT))

    assert captured["timeout"] == 60.0


def test_run_command_with_transient_retry_does_not_retry_non_transient_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}

    def fake_run_command(
        command: list[str], *, input_text: str | None = None, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=command,
            output="",
            stderr="ERROR: relation does not exist",
        )

    monkeypatch.setattr(f"{__name__}._run_command", fake_run_command)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    with pytest.raises(subprocess.CalledProcessError):
        _run_command_with_transient_retry(["bash", "dummy.sh"], transient_error_re=OPS_SCHEMA_TRANSIENT_ERROR_RE)

    assert attempts["count"] == 1


def test_run_command_with_transient_retry_retries_postgres_socket_startup_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}

    def fake_run_command(
        command: list[str], *, input_text: str | None = None, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise subprocess.CalledProcessError(
                returncode=2,
                cmd=command,
                output="",
                stderr=(
                    'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" '
                    "failed: No such file or directory\n"
                    "\tIs the server running locally and accepting connections on that socket?\n"
                ),
            )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(f"{__name__}._run_command", fake_run_command)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    result = _run_command_with_transient_retry(
        ["bash", "dummy.sh"],
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        max_attempts=4,
    )

    assert result.stdout == "ok"
    assert attempts["count"] == 3


def test_run_command_with_transient_retry_retries_container_startup_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = {"count": 0}

    def fake_run_command(
        command: list[str], *, input_text: str | None = None, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise subprocess.CalledProcessError(
                returncode=1,
                cmd=command,
                output="",
                stderr="Initialising schema...\nerror running container: exit 1\n",
            )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(f"{__name__}._run_command", fake_run_command)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    result = _run_command_with_transient_retry(
        ["bash", "dummy.sh"],
        transient_error_re=OPS_SCHEMA_TRANSIENT_ERROR_RE,
        max_attempts=4,
    )

    assert result.stdout == "ok"
    assert attempts["count"] == 3


def test_run_command_with_transient_retry_does_not_retry_on_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """TimeoutExpired is never retried — the subprocess is dead (SIGKILL'd) and any
    orphaned child processes it spawned must not be compounded by further attempts."""
    attempts = {"count": 0}

    def fake_run_command(
        command: list[str], *, input_text: str | None = None, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        raise subprocess.TimeoutExpired(cmd=command, timeout=timeout or 1.0)

    monkeypatch.setattr(f"{__name__}._run_command", fake_run_command)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    with pytest.raises(subprocess.TimeoutExpired):
        _run_command_with_transient_retry(
            ["bash", "dummy.sh"],
            transient_error_re=OPS_SCHEMA_TRANSIENT_ERROR_RE,
            max_attempts=4,
            timeout=30.0,
        )

    # Must raise on the very first attempt — never retry.
    assert attempts["count"] == 1


def test_reset_validation_detects_duplicate_migrations() -> None:
    result = _run_reset_validation_lib("_supabase_reset_has_duplicate_versions", str(REPO_ROOT))
    expected = "1" if _has_duplicate_migration_versions(MIGRATIONS_DIR) else "0"
    assert result.stdout.strip() == expected


def test_reset_validation_lib_preserves_unique_migration_versions(tmp_path: Path) -> None:
    _run_reset_validation_lib("_supabase_reset_stage_project", str(REPO_ROOT), str(tmp_path))

    staged_versions = [
        path.name.split("_", 1)[0] for path in (tmp_path / "supabase" / "migrations").glob("*.sql")
    ]
    assert len(staged_versions) == len(set(staged_versions))
    assert (tmp_path / "supabase" / "migrations" / "20260609150000_crm_customer_profile_model.sql").exists()
    assert (tmp_path / "supabase" / "migrations" / "20260609151000_enterprise_org_hierarchy.sql").exists()


def test_portal_catalog_search_path_fix_drops_function_before_recreate() -> None:
    migration = (
        MIGRATIONS_DIR / "20260610195000_fix_portal_catalog_digest_search_path.sql"
    ).read_text()
    drop_stmt = "drop function if exists public.portal_get_catalog_assets(text, text);"
    create_stmt = "create function public.portal_get_catalog_assets("

    assert drop_stmt in migration
    assert create_stmt in migration
    assert migration.index(drop_stmt) < migration.index(create_stmt)


def test_rental_master_data_foundation_smoke_validation() -> None:
    result = _run_validation_script(
        "run_rental_master_data_foundation.sh",
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        label="Rental master data foundation smoke validation",
    )
    assert "Rental master data foundation checks passed" in result.stdout


def test_live_yard_activity_projection_smoke_validation() -> None:
    if os.environ.get("REQUIRE_SUPABASE_RESET_VALIDATION") == "1":
        pytest.skip(
            "Live yard smoke validation is redundant in CI when reset-path validation is required."
        )

    result = _run_validation_script(
        "run_live_yard_activity_projection.sh",
        label="Live yard activity projection smoke validation",
    )
    assert "Live yard activity projection checks passed" in result.stdout


def test_project_equipment_hire_workflow_smoke_validation() -> None:
    result = _run_validation_script(
        "run_project_equipment_hire_workflow_rls.sh",
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        label="Project equipment hire workflow smoke validation",
    )
    assert "Project equipment hire workflow RLS checks passed" in result.stdout


def test_project_equipment_hire_workflow_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_project_equipment_hire_workflow_reset.sh",
        label="Project equipment hire workflow reset validation",
    )
    assert "Project equipment hire workflow reset checks passed" in result.stdout


def test_user_roles_profiles_smoke_validation() -> None:
    result = _run_validation_script(
        "run_user_roles_profiles.sh",
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        label="User roles profiles smoke validation",
    )
    assert "user_roles_profiles checks passed" in result.stdout


def test_enterprise_org_hierarchy_smoke_validation() -> None:
    result = _run_validation_script(
        "run_enterprise_org_hierarchy.sh",
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        label="Enterprise org hierarchy smoke validation",
    )
    assert "Enterprise org hierarchy checks passed" in result.stdout


def test_ops_factory_schema_smoke_validation() -> None:
    result = _run_validation_script(
        "run_ops_factory_schema.sh",
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        label="Ops factory schema smoke validation",
    )
    assert "ops_factory_schema checks passed" in result.stdout


def test_sage_entity_mapping_sync_contract_smoke_validation() -> None:
    result = _run_validation_script(
        "run_sage_entity_mapping_sync_contract.sh",
        transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        label="Sage entity mapping sync contract smoke validation",
    )
    assert "Sage entity mapping and sync contract checks passed" in result.stdout


def test_sage_entity_mapping_sync_contract_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_sage_entity_mapping_sync_contract_reset.sh",
        label="Sage entity mapping sync contract reset validation",
    )
    assert "Sage entity mapping sync contract reset checks passed" in result.stdout


def test_sage_entity_mapping_sync_contract_smoke_validation_uses_postgres_retry_pattern(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run_validation_script(
        script_name: str,
        *,
        transient_error_re: re.Pattern[str] = OPS_SCHEMA_TRANSIENT_ERROR_RE,
        max_attempts: int = 3,
        timeout: float = 360.0,
        label: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        captured["script_name"] = script_name
        captured["transient_error_re"] = transient_error_re
        captured["label"] = label
        captured["max_attempts"] = max_attempts
        captured["timeout"] = timeout
        return subprocess.CompletedProcess(
            ["bash", script_name],
            0,
            stdout="Sage entity mapping and sync contract checks passed",
            stderr="",
        )

    monkeypatch.setattr(f"{__name__}._run_validation_script", fake_run_validation_script)

    test_sage_entity_mapping_sync_contract_smoke_validation()

    assert captured == {
        "script_name": "run_sage_entity_mapping_sync_contract.sh",
        "transient_error_re": POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
        "label": "Sage entity mapping sync contract smoke validation",
        "max_attempts": 3,
        "timeout": 360.0,
    }


def test_sage_integration_config_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_sage_integration_config_reset.sh",
        label="Sage Intacct integration config reset validation",
    )
    assert "sage_integration_config reset checks passed" in result.stdout


def test_rental_master_data_foundation_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_rental_master_data_foundation_reset.sh",
        label="Rental master data foundation reset validation",
    )
    assert "Rental master data and live yard activity projection reset checks passed" in result.stdout


def test_rental_order_contract_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_rental_order_contract_reset.sh",
        label="Rental order/contract reset validation",
    )
    assert "Rental order/contract reset checks passed" in result.stdout


def test_rerent_unit_status_log_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_rerent_routing_init_status_log_reset.sh",
        label="Rerent routing init status log reset validation",
    )
    assert "rerent_unit_status_log reset checks passed" in result.stdout


def test_project_equipment_cost_rollups_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_project_equipment_cost_rollups_reset.sh",
        label="Project equipment cost rollups reset validation",
    )
    assert "Project equipment cost rollup reset checks passed" in result.stdout


def test_inspection_checklist_templates_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_inspection_checklist_templates_reset.sh",
        label="Inspection checklist templates reset validation",
    )
    assert "inspection_checklist_templates reset checks passed" in result.stdout


def test_demo_baseline_seed_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_demo_baseline_seed_reset.sh",
        label="Demo baseline seed reset validation",
    )
    assert "Enterprise multi-currency reset checks passed" in result.stdout
    assert "Demo baseline seed reset checks passed" in result.stdout


def test_accounting_auto_ledger_entries_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_accounting_auto_ledger_entries_reset.sh",
        label="Accounting auto ledger entries reset validation",
    )
    assert "Accounting auto ledger entry reset SQL assertions passed" in result.stdout
    assert "Accounting auto ledger entry reset checks passed" in result.stdout


def test_accounting_export_config_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_accounting_export_config_reset.sh",
        label="Accounting export config reset validation",
    )
    assert "Accounting export config reset checks passed" in result.stdout


def test_quote_builder_rpc_auth_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_quote_builder_rpc_auth_reset.sh",
        label="Quote builder RPC reset validation",
    )
    assert "Quote builder RPC reset checks passed" in result.stdout


def test_enterprise_org_hierarchy_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_enterprise_org_hierarchy_reset.sh",
        label="Enterprise org hierarchy reset validation",
    )
    assert "Enterprise org hierarchy reset checks passed" in result.stdout


def test_driver_dispatch_execution_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_driver_dispatch_execution_reset.sh",
        label="Driver dispatch execution reset validation",
    )
    assert "Driver dispatch execution reset SQL assertions passed" in result.stdout
    assert "Driver dispatch execution reset checks passed" in result.stdout


def test_driver_runsheet_contact_fields_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_driver_runsheet_contact_fields_reset.sh",
        label="Driver run-sheet contact fields reset validation",
    )
    assert "driver_runsheet_contact_fields reset SQL assertions passed" in result.stdout
    assert "driver_runsheet_contact_fields reset checks passed" in result.stdout


def test_driver_dvir_and_exceptions_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    try:
        result = _run_command_with_transient_retry(
            ["bash", str(REPO_ROOT / "supabase" / "tests" / "run_driver_dvir_and_exceptions_reset.sh")],
            transient_error_re=OPS_SCHEMA_TRANSIENT_ERROR_RE,
            max_attempts=3,
            timeout=600.0,
        )
    except subprocess.CalledProcessError as exc:
        if os.environ.get("REQUIRE_SUPABASE_RESET_VALIDATION") == "1":
            pytest.fail(
                "Driver DVIR + exceptions reset validation failed.\n"
                f"stdout:\n{exc.stdout}\n"
                f"stderr:\n{exc.stderr}"
            )
        pytest.skip(
            "Driver DVIR + exceptions reset-path validation could not run in this environment.\n"
            f"stdout:\n{exc.stdout}\n"
            f"stderr:\n{exc.stderr}"
        )
    assert "driver_dvir_and_exceptions reset SQL assertions passed" in result.stdout
    assert "driver_dvir_and_exceptions reset checks passed" in result.stdout


def test_dispatch_live_ops_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_dispatch_live_ops_reset.sh",
        label="Dispatch live ops reset validation",
    )
    assert "Dispatch live ops reset checks passed" in result.stdout


def test_integration_config_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_integration_config_reset.sh",
        label="Integration config reset validation",
    )
    assert "integration_config reset SQL assertions passed" in result.stdout
    assert "integration_config reset checks passed" in result.stdout


def test_descartes_sync_controls_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_descartes_sync_controls_reset.sh",
        label="Descartes sync controls reset validation",
    )
    assert "Descartes sync controls reset checks passed" in result.stdout


def test_powerbi_observability_reconciliation_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_powerbi_observability_reconciliation_reset.sh",
        label="Power BI observability reconciliation reset validation",
    )
    assert "Power BI observability reconciliation reset checks passed" in result.stdout


def test_billtrust_observability_reconciliation_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_billtrust_observability_reconciliation_reset.sh",
        label="Billtrust observability and reconciliation reset validation",
    )
    assert "Billtrust observability and reconciliation reset checks passed" in result.stdout


def test_netsuite_observability_reconciliation_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_netsuite_observability_reconciliation_reset.sh",
        label="NetSuite observability and reconciliation reset validation",
    )
    assert "NetSuite observability and reconciliation reset checks passed" in result.stdout


def test_smartequip_delivery_observability_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_smartequip_delivery_observability_reset.sh",
        label="SmartEquip delivery observability reset validation",
    )
    assert "SmartEquip delivery observability reset checks passed" in result.stdout


def test_crm_customer_profile_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_crm_customer_profile_reset.sh",
        label="CRM customer profile reset validation",
    )
    assert "CRM customer profile reset checks passed" in result.stdout


def test_crm_interaction_issue_timeline_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_crm_interaction_issue_timeline_reset.sh",
        label="CRM transactional reset validation",
    )
    assert "CRM transactional reset checks passed" in result.stdout


def test_procurement_purchase_order_lifecycle_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_procurement_purchase_order_lifecycle_reset.sh",
        label="Procurement purchase-order lifecycle reset validation",
    )
    assert "Procurement purchase-order lifecycle reset checks passed" in result.stdout


def test_procurement_requisition_approval_routing_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_procurement_requisition_approval_routing_reset.sh",
        label="Procurement requisition approval routing reset validation",
    )
    assert "procurement_requisition_approval_routing reset-path validation passed" in result.stdout


def test_portal_schedule_access_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_portal_schedule_access_reset.sh",
        label="Portal schedule access reset validation",
    )
    assert "portal_schedule_access reset-path validation passed" in result.stdout


def test_visionlink_observability_reconciliation_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_visionlink_observability_reconciliation_reset.sh",
        label="VisionLink observability and reconciliation reset validation",
    )
    assert "VisionLink observability and reconciliation reset checks passed" in result.stdout


def test_technician_morning_queue_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_technician_morning_queue_reset.sh",
        label="Technician morning queue reset validation",
    )
    assert "technician_morning_queue reset-path validation passed" in result.stdout


def test_samsara_observability_reconciliation_reset_validation() -> None:
    if shutil.which("supabase") is None:
        pytest.skip("Supabase CLI is required for reset-path validation")

    result = _run_reset_validation_script(
        "run_samsara_observability_reconciliation_reset.sh",
        label="Samsara observability and reconciliation reset validation",
    )
    assert "Samsara observability reconciliation reset checks passed" in result.stdout


@pytest.fixture(scope="session")
def postgres_container() -> str:
    container_name = f"wynne_lvl_3_rental_pytest_{uuid.uuid4().hex[:8]}"
    # Allows local or CI runs to pin a different disposable Postgres image when needed.
    postgres_image = os.environ.get("POSTGRES_IMAGE", DEFAULT_POSTGRES_IMAGE)

    _run_command(
        [
            "docker",
            "run",
            "-d",
            "--name",
            container_name,
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-e",
            "POSTGRES_DB=postgres",
            postgres_image,
        ],
        timeout=120.0,
    )

    try:
        for _ in range(POSTGRES_READY_TIMEOUT_SECONDS):
            ready = subprocess.run(
                ["docker", "exec", container_name, "pg_isready", "-U", "postgres", "-d", "postgres"],
                text=True,
                capture_output=True,
                timeout=5.0,
            )
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            pytest.fail("Postgres test container did not become ready")

        # Provision a minimal `auth` schema stub before migrations. Migrations that
        # reference auth.* (FK to auth.users, auth.uid()/auth.jwt() in policies — e.g.
        # 20260607120000_user_roles_profiles.sql) would otherwise abort with
        # `schema "auth" does not exist` against a bare Postgres under ON_ERROR_STOP=1.
        _run_command_with_transient_retry(
            ["docker", "exec", "-i", container_name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
            transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
            max_attempts=4,
            input_text=(REPO_ROOT / "supabase" / "tests" / "auth_stub.sql").read_text(),
            timeout=60.0,
        )

        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            _run_command_with_transient_retry(
                ["docker", "exec", "-i", container_name, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
                transient_error_re=POSTGRES_CONTAINER_TRANSIENT_ERROR_RE,
                max_attempts=4,
                input_text=migration.read_text(),
                timeout=120.0,
            )

        yield container_name
    finally:
        subprocess.run(
            ["docker", "rm", "-f", container_name],
            capture_output=True,
            text=True,
            check=False,
            timeout=30.0,
        )


def test_create_entity_with_version_populates_current_branch_view(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        begin
          perform create_entity_with_version(
            p_entity_type => 'branch',
            p_data => jsonb_build_object(
              'name', 'North Branch',
              'branch_code', 'BR-N'
            ),
            p_source_record_id => 'branch-north'
          );
        end;
        $$;

        select
          rental_current_branches.version_number,
          rental_current_branches.name,
          rental_current_branches.data ->> 'branch_code'
        from rental_current_branches
        where rental_current_branches.source_record_id = 'branch-north';

        rollback;
        """,
    )

    assert rows == ["1\tNorth Branch\tBR-N"]


def test_rental_upsert_relationships_expose_current_customer_links(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_customer_id uuid;
          v_billing_account_id uuid;
          v_contact_id uuid;
          v_job_site_id uuid;
        begin
          select entity_id
            into v_customer_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'customer',
            p_source_record_id => 'customer-acme',
            p_data => jsonb_build_object('name', 'Acme Construction')
          );

          select entity_id
            into v_billing_account_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'billing_account',
            p_source_record_id => 'billing-acme-main',
            p_data => jsonb_build_object('name', 'Acme Main Billing')
          );

          select entity_id
            into v_contact_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'contact',
            p_source_record_id => 'contact-jane-doe',
            p_data => jsonb_build_object('name', 'Jane Doe')
          );

          select entity_id
            into v_job_site_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'job_site',
            p_source_record_id => 'job-site-riverfront',
            p_data => jsonb_build_object('name', 'Riverfront Expansion')
          );

          perform rental_upsert_relationship(
            'customer_has_billing_account',
            v_customer_id,
            v_billing_account_id
          );

          perform rental_upsert_relationship(
            'customer_has_contact',
            v_customer_id,
            v_contact_id
          );

          perform rental_upsert_relationship(
            'customer_has_job_site',
            v_customer_id,
            v_job_site_id
          );
        end;
        $$;

        select
          count(*),
          string_agg(child_entity_type, ',' order by child_entity_type)
        from rental_current_relationships
        where parent_id = (
          select id
          from entities
          where entity_type = 'customer'
            and source_record_id = 'customer-acme'
        );

        rollback;
        """,
    )

    assert rows == ["3\tbilling_account,contact,job_site"]


def test_asset_updates_append_versions_and_keep_single_current_branch_assignment(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_north_id uuid;
          v_branch_south_id uuid;
          v_asset_category_id uuid;
          v_asset_id uuid;
        begin
          select entity_id
            into v_branch_north_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-north',
            p_data => jsonb_build_object('name', 'North Branch')
          );

          select entity_id
            into v_branch_south_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-south',
            p_data => jsonb_build_object('name', 'South Branch')
          );

          select entity_id
            into v_asset_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'asset-category-excavators',
            p_data => jsonb_build_object('name', 'Excavators')
          );

          select entity_id
            into v_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-ex-001',
            p_data => jsonb_build_object(
              'name', 'Excavator A',
              'ownership_type', 'owned',
              'operational_status', 'available'
            )
          );

          perform rental_upsert_relationship(
            'branch_has_asset',
            v_branch_north_id,
            v_asset_id
          );

          perform rental_upsert_relationship(
            'asset_category_has_asset',
            v_asset_category_id,
            v_asset_id
          );

          perform rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_entity_id => v_asset_id,
            p_data => jsonb_build_object(
              'name', 'Excavator A',
              'ownership_type', 'owned',
              'operational_status', 'maintenance'
            )
          );

          perform rental_upsert_relationship(
            'branch_has_asset',
            v_branch_south_id,
            v_asset_id
          );
        end;
        $$;

        select
          rental_current_assets.version_number,
          rental_current_assets.current_branch_name,
          rental_current_assets.current_asset_category_name,
          rental_current_assets.operational_status,
          (
            select count(*)
            from relationships_v2
            where relationship_type = 'branch_has_asset'
              and child_id = (
                select id
                from entities
                where entity_type = 'asset'
                  and source_record_id = 'asset-ex-001'
              )
              and is_current
          )
        from rental_current_assets
        where rental_current_assets.entity_id = (
          select id
          from entities
          where entity_type = 'asset'
            and source_record_id = 'asset-ex-001'
        );

        rollback;
        """,
    )

    assert rows == ["2\tSouth Branch\tExcavators\tmaintenance\t1"]


def test_asset_can_link_maintenance_and_inspection_work_items(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_asset_id uuid;
          v_maintenance_id uuid;
          v_inspection_id uuid;
        begin
          select entity_id
            into v_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-work-001',
            p_data => jsonb_build_object('name', 'Excavator Work Item Asset')
          );

          select entity_id
            into v_maintenance_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'maintenance_record',
            p_source_record_id => 'maint-work-001',
            p_data => jsonb_build_object('status', 'open', 'maintenance_type', 'preventive')
          );

          select entity_id
            into v_inspection_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'inspection',
            p_source_record_id => 'insp-work-001',
            p_data => jsonb_build_object('status', 'complete', 'outcome', 'pass')
          );

          perform rental_upsert_relationship(
            'asset_has_maintenance_record',
            v_asset_id,
            v_maintenance_id
          );

          perform rental_upsert_relationship(
            'asset_has_inspection',
            v_asset_id,
            v_inspection_id
          );
        end;
        $$;

        select
          count(*),
          string_agg(relationship_type, ',' order by relationship_type)
        from rental_current_relationships
        where parent_id = (
          select id
          from entities
          where entity_type = 'asset'
            and source_record_id = 'asset-work-001'
        )
          and relationship_type in ('asset_has_maintenance_record', 'asset_has_inspection');

        rollback;
        """,
    )

    assert rows == ["2\tasset_has_inspection,asset_has_maintenance_record"]


def test_maintenance_entity_and_relationship_type_catalog_entries(postgres_container: str) -> None:
    entity_rows = _run_sql(
        postgres_container,
        """
        select count(*)
        from rental_entity_type_catalog
        where entity_type in ('maintenance_record', 'inspection');
        """,
    )
    assert entity_rows == ["2"]

    relationship_rows = _run_sql(
        postgres_container,
        """
        select count(*)
        from rental_relationship_type_catalog
        where (relationship_type, parent_entity_type, child_entity_type) in (
          ('asset_has_maintenance_record', 'asset', 'maintenance_record'),
          ('asset_has_inspection', 'asset', 'inspection')
        );
        """,
    )
    assert relationship_rows == ["2"]


def test_rental_entity_type_catalog_uses_security_invoker(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        select count(*)
        from pg_class
        join pg_namespace
          on pg_namespace.oid = pg_class.relnamespace
        where pg_namespace.nspname = 'public'
          and pg_class.relname = 'rental_entity_type_catalog'
          and pg_class.relkind = 'v'
          and coalesce(pg_class.reloptions, array[]::text[]) @> array['security_invoker=true']::text[];
        """,
    )
    assert rows == ["1"]


def test_rental_current_assets_exposes_maintenance_due_at_and_due_status(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        begin
          perform rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-due-status-001',
            p_data => jsonb_build_object(
              'name', 'Excavator Due Status',
              'ownership_type', 'owned',
              'operational_status', 'available',
              'maintenance_due_at', now() + interval '3 days'
            )
          );

          perform rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-overdue-status-001',
            p_data => jsonb_build_object(
              'name', 'Excavator Overdue Status',
              'ownership_type', 'owned',
              'operational_status', 'available',
              'maintenance_due_at', now() - interval '1 day'
            )
          );

          perform rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-not-due-status-001',
            p_data => jsonb_build_object(
              'name', 'Excavator Not Due Status',
              'ownership_type', 'owned',
              'operational_status', 'available',
              'maintenance_due_at', now() + interval '30 days'
            )
          );

          perform rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-no-due-001',
            p_data => jsonb_build_object(
              'name', 'Excavator No Due Date',
              'ownership_type', 'owned',
              'operational_status', 'available'
            )
          );
        end;
        $$;

        select
          source_record_id,
          maintenance_due_status
        from rental_current_assets
        where source_record_id in (
          'asset-due-status-001',
          'asset-overdue-status-001',
          'asset-not-due-status-001',
          'asset-no-due-001'
        )
        order by source_record_id;

        rollback;
        """,
    )

    assert rows == [
        "asset-due-status-001\tdue",
        "asset-no-due-001\tnone",
        "asset-not-due-status-001\tnot_due",
        "asset-overdue-status-001\toverdue",
    ]


def test_rental_asset_availability_returns_branch_and_category_rollups(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_south_id uuid;
          v_asset_category_id uuid;
          v_asset_a_id uuid;
          v_asset_b_id uuid;
        begin
          select entity_id
            into v_branch_south_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-south',
            p_data => jsonb_build_object('name', 'South Branch')
          );

          select entity_id
            into v_asset_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'asset-category-excavators',
            p_data => jsonb_build_object('name', 'Excavators')
          );

          select entity_id
            into v_asset_a_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-ex-001',
            p_data => jsonb_build_object(
              'name', 'Excavator A',
              'ownership_type', 'owned',
              'operational_status', 'available'
            )
          );

          select entity_id
            into v_asset_b_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-ex-002',
            p_data => jsonb_build_object(
              'name', 'Excavator B',
              'ownership_type', 'leased',
              'operational_status', 'maintenance'
            )
          );

          perform rental_upsert_relationship(
            'branch_has_asset',
            v_branch_south_id,
            v_asset_a_id
          );

          perform rental_upsert_relationship(
            'branch_has_asset',
            v_branch_south_id,
            v_asset_b_id
          );

          perform rental_upsert_relationship(
            'asset_category_has_asset',
            v_asset_category_id,
            v_asset_a_id
          );

          perform rental_upsert_relationship(
            'asset_category_has_asset',
            v_asset_category_id,
            v_asset_b_id
          );
        end;
        $$;

        select
          total_assets,
          available_assets,
          unavailable_assets
        from rental_asset_availability(
          (
            select id
            from entities
            where entity_type = 'branch'
              and source_record_id = 'branch-south'
          ),
          (
            select id
            from entities
            where entity_type = 'asset_category'
              and source_record_id = 'asset-category-excavators'
          )
        );

        rollback;
        """,
    )

    assert rows == ["2\t1\t1"]


def test_rental_current_inventory_records_projects_attributes_and_relationship_assignments(
    postgres_container: str,
) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_north_id uuid;
          v_asset_category_id uuid;
          v_asset_id uuid;
          v_stock_item_id uuid;
          v_meter_fact_id uuid;
          v_condition_fact_id uuid;
        begin
          select id into v_meter_fact_id
          from fact_types
          where key = 'asset_meter_reading';

          select id into v_condition_fact_id
          from fact_types
          where key = 'inventory_condition_observation';

          select entity_id
            into v_branch_north_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-north-inventory',
            p_data => jsonb_build_object('name', 'North Branch')
          );

          select entity_id
            into v_asset_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'asset-category-loaders',
            p_data => jsonb_build_object('name', 'Loaders')
          );

          select entity_id
            into v_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-loader-001',
            p_data => jsonb_build_object(
              'name', 'Tracked Loader',
              'make', 'CAT',
              'model', '950',
              'fuel_type', 'diesel',
              'meter_type', 'hours',
              'tags', jsonb_build_array('earthmoving', 'tracked'),
              'specs', jsonb_build_object('bucket_size', '2.5m3'),
              'condition', 'snapshot-good',
              'operational_status', 'available'
            )
          );

          select entity_id
            into v_stock_item_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'stock_item',
            p_source_record_id => 'stock-filter-kit-001',
            p_data => jsonb_build_object(
              'name', 'Hydraulic Filter Kit',
              'inventory_kind', 'part',
              'make', 'CAT',
              'model', 'HFK-22',
              'fuel_type', 'n/a',
              'meter_type', 'cycles',
              'tags', jsonb_build_array('maintenance', 'consumable'),
              'specs', jsonb_build_object('compatible_with', '950'),
              'condition', 'new',
              'operational_status', 'available'
            )
          );

          perform rental_upsert_relationship('branch_has_asset', v_branch_north_id, v_asset_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_asset_category_id, v_asset_id);
          perform rental_upsert_relationship('branch_has_stock_item', v_branch_north_id, v_stock_item_id);
          perform rental_upsert_relationship('asset_category_has_stock_item', v_asset_category_id, v_stock_item_id);

          insert into time_series_points (entity_id, fact_type_id, observed_at, data_payload, source_id)
          values (
            v_asset_id,
            v_meter_fact_id,
            now(),
            jsonb_build_object('reading_value', 1425, 'reading_unit', 'hours'),
            'inventory-projection-test'
          );

          insert into time_series_points (entity_id, fact_type_id, observed_at, data_payload, source_id)
          values (
            v_asset_id,
            v_condition_fact_id,
            now(),
            jsonb_build_object('condition', 'excellent'),
            'inventory-projection-test'
          );
        end;
        $$;

        select
          source_record_id,
          entity_type,
          inventory_kind,
          current_branch_name,
          current_asset_category_name,
          make,
          model,
          fuel_type,
          meter_type,
          condition,
          tags ->> 0,
          latest_meter_metadata ->> 'reading_value'
        from rental_current_inventory_records
        where source_record_id in ('asset-loader-001', 'stock-filter-kit-001')
        order by source_record_id;

        rollback;
        """,
    )

    assert rows == [
        "asset-loader-001\tasset\tserialized\tNorth Branch\tLoaders\tCAT\t950\tdiesel\thours\texcellent\tearthmoving\t1425",
        "stock-filter-kit-001\tstock_item\tpart\tNorth Branch\tLoaders\tCAT\tHFK-22\tn/a\tcycles\tnew\tmaintenance\t",
    ]


def test_rental_asset_availability_surfaces_due_and_overdue_maintenance(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_south_id uuid;
          v_asset_category_id uuid;
          v_asset_due_id uuid;
          v_asset_overdue_id uuid;
          v_asset_not_due_id uuid;
        begin
          select entity_id
            into v_branch_south_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-south-maint',
            p_data => jsonb_build_object('name', 'South Branch')
          );

          select entity_id
            into v_asset_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'asset-category-maint',
            p_data => jsonb_build_object('name', 'Excavators')
          );

          select entity_id
            into v_asset_due_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-due-001',
            p_data => jsonb_build_object(
              'name', 'Excavator Due',
              'ownership_type', 'owned',
              'operational_status', 'available',
              'maintenance_due_at', now() + interval '3 days'
            )
          );

          select entity_id
            into v_asset_overdue_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-overdue-001',
            p_data => jsonb_build_object(
              'name', 'Excavator Overdue',
              'ownership_type', 'owned',
              'operational_status', 'available',
              'maintenance_due_at', now() - interval '1 day'
            )
          );

          select entity_id
            into v_asset_not_due_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-not-due-001',
            p_data => jsonb_build_object(
              'name', 'Excavator Not Due',
              'ownership_type', 'leased',
              'operational_status', 'maintenance',
              'maintenance_due_at', now() + interval '30 days'
            )
          );

          perform rental_upsert_relationship('branch_has_asset', v_branch_south_id, v_asset_due_id);
          perform rental_upsert_relationship('branch_has_asset', v_branch_south_id, v_asset_overdue_id);
          perform rental_upsert_relationship('branch_has_asset', v_branch_south_id, v_asset_not_due_id);

          perform rental_upsert_relationship('asset_category_has_asset', v_asset_category_id, v_asset_due_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_asset_category_id, v_asset_overdue_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_asset_category_id, v_asset_not_due_id);
        end;
        $$;

        select
          total_assets,
          available_assets,
          unavailable_assets,
          maintenance_due_assets,
          maintenance_overdue_assets
        from rental_asset_availability(
          (
            select id
            from entities
            where entity_type = 'branch'
              and source_record_id = 'branch-south-maint'
          ),
          (
            select id
            from entities
            where entity_type = 'asset_category'
              and source_record_id = 'asset-category-maint'
          )
        );

        rollback;
        """,
    )

    assert rows == ["3\t2\t1\t1\t1"]


def test_rental_operations_fact_types_are_seeded(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        select string_agg(key, ',' order by key)
        from fact_types
        where key in (
          'asset_meter_reading',
          'asset_downtime',
          'branch_on_rent_count',
          'branch_utilization_rate',
          'invoice_total',
          'rental_revenue'
        );
        """,
    )

    assert rows == [
        "asset_downtime,asset_meter_reading,branch_on_rent_count,branch_utilization_rate,invoice_total,rental_revenue"
    ]


def test_rental_operations_analytics_views(
    postgres_container: str,
) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_id uuid;
          v_asset_id uuid;
          v_invoice_id uuid;
          v_now timestamptz := '2026-01-15 10:00:00+00';
        begin
          insert into entities (entity_type, source_record_id)
          values ('branch', 'branch-flow-north')
          returning id into v_branch_id;

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_branch_id,
            1,
            jsonb_build_object('name', 'North Flow Branch'),
            v_now
          );

          insert into entities (entity_type, source_record_id)
          values ('asset', 'asset-flow-001')
          returning id into v_asset_id;

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_asset_id,
            1,
            jsonb_build_object(
              'name', 'Excavator Flow A',
              'status', 'available',
              'serial_number', 'SN-FLOW-001',
              'category_id', 'cat-excavator'
            ),
            v_now
          );

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_asset_id,
            2,
            jsonb_build_object(
              'name', 'Excavator Flow A',
              'status', 'in_transit',
              'serial_number', 'SN-FLOW-001',
              'category_id', 'cat-excavator'
            ),
            v_now + interval '5 minutes'
          );

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_asset_id,
            3,
            jsonb_build_object(
              'name', 'Excavator Flow A',
              'status', 'inspection_hold',
              'serial_number', 'SN-FLOW-001',
              'category_id', 'cat-excavator'
            ),
            v_now + interval '10 minutes'
          );

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_asset_id,
            4,
            jsonb_build_object(
              'name', 'Excavator Flow A',
              'status', 'maintenance',
              'serial_number', 'SN-FLOW-001',
              'category_id', 'cat-excavator'
            ),
            v_now + interval '20 minutes'
          );

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_asset_id,
            5,
            jsonb_build_object(
              'name', 'Excavator Flow A',
              'status', 'available',
              'serial_number', 'SN-FLOW-001',
              'category_id', 'cat-excavator'
            ),
            v_now + interval '30 minutes'
          );

          insert into entities (entity_type, source_record_id)
          values ('invoice', 'invoice-flow-001')
          returning id into v_invoice_id;

          insert into entity_versions (entity_id, version_number, data, valid_from)
          values (
            v_invoice_id,
            1,
            jsonb_build_object('status', 'pending', 'contract_id', 'contract-flow-001'),
            v_now
          );

          insert into entity_facts (entity_id, fact_type_id, value, source_id)
          values
            (
              v_branch_id,
              (select id from fact_types where key = 'branch_on_rent_count'),
              3,
              'utilization-flow'
            ),
            (
              v_branch_id,
              (select id from fact_types where key = 'branch_utilization_rate'),
              75,
              'utilization-flow'
            ),
            (
              v_invoice_id,
              (select id from fact_types where key = 'invoice_total'),
              660,
              'invoice-flow'
            ),
            (
              v_invoice_id,
              (select id from fact_types where key = 'rental_revenue'),
              600,
              'invoice-flow'
            );

          insert into time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
          values
            (
              v_asset_id,
              (select id from fact_types where key = 'asset_downtime'),
              v_now + interval '25 minutes',
              jsonb_build_object('downtime_minutes', 95, 'maintenance_record_id', 'maint-flow-001'),
              jsonb_build_object('workflow', 'maintenance'),
              'maintenance-flow'
            ),
            (
              v_asset_id,
              (select id from fact_types where key = 'asset_meter_reading'),
              v_now + interval '15 minutes',
              jsonb_build_object('reading_value', 120.5, 'reading_unit', 'hours'),
              jsonb_build_object('workflow', 'transfer'),
              'meter-flow'
            ),
            (
              v_asset_id,
              (select id from fact_types where key = 'asset_meter_reading'),
              v_now + interval '35 minutes',
              jsonb_build_object('reading_value', 145.5, 'reading_unit', 'hours'),
              jsonb_build_object('workflow', 'inspection'),
              'meter-flow'
            );
        end;
        $$;

        select
          'asset_status_history',
          (
            select string_agg(entity_versions.data ->> 'status', ',' order by entity_versions.version_number)
            from entity_versions
            where entity_id = (
              select id
              from entities
              where entity_type = 'asset'
                and source_record_id = 'asset-flow-001'
            )
          );

        select
          'v_current_assets',
          v_current_assets.status || ',' || v_current_assets.serial_number || ',' || v_current_assets.name
        from v_current_assets
        where v_current_assets.source_record_id = 'asset-flow-001';

        select
          'v_asset_downtime_history',
          v_asset_downtime_history.downtime_minutes::int::text || ',' ||
          v_asset_downtime_history.maintenance_record_id || ',' ||
          coalesce(v_asset_downtime_history.metadata ->> 'workflow', '')
        from v_asset_downtime_history
        where v_asset_downtime_history.asset_id = (
          select id
          from entities
          where entity_type = 'asset'
            and source_record_id = 'asset-flow-001'
        );

        select
          'v_branch_utilization',
          v_branch_utilization.branch_name || ',' ||
          v_branch_utilization.on_rent_count::int::text || ',' ||
          v_branch_utilization.utilization_rate_pct::int::text
        from v_branch_utilization
        where v_branch_utilization.source_record_id = 'branch-flow-north';

        select
          'v_asset_latest_meter',
          round(v_asset_latest_meter.reading_value, 1)::text || ',' || v_asset_latest_meter.reading_unit
        from v_asset_latest_meter
        where v_asset_latest_meter.asset_id = (
          select id
          from entities
          where entity_type = 'asset'
            and source_record_id = 'asset-flow-001'
        );

        select
          'invoice_facts',
          string_agg(fact_types.key || ':' || entity_facts.value::int::text, ',' order by fact_types.key)
        from entity_facts
        join fact_types on fact_types.id = entity_facts.fact_type_id
        where entity_facts.entity_id = (
          select id
          from entities
          where entity_type = 'invoice'
            and source_record_id = 'invoice-flow-001'
        )
          and fact_types.key in ('invoice_total', 'rental_revenue');

        rollback;
        """,
    )

    assert rows == [
        "asset_status_history\tavailable,in_transit,inspection_hold,maintenance,available",
        "v_current_assets\tavailable,SN-FLOW-001,Excavator Flow A",
        "v_asset_downtime_history\t95,maint-flow-001,maintenance",
        "v_branch_utilization\tNorth Flow Branch,3,75",
        "v_asset_latest_meter\t145.5,hours",
        "invoice_facts\tinvoice_total:660,rental_revenue:600",
    ]


def test_maintenance_completion_payloads_surface_in_service_history_and_downtime_views(
    postgres_container: str,
) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_id uuid;
          v_category_id uuid;
          v_asset_id uuid;
          v_maintenance_id uuid;
        begin
          select entity_id
            into v_branch_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-maint-svc',
            p_data => jsonb_build_object('name', 'Maintenance Branch')
          );

          select entity_id
            into v_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'category-maint-svc',
            p_data => jsonb_build_object('name', 'Excavators')
          );

          select entity_id
            into v_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-maint-svc',
            p_data => jsonb_build_object(
              'name', 'Excavator Service Asset',
              'serial_number', 'SN-MAINT-SVC',
              'status', 'maintenance',
              'operational_status', 'maintenance'
            )
          );

          perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_category_id, v_asset_id);

          select entity_id
            into v_maintenance_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'maintenance_record',
            p_source_record_id => 'maint-svc-001',
            p_data => jsonb_build_object(
              'name', 'Hydraulic Repair',
              'maintenance_type', 'corrective',
              'status', 'open',
              'opened_at', '2026-06-01T08:00:00Z'
            )
          );

          perform rental_upsert_relationship('asset_has_maintenance_record', v_asset_id, v_maintenance_id);

          perform rental_upsert_entity_current_state(
            p_entity_type => 'maintenance_record',
            p_entity_id => v_maintenance_id,
            p_data => jsonb_build_object(
              'name', 'Hydraulic Repair',
              'maintenance_type', 'corrective',
              'status', 'completed',
              'opened_at', '2026-06-01T08:00:00Z',
              'completed_at', '2026-06-01T10:30:00Z',
              'outcome', 'returned_to_service',
              'resolution_notes', 'replaced hose',
              'cost_summary', 'Labor $180 · Parts $95 · Total $275'
            )
          );

          insert into time_series_points (
            entity_id,
            fact_type_id,
            observed_at,
            data_payload,
            metadata,
            source_id
          )
          values (
            v_asset_id,
            (select id from fact_types where key = 'asset_downtime'),
            '2026-06-01T10:30:00Z'::timestamptz,
            jsonb_build_object(
              'downtime_minutes', 150,
              'maintenance_record_id', v_maintenance_id::text
            ),
            jsonb_build_object('source', 'maintenance'),
            'maint-svc-downtime-001'
          );
        end;
        $$;

        select
          'service_history',
          service_record_type || ',' ||
          service_type || ',' ||
          status || ',' ||
          outcome || ',' ||
          cost_summary || ',' ||
          downtime_minutes::int::text
        from v_asset_service_history
        where asset_id = (
          select id from entities where source_record_id = 'asset-maint-svc'
        )
          and service_record_id = (
            select id from entities where source_record_id = 'maint-svc-001'
          );

        select
          'asset_downtime_analytics',
          downtime_intervals::text || ',' ||
          total_downtime_minutes::int::text || ',' ||
          maintenance_downtime_minutes::int::text
        from v_asset_downtime_analytics
        where asset_id = (
          select id from entities where source_record_id = 'asset-maint-svc'
        );

        select
          'category_downtime_summary',
          asset_category_name || ',' ||
          downtime_intervals::text || ',' ||
          total_downtime_minutes::int::text
        from v_asset_category_downtime_summary
        where asset_category_id = (
          select id from entities where source_record_id = 'category-maint-svc'
        );

        rollback;
        """,
    )

    assert rows == [
        "service_history\tmaintenance,corrective,completed,returned_to_service,Labor $180 · Parts $95 · Total $275,150",
        "asset_downtime_analytics\t1,150,150",
        "category_downtime_summary\tExcavators,1,150",
    ]


def test_asset_analytics_projection_surfaces_revenue_utilization_roi_and_rerent_exclusion(
    postgres_container: str,
) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_id uuid;
          v_category_id uuid;
          v_owned_asset_id uuid;
          v_leased_asset_id uuid;
          v_owned_contract_id uuid;
          v_leased_contract_id uuid;
          v_owned_line_id uuid;
          v_leased_line_id uuid;
          v_owned_invoice_id uuid;
          v_leased_invoice_id uuid;
          v_asset_downtime_fact_id uuid;
        begin
          select id into v_asset_downtime_fact_id
          from fact_types
          where key = 'asset_downtime';

          select entity_id into v_branch_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'branch-asset-analytics',
            p_data => jsonb_build_object('name', 'Analytics Branch')
          );

          select entity_id into v_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'category-asset-analytics',
            p_data => jsonb_build_object('name', 'Analytics Category')
          );

          select entity_id into v_owned_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-analytics-owned',
            p_data => jsonb_build_object(
              'name', 'Analytics Owned Asset',
              'ownership_type', 'owned',
              'acquisition_cost', 10000,
              'operational_status', 'available'
            )
          );

          select entity_id into v_leased_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'asset-analytics-rerent',
            p_data => jsonb_build_object(
              'name', 'Analytics Re-rent Asset',
              'ownership_type', 'leased',
              'operational_status', 'available'
            )
          );

          update entities
             set created_at = now() - interval '100 days',
                 updated_at = now() - interval '100 days'
           where id in (v_owned_asset_id, v_leased_asset_id);

          perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_owned_asset_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_category_id, v_owned_asset_id);
          perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_leased_asset_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_category_id, v_leased_asset_id);

          select entity_id into v_owned_contract_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'rental_contract',
            p_source_record_id => 'contract-analytics-owned',
            p_data => jsonb_build_object('status', 'closed', 'rental_type', 'external')
          );

          select entity_id into v_leased_contract_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'rental_contract',
            p_source_record_id => 'contract-analytics-rerent',
            p_data => jsonb_build_object('status', 'closed', 'rental_type', 'external')
          );

          select entity_id into v_owned_line_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'rental_contract_line',
            p_source_record_id => 'contract-line-analytics-owned',
            p_data => jsonb_build_object(
              'contract_id', v_owned_contract_id::text,
              'asset_id', v_owned_asset_id::text,
              'rental_type', 'external',
              'status', 'returned',
              'actual_start', (now() - interval '10 days')::text,
              'actual_end', (now() - interval '5 days')::text
            )
          );

          select entity_id into v_leased_line_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'rental_contract_line',
            p_source_record_id => 'contract-line-analytics-rerent',
            p_data => jsonb_build_object(
              'contract_id', v_leased_contract_id::text,
              'asset_id', v_leased_asset_id::text,
              'rental_type', 're_rent',
              'status', 'returned',
              'actual_start', (now() - interval '8 days')::text,
              'actual_end', (now() - interval '6 days')::text
            )
          );

          select entity_id into v_owned_invoice_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'invoice',
            p_source_record_id => 'invoice-analytics-owned',
            p_data => jsonb_build_object(
              'status', 'sent',
              'contract_id', v_owned_contract_id::text
            )
          );

          select entity_id into v_leased_invoice_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'invoice',
            p_source_record_id => 'invoice-analytics-rerent',
            p_data => jsonb_build_object(
              'status', 'sent',
              'contract_id', v_leased_contract_id::text
            )
          );

          perform rental_upsert_entity_current_state(
            p_entity_type => 'invoice_line',
            p_source_record_id => 'invoice-line-analytics-owned',
            p_data => jsonb_build_object(
              'invoice_id', v_owned_invoice_id::text,
              'line_item_id', v_owned_line_id::text,
              'amount', 2500
            )
          );

          perform rental_upsert_entity_current_state(
            p_entity_type => 'invoice_line',
            p_source_record_id => 'invoice-line-analytics-rerent',
            p_data => jsonb_build_object(
              'invoice_id', v_leased_invoice_id::text,
              'line_item_id', v_leased_line_id::text,
              'amount', 900
            )
          );

          insert into time_series_points (entity_id, fact_type_id, observed_at, data_payload, metadata, source_id)
          values
            (
              v_owned_asset_id,
              v_asset_downtime_fact_id,
              now() - interval '4 days',
              jsonb_build_object('downtime_minutes', 120, 'maintenance_record_id', 'maint-analytics-owned'),
              jsonb_build_object('source', 'maintenance'),
              'analytics-owned-downtime'
            ),
            (
              v_leased_asset_id,
              v_asset_downtime_fact_id,
              now() - interval '3 days',
              jsonb_build_object('downtime_minutes', 60, 'maintenance_record_id', 'maint-analytics-rerent'),
              jsonb_build_object('source', 'maintenance'),
              'analytics-rerent-downtime'
            );
        end;
        $$;

        select
          'owned_metrics',
          round(lifetime_revenue, 2)::text || ',' ||
          round(utilization_pct, 2)::text || ',' ||
          coalesce(round(roi_pct, 2)::text, 'null') || ',' ||
          round(downtime_pct, 4)::text || ',' ||
          rental_frequency::int::text || ',' ||
          case when last_order_at is null then 'missing' else 'present' end
        from v_asset_analytics_current
        where asset_id = (
          select id from entities where entity_type = 'asset' and source_record_id = 'asset-analytics-owned'
        );

        select
          'rerent_metrics',
          round(lifetime_revenue, 2)::text || ',' ||
          round(utilization_pct, 2)::text || ',' ||
          coalesce(round(roi_pct, 2)::text, 'null') || ',' ||
          round(downtime_pct, 4)::text || ',' ||
          rental_frequency::int::text || ',' ||
          roi_status
        from v_asset_analytics_current
        where asset_id = (
          select id from entities where entity_type = 'asset' and source_record_id = 'asset-analytics-rerent'
        );

        select
          'rerent_roi_fact_count',
          count(*)::text
        from entity_facts ef
        join fact_types ft on ft.id = ef.fact_type_id
        where ft.key = 'asset_roi_pct'
          and ef.entity_id = (
            select id from entities where entity_type = 'asset' and source_record_id = 'asset-analytics-rerent'
          );

        rollback;
        """,
    )

    assert rows == [
        "owned_metrics\t2500.00,5.00,-75.00,0.0833,1,present",
        "rerent_metrics\t900.00,0.00,null,0.0417,0,unavailable",
        "rerent_roi_fact_count\t0",
    ]


def test_enterprise_org_hierarchy_closure_and_config(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_company_id  uuid;
          v_region_id   uuid;
          v_branch_id   uuid;
          v_asset_id    uuid;
          v_scope_id    uuid;
        begin
          select entity_id into v_company_id
          from rental_upsert_entity_current_state(
            p_entity_type      => 'company',
            p_source_record_id => 'pytest-org-company-1',
            p_data => jsonb_build_object(
              'name',                  'Pytest Corp',
              'default_currency_code', 'USD',
              'locale_code',           'en-US',
              'timezone',              'UTC'
            )
          );

          select entity_id into v_region_id
          from rental_upsert_entity_current_state(
            p_entity_type      => 'region',
            p_source_record_id => 'pytest-org-region-1',
            p_data => jsonb_build_object(
              'name',           'Pytest Region',
              'tax_region_code','US-TX'
            )
          );

          select entity_id into v_branch_id
          from rental_upsert_entity_current_state(
            p_entity_type      => 'branch',
            p_source_record_id => 'pytest-org-branch-1',
            p_data => jsonb_build_object('name', 'Pytest Branch', 'branch_code', 'PYT')
          );

          perform rental_upsert_relationship('company_has_region', v_company_id, v_region_id);
          perform rental_upsert_relationship('region_has_branch',  v_region_id,  v_branch_id);

          select entity_id into v_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type      => 'asset',
            p_source_record_id => 'pytest-org-asset-1',
            p_data => jsonb_build_object('name', 'Pytest Excavator')
          );

          perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_id);
        end;
        $$;

        -- Closure rows for company subtree
        select count(*)
        from org_scope_closure osc
        join entities anc on anc.id = osc.ancestor_id and anc.source_record_id = 'pytest-org-company-1'
        join entities desc_ on desc_.id = osc.descendant_id
        where desc_.source_record_id in (
          'pytest-org-company-1', 'pytest-org-region-1', 'pytest-org-branch-1'
        );

        -- Asset org_scope_id resolved to branch
        select
          case
            when e_branch.id = e_asset.org_scope_id then 'scope_ok'
            else 'scope_mismatch'
          end
        from entities e_asset
        join entities e_branch on e_branch.source_record_id = 'pytest-org-branch-1'
        where e_asset.source_record_id = 'pytest-org-asset-1';

        -- Effective config for branch inherits from company
        select default_currency_code, timezone, tax_region_code
        from org_scope_effective_config(
          (select id from entities where source_record_id = 'pytest-org-branch-1')
        );

        rollback;
        """,
    )

    assert rows[0] == "3"
    assert rows[1] == "scope_ok"
    assert rows[2] == "USD\tUTC\tUS-TX"


def test_inventory_kit_catalog_entries_are_registered(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        select count(*)
        from rental_entity_type_catalog
        where entity_type = 'inventory_kit';

        select count(*)
        from rental_relationship_type_catalog
        where (relationship_type, parent_entity_type, child_entity_type) in (
          ('kit_has_asset', 'inventory_kit', 'asset'),
          ('kit_has_asset_category', 'inventory_kit', 'asset_category'),
          ('kit_has_stock_item', 'inventory_kit', 'stock_item')
        );
        """,
    )

    assert rows == ["1", "3"]


def test_inventory_kit_availability_blocks_on_component_shortages(postgres_container: str) -> None:
    rows = _run_sql(
        postgres_container,
        """
        begin;

        do $$
        declare
          v_branch_id uuid;
          v_category_id uuid;
          v_asset_id uuid;
          v_stock_item_id uuid;
          v_kit_id uuid;
          v_stock_opening_fact_type_id uuid;
        begin
          select entity_id into v_branch_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'branch',
            p_source_record_id => 'kit-branch-001',
            p_data => jsonb_build_object('name', 'Kit Branch')
          );

          select entity_id into v_category_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset_category',
            p_source_record_id => 'kit-category-001',
            p_data => jsonb_build_object('name', 'Kit Category')
          );

          select entity_id into v_asset_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'asset',
            p_source_record_id => 'kit-asset-001',
            p_data => jsonb_build_object('name', 'Kit Asset', 'operational_status', 'available')
          );

          perform rental_upsert_relationship('branch_has_asset', v_branch_id, v_asset_id);
          perform rental_upsert_relationship('asset_category_has_asset', v_category_id, v_asset_id);

          select entity_id into v_stock_item_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'stock_item',
            p_source_record_id => 'kit-stock-001',
            p_data => jsonb_build_object('name', 'Kit Stock', 'inventory_kind', 'part', 'operational_status', 'available')
          );

          perform rental_upsert_relationship('branch_has_stock_item', v_branch_id, v_stock_item_id);
          perform rental_upsert_relationship('asset_category_has_stock_item', v_category_id, v_stock_item_id);

          select id into v_stock_opening_fact_type_id
          from fact_types
          where key = 'stock_opening_balance'
          limit 1;

          insert into time_series_points (
            entity_id,
            fact_type_id,
            observed_at,
            data_payload,
            source_id
          )
          values (
            v_stock_item_id,
            v_stock_opening_fact_type_id,
            now(),
            jsonb_build_object('quantity', 4),
            'kit-stock-open-001'
          );

          select entity_id into v_kit_id
          from rental_upsert_entity_current_state(
            p_entity_type => 'inventory_kit',
            p_source_record_id => 'kit-def-001',
            p_data => jsonb_build_object('name', 'Starter Kit')
          );

          perform rental_upsert_relationship(
            p_relationship_type => 'kit_has_asset_category',
            p_parent_id => v_kit_id,
            p_child_id => v_category_id,
            p_metadata => jsonb_build_object('quantity', 1, 'is_required', true)
          );

          perform rental_upsert_relationship(
            p_relationship_type => 'kit_has_stock_item',
            p_parent_id => v_kit_id,
            p_child_id => v_stock_item_id,
            p_metadata => jsonb_build_object('quantity', 2, 'is_required', true)
          );
        end;
        $$;

        select
          available_quantity,
          is_available,
          shortage_quantity,
          jsonb_array_length(blocking_components)
        from rental_kit_availability(
          (select id from entities where source_record_id = 'kit-def-001'),
          (select id from entities where source_record_id = 'kit-branch-001'),
          current_date,
          current_date + 2,
          3
        );

        rollback;
        """,
    )

    assert rows == ["1\tf\t2\t2"]
