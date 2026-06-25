from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib import error, request
from urllib.parse import urlparse

_ALLOWED_SCOPES = {"dataset_push", "dataset_refresh", "report_embed"}

# Mapping from scope name to the profile config key required when that scope is enabled.
_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "dataset_push": "dataset_push_profile",
    "dataset_refresh": "dataset_refresh_profile",
    "report_embed": "report_embed_profile",
}

# Power BI REST API base URL (overridable for sovereign cloud tenants).
_DEFAULT_API_BASE_URL = "https://api.powerbi.com"
_DEFAULT_AUTHORITY_URL = "https://login.microsoftonline.com"

# Failure class constants — aligned with the shared retry classification vocabulary.
FAILURE_CLASS_AUTH = "auth"
FAILURE_CLASS_RATE_LIMIT = "rate_limit"
FAILURE_CLASS_TRANSPORT = "transport"
FAILURE_CLASS_INVALID_PAYLOAD = "invalid_payload"
FAILURE_CLASS_CONFIG = "config"
FAILURE_CLASS_UNKNOWN = "unknown"

_ALL_FAILURE_CLASSES = frozenset({
    FAILURE_CLASS_AUTH,
    FAILURE_CLASS_RATE_LIMIT,
    FAILURE_CLASS_TRANSPORT,
    FAILURE_CLASS_INVALID_PAYLOAD,
    FAILURE_CLASS_CONFIG,
    FAILURE_CLASS_UNKNOWN,
})

# HTTP status → failure class mapping for Power BI REST API responses.
# 401/403 → auth (expired token, insufficient permission, workspace access revoked)
# 429     → rate_limit (Power BI enforces per-dataset refresh quotas)
# 400/422 → invalid_payload (malformed push payload, schema mismatch)
# 404/409 → config (workspace/dataset not found, capacity unavailable)
# 5xx     → transport (transient Power BI service errors)
_STATUS_TO_FAILURE_CLASS: dict[int, str] = {
    400: FAILURE_CLASS_INVALID_PAYLOAD,
    401: FAILURE_CLASS_AUTH,
    403: FAILURE_CLASS_AUTH,
    404: FAILURE_CLASS_CONFIG,
    409: FAILURE_CLASS_CONFIG,
    410: FAILURE_CLASS_CONFIG,
    413: FAILURE_CLASS_INVALID_PAYLOAD,
    422: FAILURE_CLASS_INVALID_PAYLOAD,
    429: FAILURE_CLASS_RATE_LIMIT,
    500: FAILURE_CLASS_TRANSPORT,
    502: FAILURE_CLASS_TRANSPORT,
    503: FAILURE_CLASS_TRANSPORT,
    504: FAILURE_CLASS_TRANSPORT,
}


def classify_powerbi_failure(http_status: int) -> str:
    """Map a Power BI REST API HTTP status code to a failure class.

    Returns one of: 'auth', 'rate_limit', 'transport', 'invalid_payload',
    'config', or 'unknown'.
    """
    if http_status in _STATUS_TO_FAILURE_CLASS:
        return _STATUS_TO_FAILURE_CLASS[http_status]
    if 500 <= http_status < 600:
        return FAILURE_CLASS_TRANSPORT
    if 400 <= http_status < 500:
        return FAILURE_CLASS_INVALID_PAYLOAD
    return FAILURE_CLASS_UNKNOWN


def is_recoverable_failure(failure_class: str) -> bool:
    """Return True for failure classes that are eligible for bounded retry/replay.

    Auth and config failures require operator intervention before retry.
    Rate-limit and transport failures are recoverable with backoff/replay.
    Invalid-payload failures require payload correction before replay.
    """
    return failure_class in {FAILURE_CLASS_RATE_LIMIT, FAILURE_CLASS_TRANSPORT}


@dataclass(frozen=True)
class PowerBIHealthcheckResult:
    status: Literal["ok", "failed"]
    classification: Literal["ok", "auth", "connectivity", "configuration"]
    message: str
    details: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PowerBIAuthError(RuntimeError):
    """Raised when secret resolution or token acquisition fails."""


def _failure_details(*, reason: str | None = None, status_code: int | None = None) -> dict[str, Any]:
    """Build a sanitized details dict containing only stable, non-sensitive values.

    Intentionally omits raw exception messages, secret-ref paths, hostnames,
    or any other caller-supplied text that could leak sensitive material.
    """
    details: dict[str, Any] = {}
    if reason is not None:
        details["reason"] = reason
    if status_code is not None:
        details["status_code"] = status_code
    return details


def validate_powerbi_config(config: Mapping[str, Any]) -> list[str]:
    """Validate a Power BI connector configuration mapping.

    Returns a list of human-readable error strings; an empty list means valid.
    """
    errors: list[str] = []

    api_base_url = str(config.get("api_base_url") or "").strip()
    parsed = urlparse(api_base_url)
    if not api_base_url or parsed.scheme != "https" or not parsed.netloc:
        errors.append("api_base_url must be a valid https URL")

    tenant_id = str(config.get("tenant_id") or "").strip()
    if not tenant_id:
        errors.append("tenant_id must be a non-empty Azure AD tenant identifier")

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

    workspace_mapping = config.get("workspace_mapping")
    if not isinstance(workspace_mapping, Mapping) or not workspace_mapping:
        errors.append("workspace_mapping must be a non-empty object")

    stale_threshold_minutes = config.get("stale_refresh_threshold_minutes")
    if stale_threshold_minutes is not None:
        try:
            val = int(stale_threshold_minutes)
            if val <= 0:
                errors.append("stale_refresh_threshold_minutes must be a positive integer")
        except (TypeError, ValueError):
            errors.append("stale_refresh_threshold_minutes must be a positive integer")

    return errors


def default_secret_resolver(secret_ref: str) -> str:
    raise PowerBIAuthError(f"secret resolver unavailable for {secret_ref}")


def default_health_probe(*, api_base_url: str, token: str, path: str, timeout_seconds: int) -> int:
    url = f"{api_base_url.rstrip('/')}/{path.lstrip('/')}"
    req = request.Request(
        url=url,
        method="GET",
        headers={"Authorization": " ".join(["Bearer", token])},
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        return int(response.getcode())


def run_powerbi_healthcheck(
    config: Mapping[str, Any],
    *,
    secret_resolver: Callable[[str], str] = default_secret_resolver,
    health_probe: Callable[..., int] = default_health_probe,
) -> PowerBIHealthcheckResult:
    """Run a non-destructive Power BI connectivity and configuration check.

    Validates config, resolves auth secrets, and probes the Power BI REST API.
    Returns a :class:`PowerBIHealthcheckResult` with classification and details.

    Classification values:
    - 'ok'            — connector is healthy and credentials resolved.
    - 'auth'          — secret resolution or credential validation failed.
    - 'configuration' — config validation errors or workspace/dataset not found.
    - 'connectivity'  — transport/network failure or transient API error.
    """
    validation_errors = validate_powerbi_config(config)
    if validation_errors:
        return PowerBIHealthcheckResult(
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
    except PowerBIAuthError:
        return PowerBIHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth secret resolution failed",
            details=_failure_details(reason="secret_resolution_failed"),
        )

    api_base_url = str(config.get("api_base_url") or _DEFAULT_API_BASE_URL)
    path = str(config.get("healthcheck_path") or "/v1.0/myorg/groups")
    timeout_seconds = int(config.get("healthcheck_timeout_seconds") or 10)

    try:
        status_code = health_probe(
            api_base_url=api_base_url,
            token=token,
            path=path,
            timeout_seconds=timeout_seconds,
        )
    except PowerBIAuthError:
        return PowerBIHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details=_failure_details(reason="auth_check_failed"),
        )
    except error.HTTPError as exc:
        failure_class = classify_powerbi_failure(exc.code)
        if failure_class == FAILURE_CLASS_AUTH:
            classification: Literal["auth", "connectivity", "configuration"] = "auth"
            message = "Auth check failed"
        elif failure_class == FAILURE_CLASS_CONFIG:
            classification = "configuration"
            message = "Configuration check failed"
        elif failure_class == FAILURE_CLASS_RATE_LIMIT:
            classification = "connectivity"
            message = "Rate limit reached"
        else:
            classification = "connectivity"
            message = "Connectivity check failed"
        return PowerBIHealthcheckResult(
            status="failed",
            classification=classification,
            message=message,
            details=_failure_details(status_code=exc.code),
        )
    except (error.URLError, OSError, TimeoutError):
        return PowerBIHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details=_failure_details(reason="transport_error"),
        )

    failure_class_from_status = classify_powerbi_failure(status_code)
    if failure_class_from_status == FAILURE_CLASS_AUTH:
        return PowerBIHealthcheckResult(
            status="failed",
            classification="auth",
            message="Auth check failed",
            details=_failure_details(status_code=status_code),
        )
    if failure_class_from_status == FAILURE_CLASS_RATE_LIMIT:
        return PowerBIHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Rate limit reached",
            details=_failure_details(status_code=status_code),
        )
    if failure_class_from_status == FAILURE_CLASS_CONFIG:
        return PowerBIHealthcheckResult(
            status="failed",
            classification="configuration",
            message="Configuration check failed",
            details=_failure_details(status_code=status_code),
        )
    if failure_class_from_status in {FAILURE_CLASS_INVALID_PAYLOAD, FAILURE_CLASS_TRANSPORT}:
        return PowerBIHealthcheckResult(
            status="failed",
            classification="connectivity",
            message="Connectivity check failed",
            details=_failure_details(status_code=status_code),
        )
    return PowerBIHealthcheckResult(
        status="ok",
        classification="ok",
        message="Power BI connectivity verified",
        details=_failure_details(status_code=status_code),
    )


# ---------------------------------------------------------------------------
# Stale refresh detection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DatasetRefreshState:
    """Snapshot of a Power BI dataset's last refresh state.

    Attributes
    ----------
    tenant_id:
        Wynne tenant identifier.
    workspace_id:
        Power BI workspace (group) identifier.
    dataset_id:
        Power BI dataset identifier.
    last_refreshed_at:
        UTC timestamp of the most recent completed refresh, or None if never refreshed.
    refresh_status:
        Latest Power BI refresh status string (e.g. 'Completed', 'Failed', 'Unknown').
    """

    tenant_id: str
    workspace_id: str
    dataset_id: str
    last_refreshed_at: datetime | None
    refresh_status: str


@dataclass(frozen=True)
class StaleRefreshCheckResult:
    """Result of a stale-refresh staleness check for one dataset.

    Attributes
    ----------
    is_stale:
        True when the dataset has not been refreshed within the configured threshold.
    is_failed:
        True when the latest refresh ended in a non-successful status.
    stale_since:
        UTC timestamp from which the staleness is measured (= last_refreshed_at or epoch).
    age_minutes:
        Minutes since last successful refresh, or None if never refreshed.
    failure_class:
        For failed refreshes, the classified failure class; None otherwise.
    message:
        Human-readable summary.
    """

    is_stale: bool
    is_failed: bool
    stale_since: datetime | None
    age_minutes: float | None
    failure_class: str | None
    message: str


_POWERBI_FAILED_STATUSES = frozenset({"Failed", "Disabled", "Cancelled"})
_POWERBI_UNKNOWN_STATUS = "Unknown"


def check_dataset_refresh_staleness(
    state: DatasetRefreshState,
    threshold_minutes: int,
    now: datetime | None = None,
) -> StaleRefreshCheckResult:
    """Check whether a dataset's last refresh is stale or failed.

    Parameters
    ----------
    state:
        Current dataset refresh snapshot.
    threshold_minutes:
        Maximum acceptable age (in minutes) of the last successful refresh.
    now:
        Reference UTC timestamp; defaults to ``datetime.now(UTC)``. Injected
        to keep the function deterministic in tests.

    Returns a :class:`StaleRefreshCheckResult`.
    """
    if now is None:
        now = datetime.now(UTC)

    is_failed = state.refresh_status in _POWERBI_FAILED_STATUSES
    failure_class: str | None = None
    if is_failed:
        # Failed refreshes without more information are classified as transport
        # (recoverable with retry) unless the status explicitly indicates auth/config.
        failure_class = FAILURE_CLASS_TRANSPORT

    if state.last_refreshed_at is None:
        return StaleRefreshCheckResult(
            is_stale=True,
            is_failed=is_failed,
            stale_since=None,
            age_minutes=None,
            failure_class=failure_class,
            message="Dataset has never been refreshed",
        )

    last_refreshed_at = state.last_refreshed_at
    if last_refreshed_at.tzinfo is None:
        last_refreshed_at = last_refreshed_at.replace(tzinfo=UTC)

    age = now - last_refreshed_at
    age_minutes = age.total_seconds() / 60.0
    is_stale = age_minutes > threshold_minutes

    if is_failed:
        message = (
            f"Dataset refresh failed (status={state.refresh_status!r}); "
            f"last successful refresh was {age_minutes:.1f} minutes ago"
        )
    elif is_stale:
        message = (
            f"Dataset refresh is stale: last refresh was {age_minutes:.1f} minutes ago "
            f"(threshold={threshold_minutes} minutes)"
        )
    else:
        message = (
            f"Dataset refresh is current: last refresh was {age_minutes:.1f} minutes ago"
        )

    return StaleRefreshCheckResult(
        is_stale=is_stale,
        is_failed=is_failed,
        stale_since=last_refreshed_at if (is_stale or is_failed) else None,
        age_minutes=age_minutes,
        failure_class=failure_class,
        message=message,
    )


# ---------------------------------------------------------------------------
# Export-run telemetry helpers
# ---------------------------------------------------------------------------


@dataclass
class ExportRunContext:
    """Auditable context for a single Power BI export run.

    Attributes
    ----------
    tenant_id:
        Wynne tenant identifier.
    workspace_id:
        Target Power BI workspace identifier.
    dataset_id:
        Target Power BI dataset identifier.
    export_scope:
        One of the enabled_scopes values (e.g. 'dataset_push', 'dataset_refresh').
    source_event_id:
        Opaque identifier of the originating event or workflow run.
    correlation_id:
        Optional cross-system correlation identifier for distributed tracing.
    """

    tenant_id: str
    workspace_id: str
    dataset_id: str
    export_scope: str
    source_event_id: str
    correlation_id: str | None = None


@dataclass(frozen=True)
class ExportRunOutcome:
    """Outcome record emitted after a Power BI export run completes.

    Attributes
    ----------
    context:
        Identifying context for this run.
    status:
        Terminal status: 'succeeded', 'failed', 'retrying', or 'dead_lettered'.
    failure_class:
        Populated on non-success; one of the FAILURE_CLASS_* constants.
    failure_code:
        Provider HTTP status code or error code string.
    failure_message:
        Human-readable failure summary (no secrets, no PII).
    retry_count:
        Number of attempts consumed before this outcome.
    occurred_at:
        UTC timestamp when this outcome was recorded.
    metadata:
        Arbitrary provider-specific audit context (no secrets).
    """

    context: ExportRunContext
    status: Literal["succeeded", "failed", "retrying", "dead_lettered"]
    failure_class: str | None
    failure_code: str | None
    failure_message: str | None
    retry_count: int
    occurred_at: datetime
    metadata: dict[str, Any]

    def is_recoverable(self) -> bool:
        """Return True when the failure class supports bounded replay."""
        if self.failure_class is None:
            return False
        return is_recoverable_failure(self.failure_class)

    def to_telemetry_dict(self) -> dict[str, Any]:
        """Serialize to a telemetry-safe dict (no secrets, no PII)."""
        return {
            "tenant_id": self.context.tenant_id,
            "workspace_id": self.context.workspace_id,
            "dataset_id": self.context.dataset_id,
            "export_scope": self.context.export_scope,
            "source_event_id": self.context.source_event_id,
            "correlation_id": self.context.correlation_id,
            "status": self.status,
            "failure_class": self.failure_class,
            "failure_code": self.failure_code,
            "failure_message": self.failure_message,
            "retry_count": self.retry_count,
            "occurred_at": self.occurred_at.isoformat(),
            "metadata": self.metadata,
        }


def build_export_run_outcome(
    context: ExportRunContext,
    *,
    http_status: int | None = None,
    failure_message: str | None = None,
    retry_count: int = 0,
    max_retries: int = 3,
    occurred_at: datetime | None = None,
    metadata: dict[str, Any] | None = None,
) -> ExportRunOutcome:
    """Build an :class:`ExportRunOutcome` from raw export result inputs.

    Parameters
    ----------
    context:
        Run context (tenant, workspace, dataset, scope, event ID).
    http_status:
        HTTP response status from the Power BI REST API; None for success.
    failure_message:
        Human-readable description of the failure; None on success.
    retry_count:
        Attempts consumed so far.
    max_retries:
        Maximum allowed retries before dead-lettering.
    occurred_at:
        UTC timestamp; defaults to ``datetime.now(UTC)``.
    metadata:
        Extra provider-specific audit context.
    """
    if occurred_at is None:
        occurred_at = datetime.now(UTC)
    if metadata is None:
        metadata = {}

    if http_status is None or (200 <= http_status < 300):
        return ExportRunOutcome(
            context=context,
            status="succeeded",
            failure_class=None,
            failure_code=None,
            failure_message=None,
            retry_count=retry_count,
            occurred_at=occurred_at,
            metadata=metadata,
        )

    failure_class = classify_powerbi_failure(http_status)
    failure_code = str(http_status)
    recoverable = is_recoverable_failure(failure_class)

    if not recoverable or retry_count >= max_retries:
        status: Literal["succeeded", "failed", "retrying", "dead_lettered"] = "dead_lettered"
    else:
        status = "retrying"

    return ExportRunOutcome(
        context=context,
        status=status,
        failure_class=failure_class,
        failure_code=failure_code,
        failure_message=failure_message or f"Export failed with HTTP {http_status}",
        retry_count=retry_count,
        occurred_at=occurred_at,
        metadata=metadata,
    )
