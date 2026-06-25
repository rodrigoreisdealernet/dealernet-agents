from __future__ import annotations

from typing import Any, Literal

from fastapi.testclient import TestClient
from temporal.src.integrations.registry import ConnectorProvider
from temporal.src.integrations.samsara import SamsaraHealthcheckResult
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
            "updated_at": "2026-06-12T00:00:00Z",
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
        self.samsara_sync_calls: list[dict[str, Any]] = []

    async def run_samsara_sync(
        self,
        *,
        tenant_id: str,
        scopes: list[str],
        mode: Literal["sync", "backfill"],
    ) -> dict[str, Any]:
        call = {"tenant_id": tenant_id, "scopes": scopes, "mode": mode}
        self.samsara_sync_calls.append(call)
        # Mirror the real TemporalServiceClient.run_samsara_sync ID logic so tests can
        # assert on deduplication behaviour:
        # - backfill: timestamped (multiple historical runs can coexist)
        # - incremental sync: stable (ALREADY_EXISTS prevents concurrent runs)
        if mode == "backfill":
            scopes_tag = "-".join(sorted(scopes)) if scopes else "all"
            wf_id = f"samsara-backfill-{tenant_id}-{scopes_tag}-20260101000000000000"
        else:
            wf_id = f"samsara-sync-{tenant_id}"
        return {"workflow_id": wf_id, "status": "accepted", "duplicate": False}


def _samsara_registry() -> dict[str, ConnectorProvider]:
    return {
        "samsara": ConnectorProvider(
            key="samsara",
            enabled_scopes=("gps", "hours", "eld", "dashcam_events"),
            validate_config=lambda _: [],
            healthcheck=lambda _: SamsaraHealthcheckResult(
                status="ok",
                classification="ok",
                message="ok",
                details={},
            ),
        )
    }


def _make_client(
    *,
    with_samsara_config: bool = False,
    config_enabled: bool = True,
) -> tuple[TestClient, _FakeSupabaseClient, _FakeTemporalClient]:
    supabase = _FakeSupabaseClient()
    temporal = _FakeTemporalClient()
    if with_samsara_config:
        supabase.integration_config["samsara"] = {
            "tenant_id": "tenant-a-id",
            "connector_key": "samsara",
            "enabled": config_enabled,
            "settings": {
                "api_base_url": "https://api.samsara.com",
                "enabled_scopes": ["gps", "hours"],
                "fleet_targeting": {"group_ids": ["group-1"]},
            },
            "mappings": {
                "gps_mapping_profile": {"asset_id_field": "vehicleId"},
                "hours_mapping_profile": {"driver_id_field": "driverId"},
            },
            "secret_refs": {"api_secret_ref": "secret://integrations/samsara/api_key"},
            "schedule": {},
            "updated_at": "2026-06-12T00:00:00Z",
        }
    app = create_app(
        supabase_client=supabase,
        temporal_client=temporal,
        connector_registry=_samsara_registry(),
    )
    return TestClient(app), supabase, temporal


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


# ---------------------------------------------------------------------------
# /api/ops/integrations/samsara/sync tests
# ---------------------------------------------------------------------------


def test_sync_endpoint_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal = _make_client(with_samsara_config=False)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 404


def test_sync_endpoint_returns_409_when_integration_disabled() -> None:
    client, _supabase, _temporal = _make_client(with_samsara_config=True, config_enabled=False)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 409
    assert "disabled" in response.json()["detail"].lower()


def test_sync_endpoint_accepts_incremental_sync() -> None:
    client, _supabase, temporal = _make_client(with_samsara_config=True)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"
    assert "workflow_id" in body
    assert temporal.samsara_sync_calls[0]["mode"] == "sync"
    assert temporal.samsara_sync_calls[0]["tenant_id"] == "tenant-a-id"


def test_sync_endpoint_accepts_backfill_mode() -> None:
    client, _supabase, temporal = _make_client(with_samsara_config=True)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "backfill"},
    )

    assert response.status_code == 200
    assert temporal.samsara_sync_calls[0]["mode"] == "backfill"


def test_sync_endpoint_forwards_explicit_scopes() -> None:
    client, _supabase, temporal = _make_client(with_samsara_config=True)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync", "scopes": ["gps", "eld"]},
    )

    assert response.status_code == 200
    assert temporal.samsara_sync_calls[0]["scopes"] == ["gps", "eld"]


def test_sync_endpoint_passes_empty_scopes_for_all_scopes_sync() -> None:
    """Empty scopes in the request should pass an empty list so the workflow syncs all enabled scopes."""
    client, _supabase, temporal = _make_client(with_samsara_config=True)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync", "scopes": []},
    )

    assert response.status_code == 200
    assert temporal.samsara_sync_calls[0]["scopes"] == []


def test_sync_endpoint_requires_authentication() -> None:
    client, _supabase, _temporal = _make_client(with_samsara_config=True)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        json={"mode": "sync"},
    )

    assert response.status_code == 401


def test_sync_endpoint_workflow_id_contains_mode_and_tenant() -> None:
    client, _supabase, temporal = _make_client(with_samsara_config=True)

    response = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "backfill"},
    )

    workflow_id = response.json()["workflow_id"]
    assert "backfill" in workflow_id
    assert "tenant-a-id" in workflow_id


def test_incremental_sync_uses_stable_workflow_id() -> None:
    """Incremental sync must use a stable (non-timestamped) workflow ID.

    Regression: old code appended a timestamp to the incremental sync workflow ID,
    so ALREADY_EXISTS duplicate protection never engaged and concurrent manual or
    scheduled incremental syncs could race on the per-scope cursor in
    integration_sync_state (last-writer-wins).
    """
    client, _supabase, _temporal = _make_client(with_samsara_config=True)

    response1 = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )
    response2 = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "sync"},
    )

    wf_id_1 = response1.json()["workflow_id"]
    wf_id_2 = response2.json()["workflow_id"]
    # Both calls must produce exactly the same workflow ID so ALREADY_EXISTS fires
    assert wf_id_1 == wf_id_2, (
        f"Incremental sync workflow IDs must be identical for deduplication, "
        f"got {wf_id_1!r} and {wf_id_2!r}"
    )
    # Must not embed a timestamp (no 20-digit microsecond suffix)
    assert wf_id_1 == "samsara-sync-tenant-a-id", (
        f"Expected stable ID 'samsara-sync-tenant-a-id', got {wf_id_1!r}"
    )


def test_backfill_workflow_ids_are_distinct_per_call() -> None:
    """Backfill must use a per-call timestamped ID so multiple historical re-fetches can coexist."""
    client, _supabase, _temporal = _make_client(with_samsara_config=True)

    response1 = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "backfill"},
    )
    response2 = client.post(
        "/api/ops/integrations/samsara/sync",
        headers=_auth_header(),
        json={"mode": "backfill"},
    )

    wf_id_1 = response1.json()["workflow_id"]
    wf_id_2 = response2.json()["workflow_id"]
    # Each backfill call must get its own ID so they don't ALREADY_EXISTS each other
    # (backfill is timestamped; two calls within the same microsecond could theoretically
    # collide but that's an acceptable edge case)
    assert wf_id_1.startswith("samsara-backfill-")
    assert wf_id_2.startswith("samsara-backfill-")


# ---------------------------------------------------------------------------
# /api/ops/integrations/samsara/configure tests — schedule field persistence
# ---------------------------------------------------------------------------


def _minimal_configure_body(**overrides: Any) -> dict[str, Any]:
    """Minimal valid configure payload."""
    body: dict[str, Any] = {
        "api_base_url": "https://api.samsara.com",
        "api_secret_ref": "secret://integrations/samsara/api_key",
        "enabled_scopes": ["gps"],
        "fleet_targeting": {"group_ids": ["g1"]},
        "gps_mapping_profile": {"asset_id_field": "vehicleId"},
        "hours_mapping_profile": {},
        "eld_profile": {},
        "dashcam_event_profile": {},
    }
    body.update(overrides)
    return body


def test_configure_endpoint_persists_schedule_fields() -> None:
    """configure endpoint must store the caller-supplied schedule dict verbatim.

    Regression: old code always persisted schedule={} unconditionally, discarding
    any cron/enabled values passed by the operator, so scheduled sync could never
    be wired at configure time.
    """
    client, supabase, _temporal = _make_client()

    schedule_payload = {"enabled": True, "cron": "0 */6 * * *"}
    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json={**_minimal_configure_body(), "schedule": schedule_payload},
    )

    assert response.status_code == 200
    stored = supabase.integration_config.get("samsara", {})
    assert stored.get("schedule") == schedule_payload, (
        f"Expected schedule={schedule_payload!r} to be stored, got {stored.get('schedule')!r}"
    )


def test_configure_endpoint_defaults_to_empty_schedule() -> None:
    """When schedule is omitted from the request, an empty dict must be stored."""
    client, supabase, _temporal = _make_client()

    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json=_minimal_configure_body(),  # no schedule key
    )

    assert response.status_code == 200
    stored = supabase.integration_config.get("samsara", {})
    assert stored.get("schedule") == {}, (
        f"Expected empty schedule dict but got {stored.get('schedule')!r}"
    )


def test_configure_endpoint_schedule_disabled_flag_is_persisted() -> None:
    """schedule.enabled=False must be stored and not overwritten with a default."""
    client, supabase, _temporal = _make_client()

    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json={**_minimal_configure_body(), "schedule": {"enabled": False}},
    )

    assert response.status_code == 200
    stored_schedule = supabase.integration_config.get("samsara", {}).get("schedule", {})
    assert stored_schedule.get("enabled") is False, (
        "schedule.enabled=False must survive the configure round-trip"
    )
