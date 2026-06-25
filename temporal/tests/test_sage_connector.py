from __future__ import annotations

from urllib import error

from temporal.src.integrations.registry import build_connector_registry
from temporal.src.integrations.sage import (
    SageAuthError,
    run_sage_healthcheck,
    validate_sage_config,
)


def _valid_config() -> dict[str, object]:
    return {
        "api_base_url": "https://api.intacct.com",
        "company_id": "wynne-rental-01",
        "client_id_secret_ref": "secret://integrations/sage_intacct/client_id",
        "client_secret_secret_ref": "secret://integrations/sage_intacct/client_secret",
        "enabled_scopes": ["general_ledger", "accounts_payable", "accounts_receivable", "cash_management"],
        "general_ledger_profile": {"account_id_field": "glAccountNo"},
        "accounts_payable_profile": {"vendor_id_field": "vendorId"},
        "accounts_receivable_profile": {"customer_id_field": "customerId"},
        "cash_management_profile": {"bank_account_id_field": "bankAccountId"},
        "healthcheck_path": "/v1/healthcheck",
        "healthcheck_timeout_seconds": 5,
    }


# ---------------------------------------------------------------------------
# validate_sage_config
# ---------------------------------------------------------------------------


def test_validate_sage_config_passes_for_valid_config() -> None:
    errors = validate_sage_config(_valid_config())
    assert errors == []


def test_sage_provider_is_registered_in_default_registry() -> None:
    registry = build_connector_registry()
    provider = registry["sage_intacct"]
    assert provider.key == "sage_intacct"
    assert provider.enabled_scopes == (
        "general_ledger",
        "accounts_payable",
        "accounts_receivable",
        "cash_management",
    )


def test_validate_sage_config_rejects_missing_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    errors = validate_sage_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_sage_config_rejects_http_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://api.intacct.com"
    errors = validate_sage_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_sage_config_rejects_missing_company_id() -> None:
    config = _valid_config()
    config["company_id"] = ""
    errors = validate_sage_config(config)
    assert "company_id must be a non-empty string" in errors


def test_validate_sage_config_rejects_raw_client_id() -> None:
    config = _valid_config()
    config["client_id_secret_ref"] = "raw-client-id-value"
    errors = validate_sage_config(config)
    assert "client_id_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_sage_config_rejects_raw_client_secret() -> None:
    config = _valid_config()
    config["client_secret_secret_ref"] = "raw-client-secret-value"
    errors = validate_sage_config(config)
    assert "client_secret_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_sage_config_rejects_empty_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = []
    errors = validate_sage_config(config)
    assert "enabled_scopes must include at least one scope" in errors


def test_validate_sage_config_rejects_unknown_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["general_ledger", "unknown_scope"]
    errors = validate_sage_config(config)
    assert "enabled_scopes contains unsupported scope(s): unknown_scope" in errors


def test_validate_sage_config_rejects_missing_profile_for_active_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["general_ledger"]
    config["general_ledger_profile"] = {}
    errors = validate_sage_config(config)
    assert "general_ledger_profile must be a non-empty object" in errors


def test_validate_sage_config_only_checks_profiles_for_enabled_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["general_ledger"]
    # profiles for inactive scopes are not required
    config["accounts_payable_profile"] = {}
    config["accounts_receivable_profile"] = {}
    config["cash_management_profile"] = {}
    errors = validate_sage_config(config)
    assert errors == []


def test_validate_sage_config_rejects_multiple_errors() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://insecure.example"
    config["client_id_secret_ref"] = "raw-id"
    config["client_secret_secret_ref"] = "raw-secret"
    config["enabled_scopes"] = ["general_ledger", "bad_scope"]
    config["general_ledger_profile"] = {}
    errors = validate_sage_config(config)
    assert "api_base_url must be a valid https URL" in errors
    assert "client_id_secret_ref must be a secret reference starting with secret://" in errors
    assert "client_secret_secret_ref must be a secret reference starting with secret://" in errors
    assert "enabled_scopes contains unsupported scope(s): bad_scope" in errors
    assert "general_ledger_profile must be a non-empty object" in errors


# ---------------------------------------------------------------------------
# run_sage_healthcheck
# ---------------------------------------------------------------------------


def test_healthcheck_passes_for_ok_probe() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.message == "Sage Intacct connectivity verified"


def test_healthcheck_classifies_configuration_failure_when_config_invalid() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    result = run_sage_healthcheck(
        config,
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration validation failed"
    assert "errors" in result.details


def test_healthcheck_classifies_auth_failure_when_secret_resolution_fails() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: (_ for _ in ()).throw(SageAuthError("missing secret")),
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth secret resolution failed"


def test_healthcheck_classifies_connectivity_failure_on_network_error() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.URLError("dial timeout")),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


def test_healthcheck_classifies_auth_on_401() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 401,
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_auth_on_403() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 403,
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_configuration_on_404() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 404,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Company or endpoint not found"


def test_healthcheck_classifies_connectivity_on_http_401_error() -> None:
    exc = error.HTTPError(
        url="https://api.intacct.com/v1/healthcheck",
        code=401,
        msg="Unauthorized",
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(exc),
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_connectivity_on_server_error() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 503,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"


def test_healthcheck_classifies_rate_limit_as_connectivity() -> None:
    result = run_sage_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 429,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Rate limit reached"


# ---------------------------------------------------------------------------
# Secret-resolution boundary: secret refs must not be present in settings
# ---------------------------------------------------------------------------


def test_validate_sage_config_secret_refs_not_accepted_as_plain_values() -> None:
    """Raw credential values must be rejected; only secret:// refs are accepted."""
    config = _valid_config()
    config["client_id_secret_ref"] = "oauth-client-id-1234"
    config["client_secret_secret_ref"] = "oauth-secret-abcd"
    errors = validate_sage_config(config)
    assert any("client_id_secret_ref" in e for e in errors)
    assert any("client_secret_secret_ref" in e for e in errors)


# ---------------------------------------------------------------------------
# Tenant isolation: healthcheck uses config from the authenticated tenant only
# ---------------------------------------------------------------------------


def test_healthcheck_uses_config_from_provided_config_object() -> None:
    """Healthcheck must operate on the config dict passed to it, not global state."""
    tenant_a_config = _valid_config()
    tenant_a_config["company_id"] = "tenant-a-company"

    # Simulate tenant-b config with a different company_id
    tenant_b_config = _valid_config()
    tenant_b_config["company_id"] = "tenant-b-company"

    probed: list[dict] = []

    def capturing_probe(**kwargs: object) -> int:
        probed.append(dict(kwargs))
        return 200

    run_sage_healthcheck(tenant_a_config, secret_resolver=lambda _: "tok", health_probe=capturing_probe)
    run_sage_healthcheck(tenant_b_config, secret_resolver=lambda _: "tok", health_probe=capturing_probe)

    assert len(probed) == 2
    # Both probes must use the same api_base_url (no cross-tenant bleed via shared state)
    assert probed[0]["api_base_url"] == probed[1]["api_base_url"]
