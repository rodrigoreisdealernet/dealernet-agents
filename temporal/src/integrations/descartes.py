from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib import error, request
from urllib.parse import urlparse

_ALLOWED_SCOPES = {"route", "shipment", "compliance"}


@dataclass(frozen=True)
class DescartesHealthcheckResult:
    status: Literal["ok", "failed"]
    classification: Literal["ok", "auth", "connectivity", "configuration"]
    message: str
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class DescartesAuthError(RuntimeError):
    """Raised when secret resolution/auth fails."""


def validate_descartes_config(config: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    endpoint = str(config.get("endpoint_base_url") or "").strip()
    parsed = urlparse(endpoint)
    if not endpoint or parsed.scheme != "https" or not parsed.netloc:
        errors.append("endpoint_base_url must be a valid https URL")

    secret_ref = str(config.get("auth_secret_ref") or "").strip()
    if not secret_ref or not secret_ref.startswith("secret://"):
        errors.append("auth_secret_ref must be a secret reference starting with secret://")

    scopes = config.get("enabled_scopes")
    if not isinstance(scopes, list) or not scopes:
        errors.append("enabled_scopes must include at least one scope")
    else:
        invalid_scopes = sorted({str(scope) for scope in scopes if str(scope) not in _ALLOWED_SCOPES})
        if invalid_scopes:
            errors.append(f"enabled_scopes contains unsupported scope(s): {', '.join(invalid_scopes)}")

    for key in ("route_mapping_profile", "shipment_mapping_profile", "compliance_profile"):
        value = config.get(key)
        if not isinstance(value, Mapping) or not value:
            errors.append(f"{key} must be a non-empty object")
    return errors


def default_secret_resolver(secret_ref: str) -> str:
    raise DescartesAuthError(f"secret resolver unavailable for {secret_ref}")


def default_health_probe(*, endpoint_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
    url = f"{endpoint_base_url.rstrip('/')}/{path.lstrip('/')}"
    auth_header = " ".join(["Bearer", token])
    req = request.Request(
        url=url,
        method="GET",
        headers={"Authorization": auth_header},
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        return int(response.getcode())


def run_descartes_healthcheck(
    config: Mapping[str, Any],
    *,
    secret_resolver: Callable[[str], str] = default_secret_resolver,
    health_probe: Callable[..., int] = default_health_probe,
) -> DescartesHealthcheckResult:
    validation_errors = validate_descartes_config(config)
    if validation_errors:
        return DescartesHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration validation failed",
            details={"errors": validation_errors},
        )

    secret_ref = str(config.get("auth_secret_ref"))
    try:
        token = secret_resolver(secret_ref)
    except DescartesAuthError as exc:
        return DescartesHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth secret resolution failed",
            details={"error": str(exc)},
        )

    path = str(config.get("healthcheck_path") or "/health")
    timeout_seconds = int(config.get("healthcheck_timeout_seconds") or 10)
    endpoint_base_url = str(config.get("endpoint_base_url"))
    try:
        status_code = health_probe(
            endpoint_base_url=endpoint_base_url,
            token=token,
            path=path,
            timeout_seconds=timeout_seconds,
        )
    except DescartesAuthError as exc:
        return DescartesHealthcheckResult(
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
        return DescartesHealthcheckResult(
            status="failed",
            classification=classification,
            message=message,
            details={"status_code": exc.code},
        )
    except (error.URLError, OSError, TimeoutError) as exc:
        return DescartesHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"error": str(exc)},
        )

    if status_code in {401, 403}:
        return DescartesHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details={"status_code": status_code},
        )
    if status_code in {404, 422}:
        return DescartesHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration check failed",
            details={"status_code": status_code},
        )
    if status_code >= 500:
        return DescartesHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"status_code": status_code},
        )
    return DescartesHealthcheckResult(
        status="ok",
        classification="ok",
        message="Descartes connectivity verified",
        details={"status_code": status_code},
    )
