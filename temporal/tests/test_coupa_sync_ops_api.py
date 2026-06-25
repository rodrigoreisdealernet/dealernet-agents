from __future__ import annotations

from typing import Any, Literal

import pytest
from fastapi.testclient import TestClient
from temporal.src.integrations.coupa import CoupaHealthcheckResult
from temporal.src.integrations.registry import ConnectorProvider
from temporal.src.ops_api.app import (
    _BEARER_PREFIX,
    Principal,
    create_app,
)

# ---------------------------------------------------------------------------
# Minimal fake clients
# ---------------------------------------------------------------------------


class _FakeSupabaseClient:
    def __init__(self) -> None:
        self.principal = Principal(
            sub="user-1", name="Casey", role="branch_manager", tenant="tenant-a", can_operate=True
        )
        self.tenant_id = "tenant-a-id"
        self.integration_config: dict[str, dict[str, Any]] = {}

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        return self.principal

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        return self.tenant_id if tenant_key == "tenant-a" else None

    async def upsert_integration_config(
        self,
        *,
        tenant_id: str,
        connector_key: str,
        enabled: bool,
        settings: dict[str, Any],
        mappings: dict[str, Any],
        secret_refs: dict[str, str],
        schedule: dict[str, Any],
    ) -> dict[str, Any]:
        row = {
            "tenant_id": tenant_id,
            "connector_key": connector_key,
            "enabled": enabled,
            "settings": settings,
            "mappings": mappings,
            "secret_refs": secret_refs,
            "schedule": schedule,
            "updated_at": "2026-06-14T00:00:00Z",
        }
        self.integration_config[connector_key] = row
        return row

    async def get_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        row = self.integration_config.get(connector_key)
        if row is None or row.get("tenant_id") != tenant_id:
            return None
        return row

    async def disable_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        row = self.integration_config.get(connector_key)
        if row is None or row.get("tenant_id") != tenant_id:
            return None
        row = {**row, "enabled": False}
        self.integration_config[connector_key] = row
        return row


class _FakeTemporalClient:
    def __init__(self) -> None:
        self.coupa_sync_calls: list[dict[str, Any]] = []

    async def run_coupa_sync(
        self,
        *,
        tenant_id: str,
        scopes: list[str],
        mode: Literal["sync", "backfill"],
    ) -> dict[str, Any]:
        call = {"tenant_id": tenant_id, "scopes": scopes, "mode": mode}
        self.coupa_sync_calls.append(call)
        if mode == "backfill":
            scopes_tag = "-".join(sorted(scopes)) if scopes else "all"
            wf_id = f"coupa-backfill-{tenant_id}-{scopes_tag}-20260101000000000000"
        else:
            wf_id = f"coupa-sync-{tenant_id}"
        return {"workflow_id": wf_id, "status": "accepted", "duplicate": False}


def _coupa_registry() -> dict[str, ConnectorProvider]:
    return {
        "coupa": ConnectorProvider(
            key="coupa",
            enabled_scopes=("requisitions", "purchase_orders", "suppliers", "invoices"),
            validate_config=lambda _: [],
            healthcheck=lambda _: CoupaHealthcheckResult(
                status="ok",
                classification="ok",
                message="ok",
                details={},
            ),
        )
    }


def _make_client(
    *,
    with_coupa_config: bool = False,
    config_enabled: bool = True,
) -> tuple[TestClient, _FakeSupabaseClient, _FakeTemporalClient]:
    supabase = _FakeSupabaseClient()
    temporal = _FakeTemporalClient()
    if with_coupa_config:
        supabase.integration_config["coupa"] = {
            "tenant_id": "tenant-a-id",
            "connector_key": "coupa",
            "enabled": config_enabled,
            "settings": {
                "api_base_url": "https://tenant.coupahost.com",
                "tenant_slug": "dia-rental",
                "enabled_scopes": ["requisitions", "purchase_orders"],
            },
            "mappings": {
                "requisition_mapping_profile": {"requisition_id_field": "id"},
                "purchase_order_mapping_profile": {"purchase_order_id_field": "id"},
            },
            "secret_refs": {
                "client_id_secret_ref": "secret://integrations/coupa/client_id",
                "client_secret_secret_ref": "secret://integrations/coupa/client_secret",
            },
            "schedule": {},
            "updated_at": "2026-06-14T00:00:00Z",
        }
    app = create_app(
        supabase_client=supabase,
        temporal_client=temporal,
        connector_registry=_coupa_registry(),
    )
    return TestClient(app), supabase, temporal


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


# ---------------------------------------------------------------------------
# /api/ops/integrations/coupa/sync tests
# ---------------------------------------------------------------------------


def test_sync_endpoint_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal = _make_client(with_coupa_config=False)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 404


def test_sync_endpoint_returns_409_when_integration_disabled() -> None:
    client, _supabase, _temporal = _make_client(with_coupa_config=True, config_enabled=False)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 409
    assert "disabled" in response.json()["detail"].lower()


def test_sync_endpoint_accepts_incremental_sync() -> None:
    client, _supabase, temporal = _make_client(with_coupa_config=True)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"
    assert "workflow_id" in body
    assert temporal.coupa_sync_calls[0]["mode"] == "sync"
    assert temporal.coupa_sync_calls[0]["tenant_id"] == "tenant-a-id"


def test_sync_endpoint_accepts_backfill_mode() -> None:
    client, _supabase, temporal = _make_client(with_coupa_config=True)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "backfill", "scopes": ["requisitions"]},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"
    call = temporal.coupa_sync_calls[0]
    assert call["mode"] == "backfill"
    assert call["scopes"] == ["requisitions"]


def test_sync_endpoint_backfill_workflow_id_is_timestamped() -> None:
    client, _supabase, _temporal = _make_client(with_coupa_config=True)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "backfill", "scopes": ["invoices"]},
    )

    assert response.status_code == 200
    wf_id = response.json()["workflow_id"]
    assert "coupa-backfill" in wf_id
    assert "invoices" in wf_id


def test_sync_endpoint_incremental_workflow_id_is_stable() -> None:
    client, _supabase, _temporal = _make_client(with_coupa_config=True)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 200
    wf_id = response.json()["workflow_id"]
    assert wf_id == "coupa-sync-tenant-a-id"


def test_sync_endpoint_passes_empty_scopes_for_full_sync() -> None:
    client, _supabase, temporal = _make_client(with_coupa_config=True)

    response = client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "sync", "scopes": []},
    )

    assert response.status_code == 200
    assert temporal.coupa_sync_calls[0]["scopes"] == []


def test_sync_endpoint_requires_operate_permission(monkeypatch: pytest.MonkeyPatch) -> None:
    supabase = _FakeSupabaseClient()
    supabase.principal = Principal(
        sub="viewer-1", name="Viewer", role="viewer", tenant="tenant-a", can_operate=False
    )
    supabase.integration_config["coupa"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "coupa",
        "enabled": True,
        "settings": {},
        "mappings": {},
        "secret_refs": {},
        "schedule": {},
        "updated_at": "2026-06-14T00:00:00Z",
    }
    temporal = _FakeTemporalClient()
    app = create_app(
        supabase_client=supabase,
        temporal_client=temporal,
        connector_registry=_coupa_registry(),
    )
    http_client = TestClient(app)

    response = http_client.post(
        "/api/ops/integrations/coupa/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 403
