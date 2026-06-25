from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib import error

from temporal.src.integrations.powerbi import (
    FAILURE_CLASS_AUTH,
    FAILURE_CLASS_CONFIG,
    FAILURE_CLASS_INVALID_PAYLOAD,
    FAILURE_CLASS_RATE_LIMIT,
    FAILURE_CLASS_TRANSPORT,
    FAILURE_CLASS_UNKNOWN,
    DatasetRefreshState,
    ExportRunContext,
    PowerBIAuthError,
    build_export_run_outcome,
    check_dataset_refresh_staleness,
    classify_powerbi_failure,
    is_recoverable_failure,
    run_powerbi_healthcheck,
    validate_powerbi_config,
)


def _valid_config() -> dict[str, object]:
    return {
        "api_base_url": "https://api.powerbi.com",
        "tenant_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "client_id_secret_ref": "secret://integrations/powerbi/client_id",
        "client_secret_secret_ref": "secret://integrations/powerbi/client_secret",
        "enabled_scopes": ["dataset_push", "dataset_refresh"],
        "dataset_push_profile": {"table_name": "RentalFacts", "schema_version": "1.0"},
        "dataset_refresh_profile": {"refresh_type": "full"},
        "workspace_mapping": {"dia_tenant_id_field": "tenantId"},
        "healthcheck_path": "/v1.0/myorg/groups",
        "healthcheck_timeout_seconds": 5,
        "stale_refresh_threshold_minutes": 120,
    }


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


def test_validate_powerbi_config_passes_for_valid_config() -> None:
    errors = validate_powerbi_config(_valid_config())
    assert errors == []


def test_validate_powerbi_config_rejects_missing_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    errors = validate_powerbi_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_powerbi_config_rejects_http_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://api.powerbi.com"
    errors = validate_powerbi_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_powerbi_config_rejects_missing_tenant_id() -> None:
    config = _valid_config()
    config["tenant_id"] = ""
    errors = validate_powerbi_config(config)
    assert "tenant_id must be a non-empty Azure AD tenant identifier" in errors


def test_validate_powerbi_config_rejects_raw_client_id_secret() -> None:
    config = _valid_config()
    config["client_id_secret_ref"] = "raw-client-id-value"
    errors = validate_powerbi_config(config)
    assert "client_id_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_powerbi_config_rejects_raw_client_secret() -> None:
    config = _valid_config()
    config["client_secret_secret_ref"] = "raw-client-secret-value"
    errors = validate_powerbi_config(config)
    assert "client_secret_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_powerbi_config_rejects_unknown_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["dataset_push", "unknown_scope"]
    errors = validate_powerbi_config(config)
    assert "enabled_scopes contains unsupported scope(s): unknown_scope" in errors


def test_validate_powerbi_config_rejects_empty_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = []
    errors = validate_powerbi_config(config)
    assert "enabled_scopes must include at least one scope" in errors


def test_validate_powerbi_config_rejects_missing_profile_for_active_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["dataset_push"]
    config["dataset_push_profile"] = {}
    errors = validate_powerbi_config(config)
    assert "dataset_push_profile must be a non-empty object" in errors


def test_validate_powerbi_config_only_checks_profiles_for_enabled_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["dataset_push"]
    # Inactive scope profile may be empty; should not raise errors
    config["dataset_refresh_profile"] = {}
    errors = validate_powerbi_config(config)
    assert errors == []


def test_validate_powerbi_config_rejects_missing_workspace_mapping() -> None:
    config = _valid_config()
    config["workspace_mapping"] = {}
    errors = validate_powerbi_config(config)
    assert "workspace_mapping must be a non-empty object" in errors


def test_validate_powerbi_config_rejects_non_positive_stale_threshold() -> None:
    config = _valid_config()
    config["stale_refresh_threshold_minutes"] = 0
    errors = validate_powerbi_config(config)
    assert "stale_refresh_threshold_minutes must be a positive integer" in errors


def test_validate_powerbi_config_rejects_non_integer_stale_threshold() -> None:
    config = _valid_config()
    config["stale_refresh_threshold_minutes"] = "not-a-number"
    errors = validate_powerbi_config(config)
    assert "stale_refresh_threshold_minutes must be a positive integer" in errors


def test_validate_powerbi_config_allows_omitted_stale_threshold() -> None:
    config = _valid_config()
    del config["stale_refresh_threshold_minutes"]
    errors = validate_powerbi_config(config)
    assert errors == []


# ---------------------------------------------------------------------------
# Retry classification
# ---------------------------------------------------------------------------


def test_classify_auth_failures() -> None:
    assert classify_powerbi_failure(401) == FAILURE_CLASS_AUTH
    assert classify_powerbi_failure(403) == FAILURE_CLASS_AUTH


def test_classify_rate_limit() -> None:
    assert classify_powerbi_failure(429) == FAILURE_CLASS_RATE_LIMIT


def test_classify_transport_failures() -> None:
    for status in [500, 502, 503, 504]:
        assert classify_powerbi_failure(status) == FAILURE_CLASS_TRANSPORT, status


def test_classify_invalid_payload_failures() -> None:
    assert classify_powerbi_failure(400) == FAILURE_CLASS_INVALID_PAYLOAD
    assert classify_powerbi_failure(413) == FAILURE_CLASS_INVALID_PAYLOAD
    assert classify_powerbi_failure(422) == FAILURE_CLASS_INVALID_PAYLOAD


def test_classify_config_failures() -> None:
    assert classify_powerbi_failure(404) == FAILURE_CLASS_CONFIG
    assert classify_powerbi_failure(409) == FAILURE_CLASS_CONFIG
    assert classify_powerbi_failure(410) == FAILURE_CLASS_CONFIG


def test_classify_generic_5xx_as_transport() -> None:
    assert classify_powerbi_failure(599) == FAILURE_CLASS_TRANSPORT


def test_classify_generic_4xx_as_invalid_payload() -> None:
    assert classify_powerbi_failure(423) == FAILURE_CLASS_INVALID_PAYLOAD


def test_classify_unknown_for_unexpected_codes() -> None:
    assert classify_powerbi_failure(200) == FAILURE_CLASS_UNKNOWN
    assert classify_powerbi_failure(301) == FAILURE_CLASS_UNKNOWN


def test_recoverable_failures() -> None:
    assert is_recoverable_failure(FAILURE_CLASS_RATE_LIMIT) is True
    assert is_recoverable_failure(FAILURE_CLASS_TRANSPORT) is True


def test_non_recoverable_failures() -> None:
    assert is_recoverable_failure(FAILURE_CLASS_AUTH) is False
    assert is_recoverable_failure(FAILURE_CLASS_CONFIG) is False
    assert is_recoverable_failure(FAILURE_CLASS_INVALID_PAYLOAD) is False
    assert is_recoverable_failure(FAILURE_CLASS_UNKNOWN) is False


# ---------------------------------------------------------------------------
# Healthcheck
# ---------------------------------------------------------------------------


def _noop_secret_resolver(ref: str) -> str:
    return f"resolved-{ref}"


def _make_http_probe(status_code: int):
    def probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
        return status_code
    return probe


def _make_http_error_probe(status_code: int):
    def probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
        raise error.HTTPError(url=api_base_url, code=status_code, msg="error", hdrs=None, fp=None)
    return probe


def _make_url_error_probe():
    def probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
        raise error.URLError("network unreachable")
    return probe


def test_healthcheck_ok_on_200() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_probe(200),
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.details["status_code"] == 200


def test_healthcheck_fails_on_config_validation_error() -> None:
    config = _valid_config()
    config["tenant_id"] = ""
    result = run_powerbi_healthcheck(config)
    assert result.status == "failed"
    assert result.classification == "configuration"


def test_healthcheck_fails_on_secret_resolution_error() -> None:
    def bad_resolver(ref: str) -> str:
        raise PowerBIAuthError("vault unavailable")

    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=bad_resolver,
        health_probe=_make_http_probe(200),
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.details == {"reason": "secret_resolution_failed"}


def test_healthcheck_fails_on_auth_http_error_401() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_error_probe(401),
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.details["status_code"] == 401


def test_healthcheck_fails_on_auth_http_error_403() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_error_probe(403),
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_fails_on_rate_limit_429() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_error_probe(429),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.details["status_code"] == 429


def test_healthcheck_fails_on_not_found_404() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_error_probe(404),
    )
    assert result.status == "failed"
    assert result.classification == "configuration"


def test_healthcheck_fails_on_server_error_503() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_error_probe(503),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"


def test_healthcheck_fails_on_url_error() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_url_error_probe(),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.details == {"reason": "transport_error"}


def test_healthcheck_fails_on_status_code_401() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_probe(401),
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_to_dict_is_serializable() -> None:
    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=_make_http_probe(200),
    )
    d = result.to_dict()
    assert d["status"] == "ok"
    assert isinstance(d["details"], dict)


def test_healthcheck_result_never_contains_secret_ref() -> None:
    """Regression: connector results must never expose secret:// ref paths."""
    def leaky_resolver(ref: str) -> str:
        raise PowerBIAuthError(f"cannot resolve {ref}")

    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=leaky_resolver,
        health_probe=_make_http_probe(200),
    )
    rendered = str(result.to_dict())
    assert "secret://" not in rendered
    assert result.details == {"reason": "secret_resolution_failed"}


def test_healthcheck_result_never_contains_raw_transport_exception() -> None:
    """Regression: connector results must never expose raw transport exception text."""
    raw_error = "Connection refused: internal-proxy.corp.example.com:8443"

    def leaky_probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
        raise error.URLError(raw_error)

    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=leaky_probe,
    )
    rendered = str(result.to_dict())
    assert raw_error not in rendered
    assert result.details == {"reason": "transport_error"}


def test_healthcheck_auth_probe_error_never_leaks_exception_text() -> None:
    """Regression: an auth error raised during the probe must not surface in details."""
    def auth_probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
        raise PowerBIAuthError("token invalid for tenant secret://integrations/powerbi/tenant_id")

    result = run_powerbi_healthcheck(
        _valid_config(),
        secret_resolver=_noop_secret_resolver,
        health_probe=auth_probe,
    )
    rendered = str(result.to_dict())
    assert "secret://" not in rendered
    assert result.details == {"reason": "auth_check_failed"}


# ---------------------------------------------------------------------------
# Stale refresh detection
# ---------------------------------------------------------------------------

_NOW = datetime(2026, 6, 12, 12, 0, 0, tzinfo=UTC)
_THRESHOLD = 120  # minutes


def _make_state(
    last_refreshed_at: datetime | None,
    refresh_status: str = "Completed",
) -> DatasetRefreshState:
    return DatasetRefreshState(
        tenant_id="tenant-1",
        workspace_id="workspace-abc",
        dataset_id="dataset-xyz",
        last_refreshed_at=last_refreshed_at,
        refresh_status=refresh_status,
    )


def test_stale_check_current_dataset_is_not_stale() -> None:
    refreshed_at = _NOW - timedelta(minutes=60)
    result = check_dataset_refresh_staleness(_make_state(refreshed_at), _THRESHOLD, now=_NOW)
    assert result.is_stale is False
    assert result.is_failed is False
    assert result.failure_class is None


def test_stale_check_old_dataset_is_stale() -> None:
    refreshed_at = _NOW - timedelta(minutes=180)
    result = check_dataset_refresh_staleness(_make_state(refreshed_at), _THRESHOLD, now=_NOW)
    assert result.is_stale is True
    assert result.is_failed is False
    assert result.age_minutes is not None
    assert result.age_minutes > _THRESHOLD


def test_stale_check_never_refreshed_is_stale() -> None:
    result = check_dataset_refresh_staleness(_make_state(None), _THRESHOLD, now=_NOW)
    assert result.is_stale is True
    assert result.age_minutes is None
    assert "never" in result.message.lower()


def test_stale_check_failed_refresh_status() -> None:
    refreshed_at = _NOW - timedelta(minutes=30)
    result = check_dataset_refresh_staleness(
        _make_state(refreshed_at, refresh_status="Failed"), _THRESHOLD, now=_NOW
    )
    assert result.is_failed is True
    assert result.failure_class == FAILURE_CLASS_TRANSPORT
    assert "Failed" in result.message


def test_stale_check_disabled_refresh_status() -> None:
    refreshed_at = _NOW - timedelta(minutes=10)
    result = check_dataset_refresh_staleness(
        _make_state(refreshed_at, refresh_status="Disabled"), _THRESHOLD, now=_NOW
    )
    assert result.is_failed is True


def test_stale_check_calculates_age_minutes() -> None:
    refreshed_at = _NOW - timedelta(minutes=90)
    result = check_dataset_refresh_staleness(_make_state(refreshed_at), _THRESHOLD, now=_NOW)
    assert result.age_minutes is not None
    assert abs(result.age_minutes - 90.0) < 0.1


def test_stale_check_naive_datetime_is_treated_as_utc() -> None:
    # Naive datetime (no tzinfo) should be treated as UTC without raising.
    naive_dt = datetime(2026, 6, 12, 10, 0, 0)  # 2h before _NOW
    result = check_dataset_refresh_staleness(_make_state(naive_dt), _THRESHOLD, now=_NOW)
    assert result.age_minutes is not None
    assert abs(result.age_minutes - 120.0) < 0.1


def test_stale_check_stale_since_populated_when_stale() -> None:
    refreshed_at = _NOW - timedelta(minutes=200)
    result = check_dataset_refresh_staleness(_make_state(refreshed_at), _THRESHOLD, now=_NOW)
    assert result.is_stale is True
    assert result.stale_since is not None


def test_stale_check_stale_since_none_when_current() -> None:
    refreshed_at = _NOW - timedelta(minutes=30)
    result = check_dataset_refresh_staleness(_make_state(refreshed_at), _THRESHOLD, now=_NOW)
    assert result.is_stale is False
    assert result.stale_since is None


# ---------------------------------------------------------------------------
# Export-run telemetry
# ---------------------------------------------------------------------------


def _make_context() -> ExportRunContext:
    return ExportRunContext(
        tenant_id="tenant-1",
        workspace_id="workspace-abc",
        dataset_id="dataset-xyz",
        export_scope="dataset_push",
        source_event_id="run-001",
        correlation_id="corr-abc",
    )


def test_export_outcome_succeeded_on_200() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=200,
        occurred_at=_NOW,
    )
    assert outcome.status == "succeeded"
    assert outcome.failure_class is None
    assert outcome.failure_code is None
    assert outcome.is_recoverable() is False


def test_export_outcome_succeeded_on_no_status() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=None,
        occurred_at=_NOW,
    )
    assert outcome.status == "succeeded"


def test_export_outcome_retrying_on_recoverable_failure_below_max() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=503,
        failure_message="Service unavailable",
        retry_count=1,
        max_retries=3,
        occurred_at=_NOW,
    )
    assert outcome.status == "retrying"
    assert outcome.failure_class == FAILURE_CLASS_TRANSPORT
    assert outcome.is_recoverable() is True


def test_export_outcome_dead_lettered_when_retries_exhausted() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=503,
        retry_count=3,
        max_retries=3,
        occurred_at=_NOW,
    )
    assert outcome.status == "dead_lettered"
    assert outcome.failure_class == FAILURE_CLASS_TRANSPORT


def test_export_outcome_dead_lettered_on_non_recoverable_failure() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=401,
        retry_count=0,
        max_retries=3,
        occurred_at=_NOW,
    )
    assert outcome.status == "dead_lettered"
    assert outcome.failure_class == FAILURE_CLASS_AUTH
    assert outcome.is_recoverable() is False


def test_export_outcome_dead_lettered_on_invalid_payload() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=400,
        retry_count=0,
        max_retries=3,
        occurred_at=_NOW,
    )
    assert outcome.status == "dead_lettered"
    assert outcome.failure_class == FAILURE_CLASS_INVALID_PAYLOAD
    assert outcome.is_recoverable() is False


def test_export_outcome_rate_limit_is_recoverable() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=429,
        retry_count=1,
        max_retries=3,
        occurred_at=_NOW,
    )
    assert outcome.status == "retrying"
    assert outcome.failure_class == FAILURE_CLASS_RATE_LIMIT
    assert outcome.is_recoverable() is True


def test_export_outcome_telemetry_dict_contains_expected_keys() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=200,
        occurred_at=_NOW,
    )
    d = outcome.to_telemetry_dict()
    assert d["tenant_id"] == "tenant-1"
    assert d["workspace_id"] == "workspace-abc"
    assert d["dataset_id"] == "dataset-xyz"
    assert d["export_scope"] == "dataset_push"
    assert d["status"] == "succeeded"
    assert d["failure_class"] is None
    assert "occurred_at" in d


def test_export_outcome_telemetry_dict_includes_failure_context() -> None:
    outcome = build_export_run_outcome(
        _make_context(),
        http_status=429,
        failure_message="Too many requests",
        retry_count=2,
        max_retries=5,
        occurred_at=_NOW,
    )
    d = outcome.to_telemetry_dict()
    assert d["failure_class"] == FAILURE_CLASS_RATE_LIMIT
    assert d["failure_code"] == "429"
    assert d["failure_message"] == "Too many requests"
    assert d["retry_count"] == 2
