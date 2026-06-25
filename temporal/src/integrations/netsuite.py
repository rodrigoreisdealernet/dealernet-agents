from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib import error
from urllib.parse import urlparse

# Oracle NetSuite REST Web Services connector (TBA — Token-Based Authentication).
# Supported scopes align to the rental ERP flows consumed by Dealernet:
# items, customers, vendors, invoices.
_ALLOWED_SCOPES = {"items", "customers", "vendors", "invoices"}

_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "items": "items_profile",
    "customers": "customers_profile",
    "vendors": "vendors_profile",
    "invoices": "invoices_profile",
}

# NetSuite SuiteTalk REST Web Services URLs are scoped to a single canonical
# subdomain format: https://{normalized_account_id}.suitetalk.api.netsuite.com
# Arbitrary HTTPS origins are rejected to prevent SSRF / secret exfiltration.
_NETSUITE_SUITETALK_HOST_SUFFIX = ".suitetalk.api.netsuite.com"


def _expected_netsuite_host(account_id: str) -> str:
    """Return the canonical SuiteTalk REST hostname for *account_id*.

    NetSuite normalizes account IDs by lowercasing and replacing underscores
    with hyphens when constructing the SuiteTalk subdomain.
    """
    return account_id.lower().replace("_", "-") + _NETSUITE_SUITETALK_HOST_SUFFIX


@dataclass(frozen=True)
class NetSuiteHealthcheckResult:
    status: Literal["ok", "failed"]
    classification: Literal["ok", "auth", "connectivity", "configuration"]
    message: str
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class NetSuiteAuthError(RuntimeError):
    """Raised when TBA secret resolution or token validation fails."""


def validate_netsuite_config(config: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []

    # Validate account_id first; it is required for URL host verification.
    account_id = str(config.get("account_id") or "").strip()
    if not account_id:
        errors.append("account_id must be a non-empty string")

    api_base_url = str(config.get("api_base_url") or "").strip()
    parsed = urlparse(api_base_url)
    _structurally_valid = (
        bool(api_base_url)
        and parsed.scheme == "https"
        and bool(parsed.netloc)
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and parsed.path in ("", "/")
    )
    if not _structurally_valid:
        errors.append("api_base_url must be a valid https URL")
    else:
        host = (parsed.hostname or "").lower()
        if not host.endswith(_NETSUITE_SUITETALK_HOST_SUFFIX):
            errors.append(
                "api_base_url must use a NetSuite SuiteTalk host (*.suitetalk.api.netsuite.com)"
            )
        elif account_id:
            expected_host = _expected_netsuite_host(account_id)
            if host != expected_host:
                errors.append(
                    f"api_base_url host must match account_id; expected https://{expected_host}"
                )

    for ref_field in (
        "consumer_key_secret_ref",
        "consumer_secret_secret_ref",
        "token_id_secret_ref",
        "token_secret_secret_ref",
    ):
        ref_value = str(config.get(ref_field) or "").strip()
        if not ref_value or not ref_value.startswith("secret://"):
            errors.append(f"{ref_field} must be a secret reference starting with secret://")

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
    raise NetSuiteAuthError(f"secret resolver unavailable for {secret_ref}")


def run_netsuite_healthcheck(
    config: Mapping[str, Any],
    *,
    secret_resolver: Callable[[str], str] = default_secret_resolver,
    health_probe: Callable[..., int] | None = None,
) -> NetSuiteHealthcheckResult:
    """Run a healthcheck against the NetSuite configuration.

    When *health_probe* is ``None`` (the default) the function performs a
    dry-run: it validates the configuration structure and verifies that all
    four TBA secret references can be resolved, but makes **no outbound HTTP
    request**.  A live connectivity probe requires proper NetSuite TBA
    (OAuth 1.0a HMAC-SHA256) signing; callers that need live checks must
    supply an explicit *health_probe* implementation.

    The *health_probe* callable is invoked as::

        health_probe(api_base_url=..., path=..., timeout_seconds=...)

    It must return an integer HTTP status code.  Raw credential values are
    **never** passed to the probe.
    """
    validation_errors = validate_netsuite_config(config)
    if validation_errors:
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration validation failed",
            details={"errors": validation_errors},
        )

    consumer_key_ref = str(config.get("consumer_key_secret_ref"))
    consumer_secret_ref = str(config.get("consumer_secret_secret_ref"))
    token_id_ref = str(config.get("token_id_secret_ref"))
    token_secret_ref = str(config.get("token_secret_secret_ref"))
    try:
        _consumer_key = secret_resolver(consumer_key_ref)
        _consumer_secret = secret_resolver(consumer_secret_ref)
        _token_id = secret_resolver(token_id_ref)
        _token_secret = secret_resolver(token_secret_ref)
    except NetSuiteAuthError:
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth secret resolution failed",
            details={"reason": "secret_resolution_failed"},
        )

    # When no live probe is supplied, return a dry-run result after verifying
    # that configuration is valid and all secrets are resolvable.  A live HTTP
    # probe is intentionally omitted here because NetSuite TBA requires
    # OAuth 1.0a HMAC-SHA256 request signing; transmitting raw long-lived
    # credentials as a raw bearer token would be both incorrect and a security
    # risk.  Callers that need live connectivity checks must supply an
    # explicit health_probe that implements the full TBA signing flow.
    if health_probe is None:
        return NetSuiteHealthcheckResult(
            status="ok",
            classification="ok",
            message="NetSuite configuration and secret access verified",
            details={"probe": "dry_run"},
        )

    path = str(config.get("healthcheck_path") or "/services/rest/record/v1/metadata-catalog/")
    timeout_seconds = int(config.get("healthcheck_timeout_seconds") or 10)
    api_base_url = str(config.get("api_base_url"))
    try:
        # Raw credential values are intentionally NOT forwarded to the probe.
        status_code = health_probe(
            api_base_url=api_base_url,
            path=path,
            timeout_seconds=timeout_seconds,
        )
    except NetSuiteAuthError:
        return NetSuiteHealthcheckResult(
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
            message = "Account or endpoint not found"
        else:
            classification = "connectivity"
            message = "Connectivity check failed"
        return NetSuiteHealthcheckResult(
            status="failed",
            classification=classification,
            message=message,
            details={"status_code": exc.code},
        )
    except (error.URLError, OSError, TimeoutError):
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"reason": "transport_error"},
        )

    if status_code in {401, 403}:
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details={"status_code": status_code},
        )
    if status_code == 429:
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Rate limit reached",
            details={"status_code": status_code},
        )
    if status_code in {404, 422}:
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Account or endpoint not found",
            details={"status_code": status_code},
        )
    if status_code >= 500:
        return NetSuiteHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details={"status_code": status_code},
        )
    return NetSuiteHealthcheckResult(
        status="ok",
        classification="ok",
        message="NetSuite connectivity verified",
        details={"status_code": status_code},
    )
