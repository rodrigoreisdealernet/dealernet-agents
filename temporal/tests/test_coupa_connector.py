from __future__ import annotations

from urllib import error

from temporal.src.integrations.coupa import (
    CoupaAuthError,
    run_coupa_healthcheck,
    validate_coupa_config,
)
from temporal.src.integrations.registry import build_connector_registry


def _valid_config() -> dict[str, object]:
    return {
        "api_base_url": "https://tenant.coupahost.com",
        "tenant_slug": "wynne-rental",
        "client_id_secret_ref": "secret://integrations/coupa/client_id",
        "client_secret_secret_ref": "secret://integrations/coupa/client_secret",
        "enabled_scopes": ["requisitions", "purchase_orders", "suppliers", "invoices"],
        "requisition_mapping_profile": {"requisition_id_field": "id"},
        "purchase_order_mapping_profile": {"purchase_order_id_field": "id"},
        "supplier_mapping_profile": {"supplier_id_field": "id"},
        "invoice_mapping_profile": {"invoice_id_field": "id"},
        "healthcheck_path": "/api/health",
        "healthcheck_timeout_seconds": 5,
    }


def test_validate_coupa_config_passes_for_valid_config() -> None:
    errors = validate_coupa_config(_valid_config())
    assert errors == []


def test_coupa_provider_is_registered_in_default_registry() -> None:
    registry = build_connector_registry()
    provider = registry["coupa"]
    assert provider.key == "coupa"
    assert provider.enabled_scopes == ("requisitions", "purchase_orders", "suppliers", "invoices")


def test_validate_coupa_config_rejects_missing_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    errors = validate_coupa_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_coupa_config_rejects_missing_tenant_slug() -> None:
    config = _valid_config()
    config["tenant_slug"] = ""
    errors = validate_coupa_config(config)
    assert "tenant_slug must be a non-empty string" in errors


def test_validate_coupa_config_rejects_raw_client_id() -> None:
    config = _valid_config()
    config["client_id_secret_ref"] = "raw-client-id"
    errors = validate_coupa_config(config)
    assert "client_id_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_coupa_config_rejects_raw_client_secret() -> None:
    config = _valid_config()
    config["client_secret_secret_ref"] = "raw-client-secret"
    errors = validate_coupa_config(config)
    assert "client_secret_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_coupa_config_rejects_empty_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = []
    errors = validate_coupa_config(config)
    assert "enabled_scopes must include at least one scope" in errors


def test_validate_coupa_config_rejects_unknown_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["requisitions", "bad_scope"]
    errors = validate_coupa_config(config)
    assert "enabled_scopes contains unsupported scope(s): bad_scope" in errors


def test_validate_coupa_config_requires_profiles_for_enabled_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["requisitions"]
    config["requisition_mapping_profile"] = {}
    errors = validate_coupa_config(config)
    assert "requisition_mapping_profile must be a non-empty object" in errors


def test_validate_coupa_config_only_checks_enabled_scope_profiles() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["requisitions"]
    config["purchase_order_mapping_profile"] = {}
    config["supplier_mapping_profile"] = {}
    config["invoice_mapping_profile"] = {}
    errors = validate_coupa_config(config)
    assert errors == []


def test_healthcheck_passes_for_ok_probe() -> None:
    result = run_coupa_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.message == "Coupa connectivity verified"


def test_healthcheck_classifies_configuration_failure_when_config_invalid() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    result = run_coupa_healthcheck(
        config,
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration validation failed"


def test_healthcheck_classifies_auth_failure_when_secret_resolution_fails() -> None:
    result = run_coupa_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: (_ for _ in ()).throw(CoupaAuthError("missing secret")),
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth secret resolution failed"
    assert result.details == {"reason": "secret_resolution_failed"}


def test_healthcheck_classifies_connectivity_failure_on_network_error() -> None:
    result = run_coupa_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.URLError("dial timeout")),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"
    assert result.details == {"reason": "transport_error"}


def test_healthcheck_classifies_auth_on_401() -> None:
    result = run_coupa_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 401,
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_configuration_on_404() -> None:
    result = run_coupa_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 404,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Tenant or endpoint not found"


def test_healthcheck_classifies_connectivity_on_500() -> None:
    result = run_coupa_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 500,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
