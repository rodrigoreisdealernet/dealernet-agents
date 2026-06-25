from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib import error, request
from urllib.parse import urlparse

_ALLOWED_SCOPES = {"invoices", "payments", "ar_aging"}

# Mapping from scope name to the profile config key required when that scope is enabled.
_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "invoices": "invoice_mapping_profile",
    "payments": "payment_mapping_profile",
    "ar_aging": "ar_aging_profile",
}


@dataclass(frozen=True)
class BilltrustHealthcheckResult:
    status: Literal["ok", "failed"]
    classification: Literal["ok", "auth", "connectivity", "configuration"]
    message: str
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class BilltrustAuthError(RuntimeError):
    """Raised when secret resolution or auth token acquisition fails."""


def _failure_details(*, reason: str | None = None, status_code: int | None = None) -> dict[str, Any]:
    details: dict[str, Any] = {}
    if reason is not None:
        details["reason"] = reason
    if status_code is not None:
        details["status_code"] = status_code
    return details


def validate_billtrust_config(config: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []

    api_base_url = str(config.get("api_base_url") or "").strip()
    parsed = urlparse(api_base_url)
    if not api_base_url or parsed.scheme != "https" or not parsed.netloc:
        errors.append("api_base_url must be a valid https URL")

    client_id_ref = str(config.get("client_id_secret_ref") or "").strip()
    if not client_id_ref or not client_id_ref.startswith("secret://"):
        errors.append("client_id_secret_ref must be a secret reference starting with secret://")

    client_secret_ref = str(config.get("client_secret_secret_ref") or "").strip()
    if not client_secret_ref or not client_secret_ref.startswith("secret://"):
        errors.append("client_secret_secret_ref must be a secret reference starting with secret://")

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

    tenant_mapping = config.get("tenant_mapping")
    if not isinstance(tenant_mapping, Mapping) or not tenant_mapping:
        errors.append("tenant_mapping must be a non-empty object")

    return errors


def default_secret_resolver(secret_ref: str) -> str:
    raise BilltrustAuthError(f"secret resolver unavailable for {secret_ref}")


def default_health_probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
    url = f"{api_base_url.rstrip('/')}/{path.lstrip('/')}"
    req = request.Request(
        url=url,
        method="GET",
        headers={"Authorization": " ".join(["Bearer", token])},
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        return int(response.getcode())


def run_billtrust_healthcheck(
    config: Mapping[str, Any],
    *,
    secret_resolver: Callable[[str], str] = default_secret_resolver,
    health_probe: Callable[..., int] = default_health_probe,
) -> BilltrustHealthcheckResult:
    validation_errors = validate_billtrust_config(config)
    if validation_errors:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration validation failed",
            details={"errors": validation_errors},
        )

    client_id_ref = str(config.get("client_id_secret_ref"))
    client_secret_ref = str(config.get("client_secret_secret_ref"))
    try:
        _client_id = secret_resolver(client_id_ref)
        token = secret_resolver(client_secret_ref)
    except BilltrustAuthError:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth secret resolution failed",
            details=_failure_details(reason="secret_resolution_failed"),
        )

    path = str(config.get("healthcheck_path") or "/v1/health")
    timeout_seconds = int(config.get("healthcheck_timeout_seconds") or 10)
    api_base_url = str(config.get("api_base_url"))
    try:
        status_code = health_probe(
            api_base_url=api_base_url,
            token=token,
            path=path,
            timeout_seconds=timeout_seconds,
        )
    except BilltrustAuthError:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details=_failure_details(reason="auth_check_failed"),
        )
    except error.HTTPError as exc:
        if exc.code in {401, 403}:
            classification: Literal["auth", "connectivity", "configuration"] = "auth"
            message = "Auth check failed"
        elif exc.code == 429:
            classification = "connectivity"
            message = "Rate limit reached"
        elif exc.code in {404, 422}:
            classification = "configuration"
            message = "Target account/tenant resolution failed"
        else:
            classification = "connectivity"
            message = "Connectivity check failed"
        return BilltrustHealthcheckResult(
            status="failed",
            classification=classification,
            message=message,
            details=_failure_details(status_code=exc.code),
        )
    except (error.URLError, OSError, TimeoutError):
        return BilltrustHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details=_failure_details(reason="transport_error"),
        )

    if status_code in {401, 403}:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details=_failure_details(status_code=status_code),
        )
    if status_code == 429:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Rate limit reached",
            details=_failure_details(status_code=status_code),
        )
    if status_code in {404, 422}:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Target account/tenant resolution failed",
            details=_failure_details(status_code=status_code),
        )
    if status_code >= 500:
        return BilltrustHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details=_failure_details(status_code=status_code),
        )
    return BilltrustHealthcheckResult(
        status="ok",
        classification="ok",
        message="Billtrust connectivity verified",
        details=_failure_details(status_code=status_code),
    )
