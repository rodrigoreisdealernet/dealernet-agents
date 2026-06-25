from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import descartes_sync


class _FakePersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "integration_config": [
                {
                    "id": str(uuid4()),
                    "tenant_id": "tenant-a",
                    "connector_key": "descartes",
                    "enabled": True,
                    "settings": {
                        "endpoint_base_url": "https://api.descartes.example",
                        "enabled_scopes": ["route", "shipment", "compliance"],
                        "healthcheck_timeout_seconds": 5,
                    },
                    "mappings": {
                        "route_mapping_profile": {"route_id_field": "routeNumber"},
                        "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
                        "compliance_profile": {"compliance_id_field": "complianceRecordId"},
                    },
                    "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
                }
            ],
            "integration_sync_state": [],
            "integration_delivery_log": [],
            "external_id_map": [],
        }

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
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        result: list[dict[str, Any]] = []
        for row in rows:
            keep = True
            for key, value in (filters or {}).items():
                row_value = row.get(key)
                if isinstance(row_value, bool):
                    expected = str(value).strip().lower()
                    if (row_value and expected != "true") or ((not row_value) and expected != "false"):
                        keep = False
                        break
                    continue
                if str(row_value) != str(value):
                    keep = False
                    break
            if keep:
                result.append(row)
        if limit is not None:
            result = result[:limit]
        return result

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        keys = [k.strip() for k in on_conflict.split(",")]
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(str(existing.get(k)) == str(row.get(k)) for k in keys):
                merged = {**existing, **row}
                merged["id"] = existing.get("id") or row["id"]
                table[idx] = merged
                return merged
        table.append(row)
        return row

    def update(self, resource: str, payload: Mapping[str, Any], *, filters: Mapping[str, Any]) -> list[dict[str, Any]]:
        updated: list[dict[str, Any]] = []
        table = self.tables.setdefault(resource, [])
        for idx, row in enumerate(table):
            if all(str(row.get(k)) == str(v) for k, v in filters.items()):
                merged = {**row, **dict(payload)}
                table[idx] = merged
                updated.append(merged)
        return updated


@pytest.fixture()
def fake_client(monkeypatch: pytest.MonkeyPatch) -> _FakePersistenceClient:
    client = _FakePersistenceClient()
    monkeypatch.setattr(descartes_sync, "_persistence_client", client)
    return client


def _route_record(route_number: str = "route-1") -> dict[str, Any]:
    return {"routeNumber": route_number, "status": "dispatched", "updatedAt": "2026-06-12T00:00:00Z"}


def _compliance_record(record_id: str = "cmp-1") -> dict[str, Any]:
    return {"complianceRecordId": record_id, "status": "compliant", "updatedAt": "2026-06-12T00:00:00Z"}


def test_load_sync_config_returns_scope_direction_and_source(fake_client: _FakePersistenceClient) -> None:
    result = descartes_sync.descartes_load_sync_config("tenant-a", "compliance")
    assert result["direction"] == "inbound"
    assert result["source_of_truth"] == "descartes"
    assert result["enabled_scopes"] == ["route", "shipment", "compliance"]


def test_persist_route_batch_writes_alias_and_delivery_log(fake_client: _FakePersistenceClient) -> None:
    result = descartes_sync.descartes_persist_scope_batch(
        "tenant-a", "route", [_route_record()], "2026-06-12T00:00:00Z"
    )
    assert result["upserted"] == 1
    alias_rows = fake_client.tables["external_id_map"]
    assert alias_rows[0]["external_id"] == "route-1"
    assert alias_rows[0]["connector_key"] == "descartes"
    log_rows = fake_client.tables["integration_delivery_log"]
    assert log_rows[0]["direction"] == "outbound"
    assert log_rows[0]["source_of_truth"] == "dia"


def test_persist_batch_deduplicates_on_idempotency_key(fake_client: _FakePersistenceClient) -> None:
    record = _compliance_record()
    descartes_sync.descartes_persist_scope_batch("tenant-a", "compliance", [record], "2026-06-12T00:00:00Z")
    result = descartes_sync.descartes_persist_scope_batch("tenant-a", "compliance", [record], "2026-06-12T00:00:00Z")
    assert result["duplicates"] == 1
    assert result["upserted"] == 0
    assert len(fake_client.tables["integration_delivery_log"]) == 1


def test_advance_sync_cursor_writes_integration_sync_state(fake_client: _FakePersistenceClient) -> None:
    result = descartes_sync.descartes_advance_sync_cursor(
        "tenant-a", "route", "cursor-123", "2026-06-12T00:00:00Z"
    )
    assert result["cursor"] == "cursor-123"
    state_rows = fake_client.tables["integration_sync_state"]
    assert len(state_rows) == 1
    assert state_rows[0]["direction"] == "outbound"
    assert state_rows[0]["source_of_truth"] == "dia"


def test_classify_http_error_mapping() -> None:
    assert descartes_sync._classify_http_error(429) == "rate_limit"
    assert descartes_sync._classify_http_error(401) == "auth"
    assert descartes_sync._classify_http_error(422) == "permanent"


def test_descartes_token_resolution_prioritizes_configured_secret_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify configured secret-ref-derived env var takes priority over global DESCARTES_API_TOKEN."""
    monkeypatch.setenv("INTEGRATIONS_DESCARTES_TOKEN", "tenant-specific-token-456")
    monkeypatch.setenv("DESCARTES_API_TOKEN", "global-token-123")
    config = {"secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"}}
    token = descartes_sync._descartes_token(config)
    assert token == "tenant-specific-token-456"


def test_descartes_token_resolution_uses_configured_secret_ref_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify token resolution works with configured secret ref as env var name."""
    monkeypatch.delenv("DESCARTES_API_TOKEN", raising=False)
    monkeypatch.setenv("INTEGRATIONS_DESCARTES_TOKEN", "tenant-specific-token-456")
    config = {"secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"}}
    token = descartes_sync._descartes_token(config)
    assert token == "tenant-specific-token-456"


def test_descartes_token_resolution_falls_back_to_global_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify token resolution falls back to DESCARTES_API_TOKEN when configured secret ref not available."""
    monkeypatch.delenv("INTEGRATIONS_DESCARTES_TOKEN", raising=False)
    monkeypatch.setenv("DESCARTES_API_TOKEN", "global-token-123")
    config = {"secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"}}
    token = descartes_sync._descartes_token(config)
    assert token == "global-token-123"


def test_descartes_token_resolution_raises_when_no_token_available(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify token resolution raises DescartesAuthError when no token is configured."""
    monkeypatch.delenv("DESCARTES_API_TOKEN", raising=False)
    monkeypatch.delenv("INTEGRATIONS_DESCARTES_TOKEN", raising=False)
    config = {"secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"}}
    with pytest.raises(descartes_sync.DescartesAuthError, match="Descartes API token not configured"):
        descartes_sync._descartes_token(config)


def test_descartes_token_resolution_raises_when_auth_secret_ref_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify token resolution raises when auth_secret_ref is missing or malformed."""
    monkeypatch.setenv("DESCARTES_API_TOKEN", "test-token-123")
    config = {"secret_refs": {"auth_secret_ref": "not-a-secret-ref"}}
    with pytest.raises(descartes_sync.DescartesAuthError, match="auth_secret_ref is missing or invalid"):
        descartes_sync._descartes_token(config)


def test_fetch_page_terminal_page_with_end_cursor_but_no_next(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify terminal page returns page_cursor but not next_cursor."""
    monkeypatch.setenv("DESCARTES_API_TOKEN", "test-token")

    def fake_fetch(*, url: str, token: str, params: dict, timeout_seconds: int) -> dict:
        return {
            "data": [{"routeNumber": "route-1"}],
            "pagination": {
                "endCursor": "terminal-page-cursor",
                "hasNextPage": False,
            },
        }

    monkeypatch.setattr(descartes_sync, "_fetch_page_from_descartes", fake_fetch)
    config = {
        "settings": {"endpoint_base_url": "https://api.descartes.example"},
        "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
    }
    result = descartes_sync.descartes_fetch_scope_page("tenant-a", "route", None, config)

    assert result["page_cursor"] == "terminal-page-cursor"
    assert result["next_cursor"] is None
    assert len(result["records"]) == 1


def test_fetch_page_with_next_cursor_and_has_next_page(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify non-terminal page returns both page_cursor and next_cursor."""
    monkeypatch.setenv("DESCARTES_API_TOKEN", "test-token")

    def fake_fetch(*, url: str, token: str, params: dict, timeout_seconds: int) -> dict:
        return {
            "data": [{"routeNumber": "route-1"}],
            "pagination": {
                "endCursor": "page-2-cursor",
                "hasNextPage": True,
            },
        }

    monkeypatch.setattr(descartes_sync, "_fetch_page_from_descartes", fake_fetch)
    config = {
        "settings": {"endpoint_base_url": "https://api.descartes.example"},
        "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
    }
    result = descartes_sync.descartes_fetch_scope_page("tenant-a", "route", None, config)

    assert result["page_cursor"] == "page-2-cursor"
    assert result["next_cursor"] == "page-2-cursor"


def test_fetch_page_fallback_to_next_cursor_field(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify fallback to root-level next_cursor field when pagination object not present."""
    monkeypatch.setenv("DESCARTES_API_TOKEN", "test-token")

    def fake_fetch(*, url: str, token: str, params: dict, timeout_seconds: int) -> dict:
        # Response shaped like {"data": [...], "next_cursor": "..."}
        # without a pagination object - should treat next_cursor as both page_cursor and next_cursor
        return {
            "data": [],
            "next_cursor": "root-level-cursor",
        }

    monkeypatch.setattr(descartes_sync, "_fetch_page_from_descartes", fake_fetch)
    config = {
        "settings": {"endpoint_base_url": "https://api.descartes.example"},
        "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
    }
    result = descartes_sync.descartes_fetch_scope_page("tenant-a", "route", None, config)

    # When next_cursor is present at root level, propagate it as both page_cursor and next_cursor
    assert result["page_cursor"] == "root-level-cursor"
    assert result["next_cursor"] == "root-level-cursor"


def test_persist_batch_with_custom_mapping_profile_for_route(fake_client: _FakePersistenceClient) -> None:
    """Verify custom mapping profile changes ID/status/timestamp source fields in external_id and idempotency_key."""
    # Use a custom mapping profile that remaps the source fields to non-default names
    custom_mapping = {
        "route_mapping_profile": {
            "route_id_field": "customRouteId",
            "status_field": "customStatus",
            "timestamp_field": "customTimestamp",
        }
    }

    # Record with ONLY custom field names (default fields are absent/empty)
    record = {
        "customRouteId": "custom-route-123",
        "customStatus": "in-transit",
        "customTimestamp": "2026-06-14T10:00:00Z",
        "routeNumber": "",  # Default field is empty
        "status": "",       # Default field is empty
        "updatedAt": "",    # Default field is empty
    }

    result = descartes_sync.descartes_persist_scope_batch(
        "tenant-a", "route", [record], "2026-06-14T10:00:00Z", mappings=custom_mapping
    )

    assert result["upserted"] == 1
    assert result["duplicates"] == 0

    # Verify external_id_map used the custom field
    alias_rows = fake_client.tables["external_id_map"]
    assert len(alias_rows) == 1
    assert alias_rows[0]["external_id"] == "custom-route-123"

    # Verify integration_delivery_log idempotency key used custom status and timestamp
    log_rows = fake_client.tables["integration_delivery_log"]
    assert len(log_rows) == 1
    assert "custom-route-123" in log_rows[0]["idempotency_key"]
    assert "in-transit" in log_rows[0]["idempotency_key"]
    assert "2026-06-14T10:00:00Z" in log_rows[0]["idempotency_key"]

    # Verify the mapped payload used custom fields
    mapped = log_rows[0]["response_payload"]
    assert mapped["route_id"] == "custom-route-123"
    assert mapped["status"] == "in-transit"


def test_persist_batch_with_custom_mapping_profile_for_shipment(fake_client: _FakePersistenceClient) -> None:
    """Verify custom mapping profile changes ID/status/timestamp source fields for shipment scope."""
    custom_mapping = {
        "shipment_mapping_profile": {
            "shipment_id_field": "customShipmentId",
            "status_field": "customStatus",
            "timestamp_field": "customTimestamp",
        }
    }

    record = {
        "customShipmentId": "custom-ship-456",
        "customStatus": "delivered",
        "customTimestamp": "2026-06-14T11:00:00Z",
        "shipmentNumber": "",
        "status": "",
        "updatedAt": "",
    }

    result = descartes_sync.descartes_persist_scope_batch(
        "tenant-a", "shipment", [record], "2026-06-14T11:00:00Z", mappings=custom_mapping
    )

    assert result["upserted"] == 1
    alias_rows = fake_client.tables["external_id_map"]
    assert alias_rows[0]["external_id"] == "custom-ship-456"

    log_rows = fake_client.tables["integration_delivery_log"]
    assert "custom-ship-456" in log_rows[0]["idempotency_key"]
    assert "delivered" in log_rows[0]["idempotency_key"]
    assert "2026-06-14T11:00:00Z" in log_rows[0]["idempotency_key"]


def test_persist_batch_with_custom_mapping_profile_for_compliance(fake_client: _FakePersistenceClient) -> None:
    """Verify custom mapping profile changes ID/status/timestamp source fields for compliance scope."""
    custom_mapping = {
        "compliance_profile": {
            "compliance_id_field": "customComplianceId",
            "status_field": "customStatus",
            "timestamp_field": "customTimestamp",
        }
    }

    record = {
        "customComplianceId": "custom-cmp-789",
        "customStatus": "verified",
        "customTimestamp": "2026-06-14T12:00:00Z",
        "complianceRecordId": "",
        "status": "",
        "updatedAt": "",
    }

    result = descartes_sync.descartes_persist_scope_batch(
        "tenant-a", "compliance", [record], "2026-06-14T12:00:00Z", mappings=custom_mapping
    )

    assert result["upserted"] == 1
    alias_rows = fake_client.tables["external_id_map"]
    assert alias_rows[0]["external_id"] == "custom-cmp-789"

    log_rows = fake_client.tables["integration_delivery_log"]
    assert "custom-cmp-789" in log_rows[0]["idempotency_key"]
    assert "verified" in log_rows[0]["idempotency_key"]
    assert "2026-06-14T12:00:00Z" in log_rows[0]["idempotency_key"]

