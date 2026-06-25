from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import mulesoft
from temporal.src.integrations.mulesoft import build_outbound_payload


def _fixture(name: str) -> dict[str, Any]:
    path = Path(__file__).parent / "fixtures" / "mulesoft" / name
    return json.loads(path.read_text())


class _FakePersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "integration_config": [
                {
                    "tenant_id": "tenant-a-id",
                    "connector_key": "mulesoft",
                    "enabled": True,
                    "settings": {
                        "base_url": "https://mulesoft.example.com",
                        "exchange_paths": {
                            "rental_contract_snapshot": "/contracts",
                            "invoice_snapshot": "/invoices",
                        },
                        "auth_header": "X-API-Key",
                    },
                    "secret_refs": {"api_key_env": "MULESOFT_API_KEY"},
                    "mappings": {},
                }
            ],
            "entities": [
                {
                    "id": "contract-1",
                    "entity_type": "rental_contract",
                    "entity_versions": [
                        {
                            "version_number": 4,
                            "is_current": True,
                            "data": {
                                "contract_number": "RC-100",
                                "status": "active",
                                "branch_id": "branch-1",
                                "customer_id": "customer-1",
                                "billing_account_id": "billing-1",
                                "start_date": "2026-06-01T00:00:00Z",
                                "expected_end_date": "2026-06-10T00:00:00Z",
                            },
                        }
                    ],
                }
            ],
            "external_id_map": [
                {
                    "id": str(uuid4()),
                    "tenant_id": "tenant-a-id",
                    "connector_key": "mulesoft",
                    "exchange_key": "rental_contract_snapshot",
                    "entity_type": "rental_contract",
                    "entity_id": "contract-1",
                    "external_id": "mule-contract-100",
                    "metadata": {},
                }
            ],
            "integration_delivery_log": [],
            "integration_sync_state": [],
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
        filtered: list[dict[str, Any]] = []
        for row in rows:
            keep = True
            for key, value in (filters or {}).items():
                row_value = row.get(key)
                if "." in key:
                    prefix, nested_key = key.split(".", 1)
                    nested = row.get(prefix)
                    if isinstance(nested, list) and nested and isinstance(nested[0], Mapping):
                        row_value = nested[0].get(nested_key)
                if str(row_value).lower() != str(value).lower():
                    keep = False
                    break
            if keep:
                filtered.append(row)
        if limit is not None:
            filtered = filtered[:limit]
        return filtered

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        self.tables.setdefault(resource, []).append(row)
        return row

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        keys = [part.strip() for part in on_conflict.split(",")]
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(str(existing.get(key)) == str(row.get(key)) for key in keys):
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
            if all(str(row.get(key)) == str(value) for key, value in filters.items()):
                merged = {**row, **dict(payload)}
                table[idx] = merged
                updated.append(merged)
        return updated


class _FakeTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send(self, *, url: str, headers: Mapping[str, str], payload: Mapping[str, Any]) -> dict[str, Any]:
        self.calls.append({"url": url, "headers": dict(headers), "payload": dict(payload)})
        return {"http_status": 202, "status": "sent", "body": {"externalId": "mule-contract-100", "accepted": True}}


@pytest.fixture()
def fake_client(monkeypatch: pytest.MonkeyPatch) -> _FakePersistenceClient:
    client = _FakePersistenceClient()
    monkeypatch.setattr(mulesoft, "_persistence_client", client)
    return client


@pytest.fixture()
def fake_transport(monkeypatch: pytest.MonkeyPatch) -> _FakeTransport:
    transport = _FakeTransport()
    monkeypatch.setattr(mulesoft, "_transport", transport)
    return transport


def test_build_outbound_payload_matches_contract_fixture() -> None:
    payload = build_outbound_payload(
        exchange_key="rental_contract_snapshot",
        entity_id="contract-1",
        version_number=4,
        external_id="mule-contract-100",
        data={
            "contract_number": "RC-100",
            "status": "active",
            "branch_id": "branch-1",
            "customer_id": "customer-1",
            "billing_account_id": "billing-1",
            "start_date": "2026-06-01T00:00:00Z",
            "expected_end_date": "2026-06-10T00:00:00Z",
        },
    )
    assert payload == _fixture("rental_contract_snapshot.json")


def test_prepare_outbound_delivery_creates_pending_log(fake_client: _FakePersistenceClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MULESOFT_API_KEY", "secret-token")

    prepared = mulesoft.mulesoft_prepare_outbound_delivery("tenant-a-id", "rental_contract_snapshot", "contract-1")

    assert prepared["skip"] is False
    assert prepared["headers"] == {"X-API-Key": "secret-token"}
    assert prepared["payload"] == _fixture("rental_contract_snapshot.json")
    assert fake_client.tables["integration_delivery_log"][0]["status"] == "pending"


def test_send_outbound_delivery_updates_alias_and_sync_state(
    fake_client: _FakePersistenceClient,
    fake_transport: _FakeTransport,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MULESOFT_API_KEY", "secret-token")
    prepared = mulesoft.mulesoft_prepare_outbound_delivery("tenant-a-id", "rental_contract_snapshot", "contract-1")

    result = mulesoft.mulesoft_send_outbound_delivery(prepared)

    assert result["status"] == "sent"
    assert fake_transport.calls[0]["url"] == "https://mulesoft.example.com/contracts"
    assert fake_client.tables["integration_delivery_log"][0]["status"] == "sent"
    assert fake_client.tables["integration_sync_state"][0]["cursor"] == "4"


def test_process_inbound_callback_updates_sync_state(fake_client: _FakePersistenceClient) -> None:
    receipt = _fixture("delivery_receipt.json")
    log_row = fake_client.insert(
        "integration_delivery_log",
        {
            "tenant_id": "tenant-a-id",
            "connector_key": "mulesoft",
            "exchange_key": "delivery_receipt",
            "direction": "inbound",
            "scope_key": "rental_contract_snapshot:contract-1",
            "source_of_truth": "mulesoft",
            "idempotency_key": "delivery-1",
            "status": "received",
            "request_payload": receipt,
        },
    )

    result = mulesoft.mulesoft_process_inbound_callback("tenant-a-id", log_row["id"], receipt)

    assert result["status"] == "processed"
    assert fake_client.tables["integration_delivery_log"][0]["status"] == "processed"
    assert fake_client.tables["integration_sync_state"][0]["state"]["delivery_status"] == "accepted"
