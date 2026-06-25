"""Tests for the branch morning-brief workflow, activities, and agent.

Coverage:
- Brief ranking: critical > high > medium > low
- Item-type detection: contract_exception, ap_hold, maintenance_blocker,
  unavailable_unit, dispatch_exception, customer_followup, utilization_outlier
- No-op state: empty scoped items returns status='no_op' without recording findings
- Freshness / stale detection: _is_stale returns True for old or absent timestamps
- Recommendation rendering: assessed items carry recommendation + evidence + owner_team
- Dedup: items with existing fingerprints are skipped
- Acknowledge signal: recorded as informational, no status change on finding
- ops_branch_brief_scope: correctly categorises contract/AP, maintenance, and
  not-available assets
- BranchBriefItemV1: operating-model tag threaded in by agent wrapper
- _item_finding_for_storage: correct mapping onto generic finding schema
"""
from __future__ import annotations

import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporal.src.activities import ops_branch_brief
from temporal.src.agents.branch_brief_assistant import (
    OM_TAG_AP_HOLD,
    OM_TAG_CONTRACT_EXCEPTION,
    OM_TAG_CUSTOMER_FOLLOWUP,
    OM_TAG_DISPATCH_EXCEPTION,
    OM_TAG_MAINTENANCE_BLOCKER,
    OM_TAG_UNAVAILABLE_UNIT,
    BranchBriefItemV1,
    branch_brief_item_v1_schema,
    run_branch_brief_assistant,
)
from temporal.src.workflows.ops.branch_morning_brief import (
    AcknowledgeBriefItemSignal,
    BranchMorningBriefWorkflow,
    BranchMorningBriefWorkflowInput,
)
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-branch-test"
_CONTRACT_ID = "contract-branch-001"
_ASSET_ID = "asset-branch-001"
_CUSTOMER_ID = "customer-branch-001"

_NOW = datetime.datetime(2026, 6, 15, 7, 0, 0, tzinfo=datetime.UTC)
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
    item_id: str = _CONTRACT_ID,
    item_type: str = "contract_exception",
    priority: str = "high",
    source_record_id: str | None = None,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "item_id": item_id,
        "item_type": item_type,
        "source_record_id": source_record_id or item_id,
        "secondary_record_id": None,
        "last_updated_at": _NOW.isoformat(),
        "is_stale_hint": False,
        "rental_data": {
            "entities": [],
            "relationships": [],
            "facts": [],
            "time_series": [],
            "telematics": [],
        },
    }


def _make_assessment(
    item_id: str = _CONTRACT_ID,
    item_type: str = "contract_exception",
    priority: str = "high",
    source_record_id: str | None = None,
    is_stale: bool = False,
) -> dict:
    return {
        "item_id": item_id,
        "item_type": item_type,
        "priority": priority,
        "recommendation": "Review contract and contact counter team.",
        "owner_team": "counter",
        "evidence": ["Contract status: on_hold since 2026-06-14", "AR balance: $4,200 overdue"],
        "blockers": [],
        "confidence": 0.82,
        "rationale": "Contract on hold with outstanding AR — branch manager action required.",
        "is_stale_data": is_stale,
        "stale_signals": ["Contract data is 10 hours old"] if is_stale else [],
        "operating_model_tags": [],
        "source_record_id": source_record_id or item_id,
        "secondary_record_id": None,
        "tenant_id": _TENANT_ID,
    }


# ---------------------------------------------------------------------------
# Unit: freshness / stale detection
# ---------------------------------------------------------------------------

class TestIsStaleFn:
    def test_none_timestamp_is_stale(self) -> None:
        assert ops_branch_brief._is_stale(None)

    def test_empty_string_is_stale(self) -> None:
        assert ops_branch_brief._is_stale("")

    def test_old_timestamp_is_stale(self) -> None:
        old = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=10)).isoformat()
        assert ops_branch_brief._is_stale(old, threshold_hours=8)

    def test_fresh_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)).isoformat()
        assert not ops_branch_brief._is_stale(fresh, threshold_hours=8)

    def test_invalid_string_is_stale(self) -> None:
        assert ops_branch_brief._is_stale("not-a-date")


# ---------------------------------------------------------------------------
# Unit: _item_finding_for_storage mapping
# ---------------------------------------------------------------------------

class TestItemFindingForStorage:
    def test_maps_source_record_id_to_contract_id(self) -> None:
        item = _make_assessment(item_id=_CONTRACT_ID, source_record_id=_CONTRACT_ID)
        stored = ops_branch_brief._item_finding_for_storage(item)
        assert stored["contract_id"] == _CONTRACT_ID

    def test_maps_secondary_record_id_to_line_item_id(self) -> None:
        item = _make_assessment(item_id=_CONTRACT_ID)
        item["secondary_record_id"] = "ba-001"
        stored = ops_branch_brief._item_finding_for_storage(item)
        assert stored["line_item_id"] == "ba-001"

    def test_finding_type_is_item_type(self) -> None:
        item = _make_assessment(item_type="ap_hold")
        stored = ops_branch_brief._item_finding_for_storage(item)
        assert stored["finding_type"] == "ap_hold"

    def test_severity_maps_from_priority(self) -> None:
        for priority, expected_severity in [
            ("critical", "critical"),
            ("high", "high"),
            ("medium", "medium"),
            ("low", "low"),
        ]:
            item = _make_assessment(priority=priority)
            stored = ops_branch_brief._item_finding_for_storage(item)
            assert stored["severity"] == expected_severity, f"priority={priority}"

    def test_expected_contains_owner_team(self) -> None:
        item = _make_assessment()
        item["owner_team"] = "yard"
        stored = ops_branch_brief._item_finding_for_storage(item)
        assert stored["expected"]["owner_team"] == "yard"

    def test_expected_contains_stale_signals(self) -> None:
        item = _make_assessment(is_stale=True)
        item["stale_signals"] = ["Contract data is 10 hours old"]
        stored = ops_branch_brief._item_finding_for_storage(item)
        assert stored["expected"]["stale_signals"] == ["Contract data is 10 hours old"]
        assert stored["expected"]["is_stale_data"] is True

    def test_expected_contains_operating_model_tags(self) -> None:
        item = _make_assessment(item_type="maintenance_blocker")
        item["operating_model_tags"] = [OM_TAG_MAINTENANCE_BLOCKER]
        stored = ops_branch_brief._item_finding_for_storage(item)
        assert OM_TAG_MAINTENANCE_BLOCKER in stored["expected"]["operating_model_tags"]


# ---------------------------------------------------------------------------
# Unit: BranchBriefItemV1 model validation
# ---------------------------------------------------------------------------

class TestBranchBriefItemV1:
    def test_valid_contract_exception_item(self) -> None:
        item = BranchBriefItemV1(
            item_id=_CONTRACT_ID,
            item_type="contract_exception",
            priority="high",
            recommendation="Review contract.",
            owner_team="counter",
            rationale="Contract on hold.",
        )
        assert item.item_type == "contract_exception"
        assert item.priority == "high"
        assert item.is_stale_data is False
        assert item.operating_model_tags == []

    def test_invalid_item_type_raises(self) -> None:
        with pytest.raises(ValueError):
            BranchBriefItemV1(
                item_id=_CONTRACT_ID,
                item_type="unknown_type",
                priority="high",
                recommendation="x",
                owner_team="counter",
                rationale="x",
            )

    def test_invalid_priority_raises(self) -> None:
        with pytest.raises(ValueError):
            BranchBriefItemV1(
                item_id=_CONTRACT_ID,
                item_type="contract_exception",
                priority="urgent",
                recommendation="x",
                owner_team="counter",
                rationale="x",
            )

    def test_schema_is_json_serialisable(self) -> None:
        schema = branch_brief_item_v1_schema()
        assert isinstance(schema, dict)
        assert schema.get("type") == "object"

    def test_all_item_types_are_valid(self) -> None:
        valid_types = (
            "contract_exception",
            "ap_hold",
            "utilization_outlier",
            "dispatch_exception",
            "maintenance_blocker",
            "unavailable_unit",
            "customer_followup",
        )
        for item_type in valid_types:
            item = BranchBriefItemV1(
                item_id=_CONTRACT_ID,
                item_type=item_type,
                priority="medium",
                recommendation="x",
                owner_team="counter",
                rationale="x",
            )
            assert item.item_type == item_type


# ---------------------------------------------------------------------------
# Unit: operating-model tag injection in agent wrapper
# ---------------------------------------------------------------------------

class TestOperatingModelTags:
    @pytest.mark.asyncio
    async def test_contract_exception_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = BranchBriefItemV1(
            item_id=_CONTRACT_ID,
            item_type="contract_exception",
            priority="high",
            recommendation="Review contract.",
            owner_team="counter",
            rationale="On hold.",
        )

        with patch(
            "temporal.src.agents.branch_brief_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_branch_brief_assistant(
                {"item_id": _CONTRACT_ID, "item_type": "contract_exception"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_CONTRACT_EXCEPTION in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_ap_hold_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = BranchBriefItemV1(
            item_id=_CONTRACT_ID,
            item_type="ap_hold",
            priority="critical",
            recommendation="Contact AP team.",
            owner_team="counter",
            rationale="AP hold active.",
        )

        with patch(
            "temporal.src.agents.branch_brief_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_branch_brief_assistant(
                {"item_id": _CONTRACT_ID, "item_type": "ap_hold"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_AP_HOLD in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_maintenance_blocker_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = BranchBriefItemV1(
            item_id=_ASSET_ID,
            item_type="maintenance_blocker",
            priority="high",
            recommendation="Escalate to shop foreman.",
            owner_team="shop",
            rationale="Active contract threatened.",
        )

        with patch(
            "temporal.src.agents.branch_brief_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_branch_brief_assistant(
                {"item_id": _ASSET_ID, "item_type": "maintenance_blocker"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_MAINTENANCE_BLOCKER in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_dispatch_exception_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = BranchBriefItemV1(
            item_id="dispatch-001",
            item_type="dispatch_exception",
            priority="critical",
            recommendation="Reassign driver immediately.",
            owner_team="yard",
            rationale="Delivery at risk.",
        )

        with patch(
            "temporal.src.agents.branch_brief_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_branch_brief_assistant(
                {"item_id": "dispatch-001", "item_type": "dispatch_exception"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_DISPATCH_EXCEPTION in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_customer_followup_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = BranchBriefItemV1(
            item_id=_CUSTOMER_ID,
            item_type="customer_followup",
            priority="medium",
            recommendation="Call customer re: AR balance.",
            owner_team="counter",
            rationale="AR overdue 30 days.",
        )

        with patch(
            "temporal.src.agents.branch_brief_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_branch_brief_assistant(
                {"item_id": _CUSTOMER_ID, "item_type": "customer_followup"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_CUSTOMER_FOLLOWUP in result["operating_model_tags"]

    @pytest.mark.asyncio
    async def test_unavailable_unit_tag_injected(self) -> None:
        mock_result = MagicMock()
        mock_result.response = BranchBriefItemV1(
            item_id=_ASSET_ID,
            item_type="unavailable_unit",
            priority="high",
            recommendation="Confirm return-to-fleet timeline with shop.",
            owner_team="shop",
            rationale="In maintenance, active contract at risk.",
        )

        with patch(
            "temporal.src.agents.branch_brief_assistant.chat_with_tools",
            new=AsyncMock(return_value=mock_result),
        ):
            result = await run_branch_brief_assistant(
                {"item_id": _ASSET_ID, "item_type": "unavailable_unit"},
                system_prompt="x",
                user_prompt_template="x",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_UNAVAILABLE_UNIT in result["operating_model_tags"]


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
            return {"run_id": "run-branch-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1] if len(args) > 1 else {}
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_branch_brief_scope":
            return scoped_items
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_branch_brief_assess":
            item_payload = args[0]
            item_id = str(item_payload.get("item_id") or "")
            return next(
                (a for a in assessments if str(a.get("item_id") or "") == item_id),
                _make_assessment(item_id=item_id),
            )
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0] if args else {})
            return {"id": "finding-1"}
        return None

    return state, fake_execute_activity


@pytest.mark.asyncio
async def test_workflow_no_op_when_no_scoped_items() -> None:
    """Workflow returns status='no_op' when nothing new at the branch."""
    config = _default_config()
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=[],
        assessments=[],
    )

    wf = BranchMorningBriefWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        BranchMorningBriefWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["status"] == "no_op"
    assert result["no_op"] is True
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_records_items_when_scoped() -> None:
    """Workflow records findings for each assessed item."""
    config = _default_config()
    items = [
        _make_item(),
        _make_item(item_id=_ASSET_ID, item_type="unavailable_unit"),
    ]
    assessments = [
        _make_assessment(item_id=_CONTRACT_ID, priority="high"),
        _make_assessment(item_id=_ASSET_ID, item_type="unavailable_unit", priority="medium"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=items,
        assessments=assessments,
    )
    wf = BranchMorningBriefWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        BranchMorningBriefWorkflowInput(tenant_id=_TENANT_ID),
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
    assessments = [_make_assessment(item_id=_CONTRACT_ID, priority="high")]
    fingerprint = f"branch:contract_exception:{_CONTRACT_ID}"
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=items,
        assessments=assessments,
        existing_fingerprints=[fingerprint],
    )
    wf = BranchMorningBriefWorkflow()
    result = await _run_workflow_with_mocks(
        wf,
        BranchMorningBriefWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert result["deduped_items"] == 1
    assert result["recorded_items"] == 0


@pytest.mark.asyncio
async def test_workflow_ranks_critical_first() -> None:
    """Critical items must be recorded before lower-priority items."""
    config = _default_config()
    items = [
        _make_item(item_id="item-low", item_type="utilization_outlier"),
        _make_item(item_id="item-crit", item_type="dispatch_exception"),
    ]
    assessments = [
        _make_assessment(item_id="item-low", item_type="utilization_outlier", priority="low"),
        _make_assessment(item_id="item-crit", item_type="dispatch_exception", priority="critical"),
    ]
    state, fake_execute = _build_workflow_harness(
        config=config,
        scoped_items=items,
        assessments=assessments,
    )
    wf = BranchMorningBriefWorkflow()
    await _run_workflow_with_mocks(
        wf,
        BranchMorningBriefWorkflowInput(tenant_id=_TENANT_ID),
        fake_execute,
    )
    assert len(state["recorded_findings"]) == 2
    # Critical item should be first in recorded order.
    first = state["recorded_findings"][0]
    assert str(first.get("item_id") or "") == "item-crit"


# ---------------------------------------------------------------------------
# Workflow signal: acknowledge_brief_item
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_acknowledge_signal_is_informational_only() -> None:
    """Acknowledge signal stores ack without triggering any finding mutation."""
    wf = BranchMorningBriefWorkflow()
    sig = AcknowledgeBriefItemSignal(
        item_id=_CONTRACT_ID,
        item_type="contract_exception",
        approver_id="manager-1",
        fingerprint=f"branch:contract_exception:{_CONTRACT_ID}",
        note="Contacted counter team — resolving.",
    )
    await wf.acknowledge_brief_item(sig)
    key = f"branch:contract_exception:{_CONTRACT_ID}"
    assert key in wf._acknowledgements
    ack = wf._acknowledgements[key]
    assert ack["approver_id"] == "manager-1"
    assert ack["acknowledged"] is True
    assert ack["note"] == "Contacted counter team — resolving."


# ---------------------------------------------------------------------------
# Activity: ops_branch_brief_scope with mock persistence
# ---------------------------------------------------------------------------

class _FakeOpsPersistence:
    """Minimal fake for testing ops_branch_brief_scope without a real DB."""

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


def test_scope_returns_contract_exception_items(activity_env: ActivityEnvironment) -> None:
    """ops_branch_brief_scope surfaces active contracts with on_hold as contract_exception."""
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": _CONTRACT_ID,
                "entity_type": "rental_contract",
                "name": "Contract ABC",
                "data": {
                    "status": "on_hold",
                    "billing_account_id": "ba-001",
                    "ap_hold": False,
                },
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    contract_items = [r for r in result if r["item_type"] in ("contract_exception", "ap_hold")]
    assert contract_items
    assert contract_items[0]["item_id"] == _CONTRACT_ID


def test_scope_returns_ap_hold_items(activity_env: ActivityEnvironment) -> None:
    """ops_branch_brief_scope surfaces contracts with ap_hold=True as ap_hold items."""
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": _CONTRACT_ID,
                "entity_type": "rental_contract",
                "name": "Contract XYZ",
                "data": {
                    "status": "active",
                    "billing_account_id": "ba-002",
                    "ap_hold": True,
                },
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    ap_items = [r for r in result if r["item_type"] == "ap_hold"]
    assert ap_items, f"Expected ap_hold items, got: {[r['item_type'] for r in result]}"
    assert ap_items[0]["ap_hold"] is True


def test_scope_detects_maintenance_blocker_on_active_contract(
    activity_env: ActivityEnvironment,
) -> None:
    """Maintenance records blocking an active contract appear as maintenance_blocker."""
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": "maint-001",
                "entity_type": "maintenance_record",
                "name": "Hydraulic repair",
                "data": {"status": "in_progress", "parts_blocked": False},
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
            },
            {
                "relationship_type": "contract_has_asset",
                "parent_id": _CONTRACT_ID,
                "child_id": _ASSET_ID,
            },
        ],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    maint_items = [r for r in result if r["item_type"] == "maintenance_blocker"]
    assert maint_items, f"Expected maintenance_blocker items, got: {[r['item_type'] for r in result]}"
    assert maint_items[0]["source_record_id"] == _ASSET_ID


def test_scope_detects_unavailable_assets(activity_env: ActivityEnvironment) -> None:
    """Assets with operational_status=in_maintenance appear as unavailable_unit."""
    na_asset_id = "asset-na-001"
    fake_client = _FakeOpsPersistence({
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
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    na_items = [r for r in result if r["item_type"] == "unavailable_unit"]
    assert na_items
    assert na_items[0]["item_id"] == na_asset_id


def test_scope_detects_customer_followup(activity_env: ActivityEnvironment) -> None:
    """Customers flagged with ar_overdue=True appear as customer_followup items."""
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": _CUSTOMER_ID,
                "entity_type": "customer",
                "name": "BigCorp Ltd",
                "data": {"ar_overdue": True},
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    followup_items = [r for r in result if r["item_type"] == "customer_followup"]
    assert followup_items
    assert followup_items[0]["item_id"] == _CUSTOMER_ID
    assert followup_items[0]["followup_reason"] == "ar_overdue"


def test_scope_excludes_customer_from_other_branch(activity_env: ActivityEnvironment) -> None:
    """With branch_id specified, customers not linked to that branch are excluded."""
    branch_id = "branch-001"
    other_branch_id = "branch-002"
    customer_in_branch = "customer-in-branch"
    customer_other_branch = "customer-other-branch"

    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": customer_in_branch,
                "entity_type": "customer",
                "name": "InBranch Corp",
                "data": {"ar_overdue": True},
                "updated_at": _NOW.isoformat(),
            },
            {
                "entity_id": customer_other_branch,
                "entity_type": "customer",
                "name": "OtherBranch Corp",
                "data": {"ar_overdue": True},
                "updated_at": _NOW.isoformat(),
            },
        ],
        "rental_current_relationships": [
            {
                "relationship_type": "branch_has_customer",
                "parent_id": branch_id,
                "child_id": customer_in_branch,
            },
            {
                "relationship_type": "branch_has_customer",
                "parent_id": other_branch_id,
                "child_id": customer_other_branch,
            },
        ],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, branch_id,
        )
    followup_items = [r for r in result if r["item_type"] == "customer_followup"]
    item_ids = {r["item_id"] for r in followup_items}
    assert customer_in_branch in item_ids, "Customer belonging to branch should be included"
    assert customer_other_branch not in item_ids, "Customer from another branch should be excluded"


def test_scope_customer_followup_included_when_no_branch_id(activity_env: ActivityEnvironment) -> None:
    """Without branch_id, all qualifying customers are included regardless of branch."""
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": "customer-a",
                "entity_type": "customer",
                "name": "Alpha Corp",
                "data": {"ar_overdue": True},
                "updated_at": _NOW.isoformat(),
            },
            {
                "entity_id": "customer-b",
                "entity_type": "customer",
                "name": "Beta Corp",
                "data": {"service_issue_open": True},
                "updated_at": _NOW.isoformat(),
            },
        ],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    followup_items = [r for r in result if r["item_type"] == "customer_followup"]
    item_ids = {r["item_id"] for r in followup_items}
    assert "customer-a" in item_ids
    assert "customer-b" in item_ids


# ---------------------------------------------------------------------------
# Contract: run_date removed from trigger/workflow/scope contracts
# ---------------------------------------------------------------------------

def test_trigger_request_has_no_run_date_field() -> None:
    """BranchMorningBriefTriggerRequest does not expose a run_date field."""
    from temporal.src.ops_api.app import BranchMorningBriefTriggerRequest
    field_names = set(BranchMorningBriefTriggerRequest.model_fields.keys())
    assert "run_date" not in field_names, (
        "run_date was removed from the trigger contract because the scope "
        "activity does not honour it; backdated triggers would silently return "
        "today's data under a date-specific workflow ID."
    )


def test_workflow_input_has_no_run_date_field() -> None:
    """BranchMorningBriefWorkflowInput does not include run_date."""
    import dataclasses
    field_names = {f.name for f in dataclasses.fields(BranchMorningBriefWorkflowInput)}
    assert "run_date" not in field_names


def test_scope_activity_accepts_two_args(activity_env: ActivityEnvironment) -> None:
    """ops_branch_brief_scope takes tenant_id + branch_id only (no run_date)."""
    import inspect
    sig = inspect.signature(ops_branch_brief.ops_branch_brief_scope)
    param_names = list(sig.parameters.keys())
    assert "run_date" not in param_names
    assert "tenant_id" in param_names
    assert "branch_id" in param_names

    # Verify the activity actually executes successfully with two arguments.
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    assert result == []


def test_scope_flags_stale_data_on_old_timestamp(activity_env: ActivityEnvironment) -> None:
    """Items whose last_updated_at is old are flagged is_stale_hint=True."""
    old_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=20)).isoformat()
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": _CONTRACT_ID,
                "entity_type": "rental_contract",
                "name": "Old Contract",
                "data": {"status": "active", "ap_hold": True},
                "updated_at": old_ts,
            }
        ],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    assert result
    assert result[0]["is_stale_hint"] is True


def test_scope_skips_contract_without_id(activity_env: ActivityEnvironment) -> None:
    """Contract records without entity_id are silently skipped."""
    fake_client = _FakeOpsPersistence({
        "rental_current_entity_state": [
            {
                "entity_id": None,
                "entity_type": "rental_contract",
                "name": "Bad Contract",
                "data": {"status": "active"},
                "updated_at": _NOW.isoformat(),
            }
        ],
        "rental_current_relationships": [],
        "rental_asset_availability_current": [],
    })
    with patch(
        "temporal.src.activities.ops_branch_brief.ops_revrec._get_ops_persistence_client",
        return_value=fake_client,
    ):
        result = activity_env.run(
            ops_branch_brief.ops_branch_brief_scope,
            _TENANT_ID, None,
        )
    assert result == []


# ---------------------------------------------------------------------------
# Assist-only constraints: no autonomous customer/money/status actions
# ---------------------------------------------------------------------------

def test_brief_item_has_no_auto_action_fields() -> None:
    """BranchBriefItemV1 has no field that auto-triggers customer or financial action."""
    item = BranchBriefItemV1(
        item_id=_CONTRACT_ID,
        item_type="contract_exception",
        priority="high",
        recommendation="Contact counter team.",
        owner_team="counter",
        rationale="On hold.",
    )
    item_dict = item.model_dump()
    # None of the fields should be an auto-action trigger.
    auto_action_fields = {"auto_action", "auto_outreach", "auto_status_change", "auto_rerate"}
    assert not auto_action_fields.intersection(item_dict.keys())


# ---------------------------------------------------------------------------
# Helpers for running workflow with mocked activities
# ---------------------------------------------------------------------------

async def _run_workflow_with_mocks(
    wf: BranchMorningBriefWorkflow,
    inp: BranchMorningBriefWorkflowInput,
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
