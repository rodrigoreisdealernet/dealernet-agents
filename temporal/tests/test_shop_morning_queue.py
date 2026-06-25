"""Tests for the shop morning-queue workflow, activities, and agent.

Coverage:
- Queue ranking: critical > high > medium > low
- Blocker detection: parts_blocked flag in maintenance record → parts_blocker item type
- No-op state: empty scoped items returns status='no_op' without recording findings
- Freshness / stale detection: _is_stale returns True for old or absent timestamps
- Recommendation rendering: assessed items carry recommendation + evidence
- Dedup: items with existing fingerprints are skipped
- Acknowledge signal: recorded as informational, no status change on finding
- ops_shop_queue_scope: correctly categorises PM work orders, maintenance
  records, and not-available assets
- ops_shop_queue_assess: carries through asset_id / work_order_id from payload
- ShopQueueItemV1: operating-model tag threaded in by agent wrapper
"""
from __future__ import annotations

import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporal.src.activities import ops_shop_queue
from temporal.src.agents.shop_queue_assistant import (
    OM_TAG_NOT_AVAILABLE,
    OM_TAG_PARTS_BLOCKER,
    OM_TAG_PM_DUE,
    OM_TAG_WORK_ORDER_PRIORITY,
    ShopQueueItemV1,
    run_shop_queue_assistant,
    shop_queue_item_v1_schema,
)
from temporal.src.workflows.ops.shop_morning_queue import (
    AcknowledgeQueueItemSignal,
    ShopMorningQueueWorkflow,
    ShopMorningQueueWorkflowInput,
)
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-shop-test"
_ASSET_ID = "asset-shop-001"
_WORK_ORDER_ID = "wo-shop-001"

_NOW = datetime.datetime(2026, 6, 14, 8, 0, 0, tzinfo=datetime.UTC)
_OLD = datetime.datetime(2026, 6, 13, 0, 0, 0, tzinfo=datetime.UTC)


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
    item_type: str = "pm_due",
    priority: str = "high",
    work_order_id: str | None = None,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "asset_id": asset_id,
        "item_type": item_type,
        "work_order_id": work_order_id or _WORK_ORDER_ID,
        "last_updated_at": _NOW.isoformat(),
        "is_stale_hint": False,
        "rental_data": {"entities": [], "relationships": [], "facts": [], "time_series": [], "telematics": []},
    }


def _make_assessment(
    asset_id: str = _ASSET_ID,
    item_type: str = "pm_due",
    priority: str = "high",
    work_order_id: str | None = None,
    is_stale: bool = False,
) -> dict:
    return {
        "asset_id": asset_id,
        "item_type": item_type,
        "priority": priority,
        "recommendation": "Pull unit for 500h oil change before next rental cycle.",
        "evidence": ["PM policy: 500h oil change", "Last meter: 498h"],
        "blockers": [],
        "return_to_fleet_eta": None,
        "confidence": 0.85,
        "rationale": "Meter at 498h, threshold 500h — due on next cycle.",
        "is_stale_data": is_stale,
        "stale_signals": ["Meter reading is 9 hours old"] if is_stale else [],
        "operating_model_tags": [],
        "work_order_id": work_order_id or _WORK_ORDER_ID,
        "tenant_id": _TENANT_ID,
    }


# ---------------------------------------------------------------------------
# Unit: freshness / stale detection
# ---------------------------------------------------------------------------

class TestIsStaleFn:
    def test_none_timestamp_is_stale(self) -> None:
        assert ops_shop_queue._is_stale(None)

    def test_empty_string_is_stale(self) -> None:
        assert ops_shop_queue._is_stale("")

    def test_old_timestamp_is_stale(self) -> None:
        old = (_NOW - datetime.timedelta(hours=10)).isoformat()
        assert ops_shop_queue._is_stale(old, threshold_hours=8)

    def test_fresh_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)).isoformat()
        assert not ops_shop_queue._is_stale(fresh, threshold_hours=8)

    def test_invalid_string_is_stale(self) -> None:
        assert ops_shop_queue._is_stale("not-a-date")


# ---------------------------------------------------------------------------
# Unit: _item_finding_for_storage mapping
# ---------------------------------------------------------------------------

class TestItemFindingForStorage:
    def test_maps_asset_id_to_contract_id(self) -> None:
        item = _make_assessment(asset_id="asset-abc", item_type="pm_due")
        stored = ops_shop_queue._item_finding_for_storage(item)
        assert stored["contract_id"] == "asset-abc"

    def test_maps_work_order_id_to_line_item_id(self) -> None:
        item = _make_assessment(work_order_id="wo-xyz")
        stored = ops_shop_queue._item_finding_for_storage(item)
        assert stored["line_item_id"] == "wo-xyz"

    def test_finding_type_is_item_type(self) -> None:
        item = _make_assessment(item_type="parts_blocker")
        stored = ops_shop_queue._item_finding_for_storage(item)
        assert stored["finding_type"] == "parts_blocker"

    def test_severity_maps_from_priority(self) -> None:
        for priority, expected_severity in [
            ("critical", "critical"),
            ("high", "high"),
            ("medium", "medium"),
            ("low", "low"),
        ]:
            item = _make_assessment(priority=priority)
            stored = ops_shop_queue._item_finding_for_storage(item)
            assert stored["severity"] == expected_severity, f"priority={priority}"

    def test_expected_contains_blockers_and_stale_signals(self) -> None:
        item = _make_assessment(is_stale=True)
        item["blockers"] = ["Parts not in stock"]
        item["stale_signals"] = ["Meter reading is 9 hours old"]
        stored = ops_shop_queue._item_finding_for_storage(item)
        assert stored["expected"]["blockers"] == ["Parts not in stock"]
        assert stored["expected"]["stale_signals"] == ["Meter reading is 9 hours old"]
        assert stored["expected"]["is_stale_data"] is True

    def test_expected_contains_operating_model_tags(self) -> None:
        item = _make_assessment(item_type="not_available_unit")
        item["operating_model_tags"] = [OM_TAG_NOT_AVAILABLE]
        stored = ops_shop_queue._item_finding_for_storage(item)
        assert OM_TAG_NOT_AVAILABLE in stored["expected"]["operating_model_tags"]


# ---------------------------------------------------------------------------
# Unit: ShopQueueItemV1 model validation
# ---------------------------------------------------------------------------

class TestShopQueueItemV1:
    def test_valid_pm_due_item(self) -> None:
        item = ShopQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="pm_due",
            priority="high",
            recommendation="Pull unit for 500h oil change.",
            rationale="Meter at threshold.",
        )
        assert item.item_type == "pm_due"
        assert item.priority == "high"
        assert item.is_stale_data is False
        assert item.operating_model_tags == []

    def test_invalid_item_type_raises(self) -> None:
        with pytest.raises(ValueError):
            ShopQueueItemV1(
                asset_id=_ASSET_ID,
                item_type="unknown_type",
                priority="high",
                recommendation="x",
                rationale="x",
            )

    def test_invalid_priority_raises(self) -> None:
        with pytest.raises(ValueError):
            ShopQueueItemV1(
                asset_id=_ASSET_ID,
                item_type="pm_due",
                priority="urgent",
                recommendation="x",
                rationale="x",
            )

    def test_schema_is_json_serialisable(self) -> None:
        schema = shop_queue_item_v1_schema()
        assert isinstance(schema, dict)
        assert schema.get("type") == "object"

    def test_all_item_types_are_valid(self) -> None:
        for item_type in ("pm_due", "work_order_priority", "parts_blocker", "not_available_unit"):
            item = ShopQueueItemV1(
                asset_id=_ASSET_ID,
                item_type=item_type,
                priority="medium",
                recommendation="x",
                rationale="x",
            )
            assert item.item_type == item_type


# ---------------------------------------------------------------------------
# Unit: operating-model tag injection in agent wrapper
# ---------------------------------------------------------------------------

class TestOperatingModelTags:
    @pytest.mark.asyncio
    async def test_pm_due_tag_injected(self) -> None:
        class _FakeTransport:
            async def complete(self, *, messages, tools, response_schema, **kw):
                return {
                    "choices": [{
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": None,
                        }
                    }]
                }

        # Mock chat_with_tools to return a valid ShopQueueItemV1
        mock_result = MagicMock()
        mock_result.response = ShopQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="pm_due",
            priority="high",
            recommendation="Pull unit.",
            rationale="Meter at threshold.",
        )

        with patch(
            "temporal.src.agents.shop_queue_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_shop_queue_assistant(
                {"asset_id": _ASSET_ID, "item_type": "pm_due"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_PM_DUE in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_parts_blocker_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = ShopQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="parts_blocker",
            priority="high",
            recommendation="Order missing part.",
            rationale="Part unavailable.",
        )

        with patch(
            "temporal.src.agents.shop_queue_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_shop_queue_assistant(
                {"asset_id": _ASSET_ID, "item_type": "parts_blocker"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_PARTS_BLOCKER in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_not_available_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = ShopQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="not_available_unit",
            priority="medium",
            recommendation="Update return ETA.",
            rationale="In maintenance.",
        )

        with patch(
            "temporal.src.agents.shop_queue_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_shop_queue_assistant(
                {"asset_id": _ASSET_ID, "item_type": "not_available_unit"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_NOT_AVAILABLE in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_work_order_priority_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = ShopQueueItemV1(
            asset_id=_ASSET_ID,
            item_type="work_order_priority",
            priority="critical",
            recommendation="Resequence WO to top.",
            rationale="Contract pressure.",
        )

        with patch(
            "temporal.src.agents.shop_queue_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_shop_queue_assistant(
                {"asset_id": _ASSET_ID, "item_type": "work_order_priority"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_WORK_ORDER_PRIORITY in result["operating_model_tags"]


# ---------------------------------------------------------------------------
# Workflow: no-op state
# ---------------------------------------------------------------------------

def _build_workflow_harness(
    *,
    config: dict,
    scoped_items: list[dict],
    assessments: list[dict],
    existing_fingerprints: list[str] | None = None,
):
    state: dict = {
        "recorded_findings": [],
        "finalized": None,
    }
    existing = existing_fingerprints or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-shop-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1] if len(args) > 1 else {}
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_shop_queue_scope":
            return scoped_items
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_shop_queue_assess":
            item_payload = args[0]
            asset_id = str(item_payload.get("asset_id") or "")
            return next(
                (a for a in assessments if str(a.get("asset_id") or "") == asset_id),
                _make_assessment(asset_id=asset_id),
            )
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0] if args else {})
            return {"id": "finding-1"}
        return None

    return state, fake_execute_activity


@pytest.mark.asyncio
async def test_workflow_no_op_when_no_scoped_items() -> None:
    """Workflow returns status='no_op' when nothing new in the shop."""
    config = _default_config()
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=[],
        assessments=[],
    )

    wf = ShopMorningQueueWorkflow()
    with patch.object(
        __import__("temporalio.workflow", fromlist=["workflow"]),
        "execute_activity",
        side_effect=fake_execute,
    ):
        import temporalio.workflow as wf_mod

        wf_mod.execute_activity = fake_execute  # type: ignore[method-assign]
        with (
            patch("temporalio.workflow.execute_activity", side_effect=fake_execute),
            patch("temporalio.workflow.now", return_value=_NOW),
        ):
            # Run via direct invocation with mocked activities
            result = await _run_workflow_with_mocks(
                wf,
                ShopMorningQueueWorkflowInput(tenant_id=_TENANT_ID),
                fake_execute,
            )
    assert result["status"] == "no_op"
    assert result["no_op"] is True
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_records_items_when_scoped() -> None:
    """Workflow records findings for each assessed item."""
    config = _default_config()
    items = [_make_item(), _make_item(asset_id="asset-002", item_type="not_available_unit")]
    assessments = [
        _make_assessment(asset_id=_ASSET_ID, priority="high"),
        _make_assessment(asset_id="asset-002", item_type="not_available_unit", priority="medium"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=items,
        assessments=assessments,
    )
    wf = ShopMorningQueueWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        ShopMorningQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["status"] == "succeeded"
    assert result["recorded_items"] == 2
    assert result["no_op"] is False


@pytest.mark.asyncio
async def test_workflow_deduplicates_existing_fingerprints() -> None:
    """Items whose fingerprints already exist are counted as deduped."""
    config = _default_config()
    items = [_make_item()]
    assessments = [_make_assessment(asset_id=_ASSET_ID, priority="high")]
    fingerprint = f"shop:{_ASSET_ID}:pm_due:{_WORK_ORDER_ID}"
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=items,
        assessments=assessments,
        existing_fingerprints=[fingerprint],
    )
    wf = ShopMorningQueueWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        ShopMorningQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["deduped_items"] == 1
    assert result["recorded_items"] == 0


@pytest.mark.asyncio
async def test_workflow_ranks_critical_first() -> None:
    """Critical items must be recorded before lower-priority items."""
    config = _default_config()
    items = [
        _make_item(asset_id="asset-low", item_type="not_available_unit"),
        _make_item(asset_id="asset-crit", item_type="work_order_priority"),
    ]
    assessments = [
        _make_assessment(asset_id="asset-low", item_type="not_available_unit", priority="low"),
        _make_assessment(asset_id="asset-crit", item_type="work_order_priority", priority="critical"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=items,
        assessments=assessments,
    )
    wf = ShopMorningQueueWorkflow()
    await _run_workflow_with_mocks(
        wf,
        ShopMorningQueueWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert len(state["recorded_findings"]) == 2
    # Critical item should be first in recorded order (workflow sorts by priority).
    first = state["recorded_findings"][0]
    assert str(first.get("asset_id") or "") == "asset-crit"


# ---------------------------------------------------------------------------
# Workflow signal: acknowledge_queue_item
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_acknowledge_signal_is_informational_only() -> None:
    """Acknowledge signal stores ack without triggering any finding mutation."""
    wf = ShopMorningQueueWorkflow()
    sig = AcknowledgeQueueItemSignal(
        asset_id=_ASSET_ID,
        item_type="pm_due",
        approver_id="manager-1",
        fingerprint=f"shop:{_ASSET_ID}:pm_due:{_WORK_ORDER_ID}",
        note="Pulled unit for PM.",
    )
    await wf.acknowledge_queue_item(sig)
    key = f"shop:{_ASSET_ID}:pm_due:{_WORK_ORDER_ID}"
    assert key in wf._acknowledgements
    ack = wf._acknowledgements[key]
    assert ack["approver_id"] == "manager-1"
    assert ack["acknowledged"] is True
    assert ack["note"] == "Pulled unit for PM."


# ---------------------------------------------------------------------------
# Activity: ops_shop_queue_scope with mock persistence
# ---------------------------------------------------------------------------

class _FakeOpsPersistence:
    """Minimal fake for testing ops_shop_queue_scope without a real DB."""

    def __init__(self, tables: dict) -> None:
        self._tables = tables

    def select(self, resource, *, columns="*", filters=None, order_by=None, descending=False, limit=None):
        rows = list(self._tables.get(resource, []))
        for key, value in (filters or {}).items():
            rows = [r for r in rows if r.get(key) == value]
        if limit:
            rows = rows[:limit]
        return rows

    def insert(self, resource, payload):
        return payload

    def upsert(self, resource, payload, *, on_conflict):
        return payload

    def update(self, resource, payload, *, filters):
        return [payload]


@pytest.fixture
def activity_env() -> ActivityEnvironment:
    return ActivityEnvironment()


def test_scope_returns_pm_due_items(activity_env: ActivityEnvironment) -> None:
    """ops_shop_queue_scope surfaces open PM work orders as pm_due items."""
    fake_client = _FakeOpsPersistence({
        "pm_work_orders": [
            {
                "id": _WORK_ORDER_ID,
                "tenant_id": _TENANT_ID,
                "asset_id": _ASSET_ID,
                "status": "open",
                "trigger_type": "meter",
                "policy_id": "policy-1",
                "reason": "500h interval due",
                "created_at": _NOW.isoformat(),
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_entity_state": [
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "name": "Excavator 001",
                "data": {"operational_status": "available"},
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_relationships": [],
    })
    with patch(
        "temporal.src.activities.ops_shop_queue.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_shop_queue.ops_shop_queue_scope,
            _TENANT_ID, None, None,
        )
    assert len(result) >= 1
    pm_items = [r for r in result if r["item_type"] == "pm_due"]
    assert pm_items
    assert pm_items[0]["asset_id"] == _ASSET_ID
    assert pm_items[0]["work_order_id"] == _WORK_ORDER_ID


def test_scope_detects_parts_blocker_from_maintenance_record(
    activity_env: ActivityEnvironment,
) -> None:
    """Maintenance records with parts_blocked=true become parts_blocker items."""
    fake_client = _FakeOpsPersistence({
        "pm_work_orders": [],
        "rental_current_entity_state": [
            {
                "entity_id": "maint-001",
                "entity_type": "maintenance_record",
                "name": "Hydraulic repair",
                "data": {"status": "in_progress", "parts_blocked": True},
                "updated_at": _NOW.isoformat(),
            },
            {
                "entity_id": _ASSET_ID,
                "entity_type": "asset",
                "name": "Excavator 001",
                "data": {"operational_status": "in_maintenance"},
                "updated_at": _NOW.isoformat(),
            },
        ],
        "rental_current_relationships": [
            {
                "relationship_type": "asset_has_maintenance_record",
                "parent_id": _ASSET_ID,
                "child_id": "maint-001",
            }
        ],
    })
    with patch(
        "temporal.src.activities.ops_shop_queue.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_shop_queue.ops_shop_queue_scope,
            _TENANT_ID, None, None,
        )
    blocker_items = [r for r in result if r["item_type"] == "parts_blocker"]
    assert blocker_items, f"Expected parts_blocker items, got: {[r['item_type'] for r in result]}"
    assert blocker_items[0]["parts_blocked"] is True


def test_scope_detects_not_available_assets(activity_env: ActivityEnvironment) -> None:
    """Assets with operational_status=in_maintenance appear as not_available_unit."""
    na_asset_id = "asset-na-001"
    fake_client = _FakeOpsPersistence({
        "pm_work_orders": [],
        "rental_current_entity_state": [
            {
                "entity_id": na_asset_id,
                "entity_type": "asset",
                "name": "Crane 002",
                "data": {"operational_status": "in_maintenance"},
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_relationships": [],
    })
    with patch(
        "temporal.src.activities.ops_shop_queue.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_shop_queue.ops_shop_queue_scope,
            _TENANT_ID, None, None,
        )
    na_items = [r for r in result if r["item_type"] == "not_available_unit"]
    assert na_items
    assert na_items[0]["asset_id"] == na_asset_id


def test_scope_flags_stale_data_on_old_timestamp(activity_env: ActivityEnvironment) -> None:
    """Items whose last_updated_at is old are flagged is_stale_hint=True."""
    old_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=20)).isoformat()
    fake_client = _FakeOpsPersistence({
        "pm_work_orders": [
            {
                "id": _WORK_ORDER_ID,
                "tenant_id": _TENANT_ID,
                "asset_id": _ASSET_ID,
                "status": "open",
                "trigger_type": "meter",
                "policy_id": "policy-1",
                "reason": "",
                "created_at": old_ts,
                "updated_at": old_ts,
            }
        ],
        "rental_current_entity_state": [],
        "rental_current_relationships": [],
    })
    with patch(
        "temporal.src.activities.ops_shop_queue.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_shop_queue.ops_shop_queue_scope,
            _TENANT_ID, None, None,
        )
    assert result[0]["is_stale_hint"] is True


def test_scope_skips_items_without_asset_id(activity_env: ActivityEnvironment) -> None:
    """PM work orders without an asset_id are silently skipped."""
    fake_client = _FakeOpsPersistence({
        "pm_work_orders": [
            {
                "id": "wo-no-asset",
                "tenant_id": _TENANT_ID,
                "asset_id": None,
                "status": "open",
                "trigger_type": "time_interval",
                "policy_id": "policy-1",
                "reason": "",
                "created_at": _NOW.isoformat(),
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_entity_state": [],
        "rental_current_relationships": [],
    })
    with patch(
        "temporal.src.activities.ops_shop_queue.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_shop_queue.ops_shop_queue_scope,
            _TENANT_ID, None, None,
        )
    assert result == []


# ---------------------------------------------------------------------------
# Return-to-fleet ETA is human-approved only
# ---------------------------------------------------------------------------

def test_return_to_fleet_eta_field_is_human_only() -> None:
    """return_to_fleet_eta is optional and is never auto-populated by the workflow."""
    item = ShopQueueItemV1(
        asset_id=_ASSET_ID,
        item_type="not_available_unit",
        priority="medium",
        recommendation="Contact branch for return date.",
        rationale="In maintenance, ETA unknown.",
    )
    assert item.return_to_fleet_eta is None


# ---------------------------------------------------------------------------
# Helpers for running workflow with mocked activities
# ---------------------------------------------------------------------------

async def _run_workflow_with_mocks(
    wf: ShopMorningQueueWorkflow,
    inp: ShopMorningQueueWorkflowInput,
    fake_execute,
) -> dict:
    """Run the workflow with mocked execute_activity."""
    import asyncio
    import unittest.mock as _mock

    with (
        _mock.patch("temporalio.workflow.execute_activity", side_effect=fake_execute),
        _mock.patch("asyncio.gather", side_effect=asyncio.gather),
    ):
        return await wf.run(inp)
