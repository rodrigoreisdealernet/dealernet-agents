from __future__ import annotations

import io
from collections.abc import Mapping
from typing import Any
from unittest.mock import patch
from urllib import error as urllib_error
from uuid import uuid4

import pytest
from temporal.src.activities import coupa

# ---------------------------------------------------------------------------
# Fake persistence client
# ---------------------------------------------------------------------------


class _FakePersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "integration_config": [
                {
                    "id": str(uuid4()),
                    "tenant_id": "tenant-a",
                    "connector_key": "coupa",
                    "enabled": True,
                    "settings": {
                        "api_base_url": "https://tenant.coupahost.com",
                        "tenant_slug": "wynne-rental",
                        "enabled_scopes": ["requisitions", "purchase_orders", "suppliers", "invoices"],
                        "healthcheck_timeout_seconds": 5,
                    },
                    "mappings": {
                        "requisition_mapping_profile": {"requisition_id_field": "id"},
                        "purchase_order_mapping_profile": {"purchase_order_id_field": "id"},
                        "supplier_mapping_profile": {"supplier_id_field": "id"},
                        "invoice_mapping_profile": {"invoice_id_field": "id"},
                    },
                    "secret_refs": {
                        "client_id_secret_ref": "secret://integrations/coupa/client_id",
                        "client_secret_secret_ref": "secret://integrations/coupa/client_secret",
                    },
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
                if str(row.get(key)).lower() != str(value).lower():
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
    monkeypatch.setattr(coupa, "_persistence_client", client)
    return client


# ---------------------------------------------------------------------------
# coupa_load_sync_config tests
# ---------------------------------------------------------------------------


def test_load_sync_config_returns_enabled_scopes(fake_client: _FakePersistenceClient) -> None:
    result = coupa.coupa_load_sync_config("tenant-a", "requisitions")
    assert result["tenant_id"] == "tenant-a"
    assert "requisitions" in result["enabled_scopes"]
    assert "purchase_orders" in result["enabled_scopes"]
    assert result["cursor"] is None


def test_load_sync_config_returns_stored_cursor(fake_client: _FakePersistenceClient) -> None:
    fake_client.tables["integration_sync_state"].append({
        "tenant_id": "tenant-a",
        "connector_key": "coupa",
        "scope_key": "requisitions",
        "cursor_value": "2026-06-01T00:00:00Z",
    })
    result = coupa.coupa_load_sync_config("tenant-a", "requisitions")
    assert result["cursor"] == "2026-06-01T00:00:00Z"


def test_load_sync_config_raises_for_missing_config(fake_client: _FakePersistenceClient) -> None:
    with pytest.raises(ValueError, match="not found or disabled"):
        coupa.coupa_load_sync_config("unknown-tenant", "requisitions")


# ---------------------------------------------------------------------------
# coupa_persist_procurement_batch tests
# ---------------------------------------------------------------------------


def test_persist_requisitions_upserts_external_id_and_delivery_log(fake_client: _FakePersistenceClient) -> None:
    records = [{"id": 101, "status": "pending_approval", "updated-at": "2026-06-01T00:00:00Z"}]
    result = coupa.coupa_persist_procurement_batch(
        "tenant-a", "requisitions", records, "2026-06-01T00:00:00Z",
        {"requisition_mapping_profile": {"requisition_id_field": "id"}},
    )
    assert result["upserted"] == 1
    assert result["duplicates"] == 0
    assert len(fake_client.tables["external_id_map"]) == 1
    assert len(fake_client.tables["integration_delivery_log"]) == 1


def test_persist_skips_duplicate_delivery(fake_client: _FakePersistenceClient) -> None:
    records = [{"id": 201, "status": "approved", "updated-at": "2026-06-01T00:00:00Z"}]
    idempotency_key = "coupa:requisitions:201:2026-06-01T00:00:00Z"
    fake_client.tables["integration_delivery_log"].append({
        "tenant_id": "tenant-a",
        "connector_key": "coupa",
        "direction": "inbound",
        "scope_key": "requisitions",
        "idempotency_key": idempotency_key,
        "status": "received",
    })
    result = coupa.coupa_persist_procurement_batch(
        "tenant-a", "requisitions", records, "2026-06-01T00:00:00Z",
        {"requisition_mapping_profile": {"requisition_id_field": "id"}},
    )
    assert result["duplicates"] == 1
    assert result["upserted"] == 0


def test_persist_skips_records_with_no_external_id(fake_client: _FakePersistenceClient) -> None:
    records = [{"status": "draft"}]  # no "id" field
    result = coupa.coupa_persist_procurement_batch(
        "tenant-a", "requisitions", records, "2026-06-01T00:00:00Z", {}
    )
    assert result["upserted"] == 0
    assert result["total"] == 1


def test_persist_purchase_orders(fake_client: _FakePersistenceClient) -> None:
    records = [{"id": 301, "status": "issued", "supplier": {"id": 50}, "updated-at": "2026-06-01T00:00:00Z"}]
    result = coupa.coupa_persist_procurement_batch(
        "tenant-a", "purchase_orders", records, "2026-06-01T00:00:00Z",
        {"purchase_order_mapping_profile": {"purchase_order_id_field": "id"}},
    )
    assert result["upserted"] == 1
    delivery = fake_client.tables["integration_delivery_log"][0]
    assert delivery["response_payload"]["supplier_id"] == 50


def test_persist_suppliers(fake_client: _FakePersistenceClient) -> None:
    records = [{"id": 50, "name": "ACME Corp", "status": "active", "updated-at": "2026-06-01T00:00:00Z"}]
    result = coupa.coupa_persist_procurement_batch(
        "tenant-a", "suppliers", records, "2026-06-01T00:00:00Z",
        {"supplier_mapping_profile": {"supplier_id_field": "id"}},
    )
    assert result["upserted"] == 1
    delivery = fake_client.tables["integration_delivery_log"][0]
    assert delivery["response_payload"]["name"] == "ACME Corp"


def test_persist_invoices(fake_client: _FakePersistenceClient) -> None:
    records = [{
        "id": 401,
        "invoice-number": "INV-001",
        "status": "approved",
        "supplier": {"id": 50},
        "total": "500.00",
        "invoice-date": "2026-05-31",
        "updated-at": "2026-06-01T00:00:00Z",
    }]
    result = coupa.coupa_persist_procurement_batch(
        "tenant-a", "invoices", records, "2026-06-01T00:00:00Z",
        {"invoice_mapping_profile": {"invoice_id_field": "id"}},
    )
    assert result["upserted"] == 1
    delivery = fake_client.tables["integration_delivery_log"][0]
    assert delivery["response_payload"]["invoice_number"] == "INV-001"


# ---------------------------------------------------------------------------
# coupa_advance_sync_cursor tests
# ---------------------------------------------------------------------------


def test_advance_sync_cursor_upserts_state(fake_client: _FakePersistenceClient) -> None:
    result = coupa.coupa_advance_sync_cursor(
        "tenant-a", "requisitions", "2026-06-01T12:00:00Z", "2026-06-01T12:00:00Z"
    )
    assert result["cursor"] == "2026-06-01T12:00:00Z"
    assert len(fake_client.tables["integration_sync_state"]) == 1
    state = fake_client.tables["integration_sync_state"][0]
    assert state["connector_key"] == "coupa"
    assert state["scope_key"] == "requisitions"
    assert state["cursor_value"] == "2026-06-01T12:00:00Z"


def test_advance_sync_cursor_updates_existing_state(fake_client: _FakePersistenceClient) -> None:
    coupa.coupa_advance_sync_cursor("tenant-a", "requisitions", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z")
    coupa.coupa_advance_sync_cursor("tenant-a", "requisitions", "2026-06-02T00:00:00Z", "2026-06-02T00:00:00Z")
    state_rows = fake_client.tables["integration_sync_state"]
    assert len(state_rows) == 1
    assert state_rows[0]["cursor_value"] == "2026-06-02T00:00:00Z"


# ---------------------------------------------------------------------------
# Mapping helper tests
# ---------------------------------------------------------------------------


def test_apply_coupa_mapping_requisition_defaults() -> None:
    record = {"id": 1, "status": "draft", "requested_by": "alice", "total": "100.00", "created-at": "2026-01-01"}
    result = coupa._apply_coupa_mapping(record, "requisitions", {})
    assert result["requisition_id"] == 1
    assert result["status"] == "draft"
    assert result["total"] == "100.00"


def test_apply_coupa_mapping_purchase_order_extracts_supplier_id() -> None:
    record = {"id": 10, "status": "issued", "supplier": {"id": 99}, "total": "200.00", "created-at": "2026-01-01"}
    result = coupa._apply_coupa_mapping(record, "purchase_orders", {})
    assert result["purchase_order_id"] == 10
    assert result["supplier_id"] == 99


def test_apply_coupa_mapping_invoice_extracts_invoice_number() -> None:
    record = {
        "id": 20,
        "invoice-number": "INV-100",
        "status": "approved",
        "supplier": {"id": 5},
        "total": "300.00",
        "invoice-date": "2026-02-15",
    }
    result = coupa._apply_coupa_mapping(record, "invoices", {})
    assert result["invoice_id"] == 20
    assert result["invoice_number"] == "INV-100"
    assert result["supplier_id"] == 5


def test_apply_coupa_mapping_unknown_scope_returns_raw() -> None:
    record = {"foo": "bar"}
    result = coupa._apply_coupa_mapping(record, "unknown_scope", {})
    assert result == {"foo": "bar"}


# ---------------------------------------------------------------------------
# Idempotency key tests
# ---------------------------------------------------------------------------


def test_idempotency_key_includes_updated_at() -> None:
    key = coupa._idempotency_key_for_record("requisitions", "42", {"updated-at": "2026-06-01T00:00:00Z"})
    assert key == "coupa:requisitions:42:2026-06-01T00:00:00Z"


def test_idempotency_key_without_updated_at_uses_id_only() -> None:
    key = coupa._idempotency_key_for_record("suppliers", "99", {})
    assert key == "coupa:suppliers:99"


# ---------------------------------------------------------------------------
# coupa_fetch_scope_page error classification tests
# ---------------------------------------------------------------------------


def test_fetch_raises_auth_error_on_401() -> None:
    exc = urllib_error.HTTPError(url="u", code=401, msg="Unauthorized", hdrs=None, fp=io.BytesIO(b""))  # type: ignore[arg-type]
    with patch("urllib.request.urlopen", side_effect=exc), pytest.raises(coupa.CoupaAuthError):
        coupa._fetch_page_from_coupa(url="https://example.com", token="t", params={}, timeout_seconds=5)


def test_fetch_raises_rate_limit_error_on_429() -> None:
    exc = urllib_error.HTTPError(url="u", code=429, msg="Too Many Requests", hdrs=None, fp=io.BytesIO(b""))  # type: ignore[arg-type]
    with patch("urllib.request.urlopen", side_effect=exc), pytest.raises(coupa.CoupaRateLimitError):
        coupa._fetch_page_from_coupa(url="https://example.com", token="t", params={}, timeout_seconds=5)


def test_fetch_raises_mapping_error_on_404() -> None:
    exc = urllib_error.HTTPError(url="u", code=404, msg="Not Found", hdrs=None, fp=io.BytesIO(b""))  # type: ignore[arg-type]
    with patch("urllib.request.urlopen", side_effect=exc), pytest.raises(coupa.CoupaMappingError):
        coupa._fetch_page_from_coupa(url="https://example.com", token="t", params={}, timeout_seconds=5)


# ---------------------------------------------------------------------------
# Tenant credential isolation regression tests
# ---------------------------------------------------------------------------
# These tests prove that _coupa_token() resolves credentials exclusively from
# the tenant-scoped secret_ref and never falls back to global env var names.


def test_token_from_tenant_ref(monkeypatch: pytest.MonkeyPatch) -> None:
    """Token is resolved from the env var derived from the tenant's secret_ref."""
    monkeypatch.setenv("INTEGRATIONS_COUPA_ACME_CLIENT_SECRET", "tenant-a-token")
    config: dict[str, Any] = {
        "secret_refs": {
            "client_secret_secret_ref": "secret://integrations/coupa/acme/client_secret",
        }
    }
    assert coupa._coupa_token(config) == "tenant-a-token"


def test_missing_secret_ref_raises_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A config with no client_secret_secret_ref must raise CoupaAuthError immediately."""
    # Even if a global-looking env var is present it must not be consulted.
    monkeypatch.setenv("COUPA_CLIENT_SECRET", "global-token")
    monkeypatch.setenv("COUPA_API_TOKEN", "global-token-2")
    config: dict[str, Any] = {"secret_refs": {}}
    with pytest.raises(coupa.CoupaAuthError, match="client_secret_secret_ref"):
        coupa._coupa_token(config)


def test_no_secret_refs_raises_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A config with no secret_refs block at all must raise CoupaAuthError."""
    monkeypatch.setenv("COUPA_CLIENT_SECRET", "global-token")
    config: dict[str, Any] = {}
    with pytest.raises(coupa.CoupaAuthError, match="client_secret_secret_ref"):
        coupa._coupa_token(config)


def test_unresolvable_ref_raises_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the derived env var is absent the sync fails closed; no global fallback."""
    # Global env vars are set but must be ignored.
    monkeypatch.setenv("COUPA_CLIENT_SECRET", "global-token")
    monkeypatch.setenv("COUPA_API_TOKEN", "global-token-2")
    # Tenant-specific env var is NOT set.
    monkeypatch.delenv("INTEGRATIONS_COUPA_ACME_CLIENT_SECRET", raising=False)
    config: dict[str, Any] = {
        "secret_refs": {
            "client_secret_secret_ref": "secret://integrations/coupa/acme/client_secret",
        }
    }
    with pytest.raises(coupa.CoupaAuthError, match="INTEGRATIONS_COUPA_ACME_CLIENT_SECRET"):
        coupa._coupa_token(config)


def test_global_env_vars_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """COUPA_CLIENT_SECRET / COUPA_API_TOKEN must never be used regardless of presence.

    This is the cross-tenant contamination regression: tenant-B/global creds
    must not drive a sync for tenant-A even when those vars are populated.
    """
    monkeypatch.setenv("COUPA_CLIENT_SECRET", "global-secret")
    monkeypatch.setenv("COUPA_API_TOKEN", "global-api-token")
    # Tenant-A has its own ref but the corresponding env var is not injected.
    monkeypatch.delenv("INTEGRATIONS_COUPA_TENANT_A_CLIENT_SECRET", raising=False)
    config: dict[str, Any] = {
        "secret_refs": {
            "client_secret_secret_ref": "secret://integrations/coupa/tenant-a/client_secret",
        }
    }
    # Must raise — the global vars must not be consulted.
    with pytest.raises(coupa.CoupaAuthError):
        coupa._coupa_token(config)
