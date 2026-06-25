from __future__ import annotations

from urllib import error

from temporal.src.integrations.samsara import (
    SamsaraAuthError,
    run_samsara_healthcheck,
    validate_samsara_config,
)


def _valid_config() -> dict[str, object]:
    return {
        "api_base_url": "https://api.samsara.com",
        "api_secret_ref": "secret://integrations/samsara/api_key",
        "enabled_scopes": ["gps", "hours", "eld", "dashcam_events"],
        "fleet_targeting": {"group_ids": ["group-1", "group-2"]},
        "gps_mapping_profile": {"asset_id_field": "vehicleId"},
        "hours_mapping_profile": {"driver_id_field": "driverId"},
        "eld_profile": {"hos_mode": "property"},
        "dashcam_event_profile": {"event_types": ["harsh_acceleration", "harsh_braking"]},
        "healthcheck_path": "/v1/me",
        "healthcheck_timeout_seconds": 5,
    }


def test_validate_samsara_config_passes_for_valid_config() -> None:
    errors = validate_samsara_config(_valid_config())
    assert errors == []


def test_validate_samsara_config_rejects_missing_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = ""
    errors = validate_samsara_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_samsara_config_rejects_http_api_base_url() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://api.samsara.com"
    errors = validate_samsara_config(config)
    assert "api_base_url must be a valid https URL" in errors


def test_validate_samsara_config_rejects_raw_secret() -> None:
    config = _valid_config()
    config["api_secret_ref"] = "raw-api-key-value"
    errors = validate_samsara_config(config)
    assert "api_secret_ref must be a secret reference starting with secret://" in errors


def test_validate_samsara_config_rejects_unknown_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["gps", "unknown_scope"]
    errors = validate_samsara_config(config)
    assert "enabled_scopes contains unsupported scope(s): unknown_scope" in errors


def test_validate_samsara_config_rejects_empty_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = []
    errors = validate_samsara_config(config)
    assert "enabled_scopes must include at least one scope" in errors


def test_validate_samsara_config_rejects_missing_profile_for_active_scope() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["gps"]
    config["gps_mapping_profile"] = {}
    errors = validate_samsara_config(config)
    assert "gps_mapping_profile must be a non-empty object" in errors


def test_validate_samsara_config_only_checks_profiles_for_enabled_scopes() -> None:
    config = _valid_config()
    config["enabled_scopes"] = ["gps"]
    # hours_mapping_profile not needed when hours scope is not enabled
    config["hours_mapping_profile"] = {}
    config["eld_profile"] = {}
    config["dashcam_event_profile"] = {}
    errors = validate_samsara_config(config)
    assert errors == []


def test_validate_samsara_config_rejects_empty_fleet_targeting() -> None:
    config = _valid_config()
    config["fleet_targeting"] = {}
    errors = validate_samsara_config(config)
    assert "fleet_targeting must be a non-empty object" in errors


def test_validate_samsara_config_rejects_multiple_errors() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://insecure.example"
    config["api_secret_ref"] = "raw-key"
    config["enabled_scopes"] = ["gps", "bad_scope"]
    config["gps_mapping_profile"] = {}
    config["fleet_targeting"] = {}
    errors = validate_samsara_config(config)
    assert "api_base_url must be a valid https URL" in errors
    assert "api_secret_ref must be a secret reference starting with secret://" in errors
    assert "enabled_scopes contains unsupported scope(s): bad_scope" in errors
    assert "gps_mapping_profile must be a non-empty object" in errors
    assert "fleet_targeting must be a non-empty object" in errors


def test_healthcheck_passes_for_ok_probe() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "ok"
    assert result.classification == "ok"
    assert result.message == "Samsara connectivity verified"


def test_healthcheck_classifies_configuration_failure_when_config_invalid() -> None:
    config = _valid_config()
    config["api_base_url"] = "http://insecure.example"
    result = run_samsara_healthcheck(
        config,
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration validation failed"


def test_healthcheck_classifies_auth_failure_when_secret_resolution_fails() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: (_ for _ in ()).throw(SamsaraAuthError("missing secret")),
        health_probe=lambda **_: 200,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth secret resolution failed"


def test_healthcheck_classifies_connectivity_failure_on_network_error() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.URLError("dial timeout")),
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"


def test_healthcheck_classifies_auth_failure_on_401() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: (_ for _ in ()).throw(error.HTTPError(None, 401, "Unauthorized", {}, None)),
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth check failed"


def test_healthcheck_classifies_auth_failure_on_403() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 403,
    )
    assert result.status == "failed"
    assert result.classification == "auth"
    assert result.message == "Auth check failed"


def test_healthcheck_classifies_configuration_failure_on_404() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 404,
    )
    assert result.status == "failed"
    assert result.classification == "configuration"
    assert result.message == "Configuration check failed"


def test_healthcheck_classifies_connectivity_failure_on_500() -> None:
    result = run_samsara_healthcheck(
        _valid_config(),
        secret_resolver=lambda _: "token",
        health_probe=lambda **_: 500,
    )
    assert result.status == "failed"
    assert result.classification == "connectivity"
    assert result.message == "Connectivity check failed"
