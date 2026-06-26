"""End-to-end revalidation lock-in for the ``vehicle-aging-analyst`` agent (issue #118).

This is a NON-REGRESSION ticket: no production code changed. The tests below
exist to *lock in* the observable behaviour of the agent so a future
#115-style generalization of the manual "Executar agora" dispatch (or any other
refactor) cannot silently regress it.

Every test traces back to an acceptance criterion in
``docs/specs/118-feat-ops-revalidar-agente-vehicle.md``. To stay DRY and mirror
the repo's cross-module test conventions (see ``test_ops_vehicle_aging`` importing
from ``test_ops_revrec_activity`` / ``test_worker_registration``), the in-memory
fakes are reused from the sibling suites rather than re-implemented:

* ``_FakeSupabaseClient`` / ``_FakeScheduleTemporalClient`` from ``test_ops_api``
  drive the FastAPI surface against the *real* ``TemporalSignalClient.run_agent_now``.
* ``_FakeClient`` (real ``SupabaseServiceClient`` + recording REST collaborators)
  from ``test_finding_action_execution`` exercises the real post-approval executor.
* ``_FakeOpsPersistenceClient`` from ``test_ops_revrec_activity`` backs the real
  ``ops_record_finding`` persistence path.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from temporal.src.activities import ops_revrec, ops_vehicle_aging
from temporal.src.activities.ops_vehicle_aging import _finding_fingerprint
from temporal.src.agents.vehicle_aging_analyst import _RECOMMENDED_ACTIONS
from temporal.src.ops_api.app import (
    DEFAULT_MARKDOWN_PCT,
    Principal,
    TemporalSignalClient,
    _MANUAL_RUN_WORKFLOWS,
    _PENDING_EXECUTION_ACTIONS,
    _VEHICLE_AGING_FINDING_TYPE,
    create_app,
)
from temporal.src.workflows.ops.vehicle_aging import VehicleAgingWorkflow, VehicleAgingWorkflowInput

# Reuse the sibling suites' fakes verbatim (repo convention: cross-module imports).
from temporal.tests.test_finding_action_execution import _FakeClient, _finding, _vehicle
from temporal.tests.test_ops_api import (
    _FakeScheduleHandle,
    _FakeScheduleTemporalClient,
    _FakeSupabaseClient,
    _auth_header,
    _make_finding,
)
from temporal.tests.test_ops_revrec_activity import _FakeOpsPersistenceClient

_AGENT_KEY = "vehicle-aging-analyst"
_TENANT_KEY = "tenant-ops"
_RESOLVED_TENANT = "resolved-tenant-id"


# ===========================================================================
# AC1 — "Executar agora sem regressão": POST .../vehicle-aging-analyst/run with
#       {"locale":"pt-BR"} returns 202 status:"started" + workflow_id, starting
#       VehicleAgingWorkflow DIRECTLY (no 409, no schedule fallback).
#
# These run the endpoint against the REAL TemporalSignalClient.run_agent_now (the
# existing endpoint tests stub run_agent_now, so the direct-dispatch envelope was
# never asserted end-to-end for this agent).
# ===========================================================================


def _make_endpoint_with_real_dispatch() -> tuple[TestClient, _FakeScheduleTemporalClient, _FakeScheduleHandle]:
    """FastAPI app wired to the real ``run_agent_now`` over a fake Temporal backend."""
    principal = Principal(sub="user-1", name="Casey", role="field_operator", tenant=_TENANT_KEY)
    supabase = _FakeSupabaseClient(
        principal=principal,
        finding=_make_finding(agent_key=_AGENT_KEY, finding_type=_VEHICLE_AGING_FINDING_TYPE),
        call_order=[],
        tenant_id=_RESOLVED_TENANT,
    )
    handle = _FakeScheduleHandle()
    backend = _FakeScheduleTemporalClient(handle)

    temporal = TemporalSignalClient(temporal_address="temporal.example:7233", temporal_namespace="default")

    async def _fake_client_instance() -> _FakeScheduleTemporalClient:
        return backend

    temporal._client_instance = _fake_client_instance  # type: ignore[method-assign]

    app = create_app(supabase_client=supabase, temporal_client=temporal)
    return TestClient(app), backend, handle


def test_ac1_endpoint_run_now_ptbr_starts_workflow_directly_no_schedule_fallback() -> None:
    client, backend, handle = _make_endpoint_with_real_dispatch()

    response = client.post(
        f"/api/ops/agents/{_AGENT_KEY}/run",
        headers=_auth_header(),
        json={"locale": "pt-BR"},
    )

    # 202 + started envelope carrying a manual workflow_id (NOT the 409/triggered path).
    assert response.status_code == 202
    body = response.json()
    assert body["agent_key"] == _AGENT_KEY
    assert body["status"] == "started"
    assert body["locale"] == "pt-BR"
    assert body["schedule_id"] == f"ops:{_RESOLVED_TENANT}:{_AGENT_KEY}"
    assert body["workflow_id"].startswith(f"ops:{_RESOLVED_TENANT}:{_AGENT_KEY}:manual:")

    # The recurring schedule is never resolved or triggered (assist-only, no fallback).
    assert backend.schedule_ids == []
    assert handle.trigger_calls == []

    # Exactly one VehicleAgingWorkflow started, scoped to the resolved tenant + locale.
    assert len(backend.started_workflows) == 1
    started = backend.started_workflows[0]
    assert started["workflow_run"] is VehicleAgingWorkflow.run
    workflow_input = started["workflow_input"]
    assert isinstance(workflow_input, VehicleAgingWorkflowInput)
    assert workflow_input.tenant_id == _RESOLVED_TENANT
    assert workflow_input.locale == "pt-BR"
    # The started workflow id matches the id echoed in the response envelope.
    assert started["kwargs"]["id"] == body["workflow_id"]


def test_ac1_endpoint_run_now_invalid_locale_resolves_to_ptbr_and_still_starts() -> None:
    # A bogus locale must not break dispatch: it resolves to pt-BR and the
    # workflow is still started directly (no schedule trigger).
    client, backend, handle = _make_endpoint_with_real_dispatch()

    response = client.post(
        f"/api/ops/agents/{_AGENT_KEY}/run",
        headers=_auth_header(),
        json={"locale": "fr-FR"},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "started"
    assert body["locale"] == "pt-BR"
    assert handle.trigger_calls == []
    assert len(backend.started_workflows) == 1
    assert backend.started_workflows[0]["workflow_input"].locale == "pt-BR"


def test_ac1_manual_run_registry_still_maps_vehicle_aging_to_its_workflow() -> None:
    # Structural regression guard against the #115 generalization dropping the
    # vehicle-aging entry (which would silently route "Executar agora" to the
    # never-provisioned schedule trigger -> HTTP 409).
    assert _AGENT_KEY in _MANUAL_RUN_WORKFLOWS, "vehicle-aging-analyst lost its manual-run registration"
    workflow_run, input_factory = _MANUAL_RUN_WORKFLOWS[_AGENT_KEY]
    assert workflow_run is VehicleAgingWorkflow.run
    # The factory builds a locale-aware VehicleAgingWorkflowInput (not the tenant-only
    # service-estimate-rescue shape).
    built = input_factory(_RESOLVED_TENANT, "pt-BR")
    assert built == VehicleAgingWorkflowInput(tenant_id=_RESOLVED_TENANT, locale="pt-BR")


# ===========================================================================
# AC2 — "Pipeline completo": recorded findings carry status='pending_approval'
#       and finding_type is the anticipatory vehicle finding type.
#
# Drives the REAL ops_vehicle_aging.ops_record_finding (which shapes the row via
# _vehicle_finding_for_storage and persists through ops_revrec) against the
# in-memory persistence fake, asserting the persisted row's concrete shape.
# ===========================================================================


def _seed_run(client: _FakeOpsPersistenceClient, *, run_id: str, tenant_id: str) -> None:
    client.tables["ops_workflow_run"] = [
        {"run_id": run_id, "tenant_id": tenant_id, "workflow_key": _AGENT_KEY}
    ]


def _surfaced_finding(*, vehicle_id: str, tenant_id: str, action: str) -> dict[str, Any]:
    return {
        "vehicle_id": vehicle_id,
        "tenant_id": tenant_id,
        "finding_type": _VEHICLE_AGING_FINDING_TYPE,
        "severity": "high",
        "brand": "Nissan",
        "model": "Kicks",
        "model_year": 2026,
        "store": "Filial Sul",
        "condition": "novo",
        "cost": 125000.0,
        "sale_price": 152900.0,
        "days_in_stock": 86,
        "signals": [_VEHICLE_AGING_FINDING_TYPE],
        "floor_plan_cost": 3823.42,
        "estimated_exposure": 3823.42,
        "recommended_action": action,
        "evidence": ["floor plan about to step up a band"],
        "confidence": 0.7,
        "rationale": "Floor-plan carrying cost is about to escalate.",
        "fingerprint": _finding_fingerprint(tenant_id, vehicle_id, _VEHICLE_AGING_FINDING_TYPE),
    }


def test_ac2_record_finding_persists_pending_approval_stock_aging_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ops_client = _FakeOpsPersistenceClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", ops_client)
    monkeypatch.setattr(ops_revrec, "_fact_type_id_cache", {})

    tenant_id = _RESOLVED_TENANT
    vehicle_id = str(uuid.uuid4())
    _seed_run(ops_client, run_id="run-1", tenant_id=tenant_id)

    finding = _surfaced_finding(vehicle_id=vehicle_id, tenant_id=tenant_id, action="markdown")
    result = ops_vehicle_aging.ops_record_finding(finding, "run-1")

    assert result["finding_id"]
    rows = ops_client.tables["finding"]
    assert len(rows) == 1
    row = rows[0]
    # AC2 — the finding is queued for human approval, typed as 90d stock-aging.
    assert row["status"] == "pending_approval"
    assert row["finding_type"] == _VEHICLE_AGING_FINDING_TYPE
    assert row["agent_key"] == _AGENT_KEY
    assert row["tenant_id"] == tenant_id
    # The vehicle entity is the audit anchor (contract_id); no line items.
    assert row["contract_id"] == vehicle_id
    assert row["line_item_id"] is None
    # Fingerprint is the deterministic stock-aging hash and the proposed action
    # is carried straight through from the LLM recommendation.
    assert row["fingerprint"] == _finding_fingerprint(tenant_id, vehicle_id, _VEHICLE_AGING_FINDING_TYPE)
    assert row["proposed_action"] == "markdown"
    # delta surfaces the floor-plan exposure (recoverable money signal).
    assert row["delta"] == 3823.42


# ===========================================================================
# AC3 — "Ação recomendada válida e dedupe": every recommended_action is in the
#       allowed set, and a re-run dedupes by fingerprint (no duplicate findings).
# ===========================================================================


def test_ac3_allowed_action_set_is_exactly_the_spec_actions() -> None:
    # Locks the closed action set (Non-Goal: do not alter the recommended actions).
    assert set(_RECOMMENDED_ACTIONS) == {
        "monitor",
        "markdown",
        "transfer",
        "prioritize_sale",
        "wholesale_auction",
    }


@pytest.mark.parametrize("action", list(_RECOMMENDED_ACTIONS))
def test_ac3_each_allowed_action_records_with_proposed_action_preserved(
    monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    ops_client = _FakeOpsPersistenceClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", ops_client)
    monkeypatch.setattr(ops_revrec, "_fact_type_id_cache", {})

    tenant_id = _RESOLVED_TENANT
    vehicle_id = str(uuid.uuid4())
    _seed_run(ops_client, run_id="run-1", tenant_id=tenant_id)

    finding = _surfaced_finding(vehicle_id=vehicle_id, tenant_id=tenant_id, action=action)
    ops_vehicle_aging.ops_record_finding(finding, "run-1")

    row = ops_client.tables["finding"][0]
    assert row["proposed_action"] == action
    assert row["proposed_action"] in _RECOMMENDED_ACTIONS


def test_ac3_rerun_dedupes_by_fingerprint_no_duplicate_finding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ops_client = _FakeOpsPersistenceClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", ops_client)
    monkeypatch.setattr(ops_revrec, "_fact_type_id_cache", {})

    tenant_id = _RESOLVED_TENANT
    vehicle_id = str(uuid.uuid4())
    _seed_run(ops_client, run_id="run-1", tenant_id=tenant_id)
    finding = _surfaced_finding(vehicle_id=vehicle_id, tenant_id=tenant_id, action="markdown")

    first = ops_vehicle_aging.ops_record_finding(finding, "run-1")
    # Second run surfaces the SAME vehicle (same tenant+fingerprint).
    second = ops_vehicle_aging.ops_record_finding(finding, "run-1")

    # Upsert on (tenant_id, fingerprint) keeps exactly one row; no duplicate finding.
    assert len(ops_client.tables["finding"]) == 1
    assert first["finding_id"] == second["finding_id"]
    assert ops_client.tables["finding"][0]["fingerprint"] == _finding_fingerprint(
        tenant_id, vehicle_id, _VEHICLE_AGING_FINDING_TYPE
    )


# ===========================================================================
# AC4 + AC5 — post-approval action contract matrix (against the REAL
# execute_finding_action). One source-of-truth regression lock for the full
# per-action side-effect contract:
#
#   markdown            -> new SCD2 version, sale_price * (1-10%), finding_action
#                          'executed', audited vehicle_action_executed.
#   transfer/prioritize_sale/wholesale_auction
#                       -> new SCD2 version tagging disposition, price UNCHANGED,
#                          finding_action 'pending_execution', audited.
#   monitor             -> NO entity version (no price move), finding_action
#                          'executed', audited.
# ===========================================================================


@pytest.mark.asyncio
async def test_ac4_markdown_moves_price_via_new_scd2_version_and_audits() -> None:
    approver = {"approver_id": "u-1", "approver_name": "Ana", "note": None}
    client = _FakeClient(current=_vehicle(100000, version=1))

    result = await client.execute_finding_action(finding=_finding("markdown"), approver=approver)

    assert result == {"executed": True, "action": "markdown", "status": "executed"}
    # New SCD2 version (v2) with the 10%-reduced price; old non-price data preserved.
    assert len(client.appended_versions) == 1
    appended = client.appended_versions[0]
    assert appended["version_number"] == 2
    expected_price = round(100000 * (1 - DEFAULT_MARKDOWN_PCT), 2)
    assert expected_price == 90000.0  # 10% markdown of 100000
    assert appended["data"]["sale_price"] == expected_price
    assert appended["data"]["brand"] == "VW"
    # Exactly one finding_action 'executed' (idempotency unit-tested separately).
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "executed"
    assert client.inserted_actions[0]["action_type"] == "markdown"
    # Audited against the vehicle entity.
    assert [a["event_type"] for a in client.audit_events] == ["vehicle_action_executed"]


@pytest.mark.parametrize("action", sorted(_PENDING_EXECUTION_ACTIONS))
@pytest.mark.asyncio
async def test_ac5_disposition_action_tags_new_version_without_moving_price(action: str) -> None:
    approver = {"approver_id": "u-1", "approver_name": "Ana", "note": None}
    client = _FakeClient(current=_vehicle(100000, version=1))

    result = await client.execute_finding_action(finding=_finding(action), approver=approver)

    assert result == {"executed": True, "action": action, "status": "pending_execution"}
    # New SCD2 version (v2) tags the disposition but leaves sale_price untouched.
    assert len(client.appended_versions) == 1
    appended = client.appended_versions[0]
    assert appended["version_number"] == 2
    assert appended["data"]["disposition"] == action
    assert appended["data"]["sale_price"] == 100000  # price NOT moved
    # finding_action queued for execution (human/back-office follow-up).
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "pending_execution"
    assert client.inserted_actions[0]["action_type"] == action


@pytest.mark.asyncio
async def test_ac5_monitor_records_executed_action_without_price_move() -> None:
    approver = {"approver_id": "u-1", "approver_name": "Ana", "note": None}
    client = _FakeClient(current=_vehicle(100000, version=1))

    result = await client.execute_finding_action(finding=_finding("monitor"), approver=approver)

    assert result == {"executed": True, "action": "monitor", "status": "executed"}
    # monitor never touches the vehicle entity (no new SCD2 version, no price move).
    assert client.appended_versions == []
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "executed"
    assert client.inserted_actions[0]["action_type"] == "monitor"
    assert [a["event_type"] for a in client.audit_events] == ["vehicle_action_executed"]
