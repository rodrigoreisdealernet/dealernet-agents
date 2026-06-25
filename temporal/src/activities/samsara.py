from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from temporalio import activity

from ..config import settings

# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

_RETRYABLE_HTTP_STATUSES = {429, 500, 502, 503, 504}
_AUTH_HTTP_STATUSES = {401, 403}
_CONFIG_HTTP_STATUSES = {404, 422}

SAMSARA_SCOPES = ("gps", "hours", "eld", "dashcam_events")

# Samsara API v2 endpoint paths for each supported scope
_SCOPE_PATHS: dict[str, str] = {
    "gps": "/v1/fleet/vehicles/stats",
    "hours": "/v1/fleet/drivers/hours",
    "eld": "/v1/fleet/hos_logs",
    "dashcam_events": "/v1/fleet/safety/events",
}

# Mapping from scope name to the mappings-column profile key
_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "gps": "gps_mapping_profile",
    "hours": "hours_mapping_profile",
    "eld": "eld_profile",
    "dashcam_events": "dashcam_event_profile",
}

# Direction is always inbound for Samsara telemetry (Samsara is source-of-truth)
_DIRECTION = "inbound"
_SOURCE_OF_TRUTH = "samsara"


# ---------------------------------------------------------------------------
# Error types
# ---------------------------------------------------------------------------


class SamsaraRateLimitError(RuntimeError):
    """Raised when the Samsara API responds with HTTP 429; signals Temporal to retry."""


class SamsaraAuthError(RuntimeError):
    """Raised for 401/403 auth failures; non-retryable at the Temporal level."""


class SamsaraMappingError(ValueError):
    """Raised for permanent payload/mapping failures; non-retryable."""


# ---------------------------------------------------------------------------
# Persistence client protocol (reuses the same PostgREST contract as mulesoft)
# ---------------------------------------------------------------------------


class SamsaraPersistenceClient(Protocol):
    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]: ...

    def upsert(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        on_conflict: str,
    ) -> dict[str, Any]: ...

    def update(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, Any],
    ) -> list[dict[str, Any]]: ...


class PostgrestServiceRoleClient:
    def __init__(self, *, base_url: str, service_role_key: str, timeout_seconds: int = 10) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_role_key = service_role_key
        self._timeout_seconds = timeout_seconds

    def _request(
        self,
        method: str,
        resource: str,
        *,
        params: Mapping[str, str] | None = None,
        payload: Mapping[str, Any] | None = None,
        prefer: str | None = None,
    ) -> list[dict[str, Any]]:
        query = f"?{urllib_parse.urlencode(params, safe='.*,()')}" if params else ""
        url = f"{self._base_url}/rest/v1/{resource}{query}"
        headers = {
            "apikey": self._service_role_key,
            "Authorization": "Bearer " + self._service_role_key,
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        req = urllib_request.Request(
            url=url,
            method=method,
            headers=headers,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
        )
        try:
            with urllib_request.urlopen(req, timeout=self._timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib_error.HTTPError as exc:
            exc.read()  # drain response body; do not propagate raw content
            raise RuntimeError(f"Supabase request failed: {method} {resource} \u2192 HTTP {exc.code}") from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"Supabase request failed: {method} {resource} \u2192 connection error") from exc

        if not raw.strip():
            return []
        decoded = json.loads(raw)
        if isinstance(decoded, list):
            return [dict(item) for item in decoded if isinstance(item, Mapping)]
        if isinstance(decoded, Mapping):
            return [dict(decoded)]
        return []

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {"select": columns}
        for key, value in (filters or {}).items():
            if value is None:
                continue
            params[key] = f"eq.{value}"
        if order_by:
            params["order"] = f"{order_by}.{'desc' if descending else 'asc'}"
        if limit is not None:
            params["limit"] = str(limit)
        return self._request("GET", resource, params=params)

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        rows = self._request(
            "POST",
            resource,
            params={"select": "*", "on_conflict": on_conflict},
            payload=payload,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return rows[0] if rows else {}

    def update(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        params = {"select": "*"}
        for key, value in filters.items():
            params[key] = f"eq.{value}"
        return self._request(
            "PATCH",
            resource,
            params=params,
            payload=payload,
            prefer="return=representation",
        )


# ---------------------------------------------------------------------------
# Module-level singletons (injectable for tests)
# ---------------------------------------------------------------------------

_persistence_client: SamsaraPersistenceClient | None = None


def _get_persistence_client() -> SamsaraPersistenceClient:
    global _persistence_client
    if _persistence_client is None:
        _persistence_client = PostgrestServiceRoleClient(
            base_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
            timeout_seconds=int(os.getenv("SUPABASE_HTTP_TIMEOUT_SECONDS", "10")),
        )
    return _persistence_client


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load_integration_config(
    client: SamsaraPersistenceClient,
    *,
    tenant_id: str,
) -> dict[str, Any]:
    rows = client.select(
        "integration_config",
        filters={"tenant_id": tenant_id, "connector_key": "samsara", "enabled": "true"},
        limit=1,
    )
    if not rows:
        raise ValueError(f"Samsara integration_config not found or disabled for tenant_id={tenant_id}")
    return dict(rows[0])


def _load_sync_cursor(
    client: SamsaraPersistenceClient,
    *,
    tenant_id: str,
    scope: str,
) -> str | None:
    rows = client.select(
        "integration_sync_state",
        filters={
            "tenant_id": tenant_id,
            "connector_key": "samsara",
            "scope_key": scope,
        },
        limit=1,
    )
    if not rows:
        return None
    cursor_value = rows[0].get("cursor_value")
    if isinstance(cursor_value, str) and cursor_value:
        return cursor_value
    cursor = rows[0].get("cursor")
    if isinstance(cursor, str) and cursor:
        return cursor
    return None


def _samsara_token(config: Mapping[str, Any]) -> str:
    """Resolve the Samsara bearer token.

    In production the secret_ref is resolved from Vault/env.  For now we
    accept the token directly from a well-known environment variable whose
    name is stored in secret_refs, falling back to the secret_ref path itself
    for deployments that inject env vars by secret ref name.
    """
    secret_refs = config.get("secret_refs")
    refs = dict(secret_refs) if isinstance(secret_refs, Mapping) else {}
    api_secret_ref = str(refs.get("api_secret_ref") or "")
    # Try a well-known env var name first (set at deploy time)
    token = os.getenv("SAMSARA_API_TOKEN") or os.getenv("SAMSARA_API_KEY")
    if token:
        return token
    # Allow tests / dev to inject via secret_ref as env var name
    env_name = api_secret_ref.replace("secret://", "").replace("/", "_").upper()
    token = os.getenv(env_name)
    if token:
        return token
    raise SamsaraAuthError("Samsara API token not configured")


def _build_api_url(config: Mapping[str, Any], scope: str) -> str:
    settings_obj = config.get("settings")
    s = dict(settings_obj) if isinstance(settings_obj, Mapping) else {}
    api_base_url = str(s.get("api_base_url") or "").rstrip("/")
    if not api_base_url:
        raise ValueError("Samsara api_base_url is missing from config settings")
    path = _SCOPE_PATHS.get(scope)
    if not path:
        raise SamsaraMappingError(f"Unsupported Samsara scope: {scope}")
    return api_base_url + path


def _classify_http_error(code: int) -> str:
    if code in _AUTH_HTTP_STATUSES:
        return "auth"
    if code == 429:
        return "rate_limit"
    if code in _CONFIG_HTTP_STATUSES:
        return "configuration"
    if code >= 500:
        return "connectivity"
    return "permanent"


def _fetch_page_from_samsara(
    *,
    url: str,
    token: str,
    params: dict[str, str],
    timeout_seconds: int,
) -> dict[str, Any]:
    query = "?" + urllib_parse.urlencode(params) if params else ""
    req = urllib_request.Request(
        url=url + query,
        method="GET",
        headers={"Authorization": "Token " + token, "Accept": "application/json"},
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        exc.read()  # drain response body; do not propagate raw content
        classification = _classify_http_error(exc.code)
        if classification == "auth":
            raise SamsaraAuthError(f"Samsara auth failed: HTTP {exc.code}") from exc
        if classification == "rate_limit":
            raise SamsaraRateLimitError(f"Samsara rate limited: HTTP {exc.code}") from exc
        if classification in {"configuration", "permanent"}:
            raise SamsaraMappingError(f"Samsara permanent error: HTTP {exc.code}") from exc
        raise RuntimeError(f"Samsara connectivity error: HTTP {exc.code}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError("Samsara API unreachable") from exc

    if not raw.strip():
        return {"data": [], "pagination": {}}
    decoded = json.loads(raw)
    return decoded if isinstance(decoded, Mapping) else {"data": decoded, "pagination": {}}


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


@activity.defn(name="samsara_load_sync_config")
def samsara_load_sync_config(tenant_id: str, scope: str) -> dict[str, Any]:
    """Load integration config and current sync cursor for a given scope.

    Returns a snapshot dict with: settings, mappings, secret_refs, and cursor.
    """
    client = _get_persistence_client()
    config = _load_integration_config(client, tenant_id=tenant_id)
    cursor = _load_sync_cursor(client, tenant_id=tenant_id, scope=scope)
    settings_obj = config.get("settings")
    mappings_obj = config.get("mappings")
    secret_refs_obj = config.get("secret_refs")
    enabled_scopes_raw = (dict(settings_obj) if isinstance(settings_obj, Mapping) else {}).get("enabled_scopes")
    enabled_scopes: list[str] = list(enabled_scopes_raw) if isinstance(enabled_scopes_raw, list) else []
    return {
        "tenant_id": tenant_id,
        "scope": scope,
        "cursor": cursor,
        "enabled_scopes": enabled_scopes,
        "settings": dict(settings_obj) if isinstance(settings_obj, Mapping) else {},
        "mappings": dict(mappings_obj) if isinstance(mappings_obj, Mapping) else {},
        "secret_refs": dict(secret_refs_obj) if isinstance(secret_refs_obj, Mapping) else {},
    }


@activity.defn(name="samsara_fetch_scope_page")
def samsara_fetch_scope_page(
    tenant_id: str,
    scope: str,
    cursor: str | None,
    config_snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    """Fetch one page of telemetry data from the Samsara API.

    Returns:
        records: list of raw record dicts
        next_cursor: pagination cursor string or None when exhausted
        scope: echo of the scope for downstream activities
    """
    token = _samsara_token(config_snapshot)
    url = _build_api_url(config_snapshot, scope)
    timeout = int((dict(config_snapshot.get("settings")) if isinstance(config_snapshot.get("settings"), Mapping) else {}).get("healthcheck_timeout_seconds") or 30)

    fleet_targeting = (dict(config_snapshot.get("settings")) if isinstance(config_snapshot.get("settings"), Mapping) else {}).get("fleet_targeting") or {}
    params: dict[str, str] = {"limit": "100"}
    group_ids = fleet_targeting.get("group_ids") if isinstance(fleet_targeting, Mapping) else None
    if isinstance(group_ids, list) and group_ids:
        params["groupId"] = str(group_ids[0])
    if cursor:
        params["after"] = cursor

    response = _fetch_page_from_samsara(url=url, token=token, params=params, timeout_seconds=timeout)
    raw_data = response.get("data")
    records: list[dict[str, Any]] = []
    if isinstance(raw_data, list):
        records = [dict(item) for item in raw_data if isinstance(item, Mapping)]

    pagination = response.get("pagination")
    next_cursor: str | None = None
    page_cursor: str | None = None  # provider-derived end cursor for this page
    if isinstance(pagination, Mapping):
        end_cursor = pagination.get("endCursor")
        has_next = pagination.get("hasNextPage")
        if isinstance(end_cursor, str) and end_cursor:
            page_cursor = end_cursor  # always capture when Samsara provides it
            if has_next:
                next_cursor = end_cursor  # only propagate as "next" when more pages follow

    return {
        "tenant_id": tenant_id,
        "scope": scope,
        "records": records,
        "next_cursor": next_cursor,
        "page_cursor": page_cursor,
        "fetched_at": _now_iso(),
    }


def _apply_samsara_mapping(
    record: Mapping[str, Any],
    scope: str,
    mapping_profile: Mapping[str, Any],
) -> dict[str, Any]:
    """Apply a scope-specific mapping profile to a raw Samsara record.

    Returns a Dealernet-side field dict. Profile keys follow the convention
    ``<dia_concept>_field`` naming the source Samsara field. Falls back to
    scope-specific defaults when a key is absent.
    """
    profile = dict(mapping_profile)

    if scope == "gps":
        asset_id_src = str(profile.get("asset_id_field") or "vehicleId")
        lat_src = str(profile.get("lat_field") or "latitude")
        lon_src = str(profile.get("lon_field") or "longitude")
        ts_src = str(profile.get("timestamp_field") or "time")
        return {
            "asset_id": record.get(asset_id_src),
            "lat": record.get(lat_src),
            "lon": record.get(lon_src),
            "ts": record.get(ts_src),
        }

    if scope == "hours":
        driver_id_src = str(profile.get("driver_id_field") or "driverId")
        hours_src = str(profile.get("hours_field") or "hoursWorked")
        period_src = str(profile.get("period_field") or "period")
        return {
            "driver_id": record.get(driver_id_src),
            "hours": record.get(hours_src),
            "period": record.get(period_src),
        }

    if scope == "eld":
        driver_id_src = str(profile.get("driver_id_field") or "driverId")
        log_id_src = str(profile.get("log_id_field") or "logId")
        status_src = str(profile.get("status_field") or "status")
        start_time_src = str(profile.get("start_time_field") or "startTime")
        mapped: dict[str, Any] = {
            "driver_id": record.get(driver_id_src),
            "log_id": record.get(log_id_src),
            "status": record.get(status_src),
            "start_time": record.get(start_time_src),
        }
        hos_mode = profile.get("hos_mode")
        if hos_mode is not None:
            mapped["hos_mode"] = hos_mode
        return mapped

    if scope == "dashcam_events":
        event_id_src = str(profile.get("event_id_field") or "eventId")
        event_type_src = str(profile.get("event_type_field") or "type")
        ts_src = str(profile.get("timestamp_field") or "eventMs")
        mapped = {
            "event_id": record.get(event_id_src),
            "event_type": record.get(event_type_src),
            "ts": record.get(ts_src),
        }
        event_types_filter = profile.get("event_types")
        if isinstance(event_types_filter, list):
            mapped["event_types_filter"] = list(event_types_filter)
        return mapped

    return dict(record)


def _external_id_for_record(scope: str, record: Mapping[str, Any]) -> str | None:
    """Extract the Samsara-side external ID from a raw record for the given scope."""
    if scope == "gps":
        return str(record.get("vehicleId") or record.get("id") or "")
    if scope == "hours":
        return str(record.get("driverId") or record.get("id") or "")
    if scope == "eld":
        return str(record.get("logId") or record.get("id") or "")
    if scope == "dashcam_events":
        return str(record.get("eventId") or record.get("id") or "")
    return None


def _idempotency_key_for_record(scope: str, external_id: str, record: Mapping[str, Any]) -> str:
    """Build an idempotency key that is stable for the same logical record."""
    if scope == "gps":
        ts = record.get("time") or record.get("updatedAtTime") or ""
        return f"samsara:{scope}:{external_id}:{ts}"
    if scope == "hours":
        period = record.get("period") or record.get("startedAt") or ""
        return f"samsara:{scope}:{external_id}:{period}"
    if scope == "eld":
        log_ts = record.get("startTime") or record.get("createdAt") or ""
        return f"samsara:{scope}:{external_id}:{log_ts}"
    if scope == "dashcam_events":
        event_ts = record.get("eventMs") or record.get("occurredAt") or ""
        return f"samsara:{scope}:{external_id}:{event_ts}"
    return f"samsara:{scope}:{external_id}"


@activity.defn(name="samsara_persist_telemetry_batch")
def samsara_persist_telemetry_batch(
    tenant_id: str,
    scope: str,
    records: list[dict[str, Any]],
    fetched_at: str,
    mappings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist a batch of Samsara telemetry records idempotently.

    For each record:
    - Upsert an external_id_map row (alias between Samsara ID and Dealernet tenant scope)
    - Upsert an integration_delivery_log row (deduplication via idempotency key)
      - request_payload: raw provider record
      - response_payload: Dealernet-side mapped record (from scope mapping profile)

    Returns counts of upserted and duplicate records.
    """
    client = _get_persistence_client()
    upserted = 0
    duplicates = 0

    # Resolve the mapping profile for this scope from the provided mappings dict
    scope_profile_key = _SCOPE_PROFILE_KEYS.get(scope, "")
    mappings_dict: Mapping[str, Any] = dict(mappings) if isinstance(mappings, Mapping) else {}
    profile_raw = mappings_dict.get(scope_profile_key)
    mapping_profile: Mapping[str, Any] = dict(profile_raw) if isinstance(profile_raw, Mapping) else {}

    for record in records:
        external_id = _external_id_for_record(scope, record)
        if not external_id:
            continue
        idempotency_key = _idempotency_key_for_record(scope, external_id, record)

        # Apply mapping profile to produce Dealernet-side payload
        mapped_record = _apply_samsara_mapping(record, scope, mapping_profile)

        existing = client.select(
            "integration_delivery_log",
            filters={
                "tenant_id": tenant_id,
                "connector_key": "samsara",
                "direction": _DIRECTION,
                "scope_key": scope,
                "idempotency_key": idempotency_key,
            },
            limit=1,
        )
        if existing and existing[0].get("status") in {"received", "processed"}:
            duplicates += 1
            continue

        client.upsert(
            "external_id_map",
            {
                "tenant_id": tenant_id,
                "connector_key": "samsara",
                "provider": "samsara",
                "exchange_key": scope,
                "entity_type": scope,
                "external_id": external_id,
                "external_system": "samsara",
                "metadata": {"scope": scope, "last_seen_at": fetched_at},
                "updated_at": _now_iso(),
            },
            on_conflict="tenant_id,connector_key,exchange_key,entity_type,external_id",
        )

        client.upsert(
            "integration_delivery_log",
            {
                "tenant_id": tenant_id,
                "connector_key": "samsara",
                "provider": "samsara",
                "exchange_key": scope,
                "direction": _DIRECTION,
                "scope_key": scope,
                "source_of_truth": _SOURCE_OF_TRUTH,
                "idempotency_key": idempotency_key,
                "status": "received",
                "request_payload": record,
                "response_payload": mapped_record,
                "received_at": fetched_at,
                "updated_at": _now_iso(),
            },
            on_conflict="tenant_id,connector_key,direction,exchange_key,idempotency_key",
        )
        upserted += 1

    return {
        "tenant_id": tenant_id,
        "scope": scope,
        "upserted": upserted,
        "duplicates": duplicates,
        "total": len(records),
    }


@activity.defn(name="samsara_advance_sync_cursor")
def samsara_advance_sync_cursor(
    tenant_id: str,
    scope: str,
    cursor: str,
    last_success_at: str,
) -> dict[str, Any]:
    """Persist the new pagination cursor to integration_sync_state.

    Called after a page of records has been successfully persisted so that
    future runs or retries resume from the correct position.
    """
    client = _get_persistence_client()
    client.upsert(
        "integration_sync_state",
        {
            "tenant_id": tenant_id,
            "connector_key": "samsara",
            "scope_key": scope,
            "source_of_truth": _SOURCE_OF_TRUTH,
            "direction": _DIRECTION,
            "cursor": cursor,
            "cursor_value": cursor,
            "last_success_at": last_success_at,
            "last_synced_at": _now_iso(),
            "state": {"last_cursor": cursor, "scope": scope},
            "updated_at": _now_iso(),
        },
        on_conflict="tenant_id,connector_key,scope_key",
    )
    return {"tenant_id": tenant_id, "scope": scope, "cursor": cursor}
