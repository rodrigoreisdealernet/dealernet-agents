from __future__ import annotations

from urllib import error

from temporal.src.integrations.descartes import (
    DescartesAuthError,
    run_descartes_healthcheck,
    validate_descartes_config,
)


def _valid_config() -> dict[str, object]:
    return {
        "endpoint_base_url": "https://api.descartes.example",
        "auth_secret_ref": "secret://integrations/descartes/token",
        "enabled_scopes": ["route", "shipment", "compliance"],
        "route_mapping_profile": {"route_id_field": "routeNumber"},
        "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
        "compliance_profile": {"hos_mode": "eld"},
        "healthcheck_path": "/health",
        "healthcheck_timeout_seconds": 5,
    }


def test_validate_descartes_config_rejects_bad_endpoint_scope_and_secret_ref() -> None:
    config = _valid_config()
    config["endpoint_base_url"] = "http://insecure.example"
    config["auth_secret_ref"] = "token-raw-value"
    config["enabled_scopes"] = ["route", "unknown-scope"]
    config["route_mapping_profile"] = {}
    errors = validate_descartes_config(config)
    assert "endpoint_base_url must be a valid https URL" in errors
    assert "auth_secret_ref must be a secret reference starting with secret://" in errors
    assert "enabled_scopes contains unsupported scope(s): unknown-scope" in errors
    assert "route_mapping_profile must be a non-empty object" in errors


def test_healthcheck_classifies_auth_failure_when_secret_resolution_fails() -> None:
    result = run_descartes_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: (_ for _ in ()).throw(DescartesAuthError("missing secret")),
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth secret resolution failed"


def test_healthcheck_classifies_connectivity_failure_on_network_error() -> None:
    result = run_descartes_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.URLError("dial timeout")),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


def test_healthcheck_classifies_configuration_failure_on_404() -> None:
    result = run_descartes_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 404,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration check failed"


def test_healthcheck_returns_ok_on_successful_probe() -> None:
    result = run_descartes_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.message == "Descartes connectivity verified"
    assert result.details["status_code"] == 200


def test_healthcheck_classifies_auth_failure_on_http_error_401() -> None:
    http_err = error.HTTPError(url="https://api.descartes.example/health", code=401, msg="Unauthorized", hdrs=None, fp=None)  # type: ignore[arg-type]
    result = run_descartes_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(http_err),
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth check failed"


def test_healthcheck_classifies_connectivity_failure_on_http_error_500() -> None:
    http_err = error.HTTPError(url="https://api.descartes.example/health", code=503, msg="Service Unavailable", hdrs=None, fp=None)  # type: ignore[arg-type]
    result = run_descartes_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(http_err),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


def test_validate_descartes_config_accepts_valid_config() -> None:
    errors = validate_descartes_config(_valid_config())
    assert errors == []
