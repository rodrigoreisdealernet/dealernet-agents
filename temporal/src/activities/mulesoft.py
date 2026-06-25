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
from ..integrations.mulesoft import MuleSoftCallbackReceipt, build_outbound_payload, get_exchange_definition


class MuleSoftPersistenceClient(Protocol):
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

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]: ...

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


class MuleSoftTransport(Protocol):
    def send(self, *, url: str, headers: Mapping[str, str], payload: Mapping[str, Any]) -> dict[str, Any]: ...


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
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Supabase request failed ({method} {resource}): {exc.code} {detail}") from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"Supabase request failed ({method} {resource}): {exc}") from exc

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

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        rows = self._request(
            "POST",
            resource,
            params={"select": "*"},
            payload=payload,
            prefer="return=representation",
        )
        return rows[0] if rows else {}

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


class HttpMuleSoftTransport:
    def __init__(self, *, timeout_seconds: int = 10) -> None:
        self._timeout_seconds = timeout_seconds

    def send(self, *, url: str, headers: Mapping[str, str], payload: Mapping[str, Any]) -> dict[str, Any]:
        req = urllib_request.Request(
            url=url,
            method="POST",
            headers={**dict(headers), "Content-Type": "application/json"},
            data=json.dumps(payload).encode("utf-8"),
        )
        try:
            with urllib_request.urlopen(req, timeout=self._timeout_seconds) as response:
                raw = response.read().decode("utf-8")
                body = json.loads(raw) if raw.strip() else {}
                if not isinstance(body, dict):
                    body = {"raw": body}
                return {
                    "http_status": response.status,
                    "status": "sent",
                    "body": body,
                }
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            body = json.loads(detail) if detail.strip().startswith("{") else {"detail": detail}
            if 400 <= exc.code < 500:
                raise ValueError(f"MuleSoft rejected request ({exc.code})") from exc
            raise RuntimeError(f"MuleSoft request failed ({exc.code})") from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"MuleSoft unavailable: {exc}") from exc


_persistence_client: MuleSoftPersistenceClient | None = None
_transport: MuleSoftTransport | None = None


def _get_persistence_client() -> MuleSoftPersistenceClient:
    global _persistence_client
    if _persistence_client is None:
        _persistence_client = PostgrestServiceRoleClient(
            base_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
            timeout_seconds=int(os.getenv("SUPABASE_HTTP_TIMEOUT_SECONDS", "10")),
        )
    return _persistence_client


def _get_transport() -> MuleSoftTransport:
    global _transport
    if _transport is None:
        _transport = HttpMuleSoftTransport(timeout_seconds=int(os.getenv("MULESOFT_HTTP_TIMEOUT_SECONDS", "10")))
    return _transport


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _load_integration_config(client: MuleSoftPersistenceClient, *, tenant_id: str) -> dict[str, Any]:
    rows = client.select(
        "integration_config",
        filters={"tenant_id": tenant_id, "connector_key": "mulesoft", "enabled": "true"},
        limit=1,
    )
    if not rows:
        raise ValueError(f"MuleSoft integration_config not found for tenant_id={tenant_id}")
    return rows[0]


def _load_current_entity(
    client: MuleSoftPersistenceClient,
    *,
    entity_id: str,
) -> tuple[str, int, dict[str, Any]]:
    rows = client.select(
        "entities",
        columns="id,entity_type,entity_versions!inner(version_number,data,is_current)",
        filters={"id": entity_id, "entity_versions.is_current": "true"},
        limit=1,
    )
    if not rows:
        raise ValueError(f"Entity not found: {entity_id}")
    row = rows[0]
    entity_type = str(row.get("entity_type") or "")
    versions = row.get("entity_versions")
    if not entity_type or not isinstance(versions, list) or not versions or not isinstance(versions[0], Mapping):
        raise ValueError(f"Current entity version missing for entity_id={entity_id}")
    version = versions[0]
    version_number = version.get("version_number")
    data = version.get("data")
    if not isinstance(version_number, int) or not isinstance(data, Mapping):
        raise ValueError(f"Invalid current entity version for entity_id={entity_id}")
    return entity_type, version_number, dict(data)


def _load_external_alias(
    client: MuleSoftPersistenceClient,
    *,
    tenant_id: str,
    exchange_key: str,
    entity_type: str,
    entity_id: str,
) -> str | None:
    rows = client.select(
        "external_id_map",
        filters={
            "tenant_id": tenant_id,
            "connector_key": "mulesoft",
            "exchange_key": exchange_key,
            "entity_type": entity_type,
            "entity_id": entity_id,
        },
        limit=1,
    )
    if not rows:
        return None
    external_id = rows[0].get("external_id")
    return str(external_id) if isinstance(external_id, str) and external_id else None


def _mulesoft_headers(config: Mapping[str, Any]) -> dict[str, str]:
    settings_payload = dict(config.get("settings")) if isinstance(config.get("settings"), Mapping) else {}
    secret_refs = config.get("secret_refs")
    refs = dict(secret_refs) if isinstance(secret_refs, Mapping) else {}
    api_key_env = refs.get("api_key_env")
    headers: dict[str, str] = {}
    if isinstance(api_key_env, str) and api_key_env:
        api_key = os.getenv(api_key_env)
        if not api_key:
            raise ValueError(f"MuleSoft API key env var is missing: {api_key_env}")
        auth_header = settings_payload.get("auth_header")
        header_name = str(auth_header or "X-API-Key")
        headers[header_name] = api_key
    return headers


@activity.defn
def mulesoft_prepare_outbound_delivery(
    tenant_id: str,
    exchange_key: str,
    entity_id: str,
    replay_token: str | None = None,
) -> dict[str, Any]:
    client = _get_persistence_client()
    config = _load_integration_config(client, tenant_id=tenant_id)
    definition = get_exchange_definition(exchange_key)
    entity_type, version_number, data = _load_current_entity(client, entity_id=entity_id)
    if entity_type != definition.entity_type:
        raise ValueError(
            f"Exchange {exchange_key} expects entity_type={definition.entity_type}, got entity_type={entity_type}"
        )

    external_id = _load_external_alias(
        client,
        tenant_id=tenant_id,
        exchange_key=exchange_key,
        entity_type=entity_type,
        entity_id=entity_id,
    )
    payload = build_outbound_payload(
        exchange_key=exchange_key,
        entity_id=entity_id,
        version_number=version_number,
        data=data,
        external_id=external_id,
    )
    base_idempotency_key = f"{exchange_key}:{entity_id}:v{version_number}"
    idempotency_key = base_idempotency_key if not replay_token else f"{base_idempotency_key}:replay:{replay_token}"
    existing = client.select(
        "integration_delivery_log",
        filters={
            "tenant_id": tenant_id,
            "connector_key": "mulesoft",
            "direction": "outbound",
            "exchange_key": exchange_key,
            "idempotency_key": idempotency_key,
        },
        limit=1,
    )
    if existing and str(existing[0].get("status") or "") == "sent":
        return {
            "skip": True,
            "delivery_log_id": existing[0].get("id"),
            "idempotency_key": idempotency_key,
            "entity_id": entity_id,
            "exchange_key": exchange_key,
        }

    settings_payload = dict(config.get("settings")) if isinstance(config.get("settings"), Mapping) else {}
    exchange_paths = (
        dict(settings_payload.get("exchange_paths"))
        if isinstance(settings_payload.get("exchange_paths"), Mapping)
        else {}
    )
    path = exchange_paths.get(exchange_key)
    if not isinstance(path, str) or not path:
        raise ValueError(f"MuleSoft exchange path missing for {exchange_key}")
    base_url = settings_payload.get("base_url")
    if not isinstance(base_url, str) or not base_url:
        raise ValueError("MuleSoft base_url is required")

    log_row = client.upsert(
        "integration_delivery_log",
        {
            "tenant_id": tenant_id,
            "connector_key": "mulesoft",
            "exchange_key": exchange_key,
            "direction": "outbound",
            "scope_key": f"{exchange_key}:{entity_id}",
            "entity_type": entity_type,
            "entity_id": entity_id,
            "source_of_truth": definition.source_of_truth,
            "idempotency_key": idempotency_key,
            "status": "pending",
            "request_payload": payload,
            "received_at": _now_iso(),
        },
        on_conflict="tenant_id,connector_key,direction,exchange_key,idempotency_key",
    )
    return {
        "skip": False,
        "delivery_log_id": log_row.get("id"),
        "tenant_id": tenant_id,
        "exchange_key": exchange_key,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "version_number": version_number,
        "idempotency_key": idempotency_key,
        "url": base_url.rstrip("/") + path,
        "headers": _mulesoft_headers(config),
        "payload": payload,
        "source_of_truth": definition.source_of_truth,
        "scope_key": f"{exchange_key}:{entity_id}",
    }


@activity.defn
def mulesoft_send_outbound_delivery(prepared: Mapping[str, Any]) -> dict[str, Any]:
    if prepared.get("skip") is True:
        return {
            "entity_id": prepared.get("entity_id"),
            "exchange_key": prepared.get("exchange_key"),
            "status": "skipped",
            "delivery_log_id": prepared.get("delivery_log_id"),
        }

    client = _get_persistence_client()
    transport = _get_transport()
    delivery_log_id = str(prepared.get("delivery_log_id") or "")
    try:
        response = transport.send(
            url=str(prepared.get("url") or ""),
            headers=dict(prepared.get("headers") or {}),
            payload=dict(prepared.get("payload") or {}),
        )
    except Exception as exc:
        client.update(
            "integration_delivery_log",
            {
                "status": "failed",
                "error_message": str(exc),
                "updated_at": _now_iso(),
            },
            filters={"id": delivery_log_id},
        )
        raise

    response_body = dict(response.get("body")) if isinstance(response.get("body"), Mapping) else {}
    client.update(
        "integration_delivery_log",
        {
            "status": "sent",
            "http_status": int(response.get("http_status") or 200),
            "response_payload": response_body,
            "delivered_at": _now_iso(),
            "updated_at": _now_iso(),
        },
        filters={"id": delivery_log_id},
    )

    external_id = response_body.get("externalId")
    if isinstance(external_id, str) and external_id:
        client.upsert(
            "external_id_map",
            {
                "tenant_id": prepared.get("tenant_id"),
                "connector_key": "mulesoft",
                "exchange_key": prepared.get("exchange_key"),
                "entity_type": prepared.get("entity_type"),
                "entity_id": prepared.get("entity_id"),
                "external_id": external_id,
                "metadata": {"delivery_log_id": delivery_log_id},
                "updated_at": _now_iso(),
            },
            on_conflict="tenant_id,connector_key,exchange_key,entity_type,entity_id",
        )

    client.upsert(
        "integration_sync_state",
        {
            "tenant_id": prepared.get("tenant_id"),
            "connector_key": "mulesoft",
            "exchange_key": prepared.get("exchange_key"),
            "scope_key": prepared.get("scope_key"),
            "source_of_truth": prepared.get("source_of_truth"),
            "direction": "outbound",
            "cursor": str(prepared.get("version_number") or ""),
            "last_success_at": _now_iso(),
            "state": {
                "last_delivery_log_id": delivery_log_id,
                "last_http_status": int(response.get("http_status") or 200),
                "last_idempotency_key": prepared.get("idempotency_key"),
            },
            "updated_at": _now_iso(),
        },
        on_conflict="tenant_id,connector_key,exchange_key,scope_key",
    )
    return {
        "entity_id": prepared.get("entity_id"),
        "exchange_key": prepared.get("exchange_key"),
        "status": "sent",
        "delivery_log_id": delivery_log_id,
        "external_id": external_id,
    }


@activity.defn
def mulesoft_process_inbound_callback(
    tenant_id: str,
    delivery_log_id: str,
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    client = _get_persistence_client()
    receipt = MuleSoftCallbackReceipt.model_validate(dict(payload))
    client.update(
        "integration_delivery_log",
        {
            "status": "processed",
            "provider_delivery_id": receipt.delivery_id,
            "response_payload": receipt.model_dump(mode="json"),
            "delivered_at": receipt.received_at.astimezone(UTC).isoformat(),
            "updated_at": _now_iso(),
        },
        filters={"id": delivery_log_id},
    )

    if receipt.external_id:
        client.upsert(
            "external_id_map",
            {
                "tenant_id": tenant_id,
                "connector_key": "mulesoft",
                "exchange_key": receipt.subject_exchange_key,
                "entity_type": receipt.entity_type,
                "entity_id": receipt.entity_id,
                "external_id": receipt.external_id,
                "metadata": {
                    "last_delivery_id": receipt.delivery_id,
                    "status": receipt.status,
                },
                "updated_at": _now_iso(),
            },
            on_conflict="tenant_id,connector_key,exchange_key,entity_type,entity_id",
        )

    client.upsert(
        "integration_sync_state",
        {
            "tenant_id": tenant_id,
            "connector_key": "mulesoft",
            "exchange_key": receipt.subject_exchange_key,
            "scope_key": f"{receipt.subject_exchange_key}:{receipt.entity_id}",
            "source_of_truth": "mulesoft",
            "direction": "inbound",
            "cursor": receipt.cursor or receipt.delivery_id,
            "last_success_at": receipt.received_at.astimezone(UTC).isoformat(),
            "state": {
                "delivery_log_id": delivery_log_id,
                "delivery_status": receipt.status,
                "message": receipt.message,
                "provider_delivery_id": receipt.delivery_id,
            },
            "updated_at": _now_iso(),
        },
        on_conflict="tenant_id,connector_key,exchange_key,scope_key",
    )
    return {
        "status": "processed",
        "delivery_id": receipt.delivery_id,
        "subject_exchange_key": receipt.subject_exchange_key,
        "entity_id": receipt.entity_id,
    }
