from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib import error, request
from urllib.parse import urlparse

_ALLOWED_SCOPES = {"gps", "hours", "eld", "dashcam_events"}

# Mapping from scope name to the profile config key required when that scope is enabled.
_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "gps": "gps_mapping_profile",
    "hours": "hours_mapping_profile",
    "eld": "eld_profile",
    "dashcam_events": "dashcam_event_profile",
}


@dataclass(frozen=True)
class SamsaraHealthcheckResult:
    status: Literal["ok", "failed"]
    classification: Literal["ok", "auth", "connectivity", "configuration"]
    message: str
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class SamsaraAuthError(RuntimeError):
    """Raised when secret resolution/auth fails."""


def validate_samsara_config(config: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []

    api_base_url = str(config.get("api_base_url") or "").strip()
    parsed = urlparse(api_base_url)
    if not api_base_url or parsed.scheme != "https" or not parsed.netloc:
        errors.append("api_base_url must be a valid https URL")

    api_secret_ref = str(config.get("api_secret_ref") or "").strip()
    if not api_secret_ref or not api_secret_ref.startswith("secret://"):
        errors.append("api_secret_ref must be a secret reference starting with secret://")

    scopes = config.get("enabled_scopes")
    if not isinstance(scopes, list) or not scopes:
        errors.append("enabled_scopes must include at least one scope")
    else:
        invalid_scopes = sorted({str(s) for s in scopes if str(s) not in _ALLOWED_SCOPES})
        if invalid_scopes:
            errors.append(f"enabled_scopes contains unsupported scope(s): {', '.join(invalid_scopes)}")

        active_scopes = {str(s) for s in scopes if str(s) in _ALLOWED_SCOPES}
        for scope in sorted(active_scopes):
            profile_key = _SCOPE_PROFILE_KEYS[scope]
            value = config.get(profile_key)
            if not isinstance(value, Mapping) or not value:
                errors.append(f"{profile_key} must be a non-empty object")

    fleet_targeting = config.get("fleet_targeting")
    if not isinstance(fleet_targeting, Mapping) or not fleet_targeting:
        errors.append("fleet_targeting must be a non-empty object")

    return errors


def default_secret_resolver(secret_ref: str) -> str:
    raise SamsaraAuthError(f"secret resolver unavailable for {secret_ref}")


def default_health_probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
    url = f"{api_base_url.rstrip('/')}/{path.lstrip('/')}"
    auth_header = " ".join(["Token", token])
    req = request.Request(
        url=url,
        method="GET",
        headers={"Authorization": auth_header},
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        return int(response.getcode())


def run_samsara_healthcheck(
    config: Mapping[str, Any],
    *,
    secret_resolver: Callable[[str], str] = default_secret_resolver,
    health_probe: Callable[..., int] = default_health_probe,
) -> SamsaraHealthcheckResult:
    validation_errors = validate_samsara_config(config)
    if validation_errors:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration validation failed",
            details={"errors": validation_errors},
        )

    secret_ref = str(config.get("api_secret_ref"))
    try:
        token = secret_resolver(secret_ref)
    except SamsaraAuthError as exc:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth secret resolution failed",
            details={"error": str(exc)},
        )

    path = str(config.get("healthcheck_path") or "/v1/me")
    timeout_seconds = int(config.get("healthcheck_timeout_seconds") or 10)
    api_base_url = str(config.get("api_base_url"))
    try:
        status_code = health_probe(
            api_base_url=api_base_url,
            token=token,
            path=path,
            timeout_seconds=timeout_seconds,
        )
    except SamsaraAuthError as exc:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details={"error": str(exc)},
        )
    except error.HTTPError as exc:
        if exc.code in {401, 403}:
            classification = "auth"
            message = "Auth check failed"
        elif exc.code in {404, 422}:
            classification = "configuration"
            message = "Configuration check failed"
        else:
            classification = "connectivity"
            message = "Connectivity check failed"
        return SamsaraHealthcheckResult(
            status="failed",
            classification=classification,
            message=message,
            details={"status_code": exc.code},
        )
    except (error.URLError, OSError, TimeoutError) as exc:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"error": str(exc)},
        )

    if status_code in {401, 403}:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details={"status_code": status_code},
        )
    if status_code in {404, 422}:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration check failed",
            details={"status_code": status_code},
        )
    if status_code >= 500:
        return SamsaraHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"status_code": status_code},
        )
    return SamsaraHealthcheckResult(
        status="ok",
        classification="ok",
        message="Samsara connectivity verified",
        details={"status_code": status_code},
    )
