"""Tests for the deterministic decision preview (issue #126).

These exercise the *behaviour* of ``describe_action_effect`` in
``temporal/src/ops_api/app.py`` — the single source of truth for what Approve vs
Reject of a finding actually does — and prove it cannot diverge from what
``execute_finding_action`` records (the PARITY tests below construct a real
``SupabaseServiceClient`` with recording fakes for its REST collaborators and
compare the *described* effect to the *recorded* ``finding_action``). No network
calls are made.

Every test traces back to an acceptance criterion in
``docs/specs/126-feat-ops-previa-de-consequencias.md``:

- AC2 — Vehicle-aging ``markdown`` is faithful (preview == recorded outcome).
- AC3 — Assist-only agents are explicit (records recommendation, no DMS write).
- AC4 — All actions covered (markdown / disposition / monitor / unknown / empty)
        without inventing effects, including the Reject monitored/audited no-op.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from temporal.src.ops_api.app import (
    _BEARER_PREFIX,
    DEFAULT_MARKDOWN_PCT,
    EntityCurrentVersion,
    FindingRecord,
    Principal,
    SupabaseServiceClient,
    create_app,
    describe_action_effect,
)

# Single shared cross-language parity table (issue #126). The SAME fixture pins
# the Python ``describe_action_effect`` (here) AND the TS ``describeActionEffect``
# (frontend-portal/scripts/verify-decision-preview.mjs executes it at runtime), so
# the duplicated rule cannot silently diverge between the two languages.
_PARITY_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "decision_preview_parity.json").read_text()
)
_PARITY_CASES: list[dict[str, Any]] = _PARITY_FIXTURE["cases"]

_TENANT = "tenant-a-id"
_VEHICLE_ID = "vehicle-entity-1"
_FINDING_ID = "finding-1"
_APPROVER = {"approver_id": "u-1", "approver_name": "Ana", "note": None}

_VEHICLE_AGING_TYPE = "stock_aging_90d"
# The three assist-only agents (no executable DMS effect) and a representative
# finding_type for each — mirrors the docstring of execute_finding_action.
_ASSIST_ONLY_TYPES = ["estimate_rescue", "collections_priority", "replenish_now", "dead_stock"]


def _finding(
    action: str | None,
    *,
    finding_type: str = _VEHICLE_AGING_TYPE,
    status: str = "approved",
) -> FindingRecord:
    return FindingRecord(
        id=_FINDING_ID,
        tenant_id=_TENANT,
        agent_key="vehicle-aging-analyst",
        run_id="run-1",
        workflow_id="wf-1",
        contract_id=_VEHICLE_ID,
        line_item_id=None,
        fingerprint="fp-1",
        finding_type=finding_type,
        status=status,
        proposed_action=action,
    )


# ===========================================================================
# AC4 — Vehicle-aging: markdown is described faithfully.
# ===========================================================================


def test_vehicle_aging_markdown_describes_recoverable_audited_assist_only_effect() -> None:
    preview = describe_action_effect(_finding("markdown"))

    approve = preview["on_approve"]
    assert approve["effect_key"] == "vehicle_aging.markdown"
    assert approve["is_noop"] is False
    assert approve["audited"] is True
    assert approve["assist_only"] is True
    # Faithful to execute_finding_action: a fixed 10% markdown is recorded.
    assert approve["params"] == {"markdown_pct": DEFAULT_MARKDOWN_PCT}
    assert approve["value_impact"] == {"amount": None, "currency": None, "kind": "recoverable"}

    # Declining a recoverable markdown leaves the value exposed.
    reject = preview["on_reject"]
    assert reject["effect_key"] == "generic.reject_noop"
    assert reject["is_noop"] is True
    assert reject["value_impact"] == {"amount": None, "currency": None, "kind": "exposure"}


# ===========================================================================
# AC4 — Vehicle-aging: each disposition action records a pending disposition.
# ===========================================================================


@pytest.mark.parametrize("action", ["transfer", "prioritize_sale", "wholesale_auction"])
def test_vehicle_aging_disposition_describes_recoverable_disposition_effect(action: str) -> None:
    preview = describe_action_effect(_finding(action))

    approve = preview["on_approve"]
    assert approve["effect_key"] == "vehicle_aging.disposition"
    assert approve["is_noop"] is False
    assert approve["audited"] is True
    assert approve["assist_only"] is True
    # The described disposition is exactly the proposed action — no invention.
    assert approve["params"] == {"disposition": action}
    assert approve["value_impact"] == {"amount": None, "currency": None, "kind": "recoverable"}

    reject = preview["on_reject"]
    assert reject["effect_key"] == "generic.reject_noop"
    assert reject["is_noop"] is True
    assert reject["value_impact"] == {"amount": None, "currency": None, "kind": "exposure"}


# ===========================================================================
# AC4 — Vehicle-aging: monitor and unknown/unrecognised actions are audited
#       no-ops; no value impact is invented, on either branch.
# ===========================================================================


def test_vehicle_aging_monitor_is_audited_noop_with_no_value_impact() -> None:
    preview = describe_action_effect(_finding("monitor"))

    approve = preview["on_approve"]
    assert approve["effect_key"] == "generic.monitor_noop"
    assert approve["is_noop"] is True
    assert approve["audited"] is True
    assert approve["assist_only"] is True
    assert approve["params"] == {}
    assert approve["value_impact"] is None

    # Reject of a no-op carries no exposure (there is nothing recoverable to lose).
    reject = preview["on_reject"]
    assert reject["is_noop"] is True
    assert reject["value_impact"] is None


def test_vehicle_aging_unknown_action_is_audited_noop_preserving_the_action() -> None:
    preview = describe_action_effect(_finding("frobnicate"))

    approve = preview["on_approve"]
    assert approve["effect_key"] == "generic.monitor_noop"
    assert approve["is_noop"] is True
    assert approve["audited"] is True
    # The unrecognised action is preserved for audit, not silently dropped.
    assert approve["params"] == {"action": "frobnicate"}
    assert approve["value_impact"] is None
    assert preview["on_reject"]["value_impact"] is None


@pytest.mark.parametrize("action", ["", None, "   "])
def test_vehicle_aging_empty_action_is_audited_noop_with_empty_params(action: str | None) -> None:
    approve = describe_action_effect(_finding(action))["on_approve"]
    assert approve["effect_key"] == "generic.monitor_noop"
    assert approve["is_noop"] is True
    assert approve["params"] == {}


# ===========================================================================
# AC3 — Assist-only agents: approving records the recommendation for follow-up
#       and executes nothing in the DMS (assist-only, audited, no value impact).
# ===========================================================================


@pytest.mark.parametrize("finding_type", _ASSIST_ONLY_TYPES)
@pytest.mark.parametrize("action", ["prioritize", "replenish_now", "markdown", "monitor", ""])
def test_assist_only_agents_register_recommendation_without_dms_effect(
    finding_type: str, action: str
) -> None:
    # Regardless of the proposed action, a non vehicle-aging finding is assist-only.
    preview = describe_action_effect(_finding(action, finding_type=finding_type))

    approve = preview["on_approve"]
    assert approve["effect_key"] == "assist_only.register"
    assert approve["is_noop"] is False
    assert approve["assist_only"] is True
    assert approve["audited"] is True
    # No DMS effect: no monetary impact is described and no execution params leak.
    assert approve["value_impact"] is None
    assert approve["params"] == {}

    reject = preview["on_reject"]
    assert reject["effect_key"] == "generic.reject_noop"
    assert reject["is_noop"] is True
    assert reject["value_impact"] is None


# ===========================================================================
# AC4 — Reject is ALWAYS a monitored/audited no-op, across every agent/action.
# ===========================================================================


@pytest.mark.parametrize(
    "finding_type,action",
    [
        (_VEHICLE_AGING_TYPE, "markdown"),
        (_VEHICLE_AGING_TYPE, "transfer"),
        (_VEHICLE_AGING_TYPE, "monitor"),
        (_VEHICLE_AGING_TYPE, "frobnicate"),
        ("estimate_rescue", "prioritize"),
        ("collections_priority", "prioritize"),
        ("replenish_now", "replenish_now"),
    ],
)
def test_reject_branch_is_always_audited_noop(finding_type: str, action: str) -> None:
    reject = describe_action_effect(_finding(action, finding_type=finding_type))["on_reject"]
    assert reject["effect_key"] == "generic.reject_noop"
    assert reject["is_noop"] is True
    assert reject["audited"] is True
    # Reject never carries an executable params bag.
    assert reject["params"] == {}


# ===========================================================================
# AC2/AC4 — CROSS-LANGUAGE PARITY: the Python rule output is pinned to the SAME
#           shared table that pins the TS mirror (executed in the frontend
#           verify suite). A change to either language's rule must update this
#           table, which immediately breaks the other language's test.
# ===========================================================================


@pytest.mark.parametrize("case", _PARITY_CASES, ids=[c["name"] for c in _PARITY_CASES])
def test_describe_action_effect_matches_shared_parity_table(case: dict[str, Any]) -> None:
    preview = describe_action_effect(
        _finding(case["proposed_action"], finding_type=case["finding_type"])
    )

    for branch_name in ("on_approve", "on_reject"):
        expected = case[branch_name]
        actual = preview[branch_name]
        assert actual["effect_key"] == expected["effect_key"], branch_name
        assert actual["is_noop"] is expected["is_noop"], branch_name
        assert actual["assist_only"] is expected["assist_only"], branch_name
        assert actual["audited"] is expected["audited"], branch_name
        # value_impact: pin the kind, and assert the amount stays None (the pure
        # rule has no price; the UI shows the finding's delta instead).
        impact = actual["value_impact"]
        kind = None if impact is None else impact["kind"]
        amount = None if impact is None else impact["amount"]
        assert kind == expected["value_impact_kind"], branch_name
        assert amount == expected["value_impact_amount"], branch_name
        assert actual["params"] == expected["params"], branch_name


def test_parity_table_covers_every_action_of_all_four_agents() -> None:
    # Guard against the fixture silently shrinking: all vehicle-aging actions and
    # all three assist-only agents must be represented (AC4 "all actions covered").
    pairs = {(c["finding_type"], c["proposed_action"]) for c in _PARITY_CASES}
    for action in ("markdown", "transfer", "prioritize_sale", "wholesale_auction", "monitor", "frobnicate", ""):
        assert ("stock_aging_90d", action) in pairs, action
    assist_only_types = {c["finding_type"] for c in _PARITY_CASES if c["finding_type"] != "stock_aging_90d"}
    assert {"estimate_rescue", "collections_priority", "replenish_now", "dead_stock"} <= assist_only_types


# ===========================================================================
# Recording fake: a real SupabaseServiceClient with REST collaborators swapped
# for in-memory recorders, so we observe the concrete side effects that
# execute_finding_action produces (no network).
# ===========================================================================


class _FakeClient(SupabaseServiceClient):
    def __init__(self, *, current: EntityCurrentVersion | None) -> None:
        super().__init__(base_url="http://fake.invalid", service_role_key="svc")
        self._current = current
        self.appended_versions: list[dict[str, Any]] = []
        self.inserted_actions: list[dict[str, Any]] = []
        self.audit_events: list[dict[str, Any]] = []

    async def get_finding_action(self, *, finding_id: str) -> dict[str, Any] | None:
        return None  # no prior action -> not idempotent

    async def get_entity_current_version(self, *, entity_id: str) -> EntityCurrentVersion | None:
        return self._current

    async def append_entity_version(
        self, *, entity_id: str, version_number: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = {"entity_id": entity_id, "version_number": version_number, "data": data}
        self.appended_versions.append(row)
        self._current = EntityCurrentVersion(
            id=entity_id, entity_type="vehicle", version_number=version_number, data=data
        )
        return {"id": "ev-new", "version_number": version_number, "data": data}

    async def insert_finding_action(
        self,
        *,
        finding_id: str,
        tenant_id: str,
        vehicle_id: str | None,
        action_type: str,
        status_value: str,
        payload: dict[str, Any],
        approver: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        self.inserted_actions.append(
            {
                "finding_id": finding_id,
                "action_type": action_type,
                "status": status_value,
                "payload": payload,
                "approver": approver,
            }
        )
        return {"id": "fa-1", "status": status_value, "action_type": action_type}

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
        self.audit_events.append({"event_type": event_type, "action_type": action_type, "payload": payload})


def _vehicle(sale_price: Any, *, version: int = 1) -> EntityCurrentVersion:
    return EntityCurrentVersion(
        id=_VEHICLE_ID,
        entity_type="vehicle",
        version_number=version,
        data={"sale_price": sale_price, "brand": "VW", "model": "Polo", "status": "em_estoque"},
    )


# ===========================================================================
# AC2 — PARITY: the described on_approve effect EXACTLY matches what
#       execute_finding_action actually records — so the preview and the
#       executed outcome can never diverge.
# ===========================================================================


@pytest.mark.asyncio
async def test_parity_markdown_preview_matches_recorded_finding_action() -> None:
    finding = _finding("markdown")
    approve = describe_action_effect(finding)["on_approve"]
    client = _FakeClient(current=_vehicle(100000))

    await client.execute_finding_action(finding=finding, approver=_APPROVER)

    assert len(client.inserted_actions) == 1
    recorded = client.inserted_actions[0]
    # effect_key ↔ executed branch: markdown writes an 'executed' finding_action.
    assert approve["effect_key"] == "vehicle_aging.markdown"
    assert recorded["status"] == "executed"
    # params ↔ recorded payload: the SAME markdown_pct drives the recorded effect.
    assert recorded["payload"]["markdown_pct"] == approve["params"]["markdown_pct"]
    # value_impact is recoverable AND a real price reduction was applied (100000 * 0.9).
    assert approve["value_impact"]["kind"] == "recoverable"
    assert recorded["payload"]["old_sale_price"] == 100000.0
    assert recorded["payload"]["new_sale_price"] == 90000.0
    assert client.appended_versions[0]["data"]["sale_price"] == 90000.0


@pytest.mark.parametrize("action", ["transfer", "prioritize_sale", "wholesale_auction"])
@pytest.mark.asyncio
async def test_parity_disposition_preview_matches_recorded_finding_action(action: str) -> None:
    finding = _finding(action)
    approve = describe_action_effect(finding)["on_approve"]
    client = _FakeClient(current=_vehicle(100000))

    await client.execute_finding_action(finding=finding, approver=_APPROVER)

    recorded = client.inserted_actions[0]
    assert approve["effect_key"] == "vehicle_aging.disposition"
    assert recorded["status"] == "pending_execution"
    # params.disposition ↔ recorded payload.disposition (and the entity disposition).
    assert recorded["payload"]["disposition"] == approve["params"]["disposition"] == action
    assert client.appended_versions[0]["data"]["disposition"] == action
    # Disposition is recoverable and leaves the price untouched (no markdown invented).
    assert approve["value_impact"]["kind"] == "recoverable"
    assert client.appended_versions[0]["data"]["sale_price"] == 100000


@pytest.mark.asyncio
async def test_parity_monitor_preview_matches_recorded_noop() -> None:
    finding = _finding("monitor")
    approve = describe_action_effect(finding)["on_approve"]
    client = _FakeClient(current=_vehicle(100000))

    await client.execute_finding_action(finding=finding, approver=_APPROVER)

    # No-op on approve: an audited finding_action is recorded but nothing changes.
    assert approve["effect_key"] == "generic.monitor_noop"
    assert approve["is_noop"] is True
    assert client.appended_versions == []
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "executed"
    assert len(client.audit_events) == 1


@pytest.mark.parametrize("finding_type", _ASSIST_ONLY_TYPES)
@pytest.mark.asyncio
async def test_parity_assist_only_preview_matches_no_dms_execution(finding_type: str) -> None:
    finding = _finding("prioritize", finding_type=finding_type)
    approve = describe_action_effect(finding)["on_approve"]

    client = _FakeClient(current=_vehicle(100000))
    result = await client.execute_finding_action(finding=finding, approver=_APPROVER)

    # Preview says assist-only with no value impact; execution writes nothing to the DMS.
    assert approve["effect_key"] == "assist_only.register"
    assert approve["value_impact"] is None
    assert result == {"executed": False, "skipped": True}
    assert client.appended_versions == []
    assert client.inserted_actions == []
    assert client.audit_events == []


@pytest.mark.asyncio
async def test_parity_unknown_action_preview_matches_recorded_noop() -> None:
    """AC4 — an unrecognised action on a vehicle-aging finding is an audited
    no-op, and the recorded finding_action matches the described on_approve."""
    finding = _finding("frobnicate")
    approve = describe_action_effect(finding)["on_approve"]
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(finding=finding, approver=_APPROVER)

    assert approve["effect_key"] == "generic.monitor_noop"
    assert approve["is_noop"] is True
    # No-op: the vehicle entity is never touched.
    assert client.appended_versions == []
    assert len(client.inserted_actions) == 1
    recorded = client.inserted_actions[0]
    assert recorded["status"] == "executed"
    assert recorded["action_type"] == "frobnicate"
    # The recorded payload preserves the unknown action — same value the preview
    # carries in params, so description and record agree.
    assert recorded["payload"] == {"note": "unknown_action", "action": "frobnicate"}
    assert recorded["payload"]["action"] == approve["params"]["action"]
    assert len(client.audit_events) == 1
    assert result == {"executed": True, "action": "frobnicate", "status": "executed"}


# ===========================================================================
# AC1/AC5 — GET /api/ops/findings/{finding_id} exposes a well-formed
#           decision_preview (read-only, no network). Uses a recording-fake
#           Supabase client and FastAPI's TestClient.
# ===========================================================================


class _FakeFindingApiClient:
    """Fake Supabase client exposing only what the detail endpoint needs."""

    def __init__(self, finding: FindingRecord | None) -> None:
        self._finding = finding
        self.principal = Principal(
            sub="u-1", name="Ana", role="branch_manager", tenant="tenant-a", can_operate=True
        )

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        return self.principal

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        return _TENANT if tenant_key == "tenant-a" else None

    async def get_finding(self, *, finding_id: str, tenant_id: str) -> FindingRecord | None:
        if self._finding is not None and finding_id == self._finding.id and tenant_id == _TENANT:
            return self._finding
        return None


def _finding_api_client(finding: FindingRecord | None) -> TestClient:
    app = create_app(supabase_client=_FakeFindingApiClient(finding), connector_registry={})
    return TestClient(app)


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


def test_get_finding_detail_returns_wellformed_decision_preview() -> None:
    client = _finding_api_client(_finding("markdown", status="pending_approval"))

    res = client.get(f"/api/ops/findings/{_FINDING_ID}", headers=_auth_header())

    assert res.status_code == 200
    body = res.json()
    assert body["id"] == _FINDING_ID
    assert body["finding_type"] == _VEHICLE_AGING_TYPE
    assert body["status"] == "pending_approval"
    assert body["proposed_action"] == "markdown"

    preview = body["decision_preview"]
    assert set(preview) == {"on_approve", "on_reject"}
    expected_branch_keys = {"effect_key", "is_noop", "value_impact", "audited", "assist_only", "params"}
    for branch in preview.values():
        assert set(branch) == expected_branch_keys

    # Faithful to the markdown rule and the always-no-op reject branch.
    assert preview["on_approve"]["effect_key"] == "vehicle_aging.markdown"
    assert preview["on_approve"]["params"]["markdown_pct"] == DEFAULT_MARKDOWN_PCT
    assert preview["on_approve"]["value_impact"]["kind"] == "recoverable"
    assert preview["on_reject"]["effect_key"] == "generic.reject_noop"
    assert preview["on_reject"]["is_noop"] is True


def test_get_finding_detail_404_when_finding_missing() -> None:
    client = _finding_api_client(None)

    res = client.get("/api/ops/findings/does-not-exist", headers=_auth_header())

    assert res.status_code == 404
