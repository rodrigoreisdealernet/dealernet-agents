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

DESCARTES_SCOPES = ("route", "shipment", "compliance")

_SCOPE_PATHS: dict[str, str] = {
    "route": "/v1/routes",
    "shipment": "/v1/shipments",
    "compliance": "/v1/compliance",
}

_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "route": "route_mapping_profile",
    "shipment": "shipment_mapping_profile",
    "compliance": "compliance_profile",
}

_SCOPE_DIRECTION: dict[str, str] = {
    "route": "outbound",
    "shipment": "outbound",
    "compliance": "inbound",
}

_SCOPE_SOURCE_OF_TRUTH: dict[str, str] = {
    "route": "wynne",
    "shipment": "wynne",
    "compliance": "descartes",
}


class DescartesRateLimitError(RuntimeError):
    """Raised when the Descartes API responds with HTTP 429."""


class DescartesAuthError(RuntimeError):
    """Raised for 401/403 auth failures; non-retryable at the workflow layer."""


class DescartesPermanentError(ValueError):
    """Raised for permanent invalid-request/configuration failures."""


class DescartesPersistenceClient(Protocol):
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
            details = _error_body_excerpt(exc)
            detail_suffix = f" ({details})" if details else ""
            raise RuntimeError(
                f"Supabase request failed: {method} {resource} -> HTTP {exc.code}{detail_suffix}"
            ) from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"Supabase request failed: {method} {resource} -> connection error") from exc

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


_persistence_client: DescartesPersistenceClient | None = None


def _get_persistence_client() -> DescartesPersistenceClient:
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


def _error_body_excerpt(exc: urllib_error.HTTPError, *, max_len: int = 256) -> str:
    raw = exc.read()
    if not raw:
        return ""
    try:
        text = raw.decode("utf-8", errors="replace").strip()
    except Exception:  # noqa: BLE001
        return ""
    if not text:
        return ""
    excerpt = " ".join(text.split())
    if len(excerpt) > max_len:
        excerpt = excerpt[:max_len] + "…"
    return excerpt


def _load_integration_config(client: DescartesPersistenceClient, *, tenant_id: str) -> dict[str, Any]:
    rows = client.select(
        "integration_config",
        filters={"tenant_id": tenant_id, "connector_key": "descartes", "enabled": "true"},
        limit=1,
    )
    if not rows:
        raise ValueError("integration_config not found for tenant/connector descartes")
    return rows[0]


def _load_sync_cursor(client: DescartesPersistenceClient, *, tenant_id: str, scope: str) -> str | None:
    rows = client.select(
        "integration_sync_state",
        filters={"tenant_id": tenant_id, "connector_key": "descartes", "scope_key": scope},
        limit=1,
    )
    if not rows:
        return None
    row = rows[0]
    cursor = row.get("cursor")
    if isinstance(cursor, str) and cursor:
        return cursor
    cursor_value = row.get("cursor_value")
    if isinstance(cursor_value, str) and cursor_value:
        return cursor_value
    return None


def _scope_direction(scope: str) -> str:
    return _SCOPE_DIRECTION.get(scope, "outbound")


def _scope_source_of_truth(scope: str) -> str:
    return _SCOPE_SOURCE_OF_TRUTH.get(scope, "wynne")


def _descartes_token(config_snapshot: Mapping[str, Any]) -> str:
    """Resolve the Descartes bearer token.

    In production the secret_ref is resolved from Vault/env.  Priority:
    1. Try the configured secret_ref as env var name (per-tenant/per-connector)
    2. Fall back to DESCARTES_API_TOKEN (backward-compat global credential)

    This ensures per-tenant secret refs take priority over global env vars.
    """
    secret_refs = dict(config_snapshot.get("secret_refs")) if isinstance(config_snapshot.get("secret_refs"), Mapping) else {}
    auth_secret_ref = str(secret_refs.get("auth_secret_ref") or "").strip()
    if not auth_secret_ref.startswith("secret://"):
        raise DescartesAuthError("auth_secret_ref is missing or invalid")

    # Try configured secret_ref as env var name first (per-tenant/per-connector)
    env_name = auth_secret_ref.replace("secret://", "").replace("/", "_").upper()
    token = os.getenv(env_name, "").strip()
    if token:
        return token

    # Fall back to well-known global env var (backward-compat)
    token = os.getenv("DESCARTES_API_TOKEN", "").strip()
    if token:
        return token

    raise DescartesAuthError("Descartes API token not configured")


def _build_api_url(config_snapshot: Mapping[str, Any], scope: str) -> str:
    settings_obj = dict(config_snapshot.get("settings")) if isinstance(config_snapshot.get("settings"), Mapping) else {}
    base_url = str(settings_obj.get("endpoint_base_url") or "").rstrip("/")
    if not base_url:
        raise ValueError("settings.endpoint_base_url is required")
    scope_paths = settings_obj.get("scope_paths")
    if isinstance(scope_paths, Mapping) and isinstance(scope_paths.get(scope), str):
        path = str(scope_paths[scope]).strip()
    else:
        path = _SCOPE_PATHS.get(scope, f"/v1/{scope}")
    return f"{base_url}/{path.lstrip('/')}"


def _classify_http_error(status_code: int) -> str:
    if status_code in {401, 403}:
        return "auth"
    if status_code == 429:
        return "rate_limit"
    if status_code in {404, 422}:
        return "permanent"
    if status_code >= 500:
        return "transient"
    return "permanent"


def _fetch_page_from_descartes(*, url: str, token: str, params: Mapping[str, str], timeout_seconds: int) -> Mapping[str, Any]:
    query = urllib_parse.urlencode(params, doseq=True)
    req = urllib_request.Request(
        url=url if not query else f"{url}?{query}",
        method="GET",
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        details = _error_body_excerpt(exc)
        detail_suffix = f" ({details})" if details else ""
        classification = _classify_http_error(exc.code)
        if classification == "auth":
            raise DescartesAuthError(f"Descartes auth failed: HTTP {exc.code}{detail_suffix}") from exc
        if classification == "rate_limit":
            raise DescartesRateLimitError(f"Descartes rate limited: HTTP {exc.code}{detail_suffix}") from exc
        if classification == "permanent":
            raise DescartesPermanentError(f"Descartes permanent error: HTTP {exc.code}{detail_suffix}") from exc
        raise RuntimeError(f"Descartes transient error: HTTP {exc.code}{detail_suffix}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError("Descartes API unreachable") from exc

    if not raw.strip():
        return {"data": [], "pagination": {}}
    decoded = json.loads(raw)
    return decoded if isinstance(decoded, Mapping) else {"data": decoded, "pagination": {}}


def _apply_descartes_mapping(record: Mapping[str, Any], scope: str, mapping_profile: Mapping[str, Any]) -> dict[str, Any]:
    profile = dict(mapping_profile)
    if scope == "route":
        route_id_src = str(profile.get("route_id_field") or "routeNumber")
        status_src = str(profile.get("status_field") or "status")
        departure_src = str(profile.get("departure_field") or "departureAt")
        return {
            "route_id": record.get(route_id_src),
            "status": record.get(status_src),
            "departure_at": record.get(departure_src),
        }
    if scope == "shipment":
        shipment_id_src = str(profile.get("shipment_id_field") or "shipmentNumber")
        status_src = str(profile.get("status_field") or "status")
        eta_src = str(profile.get("eta_field") or "estimatedArrival")
        return {
            "shipment_id": record.get(shipment_id_src),
            "status": record.get(status_src),
            "estimated_arrival": record.get(eta_src),
        }
    if scope == "compliance":
        compliance_id_src = str(profile.get("compliance_id_field") or "complianceRecordId")
        status_src = str(profile.get("status_field") or "status")
        driver_src = str(profile.get("driver_id_field") or "driverId")
        return {
            "compliance_id": record.get(compliance_id_src),
            "status": record.get(status_src),
            "driver_id": record.get(driver_src),
        }
    return dict(record)


def _external_id_for_record(scope: str, record: Mapping[str, Any], mapping_profile: Mapping[str, Any]) -> str | None:
    """Extract external ID from a record using the mapping profile to determine the source field."""
    profile = dict(mapping_profile)
    if scope == "route":
        id_field = str(profile.get("route_id_field") or "routeNumber")
        return str(record.get(id_field) or record.get("routeId") or record.get("id") or "")
    if scope == "shipment":
        id_field = str(profile.get("shipment_id_field") or "shipmentNumber")
        return str(record.get(id_field) or record.get("shipmentId") or record.get("id") or "")
    if scope == "compliance":
        id_field = str(profile.get("compliance_id_field") or "complianceRecordId")
        return str(record.get(id_field) or record.get("complianceId") or record.get("id") or "")
    return None


def _idempotency_key_for_record(scope: str, external_id: str, record: Mapping[str, Any], mapping_profile: Mapping[str, Any]) -> str:
    """Build an idempotency key using the mapping profile to determine status and timestamp fields."""
    profile = dict(mapping_profile)
    status_field = str(profile.get("status_field") or "status")
    timestamp_field = str(profile.get("timestamp_field") or "updatedAt")

    status = record.get(status_field) or ""
    # Try the configured timestamp field, then fall back to eventTime if not present
    ts = record.get(timestamp_field) or record.get("eventTime") or ""
    return f"descartes:{scope}:{external_id}:{status}:{ts}"


@activity.defn(name="descartes_load_sync_config")
def descartes_load_sync_config(tenant_id: str, scope: str) -> dict[str, Any]:
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
        "direction": _scope_direction(scope),
        "source_of_truth": _scope_source_of_truth(scope),
        "settings": dict(settings_obj) if isinstance(settings_obj, Mapping) else {},
        "mappings": dict(mappings_obj) if isinstance(mappings_obj, Mapping) else {},
        "secret_refs": dict(secret_refs_obj) if isinstance(secret_refs_obj, Mapping) else {},
    }


@activity.defn(name="descartes_fetch_scope_page")
def descartes_fetch_scope_page(
    tenant_id: str,
    scope: str,
    cursor: str | None,
    config_snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    token = _descartes_token(config_snapshot)
    url = _build_api_url(config_snapshot, scope)
    settings_obj = dict(config_snapshot.get("settings")) if isinstance(config_snapshot.get("settings"), Mapping) else {}
    timeout = int(settings_obj.get("sync_timeout_seconds") or settings_obj.get("healthcheck_timeout_seconds") or 30)
    params: dict[str, str] = {"limit": "100"}
    if cursor:
        params["cursor"] = cursor

    response = _fetch_page_from_descartes(url=url, token=token, params=params, timeout_seconds=timeout)
    raw_records = response.get("data")
    if not isinstance(raw_records, list):
        raw_records = response.get("records")
    records = [dict(item) for item in raw_records] if isinstance(raw_records, list) else []
    pagination = response.get("pagination")
    next_cursor: str | None = None
    page_cursor: str | None = None  # provider-derived end cursor for this page
    if isinstance(pagination, Mapping):
        # Look for the current/end cursor for this page
        end_cursor = pagination.get("endCursor") or pagination.get("end_cursor") or pagination.get("currentCursor") or pagination.get("current_cursor")
        if not isinstance(end_cursor, str):
            # Fall back to nextCursor if endCursor not present
            end_cursor = pagination.get("nextCursor") or pagination.get("next_cursor")

        has_next = pagination.get("hasNextPage") or pagination.get("has_next_page")

        if isinstance(end_cursor, str) and end_cursor:
            page_cursor = end_cursor  # always capture when provider provides it
            if has_next:
                next_cursor = end_cursor  # only propagate as "next" when more pages follow

    # Fallback: check response root for next_cursor
    # When next_cursor is present at root level (not in pagination object),
    # treat it as both page_cursor (for advancement) and next_cursor (for continuation)
    if page_cursor is None and next_cursor is None and isinstance(response.get("next_cursor"), str):
        cursor_value = str(response.get("next_cursor"))
        page_cursor = cursor_value
        next_cursor = cursor_value  # propagate as continuation token
    return {
        "tenant_id": tenant_id,
        "scope": scope,
        "records": records,
        "next_cursor": next_cursor,
        "page_cursor": page_cursor,
        "fetched_at": _now_iso(),
    }


@activity.defn(name="descartes_persist_scope_batch")
def descartes_persist_scope_batch(
    tenant_id: str,
    scope: str,
    records: list[dict[str, Any]],
    fetched_at: str,
    mappings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    client = _get_persistence_client()
    upserted = 0
    duplicates = 0

    scope_profile_key = _SCOPE_PROFILE_KEYS.get(scope, "")
    mappings_dict: Mapping[str, Any] = dict(mappings) if isinstance(mappings, Mapping) else {}
    profile_raw = mappings_dict.get(scope_profile_key)
    mapping_profile: Mapping[str, Any] = dict(profile_raw) if isinstance(profile_raw, Mapping) else {}
    direction = _scope_direction(scope)
    source_of_truth = _scope_source_of_truth(scope)

    for record in records:
        external_id = _external_id_for_record(scope, record, mapping_profile)
        if not external_id:
            continue
        idempotency_key = _idempotency_key_for_record(scope, external_id, record, mapping_profile)
        mapped_record = _apply_descartes_mapping(record, scope, mapping_profile)

        existing = client.select(
            "integration_delivery_log",
            filters={
                "tenant_id": tenant_id,
                "connector_key": "descartes",
                "direction": direction,
                "scope_key": scope,
                "idempotency_key": idempotency_key,
            },
            limit=1,
        )
        if existing and existing[0].get("status") in {"received", "processed", "delivered", "succeeded"}:
            duplicates += 1
            continue

        client.upsert(
            "external_id_map",
            {
                "tenant_id": tenant_id,
                "connector_key": "descartes",
                "provider": "descartes",
                "exchange_key": scope,
                "entity_type": scope,
                "external_id": external_id,
                "external_system": "descartes",
                "metadata": {"scope": scope, "last_seen_at": fetched_at},
                "updated_at": _now_iso(),
            },
            on_conflict="tenant_id,connector_key,exchange_key,entity_type,external_id",
        )

        client.upsert(
            "integration_delivery_log",
            {
                "tenant_id": tenant_id,
                "connector_key": "descartes",
                "provider": "descartes",
                "exchange_key": scope,
                "direction": direction,
                "scope_key": scope,
                "source_of_truth": source_of_truth,
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


@activity.defn(name="descartes_advance_sync_cursor")
def descartes_advance_sync_cursor(
    tenant_id: str,
    scope: str,
    cursor: str,
    last_success_at: str,
) -> dict[str, Any]:
    client = _get_persistence_client()
    direction = _scope_direction(scope)
    source_of_truth = _scope_source_of_truth(scope)
    client.upsert(
        "integration_sync_state",
        {
            "tenant_id": tenant_id,
            "connector_key": "descartes",
            "scope_key": scope,
            "source_of_truth": source_of_truth,
            "direction": direction,
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
