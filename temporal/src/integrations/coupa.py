from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib import error, request
from urllib.parse import urlparse

_ALLOWED_SCOPES = {"requisitions", "purchase_orders", "suppliers", "invoices"}

_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "requisitions": "requisition_mapping_profile",
    "purchase_orders": "purchase_order_mapping_profile",
    "suppliers": "supplier_mapping_profile",
    "invoices": "invoice_mapping_profile",
}


@dataclass(frozen=True)
class CoupaHealthcheckResult:
    status: Literal["ok", "failed"]
    classification: Literal["ok", "auth", "connectivity", "configuration"]
    message: str
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class CoupaAuthError(RuntimeError):
    """Raised when secret resolution/auth fails."""


def validate_coupa_config(config: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []

    api_base_url = str(config.get("api_base_url") or "").strip()
    parsed = urlparse(api_base_url)
    if not api_base_url or parsed.scheme != "https" or not parsed.netloc:
        errors.append("api_base_url must be a valid https URL")

    tenant_slug = str(config.get("tenant_slug") or "").strip()
    if not tenant_slug:
        errors.append("tenant_slug must be a non-empty string")

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

    return errors


def default_secret_resolver(secret_ref: str) -> str:
    raise CoupaAuthError(f"secret resolver unavailable for {secret_ref}")


def default_health_probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
    url = f"{api_base_url.rstrip('/')}/{path.lstrip('/')}"
    req = request.Request(
        url=url,
        method="GET",
        headers={"Authorization": " ".join(["Bearer", token])},
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        return int(response.getcode())


def run_coupa_healthcheck(
    config: Mapping[str, Any],
    *,
    secret_resolver: Callable[[str], str] = default_secret_resolver,
    health_probe: Callable[..., int] = default_health_probe,
) -> CoupaHealthcheckResult:
    validation_errors = validate_coupa_config(config)
    if validation_errors:
        return CoupaHealthcheckResult(
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
    except CoupaAuthError:
        return CoupaHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth secret resolution failed",
            details={"reason": "secret_resolution_failed"},
        )

    path = str(config.get("healthcheck_path") or "/api/health")
    timeout_seconds = int(config.get("healthcheck_timeout_seconds") or 10)
    api_base_url = str(config.get("api_base_url"))
    try:
        status_code = health_probe(
            api_base_url=api_base_url,
            token=token,
            path=path,
            timeout_seconds=timeout_seconds,
        )
    except CoupaAuthError:
        return CoupaHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details={"reason": "auth_check_failed"},
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
            message = "Tenant or endpoint not found"
        else:
            classification = "connectivity"
            message = "Connectivity check failed"
        return CoupaHealthcheckResult(
            status="failed",
            classification=classification,
            message=message,
            details={"status_code": exc.code},
        )
    except (error.URLError, OSError, TimeoutError):
        return CoupaHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"reason": "transport_error"},
        )

    if status_code in {401, 403}:
        return CoupaHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details={"status_code": status_code},
        )
    if status_code == 429:
        return CoupaHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Rate limit reached",
            details={"status_code": status_code},
        )
    if status_code in {404, 422}:
        return CoupaHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Tenant or endpoint not found",
            details={"status_code": status_code},
        )
    if status_code >= 500:
        return CoupaHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"status_code": status_code},
        )
    return CoupaHealthcheckResult(
        status="ok",
        classification="ok",
        message="Coupa connectivity verified",
        details={"status_code": status_code},
    )
