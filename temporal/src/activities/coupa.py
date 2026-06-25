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

COUPA_SCOPES = ("requisitions", "purchase_orders", "suppliers", "invoices")

# Coupa REST API paths for each supported scope
_SCOPE_PATHS: dict[str, str] = {
    "requisitions": "/api/requisitions",
    "purchase_orders": "/api/purchase_orders",
    "suppliers": "/api/suppliers",
    "invoices": "/api/invoices",
}

# Mapping from scope name to the mappings-column profile key
_SCOPE_PROFILE_KEYS: dict[str, str] = {
    "requisitions": "requisition_mapping_profile",
    "purchase_orders": "purchase_order_mapping_profile",
    "suppliers": "supplier_mapping_profile",
    "invoices": "invoice_mapping_profile",
}

# Source-of-truth is always Coupa for all procurement scopes (inbound direction)
_DIRECTION = "inbound"
_SOURCE_OF_TRUTH = "coupa"


# ---------------------------------------------------------------------------
# Error types
# ---------------------------------------------------------------------------


class CoupaRateLimitError(RuntimeError):
    """Raised when the Coupa API responds with HTTP 429; signals Temporal to retry."""


class CoupaAuthError(RuntimeError):
    """Raised for 401/403 auth failures; non-retryable at the Temporal level."""


class CoupaMappingError(ValueError):
    """Raised for permanent payload/mapping failures; non-retryable."""


# ---------------------------------------------------------------------------
# Persistence client protocol (reuses the same PostgREST contract as samsara)
# ---------------------------------------------------------------------------


class CoupaPersistenceClient(Protocol):
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
            exc.read()
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

_persistence_client: CoupaPersistenceClient | None = None


def _get_persistence_client() -> CoupaPersistenceClient:
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
    client: CoupaPersistenceClient,
    *,
    tenant_id: str,
) -> dict[str, Any]:
    rows = client.select(
        "integration_config",
        filters={"tenant_id": tenant_id, "connector_key": "coupa", "enabled": "true"},
        limit=1,
    )
    if not rows:
        raise ValueError(f"Coupa integration_config not found or disabled for tenant_id={tenant_id}")
    return dict(rows[0])


def _load_sync_cursor(
    client: CoupaPersistenceClient,
    *,
    tenant_id: str,
    scope: str,
) -> str | None:
    rows = client.select(
        "integration_sync_state",
        filters={
            "tenant_id": tenant_id,
            "connector_key": "coupa",
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


def _coupa_token(config: Mapping[str, Any]) -> str:
    """Resolve the Coupa bearer token from the tenant-scoped secret reference.

    Credentials are resolved *exclusively* from the tenant-configured
    ``client_secret_secret_ref``.  Global environment variable names such as
    ``COUPA_CLIENT_SECRET`` or ``COUPA_API_TOKEN`` are intentionally **not**
    consulted so that shared process-wide credentials cannot be used across
    tenant boundaries.  The function raises :class:`CoupaAuthError` immediately
    when the tenant secret reference is absent or the corresponding secret
    value cannot be resolved — the sync always fails closed rather than
    silently falling back to a cross-tenant credential.
    """
    secret_refs = config.get("secret_refs")
    refs = dict(secret_refs) if isinstance(secret_refs, Mapping) else {}
    client_secret_ref = str(refs.get("client_secret_secret_ref") or "").strip()
    if not client_secret_ref:
        raise CoupaAuthError(
            "Coupa tenant config is missing client_secret_secret_ref; "
            "cannot resolve credentials without a tenant-scoped secret reference"
        )
    # Derive the environment variable name from the tenant-scoped secret ref.
    # Deployments inject each tenant's secret under the name derived from its
    # unique ref path (e.g. "secret://integrations/coupa/acme/client_secret"
    # becomes "INTEGRATIONS_COUPA_ACME_CLIENT_SECRET").
    env_name = client_secret_ref.replace("secret://", "").replace("/", "_").upper()
    token = os.getenv(env_name)
    if not token:
        raise CoupaAuthError(
            f"Coupa bearer token could not be resolved for secret reference "
            f"{client_secret_ref!r}; ensure the secret is injected under "
            f"environment variable {env_name!r}"
        )
    return token


def _build_api_url(config: Mapping[str, Any], scope: str) -> str:
    settings_obj = config.get("settings")
    s = dict(settings_obj) if isinstance(settings_obj, Mapping) else {}
    api_base_url = str(s.get("api_base_url") or "").rstrip("/")
    if not api_base_url:
        raise ValueError("Coupa api_base_url is missing from config settings")
    path = _SCOPE_PATHS.get(scope)
    if not path:
        raise CoupaMappingError(f"Unsupported Coupa scope: {scope}")
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


def _fetch_page_from_coupa(
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
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        exc.read()
        classification = _classify_http_error(exc.code)
        if classification == "auth":
            raise CoupaAuthError(f"Coupa auth failed: HTTP {exc.code}") from exc
        if classification == "rate_limit":
            raise CoupaRateLimitError(f"Coupa rate limited: HTTP {exc.code}") from exc
        if classification in {"configuration", "permanent"}:
            raise CoupaMappingError(f"Coupa permanent error: HTTP {exc.code}") from exc
        raise RuntimeError(f"Coupa connectivity error: HTTP {exc.code}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError("Coupa API unreachable") from exc

    if not raw.strip():
        return {"objects": [], "total_count": 0}
    decoded = json.loads(raw)
    # Coupa REST API returns a list or {"objects": [...], "total_count": N}
    if isinstance(decoded, list):
        return {"objects": decoded, "total_count": len(decoded)}
    if isinstance(decoded, Mapping):
        return dict(decoded)
    return {"objects": [], "total_count": 0}


# ---------------------------------------------------------------------------
# Mapping helpers
# ---------------------------------------------------------------------------


def _apply_coupa_mapping(
    record: Mapping[str, Any],
    scope: str,
    mapping_profile: Mapping[str, Any],
) -> dict[str, Any]:
    """Apply a scope-specific mapping profile to a raw Coupa record.

    Returns a Dealernet-side field dict. Profile keys follow the convention
    ``<dia_concept>_field`` naming the source Coupa field. Falls back to
    scope-specific defaults when a key is absent.
    """
    profile = dict(mapping_profile)

    if scope == "requisitions":
        id_src = str(profile.get("requisition_id_field") or "id")
        status_src = str(profile.get("status_field") or "status")
        requested_by_src = str(profile.get("requested_by_field") or "requested_by")
        total_src = str(profile.get("total_field") or "total")
        created_at_src = str(profile.get("created_at_field") or "created-at")
        return {
            "requisition_id": record.get(id_src),
            "status": record.get(status_src),
            "requested_by": record.get(requested_by_src),
            "total": record.get(total_src),
            "created_at": record.get(created_at_src),
        }

    if scope == "purchase_orders":
        id_src = str(profile.get("purchase_order_id_field") or "id")
        status_src = str(profile.get("status_field") or "status")
        supplier_src = str(profile.get("supplier_id_field") or "supplier")
        total_src = str(profile.get("total_field") or "total")
        created_at_src = str(profile.get("created_at_field") or "created-at")
        supplier_raw = record.get(supplier_src)
        supplier_id = supplier_raw.get("id") if isinstance(supplier_raw, Mapping) else supplier_raw
        return {
            "purchase_order_id": record.get(id_src),
            "status": record.get(status_src),
            "supplier_id": supplier_id,
            "total": record.get(total_src),
            "created_at": record.get(created_at_src),
        }

    if scope == "suppliers":
        id_src = str(profile.get("supplier_id_field") or "id")
        name_src = str(profile.get("name_field") or "name")
        status_src = str(profile.get("status_field") or "status")
        created_at_src = str(profile.get("created_at_field") or "created-at")
        return {
            "supplier_id": record.get(id_src),
            "name": record.get(name_src),
            "status": record.get(status_src),
            "created_at": record.get(created_at_src),
        }

    if scope == "invoices":
        id_src = str(profile.get("invoice_id_field") or "id")
        invoice_number_src = str(profile.get("invoice_number_field") or "invoice-number")
        status_src = str(profile.get("status_field") or "status")
        supplier_src = str(profile.get("supplier_id_field") or "supplier")
        total_src = str(profile.get("total_field") or "total")
        invoice_date_src = str(profile.get("invoice_date_field") or "invoice-date")
        supplier_raw = record.get(supplier_src)
        supplier_id = supplier_raw.get("id") if isinstance(supplier_raw, Mapping) else supplier_raw
        return {
            "invoice_id": record.get(id_src),
            "invoice_number": record.get(invoice_number_src),
            "status": record.get(status_src),
            "supplier_id": supplier_id,
            "total": record.get(total_src),
            "invoice_date": record.get(invoice_date_src),
        }

    return dict(record)


def _external_id_for_record(scope: str, record: Mapping[str, Any]) -> str | None:
    """Extract the Coupa-side external ID from a raw record for the given scope."""
    raw_id = record.get("id")
    if raw_id is not None:
        return str(raw_id)
    return None


def _idempotency_key_for_record(scope: str, external_id: str, record: Mapping[str, Any]) -> str:
    """Build an idempotency key that is stable for the same logical record."""
    updated_at = record.get("updated-at") or record.get("updated_at") or ""
    if updated_at:
        return f"coupa:{scope}:{external_id}:{updated_at}"
    return f"coupa:{scope}:{external_id}"


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


@activity.defn(name="coupa_load_sync_config")
def coupa_load_sync_config(tenant_id: str, scope: str) -> dict[str, Any]:
    """Load integration config and current sync cursor for a given procurement scope.

    Returns a snapshot dict with: settings, mappings, secret_refs, cursor,
    and the list of enabled scopes from the integration config.
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


@activity.defn(name="coupa_fetch_scope_page")
def coupa_fetch_scope_page(
    tenant_id: str,
    scope: str,
    cursor: str | None,
    config_snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    """Fetch one page of procurement data from the Coupa API.

    Uses cursor-based or offset-based pagination depending on what the Coupa
    instance returns.  Coupa REST API supports ``?offset=N&limit=M`` for most
    resources.  An updated-since cursor (ISO timestamp) is used to narrow
    incremental fetches.

    Returns:
        records: list of raw record dicts
        next_cursor: pagination cursor string or None when exhausted
        page_cursor: last cursor seen on this page (used to advance state)
        scope: echo of the scope for downstream activities
        fetched_at: ISO timestamp when the fetch completed
    """
    token = _coupa_token(config_snapshot)
    url = _build_api_url(config_snapshot, scope)
    s = dict(config_snapshot.get("settings") or {}) if isinstance(config_snapshot.get("settings"), Mapping) else {}
    timeout = int(s.get("healthcheck_timeout_seconds") or 30)

    params: dict[str, str] = {"limit": "100"}
    # Coupa supports updated-since filtering via ?updated_at[gt_or_eq]=<ISO timestamp>
    if cursor:
        params["updated_at[gt_or_eq]"] = cursor
    else:
        params["offset"] = "0"

    response = _fetch_page_from_coupa(url=url, token=token, params=params, timeout_seconds=timeout)

    # Coupa returns either a JSON array at the top level or {"objects": [...]}
    raw_objects = response.get("objects")
    if not isinstance(raw_objects, list):
        raw_objects = []
    records: list[dict[str, Any]] = [dict(item) for item in raw_objects if isinstance(item, Mapping)]

    fetched_at = _now_iso()

    # Derive the next cursor from the latest updated-at timestamp in the batch.
    # A non-empty page whose size equals the page limit may have more records.
    next_cursor: str | None = None
    page_cursor: str | None = None
    if records:
        latest_ts = max(
            (str(r.get("updated-at") or r.get("updated_at") or "") for r in records),
            default="",
        )
        if latest_ts:
            page_cursor = latest_ts
            if len(records) >= 100:
                next_cursor = latest_ts

    return {
        "tenant_id": tenant_id,
        "scope": scope,
        "records": records,
        "next_cursor": next_cursor,
        "page_cursor": page_cursor,
        "fetched_at": fetched_at,
    }


@activity.defn(name="coupa_persist_procurement_batch")
def coupa_persist_procurement_batch(
    tenant_id: str,
    scope: str,
    records: list[dict[str, Any]],
    fetched_at: str,
    mappings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist a batch of Coupa procurement records idempotently.

    For each record:
    - Upsert an external_id_map row (alias between Coupa ID and Dealernet tenant scope)
    - Upsert an integration_delivery_log row (deduplication via idempotency key)
      - request_payload: raw provider record
      - response_payload: Dealernet-side mapped record (from scope mapping profile)

    Returns counts of upserted and duplicate records.
    """
    client = _get_persistence_client()
    upserted = 0
    duplicates = 0

    scope_profile_key = _SCOPE_PROFILE_KEYS.get(scope, "")
    mappings_dict: Mapping[str, Any] = dict(mappings) if isinstance(mappings, Mapping) else {}
    profile_raw = mappings_dict.get(scope_profile_key)
    mapping_profile: Mapping[str, Any] = dict(profile_raw) if isinstance(profile_raw, Mapping) else {}

    for record in records:
        external_id = _external_id_for_record(scope, record)
        if not external_id:
            continue
        idempotency_key = _idempotency_key_for_record(scope, external_id, record)

        mapped_record = _apply_coupa_mapping(record, scope, mapping_profile)

        existing = client.select(
            "integration_delivery_log",
            filters={
                "tenant_id": tenant_id,
                "connector_key": "coupa",
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
                "connector_key": "coupa",
                "provider": "coupa",
                "exchange_key": scope,
                "entity_type": scope,
                "external_id": external_id,
                "external_system": "coupa",
                "metadata": {"scope": scope, "last_seen_at": fetched_at},
                "updated_at": _now_iso(),
            },
            on_conflict="tenant_id,connector_key,exchange_key,entity_type,external_id",
        )

        client.upsert(
            "integration_delivery_log",
            {
                "tenant_id": tenant_id,
                "connector_key": "coupa",
                "provider": "coupa",
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


@activity.defn(name="coupa_advance_sync_cursor")
def coupa_advance_sync_cursor(
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
            "connector_key": "coupa",
            "scope_key": scope,
            "source_of_truth": _SOURCE_OF_TRUTH,
            "direction": _DIRECTION,
            "cursor": cursor,
            "cursor_value": cursor,  # mirrors `cursor`; both columns present in schema for cross-connector compat
            "last_success_at": last_success_at,
            "last_synced_at": _now_iso(),
            "state": {"last_cursor": cursor, "scope": scope},
            "updated_at": _now_iso(),
        },
        on_conflict="tenant_id,connector_key,scope_key",
    )
    return {"tenant_id": tenant_id, "scope": scope, "cursor": cursor}
