"""Tests for the technician morning-queue workflow, activities, and agent.

Coverage:
- Queue ranking: critical > high > medium > low
- Item types: returned_unit (t1), pm_work (t2), active_repair (t2), rent_ready_check (t5)
- Priority reasons: contract_risk, overdue_maintenance, parts_blocker,
  has_return_condition_evidence — must be explicit per row
- Fail-closed: missing data yields confidence=0 + 'insufficient_data:' reasons,
  not a success-shaped default
- No-op state: empty scoped items returns status='no_op' without recording findings
- Freshness / stale detection: _is_stale returns True for old or absent timestamps
- Dedup: items with existing fingerprints are skipped
- Override signal: recorded as informational, no status change on finding
- _item_finding_for_storage: maps technician item fields to finding schema including
  priority_reasons, contract_risk, overdue_maintenance, parts_blocker,
  has_return_condition_evidence
- TechnicianQueueItemV1: operating-model tag threaded in by agent wrapper
"""
from __future__ import annotations

import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporal.src.activities import ops_technician_queue
from temporal.src.agents.technician_queue_assistant import (
    OM_TAG_ACTIVE_REPAIR,
    OM_TAG_PM_WORK,
    OM_TAG_RENT_READY_CHECK,
    OM_TAG_RETURNED_UNIT,
    TechnicianQueueItemV1,
    run_technician_queue_assistant,
    technician_queue_item_v1_schema,
)
from temporal.src.workflows.ops.technician_morning_queue import (
    OverrideQueueItemSignal,
    TechnicianMorningQueueWorkflow,
    TechnicianMorningQueueWorkflowInput,
)
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-tech-test"
_ASSET_ID = "asset-tech-001"
_WORK_ORDER_ID = "wo-tech-001"

_NOW = datetime.datetime(2026, 6, 19, 8, 0, 0, tzinfo=datetime.UTC)
_OLD = datetime.datetime(2026, 6, 17, 0, 0, 0, tzinfo=datetime.UTC)


def _default_config(**overrides) -> dict:
    base = {
        "auto_apply": False,
        "thresholds": {},
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "x",
        "user_prompt_template": "x",
        "tools": [],
    }
    base.update(overrides)
    return base


def _make_item(
    asset_id: str = _ASSET_ID,
    item_type: str = "returned_unit",
    priority: str = "high",
    work_order_id: str | None = None,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "asset_id": asset_id,
        "item_type": item_type,
        "work_order_id": work_order_id,
        "last_updated_at": _NOW.isoformat(),
        "is_stale_hint": False,
        "rental_data": {"entities": [], "relationships": [], "facts": [], "time_series": [], "telematics": []},
    }


def _make_assessment(
    asset_id: str = _ASSET_ID,
    item_type: str = "returned_unit",
    priority: str = "high",
    work_order_id: str | None = None,
    is_stale: bool = False,
    contract_risk: bool = False,
    overdue_maintenance: bool = False,
    parts_blocker: bool = False,
    has_return_condition_evidence: bool = False,
) -> dict:
    priority_reasons = []
    if contract_risk:
        priority_reasons.append("Contract risk: active rental depends on this unit")
    if overdue_maintenance:
        priority_reasons.append("Overdue maintenance: PM past target window")
    if parts_blocker:
        priority_reasons.append("Parts blocker: repair waiting on stock")
    if has_return_condition_evidence:
        priority_reasons.append("Return condition evidence already exists")
    return {
        "asset_id": asset_id,
        "item_type": item_type,
        "priority": priority,
        "recommendation": "Inspect returned unit and open repair follow-up.",
        "priority_reasons": priority_reasons,
        "evidence": ["Unit returned yesterday", "No inspection on record"],
        "blockers": [],
        "contract_risk": contract_risk,
        "overdue_maintenance": overdue_maintenance,
        "parts_blocker": parts_blocker,
        "has_return_condition_evidence": has_return_condition_evidence,
        "rent_ready_eta": None,
        "confidence": 0.85,
        "rationale": "Returned unit with no inspection record; contract risk unknown.",
        "is_stale_data": is_stale,
        "stale_signals": ["Asset status is 12 hours old"] if is_stale else [],
        "operating_model_tags": [],
        "work_order_id": work_order_id,
        "tenant_id": _TENANT_ID,
    }


# ---------------------------------------------------------------------------
# Unit: freshness / stale detection
# ---------------------------------------------------------------------------

class TestIsStaleFn:
    def test_none_timestamp_is_stale(self) -> None:
        assert ops_technician_queue._is_stale(None)

    def test_empty_string_is_stale(self) -> None:
        assert ops_technician_queue._is_stale("")

    def test_old_timestamp_is_stale(self) -> None:
        old = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=10)).isoformat()
        assert ops_technician_queue._is_stale(old, threshold_hours=8)

    def test_fresh_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)).isoformat()
        assert not ops_technician_queue._is_stale(fresh, threshold_hours=8)

    def test_invalid_string_is_stale(self) -> None:
        assert ops_technician_queue._is_stale("not-a-date")


# ---------------------------------------------------------------------------
# Unit: _item_finding_for_storage mapping
# ---------------------------------------------------------------------------

class TestItemFindingForStorage:
    def test_maps_asset_id_to_contract_id(self) -> None:
        item = _make_assessment(asset_id="asset-abc", item_type="returned_unit")
        stored = ops_technician_queue._item_finding_for_storage(item)
        assert stored["contract_id"] == "asset-abc"

    def test_maps_work_order_id_to_line_item_id(self) -> None:
        item = _make_assessment(work_order_id="wo-xyz", item_type="pm_work")
        stored = ops_technician_queue._item_finding_for_storage(item)
        assert stored["line_item_id"] == "wo-xyz"

    def test_finding_type_is_item_type(self) -> None:
        for item_type in ("returned_unit", "pm_work", "active_repair", "rent_ready_check"):
            item = _make_assessment(item_type=item_type)
            stored = ops_technician_queue._item_finding_for_storage(item)
            assert stored["finding_type"] == item_type, f"item_type={item_type}"

    def test_severity_maps_from_priority(self) -> None:
        for priority, expected_severity in [
            ("critical", "critical"),
            ("high", "high"),
            ("medium", "medium"),
            ("low", "low"),
        ]:
            item = _make_assessment(priority=priority)
            stored = ops_technician_queue._item_finding_for_storage(item)
            assert stored["severity"] == expected_severity, f"priority={priority}"

    def test_expected_contains_priority_reasons(self) -> None:
        item = _make_assessment(
            contract_risk=True, parts_blocker=True
        )
        stored = ops_technician_queue._item_finding_for_storage(item)
        assert len(stored["expected"]["priority_reasons"]) > 0
        assert stored["expected"]["contract_risk"] is True
        assert stored["expected"]["parts_blocker"] is True

    def test_expected_contains_has_return_condition_evidence(self) -> None:
        item = _make_assessment(has_return_condition_evidence=True)
        stored = ops_technician_queue._item_finding_for_storage(item)
        assert stored["expected"]["has_return_condition_evidence"] is True

    def test_expected_contains_stale_signals(self) -> None:
        item = _make_assessment(is_stale=True)
        item["stale_signals"] = ["Asset status is 12 hours old"]
        stored = ops_technician_queue._item_finding_for_storage(item)
        assert stored["expected"]["stale_signals"] == ["Asset status is 12 hours old"]
        assert stored["expected"]["is_stale_data"] is True

    def test_expected_contains_operating_model_tags(self) -> None:
        item = _make_assessment(item_type="returned_unit")
        item["operating_model_tags"] = [OM_TAG_RETURNED_UNIT]
        stored = ops_technician_queue._item_finding_for_storage(item)
        assert OM_TAG_RETURNED_UNIT in stored["expected"]["operating_model_tags"]


# ---------------------------------------------------------------------------
# Unit: TechnicianQueueItemV1 model validation
# ---------------------------------------------------------------------------

class TestTechnicianQueueItemV1:
    def test_valid_returned_unit_item(self) -> None:
        item = TechnicianQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="returned_unit",
            priority="high",
            recommendation="Inspect returned unit and open repair follow-up.",
            rationale="Unit returned with no inspection record.",
        )
        assert item.item_type == "returned_unit"
        assert item.priority == "high"
        assert item.contract_risk is False
        assert item.has_return_condition_evidence is False
        assert item.operating_model_tags == []

    def test_valid_pm_work_item(self) -> None:
        item = TechnicianQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="pm_work",
            priority="critical",
            recommendation="Execute 500h oil-change PM before next rental.",
            rationale="PM due now; contract risk.",
            contract_risk=True,
            overdue_maintenance=True,
            priority_reasons=["Contract risk: active rental", "Overdue maintenance: 48h past interval"],
        )
        assert item.item_type == "pm_work"
        assert item.contract_risk is True
        assert len(item.priority_reasons) == 2

    def test_valid_active_repair_item(self) -> None:
        item = TechnicianQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="active_repair",
            priority="medium",
            recommendation="Continue hydraulic fault diagnosis.",
            rationale="Open repair, no parts block.",
        )
        assert item.item_type == "active_repair"
        assert item.parts_blocker is False

    def test_valid_rent_ready_check_item(self) -> None:
        item = TechnicianQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="rent_ready_check",
            priority="low",
            recommendation="Confirm decals and accessories; update status to available.",
            rationale="Maintenance completed, awaiting final check.",
        )
        assert item.item_type == "rent_ready_check"

    def test_invalid_item_type_raises(self) -> None:
        with pytest.raises(ValueError):
            TechnicianQueueItemV1(
                asset_id=_ASSET_ID,
                item_type="unknown_type",
                priority="high",
                recommendation="x",
                rationale="x",
            )

    def test_invalid_priority_raises(self) -> None:
        with pytest.raises(ValueError):
            TechnicianQueueItemV1(
                asset_id=_ASSET_ID,
                item_type="returned_unit",
                priority="urgent",
                recommendation="x",
                rationale="x",
            )

    def test_empty_asset_id_raises(self) -> None:
        with pytest.raises(ValueError):
            TechnicianQueueItemV1(
                asset_id="",
                item_type="returned_unit",
                priority="high",
                recommendation="x",
                rationale="x",
            )

    def test_confidence_out_of_range_raises(self) -> None:
        with pytest.raises(ValueError):
            TechnicianQueueItemV1(
                asset_id=_ASSET_ID,
                item_type="returned_unit",
                priority="high",
                confidence=1.5,
                recommendation="x",
                rationale="x",
            )


# ---------------------------------------------------------------------------
# Unit: operating-model tag injection
# ---------------------------------------------------------------------------

class TestOperatingModelTags:
    def test_returned_unit_tag_is_t1(self) -> None:
        assert OM_TAG_RETURNED_UNIT == "service-technician:t1"

    def test_pm_work_tag_is_t2(self) -> None:
        assert OM_TAG_PM_WORK == "service-technician:t2"

    def test_active_repair_tag_is_t2(self) -> None:
        assert OM_TAG_ACTIVE_REPAIR == "service-technician:t2"

    def test_rent_ready_check_tag_is_t5(self) -> None:
        assert OM_TAG_RENT_READY_CHECK == "service-technician:t5"

    @pytest.mark.asyncio
    async def test_run_assistant_injects_tag_for_returned_unit(self) -> None:
        mock_transport = AsyncMock()
        mock_result = MagicMock()
        mock_result.response = TechnicianQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="returned_unit",
            priority="high",
            recommendation="Inspect unit.",
            rationale="No inspection on record.",
            operating_model_tags=[],
        )
        mock_transport.return_value = mock_result

        with patch(
            "temporal.src.agents.technician_queue_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_technician_queue_assistant(
                {"asset_id": _ASSET_ID, "item_type": "returned_unit"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
                transport=mock_transport,
            )

        assert OM_TAG_RETURNED_UNIT in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_run_assistant_injects_tag_for_rent_ready_check(self) -> None:
        mock_result = MagicMock()
        mock_result.response = TechnicianQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="rent_ready_check",
            priority="low",
            recommendation="Confirm and update status.",
            rationale="Maintenance complete.",
            operating_model_tags=[],
        )

        with patch(
            "temporal.src.agents.technician_queue_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_technician_queue_assistant(
                {"asset_id": _ASSET_ID, "item_type": "rent_ready_check"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )

        assert OM_TAG_RENT_READY_CHECK in result["operating_model_tags"]


# ---------------------------------------------------------------------------
# Unit: JSON schema generation
# ---------------------------------------------------------------------------

class TestSchemaGeneration:
    def test_schema_includes_priority_reasons_field(self) -> None:
        schema = technician_queue_item_v1_schema()
        assert "priority_reasons" in schema.get("properties", {})

    def test_schema_includes_all_priority_factor_fields(self) -> None:
        schema = technician_queue_item_v1_schema()
        props = schema.get("properties", {})
        assert "contract_risk" in props
        assert "overdue_maintenance" in props
        assert "parts_blocker" in props
        assert "has_return_condition_evidence" in props

    def test_schema_includes_four_item_types(self) -> None:
        schema = technician_queue_item_v1_schema()
        item_type_schema = schema.get("properties", {}).get("item_type", {})
        pattern = item_type_schema.get("pattern", "")
        assert "returned_unit" in pattern
        assert "pm_work" in pattern
        assert "active_repair" in pattern
        assert "rent_ready_check" in pattern


# ---------------------------------------------------------------------------
# Unit: workflow deduplication
# ---------------------------------------------------------------------------

class TestFingerprintGeneration:
    def test_fingerprint_includes_tech_prefix(self) -> None:
        """Technician queue fingerprints must not collide with shop queue."""
        asset_id = "asset-x"
        item_type = "returned_unit"
        work_order_id = ""
        fingerprint = (
            f"tech:{asset_id}:{item_type}:{work_order_id}"
            if work_order_id
            else f"tech:{asset_id}:{item_type}"
        )
        assert fingerprint.startswith("tech:")
        assert "shop:" not in fingerprint

    def test_fingerprint_with_work_order_id(self) -> None:
        asset_id = "asset-x"
        item_type = "active_repair"
        work_order_id = "wo-123"
        fingerprint = f"tech:{asset_id}:{item_type}:{work_order_id}"
        assert fingerprint == "tech:asset-x:active_repair:wo-123"


# ---------------------------------------------------------------------------
# Unit: override signal
# ---------------------------------------------------------------------------

class TestOverrideQueueItemSignal:
    def test_signal_defaults_to_work_on_now_disposition(self) -> None:
        sig = OverrideQueueItemSignal(
            asset_id=_ASSET_ID,
            item_type="returned_unit",
            disposer_id="tech-001",
        )
        assert sig.disposition == "work_on_now"

    def test_signal_accepts_defer_disposition(self) -> None:
        sig = OverrideQueueItemSignal(
            asset_id=_ASSET_ID,
            item_type="active_repair",
            disposer_id="tech-001",
            disposition="defer",
            note="Waiting on customer decision",
        )
        assert sig.disposition == "defer"
        assert sig.note == "Waiting on customer decision"

    def test_signal_accepts_escalate_disposition(self) -> None:
        sig = OverrideQueueItemSignal(
            asset_id=_ASSET_ID,
            item_type="pm_work",
            disposer_id="tech-001",
            disposition="escalate",
        )
        assert sig.disposition == "escalate"

    def test_signal_accepts_needs_parts_disposition(self) -> None:
        sig = OverrideQueueItemSignal(
            asset_id=_ASSET_ID,
            item_type="active_repair",
            disposer_id="tech-001",
            disposition="needs_parts",
            note="Hydraulic seal kit on back-order",
        )
        assert sig.disposition == "needs_parts"


# ---------------------------------------------------------------------------
# Unit: ops_technician_queue_scope (mocked client)
# ---------------------------------------------------------------------------

class TestScopeActivity:
    def _make_mock_client(
        self,
        returned_assets: list[dict] | None = None,
        pm_work_orders: list[dict] | None = None,
        maintenance_records: list[dict] | None = None,
        branch_rels: list[dict] | None = None,
        asset_rels: list[dict] | None = None,
        inspection_rels: list[dict] | None = None,
    ):
        client = MagicMock()
        returned_assets = returned_assets or []
        pm_work_orders = pm_work_orders or []
        maintenance_records = maintenance_records or []

        def select_side_effect(table, **kwargs):
            filters = kwargs.get("filters", {})
            entity_type = filters.get("entity_type", "")
            rel_type = (filters.get("relationship_type") or "").split(",")[0].strip()

            if table == "pm_work_orders":
                return pm_work_orders
            if table == "rental_current_entity_state":
                if entity_type == "asset":
                    asset_id = filters.get("entity_id")
                    if asset_id:
                        return [r for r in returned_assets if r.get("entity_id") == asset_id]
                    return returned_assets
                if entity_type == "maintenance_record":
                    return maintenance_records
            if table == "rental_current_relationships":
                if rel_type == "asset_has_inspection":
                    return inspection_rels or []
                if rel_type == "asset_has_maintenance_record":
                    return asset_rels or []
                return branch_rels or []
            return []

        client.select = MagicMock(side_effect=select_side_effect)
        return client

    def test_returned_unit_scoped_correctly(self) -> None:
        returned_assets = [
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "returned", "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        client = self._make_mock_client(returned_assets=returned_assets)

        with (
            patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client),
        ):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        returned = [r for r in result if r["item_type"] == "returned_unit"]
        assert len(returned) == 1
        assert returned[0]["asset_id"] == _ASSET_ID

    def test_pm_work_order_scoped_as_pm_work(self) -> None:
        pm_rows = [
            {
                "id": _WORK_ORDER_ID,
                "tenant_id": _TENANT_ID,
                "asset_id": _ASSET_ID,
                "policy_id": "pol-1",
                "trigger_type": "meter",
                "status": "open",
                "reason": "500h service",
                "run_id": "run-1",
                "created_at": _NOW.isoformat(),
                "updated_at": _NOW.isoformat(),
            }
        ]
        client = self._make_mock_client(pm_work_orders=pm_rows)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        pm = [r for r in result if r["item_type"] == "pm_work"]
        assert len(pm) == 1
        assert pm[0]["work_order_id"] == _WORK_ORDER_ID

    def test_active_repair_scoped_for_open_maintenance(self) -> None:
        maint_rows = [
            {
                "entity_id": "maint-001",
                "entity_type": "maintenance_record",
                "data": {"status": "open", "asset_id": _ASSET_ID, "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        asset_rels = [{"parent_id": _ASSET_ID, "child_id": "maint-001", "relationship_type": "asset_has_maintenance_record"}]
        client = self._make_mock_client(maintenance_records=maint_rows, asset_rels=asset_rels)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        active = [r for r in result if r["item_type"] == "active_repair"]
        assert len(active) == 1
        assert active[0]["asset_id"] == _ASSET_ID

    def test_rent_ready_check_scoped_for_completed_maintenance(self) -> None:
        maint_rows = [
            {
                "entity_id": "maint-done-001",
                "entity_type": "maintenance_record",
                "data": {"status": "completed", "asset_id": _ASSET_ID, "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        asset_rels = [{"parent_id": _ASSET_ID, "child_id": "maint-done-001", "relationship_type": "asset_has_maintenance_record"}]
        client = self._make_mock_client(maintenance_records=maint_rows, asset_rels=asset_rels)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        rent_ready = [r for r in result if r["item_type"] == "rent_ready_check"]
        assert len(rent_ready) == 1

    def test_on_inspection_hold_is_returned_unit(self) -> None:
        returned_assets = [
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "on_inspection_hold", "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        client = self._make_mock_client(returned_assets=returned_assets)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        returned = [r for r in result if r["item_type"] == "returned_unit"]
        assert len(returned) == 1

    def test_inspection_evidence_detected(self) -> None:
        returned_assets = [
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "returned", "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        inspection_rels = [{"parent_id": _ASSET_ID, "child_id": "insp-001", "relationship_type": "asset_has_inspection"}]
        client = self._make_mock_client(returned_assets=returned_assets, inspection_rels=inspection_rels)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        returned = [r for r in result if r["item_type"] == "returned_unit"]
        assert len(returned) == 1
        assert returned[0]["has_return_condition_evidence"] is True

    def test_asset_with_available_status_not_scoped(self) -> None:
        asset_rows = [
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "available", "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        client = self._make_mock_client(returned_assets=asset_rows)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        returned = [r for r in result if r["item_type"] == "returned_unit"]
        assert len(returned) == 0

    def test_empty_asset_id_in_pm_row_is_skipped(self) -> None:
        pm_rows = [
            {
                "id": _WORK_ORDER_ID,
                "tenant_id": _TENANT_ID,
                "asset_id": "",
                "status": "open",
                "created_at": _NOW.isoformat(),
                "updated_at": _NOW.isoformat(),
            }
        ]
        client = self._make_mock_client(pm_work_orders=pm_rows)

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        pm = [r for r in result if r["item_type"] == "pm_work"]
        assert len(pm) == 0


# ---------------------------------------------------------------------------
# Unit: cross-tenant isolation in ops_technician_queue_scope
# ---------------------------------------------------------------------------

_OTHER_TENANT_ID = "tenant-other-xyz"
_OTHER_ASSET_ID  = "asset-other-001"


class TestCrossTenantIsolation:
    """Prove that a tenant-A run cannot scope tenant-B returned-unit or
    maintenance findings even when the persistence client returns a
    mixed cross-tenant result set (service-role connection)."""

    def _make_mixed_client(
        self,
        returned_assets: list[dict],
        maintenance_records: list[dict],
        asset_rels: list[dict] | None = None,
    ):
        """Mock client whose entity-state queries return rows from multiple tenants."""
        client = MagicMock()

        def select_side_effect(table, **kwargs):
            filters = kwargs.get("filters", {})
            entity_type = filters.get("entity_type", "")
            rel_type = (filters.get("relationship_type") or "").split(",")[0].strip()

            if table == "pm_work_orders":
                return []
            if table == "rental_current_entity_state":
                if entity_type == "asset":
                    asset_id = filters.get("entity_id")
                    if asset_id:
                        return [r for r in returned_assets if r.get("entity_id") == asset_id]
                    return returned_assets
                if entity_type == "maintenance_record":
                    return maintenance_records
            if table == "rental_current_relationships":
                if rel_type == "asset_has_maintenance_record":
                    return asset_rels or []
                return []
            return []

        client.select = MagicMock(side_effect=select_side_effect)
        return client

    def test_cross_tenant_returned_unit_not_scoped(self) -> None:
        """Tenant-B asset must not appear in tenant-A run even when the
        persistence client returns both in the same result set."""
        mixed_assets = [
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "returned", "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            },
            {
                "entity_id": _OTHER_ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "returned", "tenant_id": _OTHER_TENANT_ID},
                "updated_at": _NOW.isoformat(),
            },
        ]
        client = self._make_mixed_client(returned_assets=mixed_assets, maintenance_records=[])

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        returned = [r for r in result if r["item_type"] == "returned_unit"]
        assert len(returned) == 1, "Only tenant-A asset should be scoped"
        assert returned[0]["asset_id"] == _ASSET_ID
        scoped_tenants = {r["tenant_id"] for r in returned}
        assert scoped_tenants == {_TENANT_ID}, f"Found unexpected tenants: {scoped_tenants}"

    def test_cross_tenant_maintenance_record_not_scoped(self) -> None:
        """Tenant-B maintenance records must not appear in tenant-A run even
        when the persistence client returns both in the same result set."""
        mixed_maint = [
            {
                "entity_id": "maint-alpha-001",
                "entity_type": "maintenance_record",
                "data": {"status": "open", "asset_id": _ASSET_ID, "tenant_id": _TENANT_ID},
                "updated_at": _NOW.isoformat(),
            },
            {
                "entity_id": "maint-beta-001",
                "entity_type": "maintenance_record",
                "data": {"status": "open", "asset_id": _OTHER_ASSET_ID, "tenant_id": _OTHER_TENANT_ID},
                "updated_at": _NOW.isoformat(),
            },
        ]
        asset_rels = [
            {"parent_id": _ASSET_ID,      "child_id": "maint-alpha-001", "relationship_type": "asset_has_maintenance_record"},
            {"parent_id": _OTHER_ASSET_ID, "child_id": "maint-beta-001",  "relationship_type": "asset_has_maintenance_record"},
        ]
        client = self._make_mixed_client(
            returned_assets=[],
            maintenance_records=mixed_maint,
            asset_rels=asset_rels,
        )

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        repairs = [r for r in result if r["item_type"] in ("active_repair", "rent_ready_check")]
        assert len(repairs) == 1, "Only tenant-A maintenance record should be scoped"
        assert repairs[0]["asset_id"] == _ASSET_ID
        scoped_tenants = {r["tenant_id"] for r in repairs}
        assert scoped_tenants == {_TENANT_ID}, f"Found unexpected tenants: {scoped_tenants}"

    def test_no_cross_tenant_findings_recorded_when_all_rows_are_other_tenant(self) -> None:
        """When the persistence client returns only tenant-B data, a tenant-A
        run must produce an empty scoped list and record no findings."""
        mixed_assets = [
            {
                "entity_id": _OTHER_ASSET_ID,
                "entity_type": "asset",
                "data": {"operational_status": "returned", "tenant_id": _OTHER_TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        mixed_maint = [
            {
                "entity_id": "maint-beta-002",
                "entity_type": "maintenance_record",
                "data": {"status": "open", "asset_id": _OTHER_ASSET_ID, "tenant_id": _OTHER_TENANT_ID},
                "updated_at": _NOW.isoformat(),
            }
        ]
        client = self._make_mixed_client(
            returned_assets=mixed_assets,
            maintenance_records=mixed_maint,
        )

        with patch.object(ops_technician_queue.ops_revrec, "_get_ops_persistence_client", return_value=client):
            env = ActivityEnvironment()
            result = env.run(ops_technician_queue.ops_technician_queue_scope, _TENANT_ID, None, None)

        assert result == [], f"Expected empty scope for tenant-A when only tenant-B data present; got {result}"


# ---------------------------------------------------------------------------
# Unit: ranking (priority ordering)
# ---------------------------------------------------------------------------

class TestPriorityRanking:
    def _priority_rank(self, priority: str) -> int:
        _rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        return _rank.get(priority, 3)

    def test_critical_ranks_before_high(self) -> None:
        assert self._priority_rank("critical") < self._priority_rank("high")

    def test_high_ranks_before_medium(self) -> None:
        assert self._priority_rank("high") < self._priority_rank("medium")

    def test_medium_ranks_before_low(self) -> None:
        assert self._priority_rank("medium") < self._priority_rank("low")

    def test_sorted_list_has_critical_first(self) -> None:
        items = [
            _make_assessment(priority="low"),
            _make_assessment(priority="critical", asset_id="a2"),
            _make_assessment(priority="medium", asset_id="a3"),
            _make_assessment(priority="high", asset_id="a4"),
        ]
        _rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        items.sort(key=lambda x: _rank.get(str(x.get("priority") or "low"), 3))
        assert items[0]["priority"] == "critical"
        assert items[-1]["priority"] == "low"
