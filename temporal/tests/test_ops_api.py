from __future__ import annotations

from dataclasses import replace
from typing import Any
from urllib import error

import pytest
from fastapi.testclient import TestClient
from temporalio.client import ScheduleOverlapPolicy
from temporalio.service import RPCError, RPCStatusCode
from temporal.src.integrations.billtrust import BilltrustHealthcheckResult, run_billtrust_healthcheck
from temporal.src.integrations.coupa import CoupaHealthcheckResult
from temporal.src.integrations.descartes import DescartesHealthcheckResult
from temporal.src.integrations.registry import ConnectorProvider
from temporal.src.integrations.sage import SageHealthcheckResult
from temporal.src.integrations.samsara import SamsaraHealthcheckResult
from temporal.src.ops_api.app import (
    _BEARER_PREFIX,
    AgentScheduleNotProvisioned,
    EntityCurrentVersion,
    FindingRecord,
    Principal,
    TemporalSignalClient,
    create_app,
)
from temporal.src.workflows.ops import (
    ApproveFleetFindingSignal,
    ApproveFindingSignal,
    FleetUtilizationWorkflow,
    RejectFleetFindingSignal,
    RejectFindingSignal,
    RevenueRecognitionWorkflow,
)

_FLEET_AUDITOR_AGENT_KEY = "fleet-auditor"


class _FakeSupabaseClient:
    def __init__(
        self,
        *,
        principal: Principal,
        finding: FindingRecord,
        call_order: list[str],
        tenant_id: str | None = "tenant-a-id",
    ) -> None:
        self._principal = principal
        self.finding = finding
        self.call_order = call_order
        self.tenant_id = tenant_id
        self.calls: list[str] = []
        self.persisted: list[dict[str, Any]] = []
        self.auth_tokens: list[str] = []
        self.tenant_lookups: list[str] = []
        self.current_entity = EntityCurrentVersion(
            id="asset-1",
            entity_type="asset",
            version_number=3,
            data={"name": "Excavator 300", "status": "available", "image_url": "https://old.example.com/image.jpg"},
        )
        self.appended_versions: list[dict[str, Any]] = []
        self.integration_config: dict[str, dict[str, Any]] = {}
        # Issue #73 — execute-after-approval recorders. ``execute_finding_action``
        # is a stub (the real handler is unit-tested in
        # ``test_finding_action_execution.py``); here we only need to observe that
        # the approve path reaches it with the persisted finding, and that the
        # dismiss path audits without executing.
        self.execute_calls: list[dict[str, Any]] = []
        self.audit_events: list[dict[str, Any]] = []

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        self.auth_tokens.append(user_jwt)
        return self._principal

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        self.tenant_lookups.append(tenant_key)
        if tenant_key != self._principal.tenant:
            return None
        return self.tenant_id

    async def get_finding(self, *, finding_id: str, tenant_id: str) -> FindingRecord | None:
        self.calls.append("get")
        if finding_id != self.finding.id or tenant_id != self.finding.tenant_id:
            return None
        return self.finding

    async def persist_disposition(
        self,
        *,
        finding_id: str,
        tenant_id: str,
        status_value: str,
        approver: dict[str, Any],
    ) -> FindingRecord | None:
        self.calls.append("persist")
        self.call_order.append("persist")
        if tenant_id != self.finding.tenant_id:
            return None
        self.persisted.append({"finding_id": finding_id, "status": status_value, "approver": approver})
        self.finding = replace(self.finding, status=status_value)
        return self.finding

    async def get_entity_current_version(self, *, entity_id: str) -> EntityCurrentVersion | None:
        self.calls.append("get_entity")
        if entity_id != self.current_entity.id:
            return None
        return self.current_entity

    async def append_entity_version(self, *, entity_id: str, version_number: int, data: dict[str, Any]) -> dict[str, Any]:
        self.calls.append("append_entity")
        row = {"id": "entity-version-4", "entity_id": entity_id, "version_number": version_number, "data": data}
        self.appended_versions.append(row)
        self.current_entity = EntityCurrentVersion(
            id=entity_id,
            entity_type="asset",
            version_number=version_number,
            data=data,
        )
        return row

    async def execute_finding_action(
        self, *, finding: FindingRecord, approver: dict[str, Any]
    ) -> dict[str, Any]:
        # Recorded (not added to ``call_order``) so existing approve-ordering
        # assertions (``["persist", "signal"]``) stay valid while we still verify
        # the approve path hands the *persisted* finding to the executor.
        self.execute_calls.append({"finding": finding, "approver": approver})
        return {"executed": False, "skipped": True}

    async def append_audit_event(
        self,
        *,
        entity_id: str,
        tenant_id: str,
        event_type: str,
        finding_id: str,
        action_type: str,
        approver: dict[str, Any] | None,
        payload: dict[str, Any],
    ) -> None:
        self.audit_events.append(
            {
                "entity_id": entity_id,
                "tenant_id": tenant_id,
                "event_type": event_type,
                "finding_id": finding_id,
                "action_type": action_type,
                "approver": approver,
                "payload": payload,
            }
        )

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
            "updated_at": "2026-06-11T00:00:00Z",
        }
        self.integration_config[connector_key] = row
        return row

    async def get_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        row = self.integration_config.get(connector_key)
        if row is None:
            return None
        if row.get("tenant_id") != tenant_id:
            return None
        return row

    async def disable_integration_config(self, *, tenant_id: str, connector_key: str) -> dict[str, Any] | None:
        row = self.integration_config.get(connector_key)
        if row is None:
            return None
        if row.get("tenant_id") != tenant_id:
            return None
        row = {**row, "enabled": False, "updated_at": "2026-06-11T00:00:01Z"}
        self.integration_config[connector_key] = row
        return row


class _FakeTemporalClient:
    def __init__(
        self,
        *,
        calls: list[str],
        signal_raises: Exception | None = None,
        run_agent_now_raises: Exception | None = None,
    ) -> None:
        self.calls = calls
        self.signal_calls: list[tuple[Any, Any]] = []
        self.asset_update_calls: list[dict[str, Any]] = []
        self.run_agent_now_calls: list[dict[str, str]] = []
        self._signal_raises = signal_raises
        self._run_agent_now_raises = run_agent_now_raises

    async def signal_approve(self, *, finding: FindingRecord, approver: Principal, note: str | None) -> None:
        if self._signal_raises is not None:
            raise self._signal_raises
        self.calls.append("signal")
        if finding.agent_key == _FLEET_AUDITOR_AGENT_KEY:
            self.signal_calls.append(
                (
                    FleetUtilizationWorkflow.approve_finding,
                    ApproveFleetFindingSignal(
                        asset_id=str(finding.contract_id),
                        finding_type=finding.finding_type,
                        fingerprint=finding.fingerprint,
                        approver_id=approver.sub,
                        approver_name=approver.name,
                        note=note,
                    ),
                )
            )
            return
        self.signal_calls.append(
            (
                RevenueRecognitionWorkflow.approve_finding,
                ApproveFindingSignal(
                    contract_id=str(finding.contract_id),
                    line_item_id=str(finding.line_item_id),
                    finding_type=finding.finding_type,
                    approver_id=approver.sub,
                    approver_name=approver.name,
                    note=note,
                ),
            )
        )

    async def signal_reject(self, *, finding: FindingRecord, approver: Principal, reason: str) -> None:
        if self._signal_raises is not None:
            raise self._signal_raises
        self.calls.append("signal")
        if finding.agent_key == _FLEET_AUDITOR_AGENT_KEY:
            self.signal_calls.append(
                (
                    FleetUtilizationWorkflow.reject_finding,
                    RejectFleetFindingSignal(
                        asset_id=str(finding.contract_id),
                        finding_type=finding.finding_type,
                        fingerprint=finding.fingerprint,
                        approver_id=approver.sub,
                        approver_name=approver.name,
                        note=reason,
                    ),
                )
            )
            return
        self.signal_calls.append(
            (
                RevenueRecognitionWorkflow.reject_finding,
                RejectFindingSignal(
                    contract_id=str(finding.contract_id),
                    line_item_id=str(finding.line_item_id),
                    finding_type=finding.finding_type,
                    approver_id=approver.sub,
                    approver_name=approver.name,
                    note=reason,
                ),
            )
        )

    async def run_asset_update(
        self,
        *,
        asset_id: str,
        current_data: dict[str, Any],
        comments: str | None,
        report_damage: bool,
        damage_summary: str | None,
        evidence: list[Any],
    ) -> dict[str, Any]:
        self.calls.append("asset_update")
        self.asset_update_calls.append(
            {
                "asset_id": asset_id,
                "current_data": current_data,
                "comments": comments,
                "report_damage": report_damage,
                "damage_summary": damage_summary,
                "evidence": evidence,
            }
        )
        return {
            "workflow_id": "asset-update-wf-1",
            "summary": "Agentic asset review completed: attached 1 image(s), captured operator comments, flagged damage severity as high.",
            "recommended_status": "in_maintenance",
            "damage_severity": "high",
            "updated_fields": ["image_url", "damage_report_summary", "status"],
            "proposed_data": {
                **current_data,
                "image_url": "https://cdn.example.com/evidence-1.jpg",
                "damage_reported": True,
                "damage_report_summary": damage_summary,
                "latest_condition_notes": comments,
                "status": "in_maintenance",
            },
        }

    async def run_agent_now(self, *, agent_key: str, tenant_id: str) -> dict[str, Any]:
        self.calls.append("run_agent_now")
        self.run_agent_now_calls.append({"agent_key": agent_key, "tenant_id": tenant_id})
        if self._run_agent_now_raises is not None:
            raise self._run_agent_now_raises
        return {"agent_key": agent_key, "schedule_id": f"fake:{tenant_id}:{agent_key}", "status": "triggered"}

    async def run_territory_brief(
        self,
        *,
        tenant_id: str,
        rep_id: str | None,
        account_id: str | None,
    ) -> dict[str, Any]:
        self.calls.append("territory_brief")
        self.territory_brief_calls: list[dict[str, Any]]
        if not hasattr(self, "territory_brief_calls"):
            self.territory_brief_calls = []
        self.territory_brief_calls.append(
            {"tenant_id": tenant_id, "rep_id": rep_id, "account_id": account_id}
        )
        return {"workflow_id": f"territory-account-brief-{tenant_id}-{rep_id or 'all'}-2026-01-01", "status": "accepted", "duplicate": False}


class _FakeSignalWorkflowHandle:
    def __init__(self) -> None:
        self.signal_calls: list[tuple[Any, Any]] = []

    async def signal(self, signal_method: Any, signal_payload: Any) -> None:
        self.signal_calls.append((signal_method, signal_payload))


class _FakeSignalTemporalClient:
    def __init__(self, handle: _FakeSignalWorkflowHandle) -> None:
        self.handle = handle
        self.workflow_ids: list[str] = []

    def get_workflow_handle(self, workflow_id: str) -> _FakeSignalWorkflowHandle:
        self.workflow_ids.append(workflow_id)
        return self.handle


class _FakeScheduleHandle:
    def __init__(self, *, trigger_raises: Exception | None = None) -> None:
        self.trigger_calls: list[dict[str, Any]] = []
        self._trigger_raises = trigger_raises

    async def trigger(self, **kwargs: Any) -> None:
        self.trigger_calls.append(kwargs)
        if self._trigger_raises is not None:
            raise self._trigger_raises


class _FakeScheduleTemporalClient:
    def __init__(self, handle: _FakeScheduleHandle) -> None:
        self.handle = handle
        self.schedule_ids: list[str] = []

    def get_schedule_handle(self, schedule_id: str) -> _FakeScheduleHandle:
        self.schedule_ids.append(schedule_id)
        return self.handle


def _make_finding(
    status: str = "pending_approval",
    tenant_id: str = "tenant-a-id",
    workflow_id: str | None = "wf-123",
    agent_key: str = "revrec-reviewer",
    finding_type: str = "unbilled_on_rent",
    fingerprint: str = "finding-fingerprint-1",
    proposed_action: str | None = None,
) -> FindingRecord:
    return FindingRecord(
        id="11111111-1111-1111-1111-111111111111",
        tenant_id=tenant_id,
        agent_key=agent_key,
        run_id="run-123",
        workflow_id=workflow_id,
        contract_id="22222222-2222-2222-2222-222222222222",
        line_item_id="33333333-3333-3333-3333-333333333333",
        fingerprint=fingerprint,
        finding_type=finding_type,
        status=status,
        proposed_action=proposed_action,
    )


def _make_client(
    *,
    role: str = "branch_manager",
    finding_status: str = "pending_approval",
    principal_tenant: str = "tenant-a",
    resolved_tenant_id: str | None = "tenant-a-id",
    finding_tenant_id: str = "tenant-a-id",
    can_operate: bool | None = None,
    finding_workflow_id: str | None = "wf-123",
    finding_agent_key: str = "revrec-reviewer",
    finding_type: str = "unbilled_on_rent",
    finding_fingerprint: str = "finding-fingerprint-1",
    finding_proposed_action: str | None = None,
    signal_raises: Exception | None = None,
    run_agent_now_raises: Exception | None = None,
    connector_registry: dict[str, ConnectorProvider] | None = None,
    raise_server_exceptions: bool = True,
) -> tuple[TestClient, _FakeSupabaseClient, _FakeTemporalClient, list[str]]:
    principal = Principal(sub="user-1", name="Casey", role=role, tenant=principal_tenant, can_operate=can_operate)
    call_order: list[str] = []
    supabase = _FakeSupabaseClient(
        principal=principal,
        finding=_make_finding(
            status=finding_status,
            tenant_id=finding_tenant_id,
            workflow_id=finding_workflow_id,
            agent_key=finding_agent_key,
            finding_type=finding_type,
            fingerprint=finding_fingerprint,
            proposed_action=finding_proposed_action,
        ),
        call_order=call_order,
        tenant_id=resolved_tenant_id,
    )
    temporal = _FakeTemporalClient(
        calls=call_order,
        signal_raises=signal_raises,
        run_agent_now_raises=run_agent_now_raises,
    )
    app = create_app(supabase_client=supabase, temporal_client=temporal, connector_registry=connector_registry)
    return TestClient(app, raise_server_exceptions=raise_server_exceptions), supabase, temporal, call_order


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


def _descartes_registry(
    *,
    validation_errors: list[str] | None = None,
    healthcheck_result: DescartesHealthcheckResult | None = None,
) -> dict[str, ConnectorProvider]:
    return {
        "descartes": ConnectorProvider(
            key="descartes",
            enabled_scopes=("route", "shipment", "compliance"),
            validate_config=lambda _config: validation_errors or [],
            healthcheck=lambda _config: healthcheck_result
            or DescartesHealthcheckResult(
                status="ok",
                classification="ok",
                message="Descartes connectivity verified",
                details={"status_code": 200},
            ),
        )
    }


def test_approve_maps_signal_args_and_persists_before_signal() -> None:
    client, supabase, temporal, call_order = _make_client()

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "Ship it"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert supabase.persisted[0]["status"] == "approved"
    assert temporal.signal_calls == [
        (
            RevenueRecognitionWorkflow.approve_finding,
            ApproveFindingSignal(
                contract_id=supabase.finding.contract_id or "",
                line_item_id=supabase.finding.line_item_id or "",
                finding_type="unbilled_on_rent",
                approver_id="user-1",
                approver_name="Casey",
                note="Ship it",
            ),
        )
    ]
    assert supabase.calls == ["get", "persist"]
    assert supabase.tenant_lookups == ["tenant-a"]
    assert call_order == ["persist", "signal"]


def test_fleet_approve_routes_to_fleet_workflow_signal() -> None:
    client, supabase, temporal, call_order = _make_client(
        finding_agent_key=_FLEET_AUDITOR_AGENT_KEY,
        finding_type="cross_branch_utilization_outlier",
        finding_fingerprint="fleet:asset-1:cross_branch_utilization_outlier:replace",
    )

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "Approved"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert temporal.signal_calls == [
        (
            FleetUtilizationWorkflow.approve_finding,
            ApproveFleetFindingSignal(
                asset_id=supabase.finding.contract_id or "",
                finding_type="cross_branch_utilization_outlier",
                fingerprint="fleet:asset-1:cross_branch_utilization_outlier:replace",
                approver_id="user-1",
                approver_name="Casey",
                note="Approved",
            ),
        )
    ]
    assert call_order == ["persist", "signal"]


@pytest.mark.asyncio
async def test_temporal_signal_client_routes_fleet_approval_to_fleet_workflow() -> None:
    signal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    handle = _FakeSignalWorkflowHandle()
    fake_temporal_client = _FakeSignalTemporalClient(handle)

    async def fake_client_instance() -> _FakeSignalTemporalClient:
        return fake_temporal_client

    signal_client._client_instance = fake_client_instance  # type: ignore[method-assign]
    finding = _make_finding(
        agent_key=_FLEET_AUDITOR_AGENT_KEY,
        finding_type="cross_branch_utilization_outlier",
        fingerprint="fleet:asset-1:cross_branch_utilization_outlier:replace",
    )

    await signal_client.signal_approve(
        finding=finding,
        approver=Principal(sub="user-1", name="Casey", role="branch_manager", tenant="tenant-a"),
        note="approved",
    )

    assert fake_temporal_client.workflow_ids == ["wf-123"]
    assert handle.signal_calls == [
        (
            FleetUtilizationWorkflow.approve_finding,
            ApproveFleetFindingSignal(
                asset_id="22222222-2222-2222-2222-222222222222",
                finding_type="cross_branch_utilization_outlier",
                fingerprint="fleet:asset-1:cross_branch_utilization_outlier:replace",
                approver_id="user-1",
                approver_name="Casey",
                note="approved",
            ),
        )
    ]


def test_ac1_ac2_run_agent_now_accepts_valid_ops_keys_and_uses_resolved_tenant() -> None:
    client, supabase, temporal, _ = _make_client(
        role="field_operator",
        principal_tenant="tenant-ops",
        resolved_tenant_id="resolved-tenant-id",
    )

    first = client.post("/api/ops/agents/revrec-analyst/run", headers=_auth_header())
    second = client.post("/api/ops/agents/vehicle-aging-analyst/run", headers=_auth_header())

    assert first.status_code == 202
    assert first.json() == {
        "agent_key": "revrec-analyst",
        "schedule_id": "fake:resolved-tenant-id:revrec-analyst",
        "status": "triggered",
    }
    assert second.status_code == 202
    assert second.json()["agent_key"] == "vehicle-aging-analyst"
    assert second.json()["status"] == "triggered"
    assert temporal.run_agent_now_calls == [
        {"agent_key": "revrec-analyst", "tenant_id": "resolved-tenant-id"},
        {"agent_key": "vehicle-aging-analyst", "tenant_id": "resolved-tenant-id"},
    ]
    assert supabase.tenant_lookups == ["tenant-ops", "tenant-ops"]


def test_ac3_run_agent_now_unknown_key_returns_404_without_temporal_interaction() -> None:
    client, supabase, temporal, _ = _make_client()

    response = client.post("/api/ops/agents/does-not-exist/run", headers=_auth_header())

    assert response.status_code == 404
    assert response.json() == {"detail": "Unknown agent_key: does-not-exist"}
    assert temporal.run_agent_now_calls == []
    assert "run_agent_now" not in temporal.calls
    assert supabase.tenant_lookups == []


def test_ac3_run_agent_now_not_provisioned_returns_409_without_500() -> None:
    client, _, temporal, _ = _make_client(
        run_agent_now_raises=AgentScheduleNotProvisioned("revrec-analyst"),
    )

    response = client.post("/api/ops/agents/revrec-analyst/run", headers=_auth_header())

    assert response.status_code == 409
    assert response.json() == {"detail": "Agent revrec-analyst is disabled or schedule not provisioned"}
    assert temporal.run_agent_now_calls == [{"agent_key": "revrec-analyst", "tenant_id": "tenant-a-id"}]


def test_ac3_run_agent_now_other_error_is_not_classified_as_409() -> None:
    client, _, temporal, _ = _make_client(
        run_agent_now_raises=RuntimeError("temporal down"),
        raise_server_exceptions=False,
    )

    response = client.post("/api/ops/agents/revrec-analyst/run", headers=_auth_header())

    assert response.status_code != 409
    assert response.status_code == 500
    assert temporal.run_agent_now_calls == [{"agent_key": "revrec-analyst", "tenant_id": "tenant-a-id"}]


def test_ac4_run_agent_now_requires_operating_role() -> None:
    client, supabase, temporal, _ = _make_client(role="viewer")

    response = client.post("/api/ops/agents/revrec-analyst/run", headers=_auth_header())

    assert response.status_code == 403
    assert response.json() == {"detail": "Insufficient role for operation"}
    assert temporal.run_agent_now_calls == []
    assert supabase.tenant_lookups == []


def test_ac4_run_agent_now_rejects_can_operate_false() -> None:
    client, supabase, temporal, _ = _make_client(role="branch_manager", can_operate=False)

    response = client.post("/api/ops/agents/revrec-analyst/run", headers=_auth_header())

    assert response.status_code == 403
    assert response.json() == {"detail": "Operate permission denied"}
    assert temporal.run_agent_now_calls == []
    assert supabase.tenant_lookups == []


def test_ac4_run_agent_now_tenant_access_denied() -> None:
    client, supabase, temporal, _ = _make_client(
        role="field_operator",
        principal_tenant="unknown-tenant",
        resolved_tenant_id=None,
    )

    response = client.post("/api/ops/agents/revrec-analyst/run", headers=_auth_header())

    assert response.status_code == 403
    assert response.json() == {"detail": "Tenant access denied"}
    assert supabase.tenant_lookups == ["unknown-tenant"]
    assert temporal.run_agent_now_calls == []


def test_ac4_run_agent_now_scopes_to_authenticated_principal_tenant() -> None:
    client, supabase, temporal, _ = _make_client(
        role="admin",
        principal_tenant="dealer-east",
        resolved_tenant_id="tenant-east-id",
    )

    response = client.post("/api/ops/agents/fleet-auditor/run", headers=_auth_header())

    assert response.status_code == 202
    assert response.json()["schedule_id"] == "fake:tenant-east-id:fleet-auditor"
    assert supabase.tenant_lookups == ["dealer-east"]
    assert temporal.run_agent_now_calls == [{"agent_key": "fleet-auditor", "tenant_id": "tenant-east-id"}]


@pytest.mark.asyncio
async def test_ac5_temporal_signal_client_triggers_schedule_with_skip_overlap() -> None:
    signal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    handle = _FakeScheduleHandle()
    fake_temporal_client = _FakeScheduleTemporalClient(handle)

    async def fake_client_instance() -> _FakeScheduleTemporalClient:
        return fake_temporal_client

    signal_client._client_instance = fake_client_instance  # type: ignore[method-assign]

    result = await signal_client.run_agent_now(agent_key="revrec-analyst", tenant_id="tenant-a-id")

    assert result == {
        "agent_key": "revrec-analyst",
        "schedule_id": "ops:tenant-a-id:revrec-analyst",
        "status": "triggered",
    }
    assert fake_temporal_client.schedule_ids == ["ops:tenant-a-id:revrec-analyst"]
    assert handle.trigger_calls == [{"overlap": ScheduleOverlapPolicy.SKIP}]


@pytest.mark.asyncio
async def test_ac5_temporal_signal_client_maps_missing_schedule_and_propagates_other_rpc_errors() -> None:
    missing_schedule_error = RPCError("missing schedule", RPCStatusCode.NOT_FOUND, b"")
    signal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    missing_handle = _FakeScheduleHandle(trigger_raises=missing_schedule_error)
    missing_temporal_client = _FakeScheduleTemporalClient(missing_handle)

    async def missing_client_instance() -> _FakeScheduleTemporalClient:
        return missing_temporal_client

    signal_client._client_instance = missing_client_instance  # type: ignore[method-assign]

    with pytest.raises(AgentScheduleNotProvisioned):
        await signal_client.run_agent_now(agent_key="revrec-analyst", tenant_id="tenant-a-id")

    internal_error = RPCError("temporal unavailable", RPCStatusCode.INTERNAL, b"")
    signal_client = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")
    failing_handle = _FakeScheduleHandle(trigger_raises=internal_error)
    failing_temporal_client = _FakeScheduleTemporalClient(failing_handle)

    async def failing_client_instance() -> _FakeScheduleTemporalClient:
        return failing_temporal_client

    signal_client._client_instance = failing_client_instance  # type: ignore[method-assign]

    with pytest.raises(RPCError) as excinfo:
        await signal_client.run_agent_now(agent_key="revrec-analyst", tenant_id="tenant-a-id")

    assert excinfo.value is internal_error


def test_reject_requires_reason() -> None:
    client, supabase, temporal, _ = _make_client()

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/reject",
        headers=_auth_header(),
        json={"reason": "   "},
    )

    assert response.status_code == 422
    assert temporal.signal_calls == []
    assert supabase.persisted == []


def test_can_operate_enforced_server_side() -> None:
    client, supabase, temporal, _ = _make_client(role="read_only")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 403
    assert temporal.signal_calls == []
    assert supabase.persisted == []
    assert supabase.calls == []


def test_explicit_can_operate_denied_server_side() -> None:
    client, supabase, temporal, _ = _make_client(role="branch_manager", can_operate=False)

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 403
    assert temporal.signal_calls == []
    assert supabase.persisted == []
    assert supabase.calls == []


def test_cross_tenant_approve_denied_without_persist_or_signal() -> None:
    client, supabase, temporal, _ = _make_client(finding_tenant_id="tenant-b-id")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "should not pass"},
    )

    assert response.status_code == 404
    assert temporal.signal_calls == []
    assert supabase.persisted == []
    assert supabase.calls == ["get"]


def test_cross_tenant_reject_denied_without_persist_or_signal() -> None:
    client, supabase, temporal, _ = _make_client(finding_tenant_id="tenant-b-id")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/reject",
        headers=_auth_header(),
        json={"reason": "should not pass"},
    )

    assert response.status_code == 404
    assert temporal.signal_calls == []
    assert supabase.persisted == []
    assert supabase.calls == ["get"]


def test_terminal_disposition_is_idempotent_noop() -> None:
    client, supabase, temporal, _ = _make_client(finding_status="approved")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "duplicate"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": True}
    assert temporal.signal_calls == []
    assert supabase.persisted == []


def test_reject_maps_signal_args() -> None:
    client, supabase, temporal, _ = _make_client()

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/reject",
        headers=_auth_header(),
        json={"reason": "Not enough confidence"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert temporal.signal_calls == [
        (
            RevenueRecognitionWorkflow.reject_finding,
            RejectFindingSignal(
                contract_id=supabase.finding.contract_id or "",
                line_item_id=supabase.finding.line_item_id or "",
                finding_type="unbilled_on_rent",
                approver_id="user-1",
                approver_name="Casey",
                note="Not enough confidence",
            ),
        )
    ]


def test_decision_endpoint_accepts_contract_payload_and_approves() -> None:
    client, supabase, temporal, call_order = _make_client()

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": supabase.finding.workflow_id,
            "run_id": supabase.finding.run_id,
            "decision": "approve",
            "approver_id": "user-1",
            "approver_name": "Casey",
            "note": "Looks good",
        },
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert supabase.persisted[0]["status"] == "approved"
    assert supabase.persisted[0]["approver"]["approver_id"] == "user-1"
    assert supabase.persisted[0]["approver"]["approver_name"] == "Casey"
    assert temporal.signal_calls[0][0] is RevenueRecognitionWorkflow.approve_finding
    assert call_order == ["persist", "signal"]


def test_decision_approve_invokes_execute_finding_action_with_persisted_finding() -> None:
    """Issue #73 AC1-AC4 wiring: approving a vehicle-aging finding must route the
    *persisted* (approved) finding into execute_finding_action so the recommended
    action is actually executed. Closes the gap that execute was only unit-tested
    in isolation."""
    client, supabase, temporal, call_order = _make_client(
        finding_agent_key="vehicle-aging-analyst",
        finding_type="stock_aging_90d",
        finding_fingerprint="stock_aging:22222222-2222-2222-2222-222222222222:stock_aging_90d",
        finding_proposed_action="markdown",
    )

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": supabase.finding.workflow_id,
            "run_id": supabase.finding.run_id,
            "decision": "approve",
            "approver_id": "user-1",
            "approver_name": "Casey",
            "note": "Approve markdown",
        },
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}

    # The executor was invoked exactly once, with the persisted finding (status
    # flipped to approved) and the recommended action intact.
    assert len(supabase.execute_calls) == 1
    executed = supabase.execute_calls[0]
    handed_finding = executed["finding"]
    assert handed_finding.id == supabase.finding.id
    assert handed_finding.status == "approved"
    assert handed_finding.finding_type == "stock_aging_90d"
    assert handed_finding.proposed_action == "markdown"
    assert handed_finding.contract_id == "22222222-2222-2222-2222-222222222222"
    # Approver context is threaded through to the executor.
    assert executed["approver"]["approver_id"] == "user-1"
    assert executed["approver"]["approver_name"] == "Casey"
    # Execute runs after the disposition is persisted and is not in call_order
    # (it is recorded separately); the workflow signal is still attempted.
    assert call_order == ["persist", "signal"]
    assert supabase.audit_events == []  # approve path does not write the dismiss audit


def test_decision_reject_does_not_invoke_execute_finding_action() -> None:
    """Reject must never execute the recommended action."""
    client, supabase, temporal, call_order = _make_client(
        finding_agent_key="vehicle-aging-analyst",
        finding_type="stock_aging_90d",
        finding_proposed_action="markdown",
    )

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": supabase.finding.workflow_id,
            "run_id": supabase.finding.run_id,
            "decision": "reject",
            "approver_id": "user-1",
            "approver_name": "Casey",
            "reason": "Not aged enough",
        },
    )

    assert response.status_code == 202
    assert supabase.persisted[0]["status"] == "rejected"
    assert supabase.execute_calls == []
    assert supabase.audit_events == []


def test_decision_dismiss_persists_as_rejected_audits_and_does_not_signal_or_execute() -> None:
    """Issue #73 AC5: dismissing a finding persists it out of the pending queue
    (status mapped to 'rejected', tagged disposition='dismissed', NO reason
    required), writes the 'vehicle_finding_dismissed' audit, and must NOT signal
    the workflow nor execute the recommended action."""
    client, supabase, temporal, call_order = _make_client(
        finding_agent_key="vehicle-aging-analyst",
        finding_type="stock_aging_90d",
        finding_proposed_action="markdown",
    )

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": supabase.finding.workflow_id,
            "run_id": supabase.finding.run_id,
            "decision": "dismiss",
            "approver_id": "user-1",
            "approver_name": "Casey",
            # Intentionally NO "reason" — dismiss must not require one.
        },
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}

    # Persisted out of the pending queue: status -> rejected, tagged dismissed.
    assert len(supabase.persisted) == 1
    persisted = supabase.persisted[0]
    assert persisted["status"] == "rejected"
    assert persisted["approver"]["disposition"] == "dismissed"
    assert persisted["approver"]["note"] is None

    # Dismiss is audited against the vehicle entity.
    assert len(supabase.audit_events) == 1
    audit = supabase.audit_events[0]
    assert audit["event_type"] == "vehicle_finding_dismissed"
    assert audit["entity_id"] == supabase.finding.contract_id
    assert audit["finding_id"] == supabase.finding.id
    assert audit["action_type"] == "markdown"
    assert audit["payload"] == {"disposition": "dismissed"}

    # Dismiss must NOT signal the workflow and must NOT execute the action.
    assert temporal.signal_calls == []
    assert supabase.execute_calls == []
    assert call_order == ["persist"]


def test_decision_dismiss_without_contract_id_still_persists_without_audit() -> None:
    """A dismiss for a finding with no vehicle entity (contract_id) still persists
    as rejected/dismissed; the audit is skipped because there is no entity to
    anchor it to (the handler must not raise)."""
    client, supabase, temporal, call_order = _make_client(
        finding_agent_key="vehicle-aging-analyst",
        finding_type="stock_aging_90d",
        finding_proposed_action="monitor",
    )
    supabase.finding = replace(supabase.finding, contract_id=None)

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "decision": "dismiss",
            "approver_id": "user-1",
            "approver_name": "Casey",
        },
    )

    assert response.status_code == 202
    assert supabase.persisted[0]["status"] == "rejected"
    assert supabase.persisted[0]["approver"]["disposition"] == "dismissed"
    assert supabase.audit_events == []
    assert supabase.execute_calls == []
    assert temporal.signal_calls == []


def test_decision_endpoint_reject_requires_reason() -> None:
    client, supabase, temporal, _ = _make_client()

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": supabase.finding.workflow_id,
            "run_id": supabase.finding.run_id,
            "decision": "reject",
            "approver_id": "user-1",
            "approver_name": "Casey",
            "reason": "   ",
        },
    )

    assert response.status_code == 422
    assert temporal.signal_calls == []
    assert supabase.persisted == []


def test_decision_endpoint_rejects_mismatched_approver_name() -> None:
    client, supabase, temporal, _ = _make_client()

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": supabase.finding.workflow_id,
            "run_id": supabase.finding.run_id,
            "decision": "approve",
            "approver_id": "user-1",
            "approver_name": "Spoofed Name",
            "note": "Looks good",
        },
    )

    assert response.status_code == 403
    assert temporal.signal_calls == []
    assert supabase.persisted == []


def test_decision_endpoint_terminal_finding_rejects_mismatched_workflow_identity() -> None:
    client, supabase, temporal, _ = _make_client(finding_status="approved")

    response = client.post(
        "/api/ops/findings/decision",
        headers=_auth_header(),
        json={
            "finding_id": supabase.finding.id,
            "workflow_id": "wf-mismatch",
            "run_id": supabase.finding.run_id,
            "decision": "approve",
            "approver_id": "user-1",
            "approver_name": "Casey",
            "note": "Looks good",
        },
    )

    assert response.status_code == 409
    assert temporal.signal_calls == []
    assert supabase.persisted == []


def test_approve_skips_signal_and_returns_202_when_workflow_id_is_none() -> None:
    """Findings without a workflow_id (e.g. seeded manually) should still be approvable."""
    client, supabase, temporal, call_order = _make_client(finding_workflow_id=None)

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "Looks good"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert supabase.persisted[0]["status"] == "approved"
    assert temporal.signal_calls == []
    assert call_order == ["persist"]


def test_reject_skips_signal_and_returns_202_when_workflow_id_is_none() -> None:
    """Findings without a workflow_id should still be rejectable."""
    client, supabase, temporal, call_order = _make_client(finding_workflow_id=None)

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/reject",
        headers=_auth_header(),
        json={"reason": "Delta looks wrong"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert supabase.persisted[0]["status"] == "rejected"
    assert temporal.signal_calls == []
    assert call_order == ["persist"]


def test_approve_returns_202_when_temporal_signal_fails() -> None:
    """A Temporal connection error must not cause the endpoint to return a non-202 status
    when the DB disposition already succeeded."""
    client, supabase, temporal, call_order = _make_client(
        signal_raises=RuntimeError("workflow not found")
    )

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "Ship it"},
    )

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "idempotent": False}
    assert supabase.persisted[0]["status"] == "approved"
    assert temporal.signal_calls == []
    assert call_order == ["persist"]


def test_asset_update_request_runs_temporal_analysis_and_appends_entity_version() -> None:
    client, supabase, temporal, call_order = _make_client()

    response = client.post(
        "/api/ops/assets/asset-1/update-request",
        headers=_auth_header(),
        json={
            "comments": "Hydraulic leak visible by the boom.",
            "report_damage": True,
            "damage_summary": "Leak with damaged hose",
            "evidence": [
                {
                    "file_name": "damage.jpg",
                    "path": "assets/asset-1/damage.jpg",
                    "url": "https://cdn.example.com/evidence-1.jpg",
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "accepted",
        "workflow_id": "asset-update-wf-1",
        "summary": "Agentic asset review completed: attached 1 image(s), captured operator comments, flagged damage severity as high.",
        "recommended_status": "in_maintenance",
        "damage_severity": "high",
        "updated_fields": ["image_url", "damage_report_summary", "status"],
        "version_number": 4,
    }
    assert temporal.asset_update_calls[0]["asset_id"] == "asset-1"
    assert supabase.appended_versions[0]["version_number"] == 4
    assert supabase.appended_versions[0]["data"]["status"] == "in_maintenance"
    assert call_order == ["asset_update"]
    assert supabase.calls[-2:] == ["get_entity", "append_entity"]


def test_asset_update_request_requires_evidence_or_comments() -> None:
    client, supabase, temporal, _ = _make_client()

    response = client.post(
        "/api/ops/assets/asset-1/update-request",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 422
    assert temporal.asset_update_calls == []
    assert supabase.appended_versions == []


def test_configure_descartes_persists_tenant_scoped_integration_config() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_descartes_registry())

    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": ["route", "shipment", "compliance"],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
            "compliance_profile": {"hos_mode": "eld"},
            "healthcheck_path": "/health",
            "healthcheck_timeout_seconds": 5,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "configured"
    assert payload["connector_key"] == "descartes"
    assert supabase.integration_config["descartes"]["tenant_id"] == "tenant-a-id"
    assert supabase.integration_config["descartes"]["secret_refs"]["auth_secret_ref"].startswith("secret://")


def test_configure_descartes_returns_configuration_validation_errors() -> None:
    client, _supabase, _temporal, _ = _make_client(
        connector_registry=_descartes_registry(validation_errors=["enabled_scopes must include at least one scope"])
    )

    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": [],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
            "compliance_profile": {"hos_mode": "eld"},
        },
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["classification"] == "configuration"
    assert "enabled_scopes must include at least one scope" in detail["errors"]


def test_configure_descartes_preserves_custom_schedule_on_update() -> None:
    """Configure/update call must not wipe an existing custom/disabled schedule."""
    client, supabase, _temporal, _ = _make_client(connector_registry=_descartes_registry())

    # Initial configure with custom schedule
    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": ["route", "shipment"],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
            "compliance_profile": {},
            "schedule": {"enabled": False, "cron": "0 2 * * *"},
        },
    )

    assert response.status_code == 200
    assert supabase.integration_config["descartes"]["schedule"] == {"enabled": False, "cron": "0 2 * * *"}

    # Update config with different schedule
    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": ["route", "shipment", "compliance"],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
            "compliance_profile": {"hos_mode": "eld"},
            "schedule": {"enabled": True, "cron": "0 */4 * * *"},
        },
    )

    assert response.status_code == 200
    # Schedule should be updated to the new value, not clobbered to {}
    assert supabase.integration_config["descartes"]["schedule"] == {"enabled": True, "cron": "0 */4 * * *"}

    # Update config without schedule field (default empty dict)
    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": ["route"],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {},
            "compliance_profile": {},
        },
    )

    assert response.status_code == 200
    # When schedule is omitted (None), existing schedule is preserved
    assert supabase.integration_config["descartes"]["schedule"] == {"enabled": True, "cron": "0 */4 * * *"}


def test_configure_descartes_explicit_empty_schedule_resets() -> None:
    """Explicitly providing schedule={} must reset the schedule."""
    client, supabase, _temporal, _ = _make_client(connector_registry=_descartes_registry())

    # Initial configure with custom schedule
    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": ["route", "shipment"],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
            "compliance_profile": {},
            "schedule": {"enabled": False, "cron": "0 2 * * *"},
        },
    )

    assert response.status_code == 200
    assert supabase.integration_config["descartes"]["schedule"] == {"enabled": False, "cron": "0 2 * * *"}

    # Update config with explicit empty schedule
    response = client.post(
        "/api/ops/integrations/descartes/configure",
        headers=_auth_header(),
        json={
            "enabled": True,
            "endpoint_base_url": "https://api.descartes.example",
            "auth_secret_ref": "secret://integrations/descartes/token",
            "enabled_scopes": ["route"],
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {},
            "compliance_profile": {},
            "schedule": {},
        },
    )

    assert response.status_code == 200
    # Explicitly provided {} resets the schedule
    assert supabase.integration_config["descartes"]["schedule"] == {}


def test_validate_descartes_returns_healthcheck_classification() -> None:
    client, supabase, _temporal, _ = _make_client(
        connector_registry=_descartes_registry(
            healthcheck_result=DescartesHealthcheckResult(
                status="failed",
                classification="auth",
                message="Auth check failed",
                details={"status_code": 401},
            )
        )
    )
    supabase.integration_config["descartes"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "descartes",
        "enabled": True,
        "settings": {
            "endpoint_base_url": "https://api.descartes.example",
            "enabled_scopes": ["route"],
            "healthcheck_path": "/health",
            "healthcheck_timeout_seconds": 5,
        },
        "mappings": {
            "route_mapping_profile": {"route_id_field": "routeNumber"},
            "shipment_mapping_profile": {"shipment_id_field": "shipmentNumber"},
            "compliance_profile": {"hos_mode": "eld"},
        },
        "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
        "schedule": {},
        "updated_at": "2026-06-11T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/descartes/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "classification": "auth",
        "message": "Auth check failed",
        "details": {"status_code": 401},
    }


def test_disable_descartes_marks_config_disabled() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_descartes_registry())
    supabase.integration_config["descartes"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "descartes",
        "enabled": True,
        "settings": {"endpoint_base_url": "https://api.descartes.example", "enabled_scopes": ["route"]},
        "mappings": {},
        "secret_refs": {"auth_secret_ref": "secret://integrations/descartes/token"},
        "schedule": {},
        "updated_at": "2026-06-11T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/descartes/disable", headers=_auth_header())

    assert response.status_code == 200
    assert response.json()["status"] == "disabled"
    assert supabase.integration_config["descartes"]["enabled"] is False


def test_validate_descartes_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal, _ = _make_client(connector_registry=_descartes_registry())

    response = client.post("/api/ops/integrations/descartes/validate", headers=_auth_header())

    assert response.status_code == 404


def test_disable_descartes_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal, _ = _make_client(connector_registry=_descartes_registry())

    response = client.post("/api/ops/integrations/descartes/disable", headers=_auth_header())

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Samsara connector endpoints
# ---------------------------------------------------------------------------


def _samsara_registry(
    *,
    validation_errors: list[str] | None = None,
    healthcheck_result: SamsaraHealthcheckResult | None = None,
) -> dict[str, ConnectorProvider]:
    return {
        "samsara": ConnectorProvider(
            key="samsara",
            enabled_scopes=("gps", "hours", "eld", "dashcam_events"),
            validate_config=lambda _config: validation_errors or [],
            healthcheck=lambda _config: healthcheck_result
            or SamsaraHealthcheckResult(
                status="ok",
                classification="ok",
                message="Samsara connectivity verified",
                details={"status_code": 200},
            ),
        )
    }


def _samsara_configure_payload() -> dict[str, Any]:
    return {
        "enabled": True,
        "api_base_url": "https://api.samsara.com",
        "api_secret_ref": "secret://integrations/samsara/api_key",
        "enabled_scopes": ["gps", "hours", "eld", "dashcam_events"],
        "fleet_targeting": {"group_ids": ["group-1"]},
        "gps_mapping_profile": {"asset_id_field": "vehicleId"},
        "hours_mapping_profile": {"driver_id_field": "driverId"},
        "eld_profile": {"hos_mode": "property"},
        "dashcam_event_profile": {"event_types": ["harsh_braking"]},
        "healthcheck_path": "/v1/me",
        "healthcheck_timeout_seconds": 5,
    }


def test_configure_samsara_persists_tenant_scoped_integration_config() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_samsara_registry())

    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json=_samsara_configure_payload(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "configured"
    assert payload["connector_key"] == "samsara"
    assert supabase.integration_config["samsara"]["tenant_id"] == "tenant-a-id"
    assert supabase.integration_config["samsara"]["secret_refs"]["api_secret_ref"].startswith("secret://")


def test_configure_samsara_stores_fleet_targeting_in_settings() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_samsara_registry())

    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json=_samsara_configure_payload(),
    )

    assert response.status_code == 200
    settings = supabase.integration_config["samsara"]["settings"]
    assert settings["fleet_targeting"] == {"group_ids": ["group-1"]}
    assert settings["enabled_scopes"] == ["gps", "hours", "eld", "dashcam_events"]


def test_configure_samsara_stores_mapping_profiles_in_mappings() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_samsara_registry())

    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json=_samsara_configure_payload(),
    )

    assert response.status_code == 200
    mappings = supabase.integration_config["samsara"]["mappings"]
    assert mappings["gps_mapping_profile"] == {"asset_id_field": "vehicleId"}
    assert mappings["hours_mapping_profile"] == {"driver_id_field": "driverId"}
    assert mappings["eld_profile"] == {"hos_mode": "property"}
    assert mappings["dashcam_event_profile"] == {"event_types": ["harsh_braking"]}


def test_configure_samsara_returns_configuration_validation_errors() -> None:
    client, _supabase, _temporal, _ = _make_client(
        connector_registry=_samsara_registry(
            validation_errors=["fleet_targeting must be a non-empty object"]
        )
    )

    response = client.post(
        "/api/ops/integrations/samsara/configure",
        headers=_auth_header(),
        json={**_samsara_configure_payload(), "fleet_targeting": {}},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["classification"] == "configuration"
    assert "fleet_targeting must be a non-empty object" in detail["errors"]


def test_validate_samsara_returns_healthcheck_classification() -> None:
    client, supabase, _temporal, _ = _make_client(
        connector_registry=_samsara_registry(
            healthcheck_result=SamsaraHealthcheckResult(
                status="failed",
                classification="auth",
                message="Auth check failed",
                details={"status_code": 401},
            )
        )
    )
    supabase.integration_config["samsara"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "samsara",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.samsara.com",
            "enabled_scopes": ["gps"],
            "fleet_targeting": {"group_ids": ["group-1"]},
            "healthcheck_path": "/v1/me",
            "healthcheck_timeout_seconds": 5,
        },
        "mappings": {
            "gps_mapping_profile": {"asset_id_field": "vehicleId"},
            "hours_mapping_profile": {},
            "eld_profile": {},
            "dashcam_event_profile": {},
        },
        "secret_refs": {"api_secret_ref": "secret://integrations/samsara/api_key"},
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/samsara/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "classification": "auth",
        "message": "Auth check failed",
        "details": {"status_code": 401},
    }


def test_validate_samsara_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal, _ = _make_client(connector_registry=_samsara_registry())

    response = client.post("/api/ops/integrations/samsara/validate", headers=_auth_header())

    assert response.status_code == 404


def test_disable_samsara_marks_config_disabled() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_samsara_registry())
    supabase.integration_config["samsara"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "samsara",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.samsara.com",
            "enabled_scopes": ["gps"],
            "fleet_targeting": {"group_ids": ["group-1"]},
        },
        "mappings": {"gps_mapping_profile": {"asset_id_field": "vehicleId"}},
        "secret_refs": {"api_secret_ref": "secret://integrations/samsara/api_key"},
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/samsara/disable", headers=_auth_header())

    assert response.status_code == 200
    assert response.json()["status"] == "disabled"
    assert supabase.integration_config["samsara"]["enabled"] is False


def test_disable_samsara_returns_404_when_config_missing() -> None:
    client, _supabase, _temporal, _ = _make_client(connector_registry=_samsara_registry())

    response = client.post("/api/ops/integrations/samsara/disable", headers=_auth_header())

    assert response.status_code == 404


def _billtrust_registry(
    *,
    validation_errors: list[str] | None = None,
    healthcheck_result: BilltrustHealthcheckResult | None = None,
) -> dict[str, ConnectorProvider]:
    return {
        "billtrust": ConnectorProvider(
            key="billtrust",
            enabled_scopes=("invoices", "payments", "ar_aging"),
            validate_config=lambda _config: validation_errors or [],
            healthcheck=lambda _config: healthcheck_result
            or BilltrustHealthcheckResult(
                status="ok",
                classification="ok",
                message="Billtrust connectivity verified",
                details={"status_code": 200},
            ),
        )
    }


def _billtrust_configure_payload() -> dict[str, Any]:
    return {
        "enabled": True,
        "api_base_url": "https://api.billtrust.example",
        "client_id_secret_ref": "secret://integrations/billtrust/client_id",
        "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        "enabled_scopes": ["invoices", "payments"],
        "tenant_mapping": {
            "customer_id_field": "customerId",
            "billing_account_id_field": "accountId",
        },
        "invoice_mapping_profile": {"invoice_id_field": "invoiceNumber"},
        "payment_mapping_profile": {"payment_id_field": "paymentId"},
        "ar_aging_profile": {"aging_buckets": [30, 60, 90]},
        "healthcheck_path": "/v1/health",
        "healthcheck_timeout_seconds": 5,
    }


def test_configure_billtrust_persists_tenant_scoped_integration_config() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_billtrust_registry())

    response = client.post(
        "/api/ops/integrations/billtrust/configure",
        headers=_auth_header(),
        json=_billtrust_configure_payload(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "configured"
    assert payload["connector_key"] == "billtrust"
    assert supabase.integration_config["billtrust"]["tenant_id"] == "tenant-a-id"
    assert (
        supabase.integration_config["billtrust"]["secret_refs"]["client_id_secret_ref"].startswith("secret://")
    )
    assert "client_secret" not in str(supabase.integration_config["billtrust"]["settings"])


def test_configure_billtrust_stores_target_mapping_in_settings() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_billtrust_registry())

    response = client.post(
        "/api/ops/integrations/billtrust/configure",
        headers=_auth_header(),
        json=_billtrust_configure_payload(),
    )

    assert response.status_code == 200
    settings = supabase.integration_config["billtrust"]["settings"]
    assert settings["tenant_mapping"] == {
        "customer_id_field": "customerId",
        "billing_account_id_field": "accountId",
    }
    assert settings["enabled_scopes"] == ["invoices", "payments"]


def test_configure_billtrust_returns_configuration_validation_errors() -> None:
    client, _supabase, _temporal, _ = _make_client(
        connector_registry=_billtrust_registry(
            validation_errors=["tenant_mapping must be a non-empty object"]
        )
    )

    response = client.post(
        "/api/ops/integrations/billtrust/configure",
        headers=_auth_header(),
        json={**_billtrust_configure_payload(), "tenant_mapping": {}},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["classification"] == "configuration"
    assert "tenant_mapping must be a non-empty object" in detail["errors"]


def test_validate_billtrust_returns_target_resolution_failure() -> None:
    client, supabase, _temporal, _ = _make_client(
        connector_registry=_billtrust_registry(
            healthcheck_result=BilltrustHealthcheckResult(
                status="failed",
                classification="configuration",
                message="Target account/tenant resolution failed",
                details={"status_code": 404},
            )
        )
    )
    supabase.integration_config["billtrust"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "billtrust",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.billtrust.example",
            "enabled_scopes": ["invoices"],
            "tenant_mapping": {
                "customer_id_field": "customerId",
                "billing_account_id_field": "accountId",
            },
            "healthcheck_path": "/v1/health",
            "healthcheck_timeout_seconds": 5,
        },
        "mappings": {
            "invoice_mapping_profile": {"invoice_id_field": "invoiceNumber"},
            "payment_mapping_profile": {"payment_id_field": "paymentId"},
            "ar_aging_profile": {"aging_buckets": [30, 60, 90]},
        },
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/billtrust/client_id",
            "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        },
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/billtrust/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "classification": "configuration",
        "message": "Target account/tenant resolution failed",
        "details": {"status_code": 404},
    }


def test_validate_billtrust_sanitizes_secret_resolution_details() -> None:
    client, supabase, _temporal, _ = _make_client(
        connector_registry={
            "billtrust": ConnectorProvider(
                key="billtrust",
                enabled_scopes=("invoices", "payments", "ar_aging"),
                validate_config=lambda _config: [],
                healthcheck=lambda config: run_billtrust_healthcheck(config, health_probe=lambda **_: 200),
            )
        }
    )
    supabase.integration_config["billtrust"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "billtrust",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.billtrust.example",
            "enabled_scopes": ["invoices"],
            "tenant_mapping": {
                "customer_id_field": "customerId",
                "billing_account_id_field": "accountId",
            },
            "healthcheck_path": "/v1/health",
            "healthcheck_timeout_seconds": 5,
        },
        "mappings": {
            "invoice_mapping_profile": {"invoice_id_field": "invoiceNumber"},
            "payment_mapping_profile": {"payment_id_field": "paymentId"},
            "ar_aging_profile": {"aging_buckets": [30, 60, 90]},
        },
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/billtrust/client_id",
            "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        },
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/billtrust/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "classification": "auth",
        "message": "Auth secret resolution failed",
        "details": {"reason": "secret_resolution_failed"},
    }
    assert "secret://" not in response.text
    assert "integrations/billtrust/client_id" not in response.text


def test_validate_billtrust_sanitizes_transport_error_details() -> None:
    raw_error = "https://api.billtrust.example host billtrust.internal token=abc123 timeout"
    client, supabase, _temporal, _ = _make_client(
        connector_registry={
            "billtrust": ConnectorProvider(
                key="billtrust",
                enabled_scopes=("invoices", "payments", "ar_aging"),
                validate_config=lambda _config: [],
                healthcheck=lambda config: run_billtrust_healthcheck(
                    config,
                    secret_resolver=lambda _: "token",
                    health_probe=lambda **_: (_ for _ in ()).throw(error.URLError(raw_error)),
                ),
            )
        }
    )
    supabase.integration_config["billtrust"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "billtrust",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.billtrust.example",
            "enabled_scopes": ["invoices"],
            "tenant_mapping": {
                "customer_id_field": "customerId",
                "billing_account_id_field": "accountId",
            },
            "healthcheck_path": "/v1/health",
            "healthcheck_timeout_seconds": 5,
        },
        "mappings": {
            "invoice_mapping_profile": {"invoice_id_field": "invoiceNumber"},
            "payment_mapping_profile": {"payment_id_field": "paymentId"},
            "ar_aging_profile": {"aging_buckets": [30, 60, 90]},
        },
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/billtrust/client_id",
            "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        },
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/billtrust/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "classification": "connectivity",
        "message": "Connectivity check failed",
        "details": {"reason": "transport_error"},
    }
    assert raw_error not in response.text
    assert "billtrust.internal" not in response.text


def test_validate_billtrust_returns_404_for_other_tenant_config() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_billtrust_registry())
    supabase.integration_config["billtrust"] = {
        "tenant_id": "tenant-b-id",
        "connector_key": "billtrust",
        "enabled": True,
        "settings": {"api_base_url": "https://api.billtrust.example"},
        "mappings": {},
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/billtrust/client_id",
            "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        },
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/billtrust/validate", headers=_auth_header())

    assert response.status_code == 404


def test_disable_billtrust_marks_config_disabled() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_billtrust_registry())
    supabase.integration_config["billtrust"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "billtrust",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.billtrust.example",
            "enabled_scopes": ["invoices"],
            "tenant_mapping": {
                "customer_id_field": "customerId",
                "billing_account_id_field": "accountId",
            },
        },
        "mappings": {"invoice_mapping_profile": {"invoice_id_field": "invoiceNumber"}},
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/billtrust/client_id",
            "client_secret_secret_ref": "secret://integrations/billtrust/client_secret",
        },
        "schedule": {},
        "updated_at": "2026-06-12T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/billtrust/disable", headers=_auth_header())

    assert response.status_code == 200
    assert response.json()["status"] == "disabled"
    assert supabase.integration_config["billtrust"]["enabled"] is False


def _sage_registry(
    *,
    validation_errors: list[str] | None = None,
    healthcheck_result: SageHealthcheckResult | None = None,
    healthcheck_configs: list[dict[str, Any]] | None = None,
) -> dict[str, ConnectorProvider]:
    def _healthcheck(config: dict[str, Any]) -> SageHealthcheckResult:
        if healthcheck_configs is not None:
            healthcheck_configs.append(config)
        return healthcheck_result or SageHealthcheckResult(
            status="ok",
            classification="ok",
            message="Sage Intacct connectivity verified",
            details={"status_code": 200},
        )

    return {
        "sage_intacct": ConnectorProvider(
            key="sage_intacct",
            enabled_scopes=("general_ledger", "accounts_payable", "accounts_receivable", "cash_management"),
            validate_config=lambda _config: validation_errors or [],
            healthcheck=_healthcheck,
        )
    }


def _sage_configure_payload() -> dict[str, Any]:
    return {
        "enabled": True,
        "api_base_url": "https://api.intacct.com",
        "company_id": "dia-rental-01",
        "client_id_secret_ref": "secret://integrations/sage_intacct/client_id",
        "client_secret_secret_ref": "secret://integrations/sage_intacct/client_secret",
        "enabled_scopes": ["general_ledger"],
        "general_ledger_profile": {"account_id_field": "glAccountNo"},
        "healthcheck_path": "/v1/healthcheck",
        "healthcheck_timeout_seconds": 5,
    }


def test_configure_sage_intacct_persists_selected_variant_config() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_sage_registry())

    response = client.post(
        "/api/ops/integrations/sage_intacct/configure",
        headers=_auth_header(),
        json=_sage_configure_payload(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "configured"
    assert payload["connector_key"] == "sage_intacct"
    assert payload["config"]["connector_key"] == "sage_intacct"
    assert payload["config"]["settings"]["enabled_scopes"] == ["general_ledger"]
    row = supabase.integration_config["sage_intacct"]
    assert row["tenant_id"] == "tenant-a-id"
    assert row["connector_key"] == "sage_intacct"
    assert row["settings"] == {
        "api_base_url": "https://api.intacct.com",
        "company_id": "dia-rental-01",
        "enabled_scopes": ["general_ledger"],
        "healthcheck_path": "/v1/healthcheck",
        "healthcheck_timeout_seconds": 5,
    }
    assert row["mappings"] == {
        "general_ledger_profile": {"account_id_field": "glAccountNo"},
        "accounts_payable_profile": {},
        "accounts_receivable_profile": {},
        "cash_management_profile": {},
    }
    assert row["secret_refs"] == {
        "client_id_secret_ref": "secret://integrations/sage_intacct/client_id",
        "client_secret_secret_ref": "secret://integrations/sage_intacct/client_secret",
    }
    assert "client_id_secret_ref" not in row["settings"]
    assert "client_secret_secret_ref" not in row["settings"]


def test_validate_sage_intacct_uses_saved_selected_scope_without_defaulting() -> None:
    healthcheck_configs: list[dict[str, Any]] = []
    client, supabase, _temporal, _ = _make_client(
        connector_registry=_sage_registry(healthcheck_configs=healthcheck_configs)
    )

    configure_response = client.post(
        "/api/ops/integrations/sage_intacct/configure",
        headers=_auth_header(),
        json=_sage_configure_payload(),
    )
    assert configure_response.status_code == 200

    response = client.post("/api/ops/integrations/sage_intacct/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "classification": "ok",
        "message": "Sage Intacct connectivity verified",
        "details": {"status_code": 200},
    }
    assert healthcheck_configs == [
        {
            "api_base_url": "https://api.intacct.com",
            "company_id": "dia-rental-01",
            "client_id_secret_ref": "secret://integrations/sage_intacct/client_id",
            "client_secret_secret_ref": "secret://integrations/sage_intacct/client_secret",
            "enabled_scopes": ["general_ledger"],
            "healthcheck_path": "/v1/healthcheck",
            "healthcheck_timeout_seconds": 5,
            "general_ledger_profile": {"account_id_field": "glAccountNo"},
            "accounts_payable_profile": {},
            "accounts_receivable_profile": {},
            "cash_management_profile": {},
        }
    ]


def test_validate_sage_intacct_ignores_ambiguous_sage_default_row() -> None:
    healthcheck_configs: list[dict[str, Any]] = []
    client, supabase, _temporal, _ = _make_client(
        connector_registry=_sage_registry(healthcheck_configs=healthcheck_configs)
    )
    supabase.integration_config["sage"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "sage",
        "enabled": True,
        "settings": {
            "api_base_url": "https://api.intacct.com",
            "company_id": "ambiguous-default-company",
            "enabled_scopes": ["accounts_receivable"],
            "healthcheck_path": "/v1/healthcheck",
            "healthcheck_timeout_seconds": 5,
        },
        "mappings": {
            "general_ledger_profile": {},
            "accounts_payable_profile": {},
            "accounts_receivable_profile": {"customer_id_field": "legacyCustomerId"},
            "cash_management_profile": {},
        },
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/sage/default-client-id",
            "client_secret_secret_ref": "secret://integrations/sage/default-client-secret",
        },
        "schedule": {},
        "updated_at": "2026-06-11T00:00:00Z",
    }

    configure_response = client.post(
        "/api/ops/integrations/sage_intacct/configure",
        headers=_auth_header(),
        json=_sage_configure_payload(),
    )
    assert configure_response.status_code == 200

    response = client.post("/api/ops/integrations/sage_intacct/validate", headers=_auth_header())

    assert response.status_code == 200
    assert supabase.integration_config["sage"]["settings"]["company_id"] == "ambiguous-default-company"
    assert len(healthcheck_configs) == 1
    assert healthcheck_configs[0]["company_id"] == "dia-rental-01"
    assert healthcheck_configs[0]["company_id"] != "ambiguous-default-company"
    assert healthcheck_configs[0]["enabled_scopes"] == ["general_ledger"]
    assert healthcheck_configs[0]["general_ledger_profile"] == {"account_id_field": "glAccountNo"}


def _coupa_registry(
    *,
    validation_errors: list[str] | None = None,
    healthcheck_result: CoupaHealthcheckResult | None = None,
) -> dict[str, ConnectorProvider]:
    return {
        "coupa": ConnectorProvider(
            key="coupa",
            enabled_scopes=("requisitions", "purchase_orders", "suppliers", "invoices"),
            validate_config=lambda _config: validation_errors or [],
            healthcheck=lambda _config: healthcheck_result
            or CoupaHealthcheckResult(
                status="ok",
                classification="ok",
                message="Coupa connectivity verified",
                details={"status_code": 200},
            ),
        )
    }


def _coupa_configure_payload() -> dict[str, Any]:
    return {
        "enabled": True,
        "api_base_url": "https://tenant.coupahost.com",
        "tenant_slug": "dia-rental",
        "client_id_secret_ref": "secret://integrations/coupa/client_id",
        "client_secret_secret_ref": "secret://integrations/coupa/client_secret",
        "enabled_scopes": ["requisitions", "purchase_orders"],
        "requisition_mapping_profile": {"requisition_id_field": "id"},
        "purchase_order_mapping_profile": {"purchase_order_id_field": "id"},
        "supplier_mapping_profile": {"supplier_id_field": "id"},
        "invoice_mapping_profile": {"invoice_id_field": "id"},
        "healthcheck_path": "/api/health",
        "healthcheck_timeout_seconds": 5,
    }


def test_configure_coupa_persists_tenant_scoped_integration_config() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_coupa_registry())

    response = client.post(
        "/api/ops/integrations/coupa/configure",
        headers=_auth_header(),
        json=_coupa_configure_payload(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "configured"
    assert payload["connector_key"] == "coupa"
    row = supabase.integration_config["coupa"]
    assert row["tenant_id"] == "tenant-a-id"
    assert row["settings"]["enabled_scopes"] == ["requisitions", "purchase_orders"]
    assert row["settings"]["tenant_slug"] == "dia-rental"
    assert row["secret_refs"]["client_id_secret_ref"].startswith("secret://")
    assert "client_id_secret_ref" not in row["settings"]


def test_configure_coupa_returns_configuration_validation_errors() -> None:
    client, _supabase, _temporal, _ = _make_client(
        connector_registry=_coupa_registry(
            validation_errors=["enabled_scopes contains unsupported scope(s): unsupported"]
        )
    )

    response = client.post(
        "/api/ops/integrations/coupa/configure",
        headers=_auth_header(),
        json={**_coupa_configure_payload(), "enabled_scopes": ["unsupported"]},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["classification"] == "configuration"
    assert "enabled_scopes contains unsupported scope(s): unsupported" in detail["errors"]


def test_validate_coupa_returns_healthcheck_classification() -> None:
    client, supabase, _temporal, _ = _make_client(
        connector_registry=_coupa_registry(
            healthcheck_result=CoupaHealthcheckResult(
                status="failed",
                classification="auth",
                message="Auth check failed",
                details={"status_code": 401},
            )
        )
    )
    supabase.integration_config["coupa"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "coupa",
        "enabled": True,
        "settings": {
            "api_base_url": "https://tenant.coupahost.com",
            "tenant_slug": "dia-rental",
            "enabled_scopes": ["requisitions"],
            "healthcheck_path": "/api/health",
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
        "schedule": {},
        "updated_at": "2026-06-14T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/coupa/validate", headers=_auth_header())

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "classification": "auth",
        "message": "Auth check failed",
        "details": {"status_code": 401},
    }


def test_disable_coupa_marks_config_disabled() -> None:
    client, supabase, _temporal, _ = _make_client(connector_registry=_coupa_registry())
    supabase.integration_config["coupa"] = {
        "tenant_id": "tenant-a-id",
        "connector_key": "coupa",
        "enabled": True,
        "settings": {
            "api_base_url": "https://tenant.coupahost.com",
            "tenant_slug": "dia-rental",
            "enabled_scopes": ["requisitions"],
        },
        "mappings": {"requisition_mapping_profile": {"requisition_id_field": "id"}},
        "secret_refs": {
            "client_id_secret_ref": "secret://integrations/coupa/client_id",
            "client_secret_secret_ref": "secret://integrations/coupa/client_secret",
        },
        "schedule": {},
        "updated_at": "2026-06-14T00:00:00Z",
    }

    response = client.post("/api/ops/integrations/coupa/disable", headers=_auth_header())

    assert response.status_code == 200
    assert response.json()["status"] == "disabled"
    assert supabase.integration_config["coupa"]["enabled"] is False


def test_metrics_endpoint_returns_prometheus_format() -> None:
    client, _supabase, _temporal, _call_order = _make_client()
    with client:
        response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    # prometheus_client always emits at least the process/python collector lines
    assert "# HELP" in response.text or "# TYPE" in response.text


def test_metrics_endpoint_records_request_counts() -> None:
    client, _supabase, _temporal, _call_order = _make_client()
    with client:
        # Hit the health endpoint to generate a metric sample
        client.get("/api/ops/health")
        response = client.get("/metrics")
    assert response.status_code == 200
    # The custom counter should appear in the output
    assert "ops_api_http_requests_total" in response.text


def test_metrics_endpoint_records_request_duration() -> None:
    client, _supabase, _temporal, _call_order = _make_client()
    with client:
        # Hit the health endpoint to generate a histogram observation
        client.get("/api/ops/health")
        response = client.get("/metrics")
    assert response.status_code == 200
    # The Prometheus histogram for request latency must appear after a request
    assert "ops_api_http_request_duration_seconds" in response.text


def test_metrics_content_type_is_prometheus_format() -> None:
    client, _supabase, _temporal, _call_order = _make_client()
    with client:
        response = client.get("/metrics")
    assert response.status_code == 200
    # prometheus_client sets Content-Type to CONTENT_TYPE_LATEST (text/plain; version=0.0.4)
    assert response.headers["content-type"].startswith("text/plain")
    assert "version=0.0.4" in response.headers["content-type"]


def test_health_endpoint_returns_ok() -> None:
    client, _supabase, _temporal, _call_order = _make_client()
    with client:
        response = client.get("/api/ops/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# Keycloak federation auth contract
#
# These tests verify that the ops-api role-gating behavior is correct for
# each of the four roles that the Keycloak group→role mapping can produce.
# After Keycloak federation, GoTrue issues a Supabase JWT whose
# app_metadata.role reflects the mapped Keycloak group claim; the ops-api
# authenticates that Supabase token as before (no raw Keycloak token path).
# ---------------------------------------------------------------------------


def test_keycloak_federated_admin_principal_can_approve() -> None:
    """admin (from dia-admin group via Keycloak federation) can approve findings."""
    client, supabase, temporal, call_order = _make_client(role="admin")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={"note": "Approved by Keycloak-federated admin"},
    )

    assert response.status_code == 202
    assert call_order == ["persist", "signal"]


def test_keycloak_federated_branch_manager_principal_can_approve() -> None:
    """branch_manager (from dia-branch-manager via Keycloak federation) can approve findings."""
    client, supabase, temporal, call_order = _make_client(role="branch_manager")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 202
    assert call_order == ["persist", "signal"]


def test_keycloak_federated_field_operator_principal_can_operate() -> None:
    """field_operator (from dia-field-operator via Keycloak federation) is allowed to operate."""
    client, supabase, _temporal, _ = _make_client(role="field_operator", can_operate=True)

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 202


def test_keycloak_federated_read_only_principal_denied_approve() -> None:
    """read_only (from dia-read-only or no group via Keycloak federation) cannot approve findings."""
    client, supabase, temporal, _ = _make_client(role="read_only")

    response = client.post(
        f"/api/ops/findings/{supabase.finding.id}/approve",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 403
    assert temporal.signal_calls == []
    assert supabase.persisted == []


# ---------------------------------------------------------------------------
# territory-brief trigger scope-enforcement tests
# ---------------------------------------------------------------------------

def test_territory_brief_field_operator_rep_id_bound_to_principal() -> None:
    """field_operator with no rep_id gets rep scope bound to their own principal.sub."""
    client, _, temporal, _ = _make_client(role="field_operator")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 202
    assert temporal.territory_brief_calls[0]["rep_id"] == "user-1"


def test_territory_brief_field_operator_own_rep_id_accepted() -> None:
    """field_operator explicitly supplying their own sub as rep_id is accepted."""
    client, _, temporal, _ = _make_client(role="field_operator")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={"rep_id": "user-1"},
    )

    assert response.status_code == 202
    assert temporal.territory_brief_calls[0]["rep_id"] == "user-1"


def test_territory_brief_field_operator_cross_rep_denied() -> None:
    """field_operator supplying a different rep_id is rejected with 403."""
    client, _, temporal, _ = _make_client(role="field_operator")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={"rep_id": "other-rep-id"},
    )

    assert response.status_code == 403
    assert not hasattr(temporal, "territory_brief_calls") or temporal.territory_brief_calls == []


def test_territory_brief_field_operator_tenant_wide_fanout_denied() -> None:
    """field_operator cannot trigger a tenant-wide brief (no rep_id, no account_id).

    The route must bind rep_id to principal.sub, preventing tenant-wide fan-out
    even when the caller omits both rep_id and account_id.
    """
    client, _, temporal, _ = _make_client(role="field_operator")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={},
    )

    # Request is accepted, but rep_id is bound to the caller — never "all"
    assert response.status_code == 202
    assert temporal.territory_brief_calls[0]["rep_id"] == "user-1"
    assert temporal.territory_brief_calls[0]["rep_id"] != "all"


def test_territory_brief_admin_can_trigger_tenant_wide() -> None:
    """admin may omit rep_id to trigger a tenant-wide pass."""
    client, _, temporal, _ = _make_client(role="admin")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 202
    assert temporal.territory_brief_calls[0]["rep_id"] is None


def test_territory_brief_admin_can_trigger_for_other_rep() -> None:
    """admin may supply any rep_id to scope a brief to a specific rep."""
    client, _, temporal, _ = _make_client(role="admin")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={"rep_id": "some-other-rep"},
    )

    assert response.status_code == 202
    assert temporal.territory_brief_calls[0]["rep_id"] == "some-other-rep"


def test_territory_brief_branch_manager_can_trigger_tenant_wide() -> None:
    """branch_manager may omit rep_id for a tenant-wide brief."""
    client, _, temporal, _ = _make_client(role="branch_manager")

    response = client.post(
        "/api/ops/territory-brief/trigger",
        headers=_auth_header(),
        json={},
    )

    assert response.status_code == 202
    assert temporal.territory_brief_calls[0]["rep_id"] is None
