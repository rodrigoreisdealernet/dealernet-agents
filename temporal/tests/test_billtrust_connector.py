from __future__ import annotations

from urllib import error

from temporal.src.integrations.billtrust import (
    BilltrustAuthError,
    run_billtrust_healthcheck,
    validate_billtrust_config,
)
from temporal.src.integrations.registry import build_connector_registry


def _valid_config() -> dict[str, object]:
    return {
        "api_base_url": "https://api.billtrust.example",
        "client_id_secret_ref": "secret://integrations/billtrust/client_id",
        "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        "enabled_scopes": ["invoices", "payments", "ar_aging"],
        "invoice_mapping_profile": {"invoice_id_field": "invoiceNumber"},
        "payment_mapping_profile": {"payment_id_field": "paymentId"},
        "ar_aging_profile": {"aging_buckets": [30, 60, 90]},
        "tenant_mapping": {"customer_id_field": "customerId"},
        "healthcheck_path": "/v1/health",
        "healthcheck_timeout_seconds": 5,
    }


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


def test_validate_billtrust_config_passes_for_valid_config() -> None:
    errors = validate_billtrust_config(_valid_config())
    assert errors == []


def test_billtrust_provider_is_registered_in_default_registry() -> None:
    registry = build_connector_registry()
    provider = registry["billtrust"]
    assert provider.key == "billtrust"
    assert provider.enabled_scopes == ("invoices", "payments", "ar_aging")


def test_validate_billtrust_config_rejects_missing_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    errors = validate_billtrust_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_billtrust_config_rejects_http_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://api.billtrust.example"
    errors = validate_billtrust_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_billtrust_config_rejects_raw_client_id_secret() -> None:
    config = _valid_config()
    config["client_id_secret_ref"] = "raw-client-id-value"
    errors = validate_billtrust_config(config)
    assert "client_id_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_billtrust_config_rejects_raw_client_secret() -> None:
    config = _valid_config()
    config["client_secret_secret_ref"] = "raw-client-secret-value"
    errors = validate_billtrust_config(config)
    assert "client_secret_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_billtrust_config_rejects_unknown_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["invoices", "unknown_scope"]
    errors = validate_billtrust_config(config)
    assert "enabled_scopes contains unsupported scope(s): unknown_scope" in errors


def test_validate_billtrust_config_rejects_empty_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = []
    errors = validate_billtrust_config(config)
    assert "enabled_scopes must include at least one scope" in errors


def test_validate_billtrust_config_rejects_missing_profile_for_active_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["invoices"]
    config["invoice_mapping_profile"] = {}
    errors = validate_billtrust_config(config)
    assert "invoice_mapping_profile must be a non-empty object" in errors


def test_validate_billtrust_config_only_checks_profiles_for_enabled_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["invoices"]
    # Profiles for inactive scopes may be empty; should not raise errors
    config["payment_mapping_profile"] = {}
    config["ar_aging_profile"] = {}
    errors = validate_billtrust_config(config)
    assert errors == []


def test_validate_billtrust_config_rejects_missing_tenant_mapping() -> None:
    config = _valid_config()
    config["tenant_mapping"] = {}
    errors = validate_billtrust_config(config)
    assert "tenant_mapping must be a non-empty object" in errors


def test_validate_billtrust_config_rejects_multiple_errors() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://insecure.example"
    config["client_id_secret_ref"] = "raw-id"
    config["client_secret_secret_ref"] = "raw-secret"
    config["enabled_scopes"] = ["invoices", "bad_scope"]
    config["invoice_mapping_profile"] = {}
    config["tenant_mapping"] = {}
    errors = validate_billtrust_config(config)
    assert "api_base_url must be a valid https URL" in errors
    assert "client_id_secret_ref must be a secret reference starting with secret://" in errors
    assert "client_secret_secret_ref must be a secret reference starting with secret://" in errors
    assert "enabled_scopes contains unsupported scope(s): bad_scope" in errors
    assert "invoice_mapping_profile must be a non-empty object" in errors
    assert "tenant_mapping must be a non-empty object" in errors


# ---------------------------------------------------------------------------
# Healthcheck classification
# ---------------------------------------------------------------------------


def test_healthcheck_passes_for_ok_probe() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.message == "Billtrust connectivity verified"


def test_healthcheck_classifies_configuration_failure_when_config_invalid() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://insecure.example"
    result = run_billtrust_healthcheck(
        config,
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration validation failed"


def test_healthcheck_classifies_auth_failure_when_secret_resolution_fails() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: (_ for _ in ()).throw(BilltrustAuthError("missing secret")),
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth secret resolution failed"
    assert result.details == {"reason": "secret_resolution_failed"}


def test_healthcheck_classifies_connectivity_failure_on_network_error() -> None:
    raw_error = "https://api.billtrust.example host billtrust.internal connection refused"
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.URLError(raw_error)),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"
    assert result.details == {"reason": "transport_error"}
    assert raw_error not in str(result.to_dict())


def test_healthcheck_classifies_auth_failure_on_401_http_error() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(
            error.HTTPError(None, 401, "Unauthorized", {}, None)
        ),
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth check failed"


def test_healthcheck_classifies_auth_failure_on_403() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 403,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth check failed"


def test_healthcheck_classifies_rate_limit_on_429_http_error() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(
            error.HTTPError(None, 429, "Too Many Requests", {}, None)
        ),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Rate limit reached"


def test_healthcheck_classifies_rate_limit_on_429_status_code() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 429,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Rate limit reached"


def test_healthcheck_classifies_configuration_failure_on_404() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 404,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Target account/tenant resolution failed"


def test_healthcheck_classifies_target_resolution_failure_on_422_http_error() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(
            error.HTTPError(None, 422, "Unprocessable Entity", {}, None)
        ),
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Target account/tenant resolution failed"


def test_healthcheck_classifies_connectivity_failure_on_500() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 500,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


def test_healthcheck_classifies_connectivity_failure_on_503_http_error() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(
            error.HTTPError(None, 503, "Service Unavailable", {}, None)
        ),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


# ---------------------------------------------------------------------------
# Duplicate-event / idempotency guard (deduplication)
# ---------------------------------------------------------------------------


def test_healthcheck_includes_status_code_in_details_on_success() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.details.get("status_code") == 200


def test_healthcheck_includes_status_code_in_details_on_auth_status() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 401,
    )
    assert result.details.get("status_code") == 401


def test_healthcheck_sanitizes_default_secret_resolver_details() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        health_probe=lambda **_: 200,
    )
    rendered = str(result.to_dict())
    assert result.details == {"reason": "secret_resolution_failed"}
    assert "secret://" not in rendered
    assert "integrations/billtrust/client_id" not in rendered


def test_to_dict_returns_serializable_structure() -> None:
    result = run_billtrust_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    d = result.to_dict()
    assert d["status"] == "ok"
    assert d["classification"] == "ok"
    assert isinstance(d["details"], dict)
