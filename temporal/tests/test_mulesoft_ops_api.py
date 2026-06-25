from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from temporal.src.integrations.mulesoft import build_mulesoft_signature
from temporal.src.ops_api.app import (
    _BEARER_PREFIX,
    EntityCurrentVersion,
    Principal,
    TemporalSignalClient,
    _mulesoft_outbound_workflow_id,
    _stable_mulesoft_replay_token,
    create_app,
)
from temporalio.service import RPCError, RPCStatusCode


class _FakeSupabaseClient:
    def __init__(self) -> None:
        self.principal = Principal(sub="user-1", name="Casey", role="branch_manager", tenant="tenant-a", can_operate=True)
        self.tenant_id = "tenant-a-id"
        self.current_entity = EntityCurrentVersion(id="contract-1", entity_type="rental_contract", version_number=4, data={})
        self.integration_config = {
            "tenant_id": self.tenant_id,
            "connector_key": "mulesoft",
            "settings": {},
            "secret_refs": {"webhook_secret_env": "MULESOFT_WEBHOOK_SECRET"},
            "mappings": {},
        }
        self.delivery_logs: list[dict[str, Any]] = []

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        assert user_jwt == "test-token"
        return self.principal

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        return self.tenant_id if tenant_key == "tenant-a" else None

    async def get_entity_current_version(self, *, entity_id: str) -> EntityCurrentVersion | None:
        return self.current_entity if entity_id == self.current_entity.id else None

    async def get_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        if tenant_id != self.tenant_id or connector_key != "mulesoft":
            return None
        return self.integration_config

    async def get_integration_delivery_log(
        self,
        *,
        tenant_id: str,
        connector_key: str,
        direction: str,
        exchange_key: str,
        idempotency_key: str,
    ) -> dict[str, Any] | None:
        for row in self.delivery_logs:
            if (
                row["tenant_id"] == tenant_id
                and row["connector_key"] == connector_key
                and row["direction"] == direction
                and row["exchange_key"] == exchange_key
                and row["idempotency_key"] == idempotency_key
            ):
                return row
        return None

    async def upsert_integration_delivery_log(self, *, payload: dict[str, Any]) -> dict[str, Any]:
        for idx, row in enumerate(self.delivery_logs):
            if row["idempotency_key"] == payload["idempotency_key"]:
                # Mirror PostgREST resolution=merge-duplicates so route tests catch regressions.
                merged = {**row, **payload, "id": row["id"]}
                self.delivery_logs[idx] = merged
                return merged
        row = {"id": f"log-{len(self.delivery_logs)+1}", **payload}
        self.delivery_logs.append(row)
        return row

    async def update_integration_delivery_log(self, *, delivery_log_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        for idx, row in enumerate(self.delivery_logs):
            if row["id"] == delivery_log_id:
                merged = {**row, **payload}
                self.delivery_logs[idx] = merged
                return merged
        return None


class _FakeTemporalClient:
    def __init__(self) -> None:
        self.replay_calls: list[dict[str, Any]] = []
        self.callback_calls: list[dict[str, Any]] = []
        self.replay_jobs: set[str] = set()
        self.callback_jobs: set[str] = set()

    async def run_mulesoft_outbound(
        self,
        *,
        tenant_id: str,
        exchange_key: str,
        entity_ids: list[str],
        mode: str,
        replay_token: str | None = None,
    ) -> dict[str, Any]:
        resolved_replay_token = replay_token or _stable_mulesoft_replay_token(
            tenant_id=tenant_id,
            exchange_key=exchange_key,
            entity_ids=entity_ids,
            mode=mode,
        )
        workflow_id = _mulesoft_outbound_workflow_id(
            exchange_key=exchange_key,
            mode=mode,
            replay_token=resolved_replay_token,
        )
        duplicate = workflow_id in self.replay_jobs
        self.replay_jobs.add(workflow_id)
        self.replay_calls.append(
            {
                "tenant_id": tenant_id,
                "exchange_key": exchange_key,
                "entity_ids": entity_ids,
                "mode": mode,
                "replay_token": resolved_replay_token,
                "workflow_id": workflow_id,
            }
        )
        return {
            "workflow_id": workflow_id,
            "replay_token": resolved_replay_token,
            "status": "accepted",
            "duplicate": duplicate,
        }

    async def run_mulesoft_inbound_callback(
        self,
        *,
        tenant_id: str,
        delivery_log_id: str,
        payload: dict[str, Any],
        delivery_id: str,
    ) -> dict[str, Any]:
        workflow_id = f"mulesoft-inbound-{delivery_id}"
        duplicate = workflow_id in self.callback_jobs
        if not duplicate:
            self.callback_jobs.add(workflow_id)
            self.callback_calls.append(
                {
                    "tenant_id": tenant_id,
                    "delivery_log_id": delivery_log_id,
                    "payload": payload,
                    "delivery_id": delivery_id,
                }
            )
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": duplicate}


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


def _make_client() -> tuple[TestClient, _FakeSupabaseClient, _FakeTemporalClient]:
    supabase = _FakeSupabaseClient()
    temporal = _FakeTemporalClient()
    app = create_app(supabase_client=supabase, temporal_client=temporal)
    return TestClient(app), supabase, temporal


@pytest.mark.parametrize("role", ["field_operator", "read_only"])
def test_replay_endpoint_requires_privileged_role(role: str) -> None:
    client, supabase, _ = _make_client()
    supabase.principal = replace(supabase.principal, role=role)

    response = client.post(
        "/api/integrations/mulesoft/replays",
        headers=_auth_header(),
        json={"exchange_key": "rental_contract_snapshot", "entity_ids": ["contract-1"]},
    )

    assert response.status_code == 403


@pytest.mark.parametrize("role", ["admin", "branch_manager"])
def test_replay_endpoint_allows_privileged_role(role: str) -> None:
    client, supabase, temporal = _make_client()
    supabase.principal = replace(supabase.principal, role=role)

    response = client.post(
        "/api/integrations/mulesoft/replays",
        headers=_auth_header(),
        json={"exchange_key": "rental_contract_snapshot", "entity_ids": ["contract-1"], "mode": "backfill"},
    )

    assert response.status_code == 202
    assert response.json()["status"] == "accepted"
    assert response.json()["duplicate"] is False
    assert temporal.replay_calls[0]["mode"] == "backfill"
    assert response.json()["workflow_id"] == temporal.replay_calls[0]["workflow_id"]
    assert response.json()["replay_token"] == temporal.replay_calls[0]["replay_token"]


def test_replay_endpoint_retries_converge_on_same_job() -> None:
    client, _, temporal = _make_client()

    first = client.post(
        "/api/integrations/mulesoft/replays",
        headers=_auth_header(),
        json={"exchange_key": "rental_contract_snapshot", "entity_ids": ["contract-1"], "mode": "replay"},
    )
    second = client.post(
        "/api/integrations/mulesoft/replays",
        headers=_auth_header(),
        json={"exchange_key": "rental_contract_snapshot", "entity_ids": ["contract-1"], "mode": "replay"},
    )

    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["workflow_id"] == second.json()["workflow_id"]
    assert first.json()["replay_token"] == second.json()["replay_token"]
    assert second.json()["duplicate"] is True
    assert temporal.replay_calls[0]["replay_token"] == temporal.replay_calls[1]["replay_token"]


def test_delivery_receipt_validates_signature_and_dedupes(monkeypatch) -> None:
    client, supabase, temporal = _make_client()
    monkeypatch.setenv("MULESOFT_WEBHOOK_SECRET", "shared-secret")
    payload = {
        "delivery_id": "delivery-1",
        "subject_exchange_key": "rental_contract_snapshot",
        "entity_type": "rental_contract",
        "entity_id": "contract-1",
        "external_id": "mule-contract-100",
        "status": "accepted",
        "cursor": "cursor-4",
        "message": "accepted",
        "received_at": "2026-06-11T10:00:00Z",
    }
    raw = json.dumps(payload).encode("utf-8")
    signature = build_mulesoft_signature(secret="shared-secret", delivery_id="delivery-1", body=raw)

    response = client.post(
        "/api/integrations/mulesoft/callbacks/delivery_receipt",
        headers={
            "X-Tenant-Key": "tenant-a",
            "X-MuleSoft-Delivery-Id": "delivery-1",
            "X-MuleSoft-Signature": signature,
            "Content-Type": "application/json",
        },
        content=raw,
    )

    assert response.status_code == 202
    assert response.json()["idempotent"] is False
    assert temporal.callback_calls

    supabase.delivery_logs[0]["status"] = "processed"
    second = client.post(
        "/api/integrations/mulesoft/callbacks/delivery_receipt",
        headers={
            "X-Tenant-Key": "tenant-a",
            "X-MuleSoft-Delivery-Id": "delivery-1",
            "X-MuleSoft-Signature": signature,
            "Content-Type": "application/json",
        },
        content=raw,
    )

    assert second.status_code == 202
    assert second.json() == {"status": "accepted", "idempotent": True}
    assert len(temporal.callback_calls) == 1
    assert supabase.delivery_logs[0]["status"] == "processed"


def test_delivery_receipt_accepts_duplicate_while_workflow_in_flight(monkeypatch) -> None:
    client, supabase, temporal = _make_client()
    monkeypatch.setenv("MULESOFT_WEBHOOK_SECRET", "shared-secret")
    payload = {
        "delivery_id": "delivery-1",
        "subject_exchange_key": "rental_contract_snapshot",
        "entity_type": "rental_contract",
        "entity_id": "contract-1",
        "external_id": "mule-contract-100",
        "status": "accepted",
        "received_at": "2026-06-11T10:00:00Z",
    }
    raw = json.dumps(payload).encode("utf-8")
    signature = build_mulesoft_signature(secret="shared-secret", delivery_id="delivery-1", body=raw)
    headers = {
        "X-Tenant-Key": "tenant-a",
        "X-MuleSoft-Delivery-Id": "delivery-1",
        "X-MuleSoft-Signature": signature,
        "Content-Type": "application/json",
    }

    first = client.post("/api/integrations/mulesoft/callbacks/delivery_receipt", headers=headers, content=raw)
    second = client.post("/api/integrations/mulesoft/callbacks/delivery_receipt", headers=headers, content=raw)

    assert first.status_code == 202
    assert first.json()["idempotent"] is False
    assert first.json()["duplicate"] is False
    assert second.status_code == 202
    assert second.json()["status"] == "accepted"
    assert second.json()["idempotent"] is True
    assert second.json()["duplicate"] is True
    assert first.json()["workflow_id"] == second.json()["workflow_id"] == "mulesoft-inbound-delivery-1"
    assert len(temporal.callback_calls) == 1
    assert supabase.delivery_logs[0]["status"] == "received"


def test_delivery_receipt_rejects_invalid_signature(monkeypatch) -> None:
    client, _, _ = _make_client()
    monkeypatch.setenv("MULESOFT_WEBHOOK_SECRET", "shared-secret")

    response = client.post(
        "/api/integrations/mulesoft/callbacks/delivery_receipt",
        headers={
            "X-Tenant-Key": "tenant-a",
            "X-MuleSoft-Delivery-Id": "delivery-1",
            "X-MuleSoft-Signature": "bad-signature",
            "Content-Type": "application/json",
        },
        content=json.dumps({"delivery_id": "delivery-1", "subject_exchange_key": "rental_contract_snapshot", "entity_type": "rental_contract", "entity_id": "contract-1", "status": "accepted"}).encode("utf-8"),
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized"}


@pytest.mark.parametrize("scenario", ["unknown_tenant", "missing_config", "missing_secret", "invalid_signature"])
def test_delivery_receipt_fails_closed_for_unauthenticated_requests(monkeypatch, scenario: str) -> None:
    client, supabase, temporal = _make_client()
    payload = {
        "delivery_id": "delivery-1",
        "subject_exchange_key": "rental_contract_snapshot",
        "entity_type": "rental_contract",
        "entity_id": "contract-1",
        "status": "accepted",
    }
    raw = json.dumps(payload).encode("utf-8")
    tenant_key = "tenant-a"
    signature = "bad-signature"

    if scenario == "unknown_tenant":
        monkeypatch.setenv("MULESOFT_WEBHOOK_SECRET", "shared-secret")
        tenant_key = "unknown-tenant"
        signature = build_mulesoft_signature(secret="shared-secret", delivery_id="delivery-1", body=raw)
    elif scenario == "missing_config":
        supabase.integration_config = None
    elif scenario == "missing_secret":
        monkeypatch.delenv("MULESOFT_WEBHOOK_SECRET", raising=False)
    elif scenario == "invalid_signature":
        monkeypatch.setenv("MULESOFT_WEBHOOK_SECRET", "shared-secret")
    else:
        raise AssertionError(f"Unhandled scenario {scenario}")

    response = client.post(
        "/api/integrations/mulesoft/callbacks/delivery_receipt",
        headers={
            "X-Tenant-Key": tenant_key,
            "X-MuleSoft-Delivery-Id": "delivery-1",
            "X-MuleSoft-Signature": signature,
            "Content-Type": "application/json",
        },
        content=raw,
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized"}
    assert temporal.callback_calls == []
    assert supabase.delivery_logs == []


class _FakeWorkflowHandle:
    def __init__(self) -> None:
        self.result_called = False

    async def result(self) -> dict[str, Any]:
        self.result_called = True
        raise AssertionError("run_mulesoft_outbound should not wait for workflow completion")


class _FakeTemporalServiceClient:
    def __init__(self, *, handle: _FakeWorkflowHandle | None = None, start_error: Exception | None = None) -> None:
        self.handle = handle or _FakeWorkflowHandle()
        self.start_error = start_error
        self.start_calls: list[dict[str, Any]] = []

    async def start_workflow(self, workflow: Any, workflow_input: Any, *, id: str, task_queue: str) -> _FakeWorkflowHandle:
        self.start_calls.append(
            {
                "workflow": workflow,
                "workflow_input": workflow_input,
                "id": id,
                "task_queue": task_queue,
            }
        )
        if self.start_error is not None:
            raise self.start_error
        return self.handle


@pytest.mark.asyncio
async def test_temporal_client_starts_replay_async_with_stable_token() -> None:
    temporal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    fake_service_client = _FakeTemporalServiceClient()

    async def fake_client_instance() -> _FakeTemporalServiceClient:
        return fake_service_client

    temporal_client._client_instance = fake_client_instance  # type: ignore[method-assign]
    result = await temporal_client.run_mulesoft_outbound(
        tenant_id="tenant-a-id",
        exchange_key="invoice_snapshot",
        entity_ids=["invoice-1", "invoice-2"],
        mode="backfill",
    )

    expected_replay_token = _stable_mulesoft_replay_token(
        tenant_id="tenant-a-id",
        exchange_key="invoice_snapshot",
        entity_ids=["invoice-1", "invoice-2"],
        mode="backfill",
    )
    assert result == {
        "workflow_id": _mulesoft_outbound_workflow_id(
            exchange_key="invoice_snapshot",
            mode="backfill",
            replay_token=expected_replay_token,
        ),
        "replay_token": expected_replay_token,
        "status": "accepted",
        "duplicate": False,
    }
    assert len(fake_service_client.start_calls) == 1
    assert fake_service_client.handle.result_called is False
    assert fake_service_client.start_calls[0]["workflow_input"].replay_token == expected_replay_token


@pytest.mark.asyncio
async def test_temporal_client_treats_duplicate_replay_start_as_same_job() -> None:
    temporal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    fake_service_client = _FakeTemporalServiceClient(
        start_error=RPCError("already exists", RPCStatusCode.ALREADY_EXISTS, b"")
    )

    async def fake_client_instance() -> _FakeTemporalServiceClient:
        return fake_service_client

    temporal_client._client_instance = fake_client_instance  # type: ignore[method-assign]
    result = await temporal_client.run_mulesoft_outbound(
        tenant_id="tenant-a-id",
        exchange_key="rental_contract_snapshot",
        entity_ids=["contract-1"],
        mode="replay",
        replay_token="operator-retry-token",
    )

    assert result == {
        "workflow_id": _mulesoft_outbound_workflow_id(
            exchange_key="rental_contract_snapshot",
            mode="replay",
            replay_token="operator-retry-token",
        ),
        "replay_token": "operator-retry-token",
        "status": "accepted",
        "duplicate": True,
    }


@pytest.mark.asyncio
async def test_temporal_client_starts_inbound_callback_async() -> None:
    temporal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    fake_service_client = _FakeTemporalServiceClient()

    async def fake_client_instance() -> _FakeTemporalServiceClient:
        return fake_service_client

    temporal_client._client_instance = fake_client_instance  # type: ignore[method-assign]
    result = await temporal_client.run_mulesoft_inbound_callback(
        tenant_id="tenant-a-id",
        delivery_log_id="log-1",
        payload={"delivery_id": "delivery-1"},
        delivery_id="delivery-1",
    )

    assert result == {
        "workflow_id": "mulesoft-inbound-delivery-1",
        "status": "accepted",
        "duplicate": False,
    }
    assert len(fake_service_client.start_calls) == 1
    assert fake_service_client.handle.result_called is False


@pytest.mark.asyncio
async def test_temporal_client_treats_duplicate_inbound_start_as_same_job() -> None:
    temporal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    fake_service_client = _FakeTemporalServiceClient(
        start_error=RPCError("already exists", RPCStatusCode.ALREADY_EXISTS, b"")
    )

    async def fake_client_instance() -> _FakeTemporalServiceClient:
        return fake_service_client

    temporal_client._client_instance = fake_client_instance  # type: ignore[method-assign]
    result = await temporal_client.run_mulesoft_inbound_callback(
        tenant_id="tenant-a-id",
        delivery_log_id="log-1",
        payload={"delivery_id": "delivery-1"},
        delivery_id="delivery-1",
    )

    assert result == {
        "workflow_id": "mulesoft-inbound-delivery-1",
        "status": "accepted",
        "duplicate": True,
    }
