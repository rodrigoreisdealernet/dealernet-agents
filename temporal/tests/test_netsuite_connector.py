from __future__ import annotations

from urllib import error

from temporal.src.integrations.netsuite import (
    NetSuiteAuthError,
    run_netsuite_healthcheck,
    validate_netsuite_config,
)
from temporal.src.integrations.registry import build_connector_registry


def _valid_config() -> dict[str, object]:
    return {
        "api_base_url": "https://TSTDRV1234567.suitetalk.api.netsuite.com",
        "account_id": "TSTDRV1234567",
        "consumer_key_secret_ref": "secret://integrations/netsuite/consumer_key",
        "consumer_secret_secret_ref": "secret://integrations/netsuite/consumer_secret",
        "token_id_secret_ref": "secret://integrations/netsuite/token_id",
        "token_secret_secret_ref": "secret://integrations/netsuite/token_secret",
        "enabled_scopes": ["items", "customers", "vendors", "invoices"],
        "items_profile": {"item_id_field": "itemId"},
        "customers_profile": {"customer_id_field": "customerId"},
        "vendors_profile": {"vendor_id_field": "vendorId"},
        "invoices_profile": {"invoice_id_field": "tranId"},
        "healthcheck_path": "/services/rest/record/v1/metadata-catalog/",
        "healthcheck_timeout_seconds": 5,
    }


# ---------------------------------------------------------------------------
# validate_netsuite_config
# ---------------------------------------------------------------------------


def test_validate_netsuite_config_passes_for_valid_config() -> None:
    errors = validate_netsuite_config(_valid_config())
    assert errors == []


def test_netsuite_provider_is_registered_in_default_registry() -> None:
    registry = build_connector_registry()
    provider = registry["netsuite"]
    assert provider.key == "netsuite"
    assert provider.enabled_scopes == ("items", "customers", "vendors", "invoices")


def test_validate_netsuite_config_rejects_missing_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    errors = validate_netsuite_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_netsuite_config_rejects_http_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://TSTDRV1234567.suitetalk.api.netsuite.com"
    errors = validate_netsuite_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_netsuite_config_rejects_missing_account_id() -> None:
    config = _valid_config()
    config["account_id"] = ""
    errors = validate_netsuite_config(config)
    assert "account_id must be a non-empty string" in errors


def test_validate_netsuite_config_rejects_raw_consumer_key() -> None:
    config = _valid_config()
    config["consumer_key_secret_ref"] = "raw-consumer-key-value"
    errors = validate_netsuite_config(config)
    assert "consumer_key_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_netsuite_config_rejects_raw_consumer_secret() -> None:
    config = _valid_config()
    config["consumer_secret_secret_ref"] = "raw-consumer-secret-value"
    errors = validate_netsuite_config(config)
    assert "consumer_secret_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_netsuite_config_rejects_raw_token_id() -> None:
    config = _valid_config()
    config["token_id_secret_ref"] = "raw-token-id-value"
    errors = validate_netsuite_config(config)
    assert "token_id_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_netsuite_config_rejects_raw_token_secret() -> None:
    config = _valid_config()
    config["token_secret_secret_ref"] = "raw-token-secret-value"
    errors = validate_netsuite_config(config)
    assert "token_secret_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_netsuite_config_rejects_empty_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = []
    errors = validate_netsuite_config(config)
    assert "enabled_scopes must include at least one scope" in errors


def test_validate_netsuite_config_rejects_unknown_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["items", "bad_scope"]
    errors = validate_netsuite_config(config)
    assert "enabled_scopes contains unsupported scope(s): bad_scope" in errors


def test_validate_netsuite_config_rejects_missing_profile_for_active_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["items"]
    config["items_profile"] = {}
    errors = validate_netsuite_config(config)
    assert "items_profile must be a non-empty object" in errors


def test_validate_netsuite_config_only_checks_profiles_for_enabled_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["items"]
    # profiles for inactive scopes are not required
    config["customers_profile"] = {}
    config["vendors_profile"] = {}
    config["invoices_profile"] = {}
    errors = validate_netsuite_config(config)
    assert errors == []


def test_validate_netsuite_config_rejects_multiple_errors() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://insecure.example"
    config["consumer_key_secret_ref"] = "raw-key"
    config["consumer_secret_secret_ref"] = "raw-secret"
    config["token_id_secret_ref"] = "raw-token-id"
    config["token_secret_secret_ref"] = "raw-token-secret"
    config["enabled_scopes"] = ["items", "bad_scope"]
    config["items_profile"] = {}
    errors = validate_netsuite_config(config)
    assert "api_base_url must be a valid https URL" in errors
    assert "consumer_key_secret_ref must be a secret reference starting with secret://" in errors
    assert "consumer_secret_secret_ref must be a secret reference starting with secret://" in errors
    assert "token_id_secret_ref must be a secret reference starting with secret://" in errors
    assert "token_secret_secret_ref must be a secret reference starting with secret://" in errors
    assert "enabled_scopes contains unsupported scope(s): bad_scope" in errors
    assert "items_profile must be a non-empty object" in errors


# ---------------------------------------------------------------------------
# run_netsuite_healthcheck
# ---------------------------------------------------------------------------


def test_healthcheck_passes_for_ok_probe() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.message == "NetSuite connectivity verified"


def test_healthcheck_classifies_configuration_failure_when_config_invalid() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    result = run_netsuite_healthcheck(
        config,
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration validation failed"
    assert "errors" in result.details


def test_healthcheck_classifies_auth_failure_when_secret_resolution_fails() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: (_ for _ in ()).throw(NetSuiteAuthError("missing secret")),
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth secret resolution failed"


def test_healthcheck_classifies_connectivity_failure_on_network_error() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.URLError("dial timeout")),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


def test_healthcheck_classifies_auth_on_401() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 401,
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_auth_on_403() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 403,
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_configuration_on_404() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 404,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Account or endpoint not found"


def test_healthcheck_classifies_connectivity_on_server_error() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 503,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"


def test_healthcheck_classifies_rate_limit_as_connectivity() -> None:
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 429,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Rate limit reached"


def test_healthcheck_classifies_auth_on_http_401_error() -> None:
    exc = error.HTTPError(
        url="https://TSTDRV1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/",
        code=401,
        msg="Unauthorized",
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(exc),
    )
    assert result.status == "failed"
    assert result.classification == "auth"


def test_healthcheck_classifies_configuration_on_http_404_error() -> None:
    exc = error.HTTPError(
        url="https://TSTDRV1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/",
        code=404,
        msg="Not Found",
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(exc),
    )
    assert result.status == "failed"
    assert result.classification == "configuration"


# ---------------------------------------------------------------------------
# Secret-resolution boundary: secret refs must not be present as plain values
# ---------------------------------------------------------------------------


def test_validate_netsuite_config_secret_refs_not_accepted_as_plain_values() -> None:
    """Raw credential values must be rejected; only secret:// refs are accepted."""
    config = _valid_config()
    config["consumer_key_secret_ref"] = "raw-consumer-key-abc"
    config["consumer_secret_secret_ref"] = "raw-consumer-secret-xyz"
    config["token_id_secret_ref"] = "raw-token-id-123"
    config["token_secret_secret_ref"] = "raw-token-secret-456"
    errors = validate_netsuite_config(config)
    assert any("consumer_key_secret_ref" in e for e in errors)
    assert any("consumer_secret_secret_ref" in e for e in errors)
    assert any("token_id_secret_ref" in e for e in errors)
    assert any("token_secret_secret_ref" in e for e in errors)


# ---------------------------------------------------------------------------
# Tenant isolation: healthcheck uses config from the authenticated tenant only
# ---------------------------------------------------------------------------


def test_healthcheck_uses_config_from_provided_config_object() -> None:
    """Healthcheck must operate on the config dict passed to it, not global state."""
    tenant_a_config = _valid_config()
    tenant_a_config["account_id"] = "tenant-a-account"
    tenant_a_config["api_base_url"] = "https://tenant-a-account.suitetalk.api.netsuite.com"

    tenant_b_config = _valid_config()
    tenant_b_config["account_id"] = "tenant-b-account"
    tenant_b_config["api_base_url"] = "https://tenant-b-account.suitetalk.api.netsuite.com"

    probed: list[dict] = []

    def capturing_probe(**kwargs: object) -> int:
        probed.append(dict(kwargs))
        return 200

    run_netsuite_healthcheck(tenant_a_config, secret_resolver=lambda _: "tok", health_probe=capturing_probe)
    run_netsuite_healthcheck(tenant_b_config, secret_resolver=lambda _: "tok", health_probe=capturing_probe)

    assert len(probed) == 2
    assert probed[0]["api_base_url"] != probed[1]["api_base_url"]


# ---------------------------------------------------------------------------
# Security: host restriction and secret-forwarding prevention
# ---------------------------------------------------------------------------


def test_validate_netsuite_config_rejects_non_netsuite_host() -> None:
    """Arbitrary HTTPS origins must be rejected to prevent SSRF / secret exfiltration."""
    config = _valid_config()
    config["api_base_url"] = "https://attacker.example.com"
    errors = validate_netsuite_config(config)
    assert "api_base_url must use a NetSuite SuiteTalk host (*.suitetalk.api.netsuite.com)" in errors


def test_validate_netsuite_config_rejects_url_with_embedded_credentials() -> None:
    """URLs with embedded user/password must be rejected."""
    config = _valid_config()
    config["api_base_url"] = "https://user:pass@TSTDRV1234567.suitetalk.api.netsuite.com"
    errors = validate_netsuite_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_netsuite_config_rejects_url_with_query_string() -> None:
    """URLs containing query strings must be rejected."""
    config = _valid_config()
    config["api_base_url"] = "https://TSTDRV1234567.suitetalk.api.netsuite.com?redirect=attacker.com"
    errors = validate_netsuite_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_netsuite_config_rejects_mismatched_account_in_url() -> None:
    """Host in api_base_url must correspond to the configured account_id."""
    config = _valid_config()
    config["account_id"] = "DIFFERENT123"
    # api_base_url still points to the original account's host
    errors = validate_netsuite_config(config)
    assert "api_base_url host must match account_id; expected https://different123.suitetalk.api.netsuite.com" in errors


def test_healthcheck_default_does_not_make_outbound_http_call() -> None:
    """When no health_probe is supplied the healthcheck must not make any outbound call."""
    result = run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "resolved_secret_value",
    )
    # Dry-run: config + secrets verified, no HTTP request issued
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.details.get("probe") == "dry_run"


def test_healthcheck_probe_does_not_receive_raw_secret_values() -> None:
    """Raw long-lived credentials must never be forwarded as probe arguments."""
    received_kwargs: list[dict] = []

    def capturing_probe(**kwargs: object) -> int:
        received_kwargs.append(dict(kwargs))
        return 200

    run_netsuite_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "my_secret_value",
        health_probe=capturing_probe,
    )

    assert len(received_kwargs) == 1
    for value in received_kwargs[0].values():
        assert value != "my_secret_value", "Raw secret was passed to health_probe"
