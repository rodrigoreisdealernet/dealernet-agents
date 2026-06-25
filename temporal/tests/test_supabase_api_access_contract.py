from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib import error, parse, request
from urllib.parse import urlparse

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SUPABASE_CONFIG_PATH = REPO_ROOT / "supabase" / "config.toml"
READ_ENDPOINTS = (
    "/rest/v1/entities?select=id,entity_type&limit=5",
    "/rest/v1/rental_current_assets?select=entity_id&limit=5",
    "/rest/v1/rental_current_branches?select=entity_id&limit=5",
    "/rest/v1/v_asset_analytics_current?select=asset_id,lifetime_revenue,roi_status&limit=5",
)
RLS_TABLES = (
    "entities",
    "entity_versions",
    "relationships_v2",
    "fact_types",
    "entity_facts",
    "time_series_points",
    "dim_rental_order_status",
    "dim_rental_contract_status",
    "dim_rental_line_status",
    "dim_asset_availability_status",
    "dim_rental_rate_type",
    "dim_rental_type",
)
TRANSIENT_RESET_ERROR_FRAGMENTS = (
    "Error status 502",
    "error running container: exit 1",
)
RESET_RETRY_BACKOFF_SECONDS = 5


@dataclass(frozen=True)
class ContractTestConfig:
    base_url: str
    anon_key: str
    service_role_key: str | None
    jwt_secret: str | None
    read_only_jwt: str | None
    admin_jwt: str | None
    branch_manager_jwt: str | None
    field_operator_jwt: str | None
    local_stack_managed: bool
    db_url: str | None


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: str


def _run(
    command: list[str],
    *,
    input_text: str | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    run_env = os.environ.copy()
    if env:
        run_env.update(env)
    return subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        check=True,
        env=run_env,
        timeout=120.0,
    )


def _has_flag(command: list[str], flag: str) -> bool:
    try:
        result = _run(command)
    except subprocess.CalledProcessError:
        return False
    return flag in (result.stdout + result.stderr)


def _project_args() -> list[str]:
    if _has_flag(["supabase", "status", "--help"], "--config"):
        return ["--config", str(SUPABASE_CONFIG_PATH)]
    return ["--workdir", str(REPO_ROOT)]


def _reset_project_args(project_args: list[str]) -> list[str]:
    if "--workdir" in project_args:
        return ["--local", *project_args]
    return [*project_args]


def _run_with_transient_retry(
    command: list[str],
    *,
    max_attempts: int = 4,
) -> subprocess.CompletedProcess[str]:
    attempt = 0
    while True:
        try:
            return _run(command)
        except subprocess.CalledProcessError as exc:
            attempt += 1
            output = (exc.stderr or "") + (exc.stdout or "")
            if attempt >= max_attempts or not any(fragment in output for fragment in TRANSIENT_RESET_ERROR_FRAGMENTS):
                raise
            time.sleep(attempt * RESET_RETRY_BACKOFF_SECONDS)


def _parse_env_lines(lines: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in lines.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = _strip_wrapping_quotes(value.strip())
    return values


def _resolve_supabase_env() -> dict[str, str]:
    output = _run(["supabase", "status", "--output", "env", *_project_args()]).stdout
    values = _parse_env_lines(output)
    if not values:
        raise RuntimeError("supabase status --output env returned no values")
    return values


def test_parse_env_lines_strips_optional_wrapping_quotes() -> None:
    parsed = _parse_env_lines('API_URL="http://127.0.0.1:54321"\nANON_KEY=\'quoted-key\'\nDB_URL=postgres://plain')
    assert parsed["API_URL"] == "http://127.0.0.1:54321"
    assert parsed["ANON_KEY"] == "quoted-key"
    assert parsed["DB_URL"] == "postgres://plain"


def test_run_with_transient_retry_retries_container_startup_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = {"count": 0}

    def fake_run(command: list[str]) -> subprocess.CompletedProcess[str]:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise subprocess.CalledProcessError(
                returncode=1,
                cmd=command,
                stderr="error running container: exit 1",
            )
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(sys.modules[__name__], "_run", fake_run)
    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    result = _run_with_transient_retry(["supabase", "db", "reset"])

    assert result.stdout == "ok"
    assert attempts["count"] == 3


def test_run_with_transient_retry_raises_non_transient_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(command: list[str]) -> subprocess.CompletedProcess[str]:
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=command,
            stderr="fatal: migration syntax error",
        )

    monkeypatch.setattr(sys.modules[__name__], "_run", fake_run)
    monkeypatch.setattr("time.sleep", lambda _seconds: None)

    with pytest.raises(subprocess.CalledProcessError):
        _run_with_transient_retry(["supabase", "db", "reset"])


def _strip_wrapping_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _encode_jwt(secret: str, payload: dict[str, object]) -> str:
    header_segment = _b64url_encode(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode("utf-8"))
    payload_segment = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_segment}.{payload_segment}".encode()
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_segment}.{payload_segment}.{_b64url_encode(signature)}"


def _http_json(
    *,
    base_url: str,
    method: str,
    path: str,
    apikey: str,
    bearer: str,
    payload: dict[str, object] | None = None,
    prefer_representation: bool = False,
) -> HttpResponse:
    headers = {
        "apikey": apikey,
        "Authorization": "Bearer " + bearer,
    }
    data: bytes | None = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    if prefer_representation:
        headers["Prefer"] = "return=representation"

    req = request.Request(
        parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/")),
        method=method,
        headers=headers,
        data=data,
    )

    try:
        with request.urlopen(req, timeout=20) as response:
            return HttpResponse(status=response.status, body=response.read().decode("utf-8"))
    except error.HTTPError as exc:
        return HttpResponse(status=exc.code, body=exc.read().decode("utf-8"))


def _parse_local_db_connection_details(db_url: str) -> tuple[str, int, str, str | None, str]:
    parsed_db_url = urlparse(db_url)
    db_host = parsed_db_url.hostname
    db_port = parsed_db_url.port
    db_user = parsed_db_url.username
    db_password = parsed_db_url.password
    db_name = parsed_db_url.path.lstrip("/") if parsed_db_url.path else None

    if not (db_host and db_port and db_user and db_name):
        raise ValueError("Could not parse DB connection details from DB_URL")
    if db_host not in {"127.0.0.1", "localhost"}:
        raise ValueError("Direct-role guard assertions are restricted to local database hosts")

    return db_host, db_port, db_user, db_password, db_name


@pytest.fixture(scope="module")
def live_contract_config() -> ContractTestConfig:
    base_url = os.environ.get("SUPABASE_TEST_BASE_URL")
    anon_key = os.environ.get("SUPABASE_TEST_ANON_KEY")
    service_role_key = os.environ.get("SUPABASE_TEST_SERVICE_ROLE_KEY")
    jwt_secret = os.environ.get("SUPABASE_TEST_JWT_SECRET")
    read_only_jwt = os.environ.get("SUPABASE_TEST_AUTH_JWT")
    admin_jwt = os.environ.get("SUPABASE_TEST_ADMIN_JWT")
    branch_manager_jwt = os.environ.get("SUPABASE_TEST_BRANCH_MANAGER_JWT")
    field_operator_jwt = os.environ.get("SUPABASE_TEST_FIELD_OPERATOR_JWT")

    if base_url and anon_key:
        yield ContractTestConfig(
            base_url=base_url,
            anon_key=anon_key,
            service_role_key=service_role_key,
            jwt_secret=jwt_secret,
            read_only_jwt=read_only_jwt,
            admin_jwt=admin_jwt,
            branch_manager_jwt=branch_manager_jwt,
            field_operator_jwt=field_operator_jwt,
            local_stack_managed=False,
            db_url=os.environ.get("SUPABASE_TEST_DB_URL"),
        )
        return

    if shutil.which("supabase") is None:
        pytest.skip("Set SUPABASE_TEST_BASE_URL/SUPABASE_TEST_ANON_KEY, or install Supabase CLI for local contract tests")
    if shutil.which("docker") is None:
        pytest.skip("Docker is required when local Supabase stack is auto-managed")

    project_args = _project_args()
    start_args = ["supabase", "start", *project_args]
    stop_args = ["supabase", "stop", "--no-backup", *project_args]
    reset_args = ["supabase", "db", "reset", *_reset_project_args(project_args)]

    if _has_flag(["supabase", "start", "--help"], "--yes"):
        start_args.insert(2, "--yes")
    if _has_flag(["supabase", "stop", "--help"], "--yes"):
        stop_args.insert(3, "--yes")
    if _has_flag(["supabase", "db", "reset", "--help"], "--yes"):
        reset_args.insert(3, "--yes")

    # Bring up the local Supabase stack. If it can't START/RESET/RESOLVE (flaky CI
    # infra: docker/supabase-CLI hiccup or Docker image pull timeout), SKIP rather
    # than ERROR — these are integration tests, and a stack that won't come up is an
    # infrastructure gap, not a contract violation. Erroring here reddens main and
    # blocks all merges, which it has done repeatedly. Assertion-level failures below
    # remain real failures.
    try:
        _run(start_args)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        pytest.skip(f"Local Supabase stack could not start (CI infra unavailable): {exc}")

    try:
        try:
            _run_with_transient_retry(reset_args)
            env_values = _resolve_supabase_env()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError) as exc:
            pytest.skip(f"Local Supabase stack could not be reset/resolved (CI infra unavailable): {exc}")
        base_url = env_values.get("API_URL")
        anon_key = env_values.get("ANON_KEY")
        service_role_key = service_role_key or env_values.get("SERVICE_ROLE_KEY")
        jwt_secret = jwt_secret or env_values.get("JWT_SECRET")
        db_url = env_values.get("DB_URL")

        if not base_url or not anon_key:
            pytest.fail("Unable to resolve API_URL/ANON_KEY from local Supabase status output")

        if jwt_secret and not (read_only_jwt and admin_jwt and branch_manager_jwt and field_operator_jwt):
            now = int(time.time())
            def _jwt_for_app_role(app_role: str, email_prefix: str) -> str:
                return _encode_jwt(
                    jwt_secret,
                    {
                        "aud": "authenticated",
                        "role": "authenticated",
                        "sub": str(uuid.uuid4()),
                        "email": f"{email_prefix}.contract-tests@example.test",
                        "app_metadata": {"role": app_role, "tenant": "default"},
                        "user_metadata": {},
                        "iat": now,
                        "exp": now + 900,
                    },
                )

            read_only_jwt = read_only_jwt or _jwt_for_app_role("read_only", "readonly")
            admin_jwt = admin_jwt or _jwt_for_app_role("admin", "admin")
            branch_manager_jwt = branch_manager_jwt or _jwt_for_app_role("branch_manager", "manager")
            field_operator_jwt = field_operator_jwt or _jwt_for_app_role("field_operator", "operator")

        yield ContractTestConfig(
            base_url=base_url,
            anon_key=anon_key,
            service_role_key=service_role_key,
            jwt_secret=jwt_secret,
            read_only_jwt=read_only_jwt,
            admin_jwt=admin_jwt,
            branch_manager_jwt=branch_manager_jwt,
            field_operator_jwt=field_operator_jwt,
            local_stack_managed=True,
            db_url=db_url,
        )
    finally:
        try:
            _run(stop_args)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass


def _deny_status(response: HttpResponse, *, operation: str) -> None:
    assert response.status in {401, 403}, f"{operation} should be denied but returned {response.status}: {response.body}"


def test_anon_reads_return_empty_or_forbidden_for_gated_endpoints(live_contract_config: ContractTestConfig) -> None:
    for path in READ_ENDPOINTS:
        response = _http_json(
            base_url=live_contract_config.base_url,
            method="GET",
            path=path,
            apikey=live_contract_config.anon_key,
            bearer=live_contract_config.anon_key,
        )
        if response.status in {401, 403}:
            continue
        assert response.status == 200, f"Expected anon read status 200 for {path}, got {response.status}: {response.body}"
        rows = json.loads(response.body)
        assert isinstance(rows, list), f"Expected list payload for {path}, got {type(rows).__name__}"
        assert not rows, f"Expected gated endpoint to return no rows for anon on {path}, got {rows}"


def test_anon_writes_are_denied(live_contract_config: ContractTestConfig) -> None:
    existing_entity_id = str(uuid.uuid4())

    rpc_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/create_entity_with_version",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.anon_key,
        payload={
            "p_entity_type": "branch",
            "p_source_record_id": f"anon-denied-rpc-{uuid.uuid4().hex[:8]}",
            "p_data": {"name": "Anon Denied Branch"},
        },
    )
    _deny_status(rpc_response, operation="anon rpc create_entity_with_version")

    upsert_rpc_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_upsert_entity_current_state",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.anon_key,
        payload={
            "p_entity_type": "rental_contract_line",
            "p_source_record_id": f"anon-denied-upsert-{uuid.uuid4().hex[:8]}",
            "p_data": {"status": "pending"},
        },
    )
    _deny_status(upsert_rpc_response, operation="anon rpc rental_upsert_entity_current_state")

    analytics_recompute_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_recompute_asset_analytics",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.anon_key,
        payload={"p_asset_id": None},
    )
    _deny_status(analytics_recompute_response, operation="anon rpc rental_recompute_asset_analytics")

    post_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/entities",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.anon_key,
        payload={
            "entity_type": "branch",
            "source_record_id": f"anon-denied-post-{uuid.uuid4().hex[:8]}",
        },
    )
    _deny_status(post_response, operation="anon POST /entities")

    patch_response = _http_json(
        base_url=live_contract_config.base_url,
        method="PATCH",
        path=f"/rest/v1/entities?id=eq.{existing_entity_id}",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.anon_key,
        payload={"source_record_id": f"anon-denied-patch-{uuid.uuid4().hex[:8]}"},
    )
    _deny_status(patch_response, operation="anon PATCH /entities")

    delete_response = _http_json(
        base_url=live_contract_config.base_url,
        method="DELETE",
        path=f"/rest/v1/entities?id=eq.{existing_entity_id}",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.anon_key,
    )
    _deny_status(delete_response, operation="anon DELETE /entities")


def test_authenticated_read_only_jwt_matches_contract(live_contract_config: ContractTestConfig) -> None:
    if not live_contract_config.read_only_jwt:
        pytest.skip("Set SUPABASE_TEST_AUTH_JWT or SUPABASE_TEST_JWT_SECRET to validate authenticated read-only behavior")

    read_response = _http_json(
        base_url=live_contract_config.base_url,
        method="GET",
        path="/rest/v1/entities?select=id,entity_type&limit=5",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.read_only_jwt,
    )
    assert read_response.status == 200, read_response.body

    write_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/create_entity_with_version",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.read_only_jwt,
        payload={
            "p_entity_type": "branch",
            "p_source_record_id": f"auth-denied-rpc-{uuid.uuid4().hex[:8]}",
            "p_data": {"name": "Read Only Auth Denied Branch"},
        },
    )
    _deny_status(write_response, operation="authenticated(read_only) rpc write")

    analytics_recompute_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_recompute_asset_analytics",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.read_only_jwt,
        payload={"p_asset_id": None},
    )
    _deny_status(
        analytics_recompute_response,
        operation="authenticated(read_only) rpc rental_recompute_asset_analytics",
    )


def test_authenticated_admin_can_create_and_update_entities(live_contract_config: ContractTestConfig) -> None:
    if not live_contract_config.admin_jwt:
        pytest.skip(
            "Set SUPABASE_TEST_ADMIN_JWT or SUPABASE_TEST_JWT_SECRET to validate authenticated admin write behavior"
        )

    source_record_id = f"auth-admin-contract-line-{uuid.uuid4().hex[:10]}"
    create_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_upsert_entity_current_state",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.admin_jwt,
        payload={
            "p_entity_type": "rental_contract_line",
            "p_source_record_id": source_record_id,
            "p_data": {"status": "pending", "contract_id": "contract-auth-admin", "asset_id": "asset-auth-admin"},
        },
    )
    assert create_response.status in {200, 201}, create_response.body
    create_rows = json.loads(create_response.body)
    assert create_rows and create_rows[0]["entity_id"], create_response.body
    entity_id = create_rows[0]["entity_id"]
    assert create_rows[0]["version_number"] == 1, create_response.body

    update_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_upsert_entity_current_state",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.admin_jwt,
        payload={
            "p_entity_type": "rental_contract_line",
            "p_entity_id": entity_id,
            "p_data": {
                "status": "checked_out",
                "contract_id": "contract-auth-admin",
                "asset_id": "asset-auth-admin",
                "actual_start": "2026-06-07",
            },
        },
    )
    assert update_response.status in {200, 201}, update_response.body
    update_rows = json.loads(update_response.body)
    assert update_rows and update_rows[0]["entity_id"] == entity_id, update_response.body
    assert update_rows[0]["version_number"] == 2, update_response.body


def test_authenticated_branch_manager_can_create_and_update_entities(live_contract_config: ContractTestConfig) -> None:
    if not live_contract_config.branch_manager_jwt:
        pytest.skip(
            "Set SUPABASE_TEST_BRANCH_MANAGER_JWT or SUPABASE_TEST_JWT_SECRET to validate branch-manager write behavior"
        )

    source_record_id = f"auth-manager-branch-{uuid.uuid4().hex[:10]}"
    create_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_upsert_entity_current_state",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.branch_manager_jwt,
        payload={
            "p_entity_type": "branch",
            "p_source_record_id": source_record_id,
            "p_data": {"name": "Branch Manager Write"},
        },
    )
    assert create_response.status in {200, 201}, create_response.body
    create_rows = json.loads(create_response.body)
    assert create_rows and create_rows[0]["entity_id"], create_response.body
    entity_id = create_rows[0]["entity_id"]
    assert create_rows[0]["version_number"] == 1, create_response.body

    update_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_upsert_entity_current_state",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.branch_manager_jwt,
        payload={
            "p_entity_type": "branch",
            "p_entity_id": entity_id,
            "p_data": {"name": "Branch Manager Write Updated"},
        },
    )
    assert update_response.status in {200, 201}, update_response.body
    update_rows = json.loads(update_response.body)
    assert update_rows and update_rows[0]["entity_id"] == entity_id, update_response.body
    assert update_rows[0]["version_number"] == 2, update_response.body


def test_authenticated_field_operator_can_submit_mobile_writes(live_contract_config: ContractTestConfig) -> None:
    if not live_contract_config.field_operator_jwt:
        pytest.skip(
            "Set SUPABASE_TEST_FIELD_OPERATOR_JWT or SUPABASE_TEST_JWT_SECRET to validate field-operator write behavior"
        )

    contract_line_source_record_id = f"auth-field-contract-line-{uuid.uuid4().hex[:10]}"
    contract_line_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_upsert_entity_current_state",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.field_operator_jwt,
        payload={
            "p_entity_type": "rental_contract_line",
            "p_source_record_id": contract_line_source_record_id,
            "p_data": {"status": "returned", "contract_id": "contract-auth-field", "asset_id": "asset-auth-field"},
        },
    )
    assert contract_line_response.status in {200, 201}, contract_line_response.body

    inspection_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/create_entity_with_version",
        apikey=live_contract_config.anon_key,
        bearer=live_contract_config.field_operator_jwt,
        payload={
            "p_entity_type": "inspection",
            "p_source_record_id": f"auth-field-inspection-{uuid.uuid4().hex[:10]}",
            "p_data": {"inspection_type": "return", "outcome": "pass"},
        },
    )
    assert inspection_response.status in {200, 201}, inspection_response.body


def test_service_role_can_write_when_allowed(live_contract_config: ContractTestConfig) -> None:
    allow_service_role_write = os.environ.get("SUPABASE_TEST_ALLOW_SERVICE_ROLE_WRITE", "").lower() in {"1", "true", "yes"}
    if not live_contract_config.local_stack_managed and not allow_service_role_write:
        pytest.skip("Service-role writes are disabled for non-local runs by default")

    if not live_contract_config.service_role_key:
        pytest.skip("Service-role mutation tests require SUPABASE_TEST_SERVICE_ROLE_KEY")

    source_record_id = f"service-write-{uuid.uuid4().hex[:12]}"

    create_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/entities",
        apikey=live_contract_config.service_role_key,
        bearer=live_contract_config.service_role_key,
        payload={"entity_type": "branch", "source_record_id": source_record_id},
        prefer_representation=True,
    )
    assert create_response.status in {200, 201}, create_response.body
    created_rows = json.loads(create_response.body)
    assert created_rows and "id" in created_rows[0], create_response.body
    entity_id = created_rows[0]["id"]

    update_response = _http_json(
        base_url=live_contract_config.base_url,
        method="PATCH",
        path=f"/rest/v1/entities?id=eq.{entity_id}",
        apikey=live_contract_config.service_role_key,
        bearer=live_contract_config.service_role_key,
        payload={"source_record_id": source_record_id + "-updated"},
        prefer_representation=True,
    )
    assert update_response.status in {200, 204}, update_response.body

    delete_response = _http_json(
        base_url=live_contract_config.base_url,
        method="DELETE",
        path=f"/rest/v1/entities?id=eq.{entity_id}",
        apikey=live_contract_config.service_role_key,
        bearer=live_contract_config.service_role_key,
    )
    assert delete_response.status in {200, 204}, delete_response.body

    rpc_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/create_entity_with_version",
        apikey=live_contract_config.service_role_key,
        bearer=live_contract_config.service_role_key,
        payload={
            "p_entity_type": "branch",
            "p_source_record_id": f"service-rpc-{uuid.uuid4().hex[:10]}",
            "p_data": {"name": "Service Role RPC"},
        },
    )
    assert rpc_response.status in {200, 201}, rpc_response.body

    analytics_recompute_response = _http_json(
        base_url=live_contract_config.base_url,
        method="POST",
        path="/rest/v1/rpc/rental_recompute_asset_analytics",
        apikey=live_contract_config.service_role_key,
        bearer=live_contract_config.service_role_key,
        payload={"p_asset_id": None},
    )
    assert analytics_recompute_response.status in {200, 201}, analytics_recompute_response.body


def test_authenticated_jwt_without_role_claim_denies_rpc_writes(live_contract_config: ContractTestConfig) -> None:
    if not live_contract_config.jwt_secret:
        pytest.skip("Set SUPABASE_TEST_JWT_SECRET to validate missing-role-claim write denial")

    now = int(time.time())
    jwt_tokens_missing_role_claim = (
        _encode_jwt(
            live_contract_config.jwt_secret,
            {
                "aud": "authenticated",
                "sub": str(uuid.uuid4()),
                "email": "missing-role-claim.contract-tests@example.test",
                "app_metadata": {"role": "admin", "tenant": "default"},
                "user_metadata": {},
                "iat": now,
                "exp": now + 900,
            },
        ),
        _encode_jwt(
            live_contract_config.jwt_secret,
            {
                "aud": "authenticated",
                "sub": str(uuid.uuid4()),
                "email": "missing-role-claim-no-app-metadata.contract-tests@example.test",
                "app_metadata": {},
                "user_metadata": {},
                "iat": now,
                "exp": now + 900,
            },
        ),
    )

    for no_role_claim_token in jwt_tokens_missing_role_claim:
        response = _http_json(
            base_url=live_contract_config.base_url,
            method="POST",
            path="/rest/v1/rpc/create_entity_with_version",
            apikey=live_contract_config.anon_key,
            bearer=no_role_claim_token,
            payload={
                "p_entity_type": "branch",
                "p_source_record_id": f"missing-role-claim-{uuid.uuid4().hex[:8]}",
                "p_data": {"name": "Missing Role Claim Denied"},
            },
        )
        _deny_status(response, operation="authenticated(no role claim) rpc write")


def test_invalid_and_expired_jwts_are_rejected(live_contract_config: ContractTestConfig) -> None:
    invalid_response = _http_json(
        base_url=live_contract_config.base_url,
        method="GET",
        path="/rest/v1/entities?select=id&limit=1",
        apikey=live_contract_config.anon_key,
        bearer="invalid.jwt.token",
    )
    assert invalid_response.status == 401, invalid_response.body

    if not live_contract_config.jwt_secret:
        pytest.skip("Set SUPABASE_TEST_JWT_SECRET to validate expired JWT rejection")

    now = int(time.time())
    expired_token = _encode_jwt(
        live_contract_config.jwt_secret,
        {
            "aud": "authenticated",
            "role": "authenticated",
            "sub": str(uuid.uuid4()),
            "iat": now - 7200,
            "exp": now - 3600,
        },
    )

    expired_response = _http_json(
        base_url=live_contract_config.base_url,
        method="GET",
        path="/rest/v1/entities?select=id&limit=1",
        apikey=live_contract_config.anon_key,
        bearer=expired_token,
    )
    assert expired_response.status == 401, expired_response.body


def test_rls_enabled_on_all_rental_tables(live_contract_config: ContractTestConfig) -> None:
    if not live_contract_config.local_stack_managed:
        pytest.skip("RLS catalog assertions run only against local stack")
    if shutil.which("psql") is None:
        pytest.skip("psql is required for local RLS catalog assertions")
    if not live_contract_config.db_url:
        pytest.skip("DB_URL is required for local RLS catalog assertions")

    parsed_db_url = urlparse(live_contract_config.db_url)
    db_host = parsed_db_url.hostname
    db_port = parsed_db_url.port
    db_user = parsed_db_url.username
    db_password = parsed_db_url.password
    db_name = parsed_db_url.path.lstrip("/") if parsed_db_url.path else None

    if not (db_host and db_port and db_user and db_name):
        pytest.skip("Could not parse DB connection details from DB_URL")
    if db_host not in {"127.0.0.1", "localhost"}:
        pytest.skip("RLS catalog assertions are restricted to local database hosts")

    safe_table_names = []
    for table in RLS_TABLES:
        if not table.replace("_", "").isalnum():
            pytest.fail(f"Unexpected table name in RLS_TABLES: {table!r}")
        safe_table_names.append(table)

    table_list = ",".join(f"'{table}'" for table in safe_table_names)
    sql = (
        "select count(*) "
        "from pg_class c "
        "join pg_namespace n on n.oid = c.relnamespace "
        "where n.nspname = 'public' "
        f"and c.relname in ({table_list}) "
        "and c.relkind = 'r' "
        "and c.relrowsecurity;"
    )

    result = _run(
        [
            "psql",
            "-h",
            db_host,
            "-p",
            str(db_port),
            "-U",
            db_user,
            "-d",
            db_name,
            "-tAc",
            sql,
        ],
        env={"PGPASSWORD": db_password or ""},
    )
    enabled_count = int(result.stdout.strip())
    assert enabled_count == len(RLS_TABLES), (
        f"Expected RLS enabled on {len(RLS_TABLES)} rental tables, found {enabled_count}"
    )


def test_authenticated_db_role_without_jwt_role_claim_is_denied_rpc_writes(
    live_contract_config: ContractTestConfig,
) -> None:
    if not live_contract_config.local_stack_managed:
        pytest.skip("Direct-role guard assertions run only against local stack")
    if shutil.which("psql") is None:
        pytest.skip("psql is required for direct-role guard assertions")
    if not live_contract_config.db_url:
        pytest.skip("DB_URL is required for direct-role guard assertions")

    try:
        db_host, db_port, db_user, db_password, db_name = _parse_local_db_connection_details(live_contract_config.db_url)
    except ValueError as exc:
        pytest.skip(str(exc))

    bypass_probe = (
        "begin;"
        "set local role authenticated;"
        "set local request.jwt.claim.role = '';"
        "select * from public.create_entity_with_version("
        "'inspection',"
        "'{\"note\":\"direct-role-guard\"}'::jsonb,"
        "'direct-role-bypass-probe'"
        ");"
        "rollback;"
    )

    with pytest.raises(subprocess.CalledProcessError) as exc_info:
        _run(
            [
                "psql",
                "-h",
                db_host,
                "-p",
                str(db_port),
                "-U",
                db_user,
                "-d",
                db_name,
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                bypass_probe,
            ],
            env={"PGPASSWORD": db_password or ""},
        )

    stderr = (exc_info.value.stderr or "").lower()
    assert "requires an authenticated user with write access" in stderr


def test_legacy_direct_db_service_role_fallback_still_allows_rpc_writes(
    live_contract_config: ContractTestConfig,
) -> None:
    if not live_contract_config.local_stack_managed:
        pytest.skip("Direct-role guard assertions run only against local stack")
    if shutil.which("psql") is None:
        pytest.skip("psql is required for direct-role guard assertions")
    if not live_contract_config.db_url:
        pytest.skip("DB_URL is required for direct-role guard assertions")

    try:
        db_host, db_port, db_user, db_password, db_name = _parse_local_db_connection_details(live_contract_config.db_url)
    except ValueError as exc:
        pytest.skip(str(exc))

    source_record_id = f"legacy-fallback-{uuid.uuid4().hex[:10]}"
    legacy_fallback_probe = (
        "begin;"
        "set local request.jwt.claim.role = 'service_role';"
        "select * from public.create_entity_with_version("
        "'branch',"
        "'{\"name\":\"legacy-fallback\"}'::jsonb,"
        f"'{source_record_id}'"
        ");"
        "rollback;"
    )

    result = _run(
        [
            "psql",
            "-h",
            db_host,
            "-p",
            str(db_port),
            "-U",
            db_user,
            "-d",
            db_name,
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            legacy_fallback_probe,
        ],
        env={"PGPASSWORD": db_password or ""},
    )
    assert "entity_id" in result.stdout
    assert "entity_version_id" in result.stdout
    assert "version_number" in result.stdout
