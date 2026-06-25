from __future__ import annotations

from typing import Any, Literal

from fastapi.testclient import TestClient
from temporal.src.integrations.descartes import DescartesHealthcheckResult
from temporal.src.integrations.registry import ConnectorProvider
from temporal.src.ops_api.app import (
    _BEARER_PREFIX,
    Principal,
    create_app,
)


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

    async def get_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        row = self.integration_config.get(connector_key)
        if row is None or row.get("tenant_id") != tenant_id:
            return None
        # Simulate the production SQL select clause to catch regressions
        # The real query selects: tenant_id,connector_key,enabled,settings,mappings,secret_refs,schedule,updated_at
        return {
            k: v
            for k, v in row.items()
            if k in ("tenant_id", "connector_key", "enabled", "settings", "mappings", "secret_refs", "schedule", "updated_at")
        }


class _FakeTemporalClient:
    def __init__(self) -> None:
        self.descartes_sync_calls: list[dict[str, Any]] = []

    async def run_descartes_sync(
        self,
        *,
        tenant_id: str,
        scopes: list[str],
        mode: Literal["sync", "backfill"],
    ) -> dict[str, Any]:
        self.descartes_sync_calls.append({"tenant_id": tenant_id, "scopes": scopes, "mode": mode})
        if mode == "backfill":
            scopes_tag = "-".join(sorted(scopes)) if scopes else "all"
            workflow_id = f"descartes-backfill-{tenant_id}-{scopes_tag}-20260101000000000000"
        else:
            workflow_id = f"descartes-sync-{tenant_id}"
        return {"workflow_id": workflow_id, "status": "accepted", "duplicate": False}


def _descartes_registry() -> dict[str, ConnectorProvider]:
    return {
        "descartes": ConnectorProvider(
            key="descartes",
            enabled_scopes=("route", "shipment", "compliance"),
            validate_config=lambda _: [],
            healthcheck=lambda _: DescartesHealthcheckResult(
                status="ok",
                classification="ok",
                message="ok",
                details={},
            ),
        )
    }


def _make_client(
    *,
    with_descartes_config: bool = False,
    config_enabled: bool = True,
) -> tuple[TestClient, _FakeSupabaseClient, _FakeTemporalClient]:
    supabase = _FakeSupabaseClient()
    temporal = _FakeTemporalClient()
    if with_descartes_config:
        supabase.integration_config["descartes"] = {
            "tenant_id": "tenant-a-id",
            "connector_key": "descartes",
            "enabled": config_enabled,
            "settings": {"endpoint_base_url": "https://api.descartes.example", "enabled_scopes": ["route", "shipment"]},
            "mappings": {},
            "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
            "schedule": {},
            "updated_at": "2026-06-14T00:00:00Z",
        }
    app = create_app(
        supabase_client=supabase,
        temporal_client=temporal,
        connector_registry=_descartes_registry(),
    )
    return TestClient(app), supabase, temporal


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


def test_sync_endpoint_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal = _make_client(with_descartes_config=False)
    response = client.post(
        "/api/ops/integrations/descartes/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )
    assert response.status_code == 404


def test_sync_endpoint_returns_409_when_config_disabled() -> None:
    client, _supabase, _temporal = _make_client(with_descartes_config=True, config_enabled=False)
    response = client.post(
        "/api/ops/integrations/descartes/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )
    assert response.status_code == 409


def test_sync_endpoint_accepts_incremental_sync() -> None:
    client, _supabase, temporal = _make_client(with_descartes_config=True)
    response = client.post(
        "/api/ops/integrations/descartes/sync",
        headers=_auth_header(),
        json={"mode": "sync", "scopes": ["route"]},
    )
    assert response.status_code == 200
    assert response.json()["workflow_id"] == "descartes-sync-tenant-a-id"
    assert temporal.descartes_sync_calls[0]["mode"] == "sync"


def test_sync_endpoint_accepts_backfill_and_scopes() -> None:
    client, _supabase, temporal = _make_client(with_descartes_config=True)
    response = client.post(
        "/api/ops/integrations/descartes/sync",
        headers=_auth_header(),
        json={"mode": "backfill", "scopes": ["shipment", "route"]},
    )
    assert response.status_code == 200
    assert temporal.descartes_sync_calls[0]["mode"] == "backfill"
    assert temporal.descartes_sync_calls[0]["scopes"] == ["shipment", "route"]
    assert response.json()["workflow_id"].startswith("descartes-backfill-tenant-a-id-")
