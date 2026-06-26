"""Tests for ``SupabaseServiceClient.execute_finding_action`` (issue #73).

These exercise the *behaviour* of the execute-after-approval handler in
``temporal/src/ops_api/app.py`` against an in-memory fake of the Supabase REST
collaborators (``get_finding_action`` / ``get_entity_current_version`` /
``append_entity_version`` / ``insert_finding_action`` / ``append_audit_event``).
No network calls are made: a real ``SupabaseServiceClient`` is constructed and
its collaborator methods are swapped for recording fakes, so we assert on the
*concrete side effects* the handler produces, not on mock plumbing.

Every test traces back to an acceptance criterion in
``docs/specs/73-feat-ops-executar-de-fato.md``.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporal.src.ops_api.app import (
    DEFAULT_MARKDOWN_PCT,
    EntityCurrentVersion,
    FindingRecord,
    SupabaseServiceClient,
)

_TENANT = "tenant-a-id"
_VEHICLE_ID = "vehicle-entity-1"
_FINDING_ID = "finding-1"
_APPROVER = {"approver_id": "u-1", "approver_name": "Ana", "note": None}


def _finding(action: str, *, finding_type: str = "stock_aging_90d") -> FindingRecord:
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
        status="approved",
        proposed_action=action,
    )


class _FakeClient(SupabaseServiceClient):
    """Real handler logic, fake REST collaborators that record their calls."""

    def __init__(
        self,
        *,
        current: EntityCurrentVersion | None,
        existing_action: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(base_url="http://fake.invalid", service_role_key="svc")
        self._current = current
        self._existing_action = existing_action
        self.appended_versions: list[dict[str, Any]] = []
        self.inserted_actions: list[dict[str, Any]] = []
        self.audit_events: list[dict[str, Any]] = []
        self.get_action_calls: list[str] = []

    async def get_finding_action(self, *, finding_id: str) -> dict[str, Any] | None:
        self.get_action_calls.append(finding_id)
        return self._existing_action

    async def get_entity_current_version(self, *, entity_id: str) -> EntityCurrentVersion | None:
        return self._current

    async def append_entity_version(
        self, *, entity_id: str, version_number: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        row = {"entity_id": entity_id, "version_number": version_number, "data": data}
        self.appended_versions.append(row)
        # Keep the in-memory "current" coherent so a follow-up read sees the new data.
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
        row = {
            "finding_id": finding_id,
            "tenant_id": tenant_id,
            "vehicle_id": vehicle_id,
            "action_type": action_type,
            "status": status_value,
            "payload": payload,
            "approver": approver,
        }
        self.inserted_actions.append(row)
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


def _vehicle(sale_price: Any, *, version: int = 1) -> EntityCurrentVersion:
    return EntityCurrentVersion(
        id=_VEHICLE_ID,
        entity_type="vehicle",
        version_number=version,
        data={"sale_price": sale_price, "brand": "VW", "model": "Polo", "status": "em_estoque"},
    )


# ===========================================================================
# AC1: "Approving a markdown finding actually reduces the price." A new SCD2
#      entity_version is appended with sale_price = round(old * (1 - 10%), 2) and
#      a single finding_action 'executed' row records before/after + the approver.
# ===========================================================================


@pytest.mark.asyncio
async def test_markdown_reduces_price_and_records_executed_action() -> None:
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(finding=_finding("markdown"), approver=_APPROVER)

    assert result == {"executed": True, "action": "markdown", "status": "executed"}

    # Exactly one new entity_version, version bumped, price reduced by 10%.
    assert len(client.appended_versions) == 1
    appended = client.appended_versions[0]
    assert appended["version_number"] == 2
    assert appended["data"]["sale_price"] == 90000.0
    # Non-price fields are preserved on the new version.
    assert appended["data"]["brand"] == "VW"
    assert appended["data"]["model"] == "Polo"

    # Exactly one finding_action 'executed' with the before/after payload + approver.
    assert len(client.inserted_actions) == 1
    fa = client.inserted_actions[0]
    assert fa["status"] == "executed"
    assert fa["action_type"] == "markdown"
    assert fa["payload"] == {
        "old_sale_price": 100000.0,
        "new_sale_price": 90000.0,
        "markdown_pct": DEFAULT_MARKDOWN_PCT,
    }
    assert fa["approver"] == _APPROVER

    # The action is audited against the vehicle entity.
    assert len(client.audit_events) == 1
    audit = client.audit_events[0]
    assert audit["event_type"] == "vehicle_action_executed"
    assert audit["entity_id"] == _VEHICLE_ID
    assert audit["action_type"] == "markdown"


@pytest.mark.asyncio
async def test_markdown_rounds_to_two_decimals() -> None:
    # 33333.33 * 0.9 = 29999.997 -> round(,2) = 30000.0 (exercises the rounding).
    client = _FakeClient(current=_vehicle("33333.33"))

    await client.execute_finding_action(finding=_finding("markdown"), approver=_APPROVER)

    assert client.appended_versions[0]["data"]["sale_price"] == 30000.0
    assert client.inserted_actions[0]["payload"]["new_sale_price"] == 30000.0


# ===========================================================================
# AC2: "Approving the same finding twice changes nothing extra (idempotent)."
#      When a finding_action already exists, no second version and no second
#      finding_action are written; the handler returns the idempotent marker.
# ===========================================================================


@pytest.mark.asyncio
async def test_idempotent_when_action_already_exists() -> None:
    existing = {"id": "fa-1", "status": "executed", "action_type": "markdown"}
    client = _FakeClient(current=_vehicle(100000), existing_action=existing)

    result = await client.execute_finding_action(finding=_finding("markdown"), approver=_APPROVER)

    assert result == {"executed": False, "idempotent": True}
    # No second markdown, no second finding_action, no extra audit event.
    assert client.appended_versions == []
    assert client.inserted_actions == []
    assert client.audit_events == []


# ===========================================================================
# AC3: "Approving a non-monetary action records intent without touching price."
#      transfer / prioritize_sale / wholesale_auction -> finding_action
#      'pending_execution', disposition marked on the vehicle, price unchanged.
# ===========================================================================


@pytest.mark.parametrize("action", ["transfer", "prioritize_sale", "wholesale_auction"])
@pytest.mark.asyncio
async def test_non_monetary_action_marks_disposition_without_price_change(action: str) -> None:
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(finding=_finding(action), approver=_APPROVER)

    assert result == {"executed": True, "action": action, "status": "pending_execution"}

    # Disposition is recorded on a new version; price is left untouched.
    assert len(client.appended_versions) == 1
    appended_data = client.appended_versions[0]["data"]
    assert appended_data["disposition"] == action
    assert appended_data["sale_price"] == 100000  # unchanged (still the original value)

    assert len(client.inserted_actions) == 1
    fa = client.inserted_actions[0]
    assert fa["status"] == "pending_execution"
    assert fa["action_type"] == action
    assert fa["payload"] == {"disposition": action}


# ===========================================================================
# AC4: "Approving monitor is an audited no-op." A finding_action 'executed' is
#      recorded and audited, but the vehicle entity is not changed.
# ===========================================================================


@pytest.mark.asyncio
async def test_monitor_is_audited_no_op() -> None:
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(finding=_finding("monitor"), approver=_APPROVER)

    assert result == {"executed": True, "action": "monitor", "status": "executed"}
    # No entity change at all.
    assert client.appended_versions == []
    # But a finding_action is recorded (executed) and audited.
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "executed"
    assert client.inserted_actions[0]["action_type"] == "monitor"
    assert len(client.audit_events) == 1
    assert client.audit_events[0]["event_type"] == "vehicle_action_executed"


# ===========================================================================
# Scope guard: a non vehicle-aging finding_type is skipped with no side effects.
# (Supports the spec's "Scope is limited to vehicle-aging-analyst" invariant.)
# ===========================================================================


@pytest.mark.asyncio
async def test_non_vehicle_aging_finding_is_skipped() -> None:
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(
        finding=_finding("markdown", finding_type="invoice_mismatch"), approver=_APPROVER
    )

    assert result == {"executed": False, "skipped": True}
    assert client.get_action_calls == []  # short-circuits before any work
    assert client.appended_versions == []
    assert client.inserted_actions == []
    assert client.audit_events == []


@pytest.mark.asyncio
async def test_issue117_collections_priority_finding_is_assist_only_skipped() -> None:
    """Issue #117 (AC4/AC5): a ``collections_priority`` finding is assist-only —
    ``execute_finding_action`` short-circuits to ``{"skipped": True}`` with no
    money movement or outbound side effect, so approve/reject/dismiss only
    persists the disposition + audit trail upstream and never 500s."""
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(
        finding=_finding("prioritize", finding_type="collections_priority"), approver=_APPROVER
    )

    assert result == {"executed": False, "skipped": True}
    assert client.get_action_calls == []  # short-circuits before any work
    assert client.appended_versions == []
    assert client.inserted_actions == []
    assert client.audit_events == []


@pytest.mark.asyncio
async def test_missing_action_is_skipped() -> None:
    client = _FakeClient(current=_vehicle(100000))

    result = await client.execute_finding_action(finding=_finding(""), approver=_APPROVER)

    assert result == {"executed": False, "skipped": True}
    assert client.appended_versions == []
    assert client.inserted_actions == []


# ===========================================================================
# Failure path: if the vehicle entity is not found, the handler records a
# 'failed' finding_action and never raises (the decision response is preserved).
# ===========================================================================


@pytest.mark.asyncio
async def test_markdown_failure_records_failed_action_and_does_not_raise() -> None:
    client = _FakeClient(current=None)  # vehicle entity missing

    result = await client.execute_finding_action(finding=_finding("markdown"), approver=_APPROVER)

    assert result == {"executed": False, "failed": True}
    assert client.appended_versions == []
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "failed"


# ===========================================================================
# Data-integrity guard: a vehicle with a missing or non-positive sale_price must
# NOT be silently marked down to 0.00 and reported as executed. The markdown
# branch raises -> recorded as a 'failed' finding_action, no price written.
# ===========================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_price", [None, 0, "0", "", "abc"])
async def test_markdown_with_missing_or_nonpositive_price_records_failed(bad_price: Any) -> None:
    client = _FakeClient(current=_vehicle(bad_price))

    result = await client.execute_finding_action(finding=_finding("markdown"), approver=_APPROVER)

    assert result == {"executed": False, "failed": True}
    # No new entity_version -> the (bogus) price is never written as current.
    assert client.appended_versions == []
    assert len(client.inserted_actions) == 1
    assert client.inserted_actions[0]["status"] == "failed"

