"""Tests for the territory account brief and follow-up assistant workflow, activities, and agent.

Coverage:
- Brief type classification: followup_update > pre_visit > territory_plan
- No-op state: empty scoped accounts returns status='no_op' without recording
- Freshness / stale detection: _is_stale returns True for old or absent timestamps
- Days since: _days_since returns correct day counts
- Brief finding storage mapping
- Dedup: accounts with existing fingerprints are skipped
- Confirm follow-up signal: recorded as informational, no CRM mutation
- Operating-model tags: t1 for territory_plan, t2 for pre_visit, t4 for followup_update
- TerritoryBriefItemV1: Pydantic model validation
- ops_territory_brief_scope: correctly classifies accounts by signals
- Workflow sorts by priority (critical > high > medium > low)
"""
from __future__ import annotations

import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporal.src.activities import ops_territory_brief
from temporal.src.agents.territory_brief_assistant import (
    OM_TAG_FOLLOWUP_UPDATE,
    OM_TAG_SITE_VISIT,
    OM_TAG_TERRITORY_PLAN,
    TerritoryBriefItemV1,
    run_territory_brief_assistant,
    territory_brief_item_v1_schema,
)
from temporal.src.workflows.ops.territory_brief import (
    ConfirmFollowUpSignal,
    TerritoryAccountBriefWorkflow,
    TerritoryAccountBriefWorkflowInput,
)
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-territory-brief-test"
_ACCOUNT_ID = "customer-002"
_ACCOUNT_NAME = "Riverbank Excavation LLC"

_NOW = datetime.datetime(2026, 6, 19, 8, 0, 0, tzinfo=datetime.UTC)
_RECENT_TS = (_NOW - datetime.timedelta(days=3)).isoformat()
_OLD_TS = (_NOW - datetime.timedelta(days=14)).isoformat()
_VISIT_RECENT_TS = (_NOW - datetime.timedelta(days=5)).isoformat()


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


def _make_account_payload(
    account_id: str = _ACCOUNT_ID,
    brief_type: str = "territory_plan",
    open_opportunities: int = 0,
    promised_follow_ups: list | None = None,
    days_since_visit: int | None = None,
    is_stale: bool = False,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "account_id": account_id,
        "account_name": _ACCOUNT_NAME,
        "brief_type": brief_type,
        "open_opportunities": open_opportunities,
        "promised_follow_ups": promised_follow_ups or [],
        "days_since_visit": days_since_visit,
        "recent_rentals": ["Contract c-001: 2026-05-01 — $1200"],
        "visit_history": [],
        "source_account_id": account_id,
        "source_opportunity_id": None,
        "last_updated_at": _OLD_TS if is_stale else _RECENT_TS,
        "is_stale_hint": is_stale,
        "stale_signals_hint": ["Customer entity last updated 14 days ago"] if is_stale else [],
        "rental_data": {
            "entities": [],
            "relationships": [],
            "facts": [],
            "time_series": [],
            "telematics": [],
        },
    }


def _make_brief_item(
    account_id: str = _ACCOUNT_ID,
    brief_type: str = "territory_plan",
    priority: str = "medium",
    is_stale: bool = False,
) -> dict:
    return {
        "account_id": account_id,
        "account_name": _ACCOUNT_NAME,
        "brief_type": brief_type,
        "priority": priority,
        "recommended_action": "Review open opportunity and confirm equipment availability.",
        "follow_up_draft": "Following up on excavator availability for the Ridgeline project.",
        "open_opportunities": 1,
        "recent_rentals": ["Contract c-001: 2026-05-01 — $1200"],
        "visit_history": [],
        "promised_follow_ups": [],
        "branch_risks": [],
        "cross_branch_signals": [],
        "evidence": ["Contract c-001 — 49 days ago", "Open quote q-007"],
        "freshness_warnings": ["Utilization data last updated 10 days ago"] if is_stale else [],
        "confidence": 0.80,
        "rationale": "Active account with open opportunity and recent rental history.",
        "is_stale_data": is_stale,
        "stale_signals": ["Customer entity last updated 14 days ago"] if is_stale else [],
        "source_account_id": account_id,
        "source_opportunity_id": "order-007",
        "operating_model_tags": [],
        "tenant_id": _TENANT_ID,
    }


# ---------------------------------------------------------------------------
# Fake ops persistence for scoping tests
# ---------------------------------------------------------------------------

class _FakeOpsPersistence:
    """Minimal fake for testing ops_territory_brief_scope without a real DB."""

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


# ---------------------------------------------------------------------------
# Unit: freshness / stale detection
# ---------------------------------------------------------------------------

class TestIsStaleFn:
    def test_none_timestamp_is_stale(self) -> None:
        assert ops_territory_brief._is_stale(None)

    def test_empty_string_is_stale(self) -> None:
        assert ops_territory_brief._is_stale("")

    def test_old_timestamp_is_stale(self) -> None:
        old = (_NOW - datetime.timedelta(days=14)).isoformat()
        assert ops_territory_brief._is_stale(old, threshold_days=7)

    def test_fresh_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=2)).isoformat()
        assert not ops_territory_brief._is_stale(fresh, threshold_days=7)

    def test_invalid_string_is_stale(self) -> None:
        assert ops_territory_brief._is_stale("not-a-date")


# ---------------------------------------------------------------------------
# Unit: _days_since helper
# ---------------------------------------------------------------------------

class TestDaysSince:
    def test_none_returns_none(self) -> None:
        assert ops_territory_brief._days_since(None) is None

    def test_empty_returns_none(self) -> None:
        assert ops_territory_brief._days_since("") is None

    def test_invalid_returns_none(self) -> None:
        assert ops_territory_brief._days_since("not-a-date") is None

    def test_known_date_returns_correct_days(self) -> None:
        ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=45)).isoformat()
        days = ops_territory_brief._days_since(ts)
        assert days is not None
        assert 44 <= days <= 46

    def test_recent_date_is_zero_or_positive(self) -> None:
        ts = datetime.datetime.now(datetime.UTC).isoformat()
        days = ops_territory_brief._days_since(ts)
        assert days is not None and days >= 0


# ---------------------------------------------------------------------------
# Unit: _classify_brief_type
# ---------------------------------------------------------------------------

class TestClassifyBriefType:
    def test_followup_update_when_promised_followups(self) -> None:
        result = ops_territory_brief._classify_brief_type(30, 0, 2)
        assert result == "followup_update"

    def test_pre_visit_when_recent_visit(self) -> None:
        result = ops_territory_brief._classify_brief_type(5, 0, 0)
        assert result == "pre_visit"

    def test_pre_visit_when_open_opportunities(self) -> None:
        result = ops_territory_brief._classify_brief_type(None, 3, 0)
        assert result == "pre_visit"

    def test_territory_plan_by_default(self) -> None:
        result = ops_territory_brief._classify_brief_type(30, 0, 0)
        assert result == "territory_plan"

    def test_followup_update_takes_priority_over_pre_visit(self) -> None:
        # Promised follow-ups and recent visit → followup_update wins
        result = ops_territory_brief._classify_brief_type(3, 2, 1)
        assert result == "followup_update"

    def test_territory_plan_when_no_visit_and_no_opps(self) -> None:
        result = ops_territory_brief._classify_brief_type(None, 0, 0)
        assert result == "territory_plan"


# ---------------------------------------------------------------------------
# Unit: _brief_finding_for_storage mapping
# ---------------------------------------------------------------------------

class TestBriefFindingForStorage:
    def test_maps_account_id_to_contract_id(self) -> None:
        item = _make_brief_item(account_id="customer-xyz", brief_type="territory_plan")
        stored = ops_territory_brief._brief_finding_for_storage(item)
        assert stored["contract_id"] == "customer-xyz"

    def test_finding_type_is_brief_type(self) -> None:
        item = _make_brief_item(brief_type="pre_visit")
        stored = ops_territory_brief._brief_finding_for_storage(item)
        assert stored["finding_type"] == "pre_visit"

    def test_severity_maps_from_priority(self) -> None:
        for priority, expected in [("critical", "critical"), ("high", "high"), ("medium", "medium"), ("low", "low")]:
            item = _make_brief_item(priority=priority)
            stored = ops_territory_brief._brief_finding_for_storage(item)
            assert stored["severity"] == expected, f"priority={priority}"

    def test_expected_contains_recommended_action(self) -> None:
        item = _make_brief_item()
        stored = ops_territory_brief._brief_finding_for_storage(item)
        assert "recommended_action" in stored["expected"]
        assert stored["expected"]["recommended_action"] == item["recommended_action"]

    def test_expected_contains_follow_up_draft(self) -> None:
        item = _make_brief_item()
        stored = ops_territory_brief._brief_finding_for_storage(item)
        assert stored["expected"]["follow_up_draft"] == item["follow_up_draft"]

    def test_expected_contains_stale_signals_when_stale(self) -> None:
        item = _make_brief_item(is_stale=True)
        stored = ops_territory_brief._brief_finding_for_storage(item)
        assert stored["expected"]["is_stale_data"] is True
        assert len(stored["expected"]["stale_signals"]) > 0

    def test_expected_contains_operating_model_tags(self) -> None:
        item = _make_brief_item(brief_type="pre_visit")
        item["operating_model_tags"] = [OM_TAG_SITE_VISIT]
        stored = ops_territory_brief._brief_finding_for_storage(item)
        assert OM_TAG_SITE_VISIT in stored["expected"]["operating_model_tags"]


# ---------------------------------------------------------------------------
# Unit: TerritoryBriefItemV1 Pydantic model validation
# ---------------------------------------------------------------------------

class TestTerritoryBriefItemV1:
    def test_valid_territory_plan_item(self) -> None:
        item = TerritoryBriefItemV1(
            account_id=_ACCOUNT_ID,
            brief_type="territory_plan",
            priority="medium",
            recommended_action="Review contractor pipeline for next quarter.",
            rationale="Active account with no recent contact.",
        )
        assert item.brief_type == "territory_plan"
        assert item.priority == "medium"

    def test_valid_pre_visit_item(self) -> None:
        item = TerritoryBriefItemV1(
            account_id=_ACCOUNT_ID,
            brief_type="pre_visit",
            priority="high",
            recommended_action="Confirm excavator availability before site visit.",
            rationale="Open opportunity on Ridgeline project.",
        )
        assert item.brief_type == "pre_visit"

    def test_valid_followup_update_item(self) -> None:
        item = TerritoryBriefItemV1(
            account_id=_ACCOUNT_ID,
            brief_type="followup_update",
            priority="high",
            recommended_action="Log promised delivery date from this morning's call.",
            rationale="Rep promised a delivery date during the site visit.",
            follow_up_draft="Following up on promised delivery — please confirm.",
        )
        assert item.brief_type == "followup_update"
        assert "delivery" in item.follow_up_draft

    def test_invalid_brief_type_raises(self) -> None:
        import pydantic
        with pytest.raises(pydantic.ValidationError):
            TerritoryBriefItemV1(
                account_id=_ACCOUNT_ID,
                brief_type="invalid_type",
                priority="medium",
                recommended_action="x",
                rationale="x",
            )

    def test_invalid_priority_raises(self) -> None:
        import pydantic
        with pytest.raises(pydantic.ValidationError):
            TerritoryBriefItemV1(
                account_id=_ACCOUNT_ID,
                brief_type="territory_plan",
                priority="urgent",
                recommended_action="x",
                rationale="x",
            )

    def test_schema_includes_required_fields(self) -> None:
        schema = territory_brief_item_v1_schema()
        assert "account_id" in schema.get("required", [])
        assert "brief_type" in schema.get("required", [])
        assert "priority" in schema.get("required", [])
        assert "recommended_action" in schema.get("required", [])
        assert "rationale" in schema.get("required", [])

    def test_operating_model_tags_default_empty(self) -> None:
        item = TerritoryBriefItemV1(
            account_id=_ACCOUNT_ID,
            brief_type="territory_plan",
            priority="low",
            recommended_action="x",
            rationale="x",
        )
        assert item.operating_model_tags == []

    def test_stale_signals_default_empty(self) -> None:
        item = TerritoryBriefItemV1(
            account_id=_ACCOUNT_ID,
            brief_type="territory_plan",
            priority="low",
            recommended_action="x",
            rationale="x",
        )
        assert item.stale_signals == []
        assert item.is_stale_data is False


# ---------------------------------------------------------------------------
# Unit: operating-model tag threading
# ---------------------------------------------------------------------------

class TestOperatingModelTags:
    @pytest.mark.asyncio
    async def test_territory_plan_gets_t1_tag(self) -> None:
        mock_result = _make_brief_item(brief_type="territory_plan")
        mock_result["operating_model_tags"] = []

        transport = MagicMock()
        transport_result = MagicMock()
        transport_result.response = TerritoryBriefItemV1(**{
            k: v for k, v in mock_result.items()
            if k in TerritoryBriefItemV1.model_fields
        })
        transport.return_value = transport_result

        with patch("temporal.src.agents.territory_brief_assistant.chat_with_tools", new_callable=AsyncMock) as mock_chat:
            mock_chat.return_value = transport_result
            result = await run_territory_brief_assistant(
                _make_account_payload(brief_type="territory_plan"),
                system_prompt="s",
                user_prompt_template="u",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_TERRITORY_PLAN in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_pre_visit_gets_t2_tag(self) -> None:
        mock_result = _make_brief_item(brief_type="pre_visit")
        mock_result["operating_model_tags"] = []

        transport_result = MagicMock()
        transport_result.response = TerritoryBriefItemV1(**{
            k: v for k, v in mock_result.items()
            if k in TerritoryBriefItemV1.model_fields
        })

        with patch("temporal.src.agents.territory_brief_assistant.chat_with_tools", new_callable=AsyncMock) as mock_chat:
            mock_chat.return_value = transport_result
            result = await run_territory_brief_assistant(
                _make_account_payload(brief_type="pre_visit"),
                system_prompt="s",
                user_prompt_template="u",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_SITE_VISIT in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_followup_update_gets_t4_tag(self) -> None:
        mock_result = _make_brief_item(brief_type="followup_update")
        mock_result["operating_model_tags"] = []

        transport_result = MagicMock()
        transport_result.response = TerritoryBriefItemV1(**{
            k: v for k, v in mock_result.items()
            if k in TerritoryBriefItemV1.model_fields
        })

        with patch("temporal.src.agents.territory_brief_assistant.chat_with_tools", new_callable=AsyncMock) as mock_chat:
            mock_chat.return_value = transport_result
            result = await run_territory_brief_assistant(
                _make_account_payload(brief_type="followup_update"),
                system_prompt="s",
                user_prompt_template="u",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_FOLLOWUP_UPDATE in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_existing_tag_not_duplicated(self) -> None:
        mock_result = _make_brief_item(brief_type="territory_plan")
        mock_result["operating_model_tags"] = [OM_TAG_TERRITORY_PLAN]

        transport_result = MagicMock()
        transport_result.response = TerritoryBriefItemV1(**{
            k: v for k, v in mock_result.items()
            if k in TerritoryBriefItemV1.model_fields
        })

        with patch("temporal.src.agents.territory_brief_assistant.chat_with_tools", new_callable=AsyncMock) as mock_chat:
            mock_chat.return_value = transport_result
            result = await run_territory_brief_assistant(
                _make_account_payload(brief_type="territory_plan"),
                system_prompt="s",
                user_prompt_template="u",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert result["operating_model_tags"].count(OM_TAG_TERRITORY_PLAN) == 1


# ---------------------------------------------------------------------------
# Unit: workflow no-op state
# ---------------------------------------------------------------------------

class TestTerritoryBriefWorkflowNoOp:
    @pytest.mark.asyncio
    async def test_no_op_when_no_accounts_scoped(self) -> None:
        """Empty scoped accounts → workflow returns no_op without recording."""
        wf = TerritoryAccountBriefWorkflow()
        inp = TerritoryAccountBriefWorkflowInput(tenant_id=_TENANT_ID)

        call_seq = iter([
            {"run_id": "run-noop-001"},  # ops_create_workflow_run
            _default_config(),           # ops_load_agent_config
            [],                          # ops_territory_brief_scope (empty)
            True,                        # ops_finalize_workflow_run
        ])

        async def fake_execute(fn, args=None, **kwargs):
            return next(call_seq)

        import unittest.mock as _mock
        with _mock.patch("temporalio.workflow.execute_activity", side_effect=fake_execute):
            result = await wf.run(inp)

        assert result["status"] == "no_op"
        assert result["no_op"] is True
        assert result["recorded_items"] == 0


# ---------------------------------------------------------------------------
# Unit: workflow dedup
# ---------------------------------------------------------------------------

class TestTerritoryBriefWorkflowDedup:
    @pytest.mark.asyncio
    async def test_workflow_deduplicates_existing_fingerprint(self) -> None:
        """Account with an existing open finding fingerprint is skipped."""
        wf = TerritoryAccountBriefWorkflow()
        inp = TerritoryAccountBriefWorkflowInput(tenant_id=_TENANT_ID)

        assessed = [_make_brief_item(account_id=_ACCOUNT_ID, brief_type="territory_plan")]
        existing_fp = f"territory-brief:territory_plan:{_ACCOUNT_ID}"

        call_seq = iter([
            {"run_id": "run-dedup-001"},         # ops_create_workflow_run
            _default_config(),                   # ops_load_agent_config
            [_make_account_payload()],           # ops_territory_brief_scope
            [existing_fp],                       # ops_list_open_finding_fingerprints
            assessed[0],                         # ops_territory_brief_assess
            True,                                # ops_finalize_workflow_run
        ])

        async def fake_execute(fn, args=None, **kwargs):
            return next(call_seq)

        import asyncio as _asyncio
        import unittest.mock as _mock
        with (
            _mock.patch("temporalio.workflow.execute_activity", side_effect=fake_execute),
            _mock.patch("asyncio.gather", side_effect=_asyncio.gather),
        ):
            result = await wf.run(inp)

        assert result["deduped_items"] == 1
        assert result["recorded_items"] == 0


# ---------------------------------------------------------------------------
# Unit: workflow records new findings
# ---------------------------------------------------------------------------

class TestTerritoryBriefWorkflowRecord:
    @pytest.mark.asyncio
    async def test_workflow_records_new_brief_items(self) -> None:
        """New brief items are recorded when fingerprint is fresh."""
        wf = TerritoryAccountBriefWorkflow()
        inp = TerritoryAccountBriefWorkflowInput(tenant_id=_TENANT_ID)

        assessed = [_make_brief_item(account_id=_ACCOUNT_ID, brief_type="territory_plan")]

        call_seq = iter([
            {"run_id": "run-new-001"},           # ops_create_workflow_run
            _default_config(),                   # ops_load_agent_config
            [_make_account_payload()],           # ops_territory_brief_scope
            [],                                  # ops_list_open_finding_fingerprints (empty)
            assessed[0],                         # ops_territory_brief_assess
            {"finding_id": "f-001"},             # ops_record_finding
            True,                                # ops_finalize_workflow_run
        ])

        async def fake_execute(fn, args=None, **kwargs):
            return next(call_seq)

        import asyncio as _asyncio
        import unittest.mock as _mock
        with (
            _mock.patch("temporalio.workflow.execute_activity", side_effect=fake_execute),
            _mock.patch("asyncio.gather", side_effect=_asyncio.gather),
        ):
            result = await wf.run(inp)

        assert result["recorded_items"] == 1
        assert result["deduped_items"] == 0


# ---------------------------------------------------------------------------
# Unit: workflow sorts by priority
# ---------------------------------------------------------------------------

class TestTerritoryBriefWorkflowSort:
    @pytest.mark.asyncio
    async def test_workflow_sorts_by_priority(self) -> None:
        """Workflow sorts assessed items: critical before high before low."""
        wf = TerritoryAccountBriefWorkflow()
        inp = TerritoryAccountBriefWorkflowInput(tenant_id=_TENANT_ID)

        payloads = [
            _make_account_payload("c-low"),
            _make_account_payload("c-critical"),
            _make_account_payload("c-high"),
        ]
        assessed_low = _make_brief_item("c-low", "territory_plan", "low")
        assessed_critical = _make_brief_item("c-critical", "territory_plan", "critical")
        assessed_high = _make_brief_item("c-high", "territory_plan", "high")

        recorded: list[dict] = []

        import asyncio as _asyncio
        import unittest.mock as _mock

        async def fake_execute(fn, args=None, **kwargs):
            name = getattr(fn, "__name__", str(fn))
            if "scope" in name:
                return payloads
            if "create_workflow_run" in name:
                return {"run_id": "run-sort-001"}
            if "load_agent_config" in name:
                return _default_config()
            if "list_open" in name:
                return []
            if "assess" in name:
                aid = (args or [{}])[0].get("account_id", "")
                return {
                    "c-low": assessed_low,
                    "c-critical": assessed_critical,
                    "c-high": assessed_high,
                }.get(aid, assessed_low)
            if "record_finding" in name:
                finding = (args or [{}])[0]
                recorded.append(finding)
                return {"finding_id": "f"}
            if "finalize" in name:
                return True
            return {}

        with (
            _mock.patch("temporalio.workflow.execute_activity", side_effect=fake_execute),
            _mock.patch("asyncio.gather", side_effect=_asyncio.gather),
        ):
            await wf.run(inp)

        priorities = [r.get("priority") for r in recorded]
        _rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        assert sorted(priorities, key=lambda p: _rank.get(p, 3)) == priorities


# ---------------------------------------------------------------------------
# Unit: ConfirmFollowUpSignal — informational only
# ---------------------------------------------------------------------------

class TestConfirmFollowUpSignal:
    @pytest.mark.asyncio
    async def test_confirm_follow_up_records_informational(self) -> None:
        """ConfirmFollowUpSignal is recorded but does not mutate CRM or account."""
        wf = TerritoryAccountBriefWorkflow()
        sig = ConfirmFollowUpSignal(
            account_id=_ACCOUNT_ID,
            brief_type="followup_update",
            reviewer_id="rep-001",
            decision="confirmed",
            reviewer_name="Alex",
            note="Delivery date confirmed — entering in CRM manually.",
        )
        await wf.confirm_follow_up(sig)
        key = f"{_ACCOUNT_ID}:followup_update"
        assert key in wf._confirmations
        assert wf._confirmations[key]["decision"] == "confirmed"
        assert wf._confirmations[key]["confirmed"] is True

    @pytest.mark.asyncio
    async def test_confirm_follow_up_uses_fingerprint_as_key(self) -> None:
        """ConfirmFollowUpSignal uses fingerprint as the dict key when provided."""
        wf = TerritoryAccountBriefWorkflow()
        sig = ConfirmFollowUpSignal(
            account_id=_ACCOUNT_ID,
            brief_type="followup_update",
            reviewer_id="rep-002",
            decision="edited",
            fingerprint="territory-brief:followup_update:customer-002",
        )
        await wf.confirm_follow_up(sig)
        assert "territory-brief:followup_update:customer-002" in wf._confirmations

    @pytest.mark.asyncio
    async def test_confirm_follow_up_discarded_is_recorded(self) -> None:
        """A discarded follow-up is still recorded without mutating any record."""
        wf = TerritoryAccountBriefWorkflow()
        sig = ConfirmFollowUpSignal(
            account_id=_ACCOUNT_ID,
            brief_type="followup_update",
            reviewer_id="rep-003",
            decision="discarded",
        )
        await wf.confirm_follow_up(sig)
        key = f"{_ACCOUNT_ID}:followup_update"
        assert wf._confirmations[key]["decision"] == "discarded"


# ---------------------------------------------------------------------------
# Unit: ops_territory_brief_scope (minimal fake DB path)
# ---------------------------------------------------------------------------

class TestOpsTerritoryBriefScope:
    def test_scope_empty_when_no_customers(self, activity_env: ActivityEnvironment) -> None:
        """Scope returns empty list when no customer entities exist."""
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, None, None
            )
        assert result == []

    def test_scope_filters_to_single_account_when_provided(self, activity_env: ActivityEnvironment) -> None:
        """When account_id is provided, filter is applied to scope only that account."""
        customer = {
            "entity_id": _ACCOUNT_ID,
            "entity_type": "customer",
            "name": _ACCOUNT_NAME,
            "data": {"name": _ACCOUNT_NAME, "tenant_id": _TENANT_ID},
            "updated_at": _RECENT_TS,
        }
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, None, _ACCOUNT_ID
            )
        assert len(result) == 1
        assert result[0]["account_id"] == _ACCOUNT_ID

    def test_scope_classifies_followup_when_promised_facts(self, activity_env: ActivityEnvironment) -> None:
        """Account with promised follow-up facts gets brief_type=followup_update."""
        customer = {
            "entity_id": _ACCOUNT_ID,
            "entity_type": "customer",
            "name": _ACCOUNT_NAME,
            "data": {"name": _ACCOUNT_NAME, "tenant_id": _TENANT_ID},
            "updated_at": _RECENT_TS,
        }
        promise_fact = {
            "entity_id": _ACCOUNT_ID,
            "tenant_id": _TENANT_ID,
            "fact_type": "promised_followup",
            "measured_at": _RECENT_TS,
            "notes": "Confirm excavator delivery date",
        }
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [customer],
            "rental_current_relationships": [],
            "entity_facts": [promise_fact],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, None, None
            )
        assert len(result) == 1
        assert result[0]["brief_type"] == "followup_update"
        assert len(result[0]["promised_follow_ups"]) == 1


# ---------------------------------------------------------------------------
# Unit: ops_territory_brief_scope — rep-scope authorization
# ---------------------------------------------------------------------------

_REP_ID = "rep-field-op-001"
_OTHER_REP_ID = "rep-field-op-002"
_ASSIGNED_ACCOUNT_ID = "customer-assigned-001"
_UNASSIGNED_ACCOUNT_ID = "customer-other-002"


def _make_customer_row(entity_id: str, tenant_id: str, name: str = "Acme Co", assigned_rep_id: str | None = None) -> dict:
    data: dict = {"name": name, "tenant_id": tenant_id}
    if assigned_rep_id:
        data["assigned_rep_id"] = assigned_rep_id
    return {
        "entity_id": entity_id,
        "entity_type": "customer",
        "name": name,
        "data": data,
        "updated_at": _RECENT_TS,
    }


def _make_rep_assignment_fact(entity_id: str, rep_id: str, tenant_id: str) -> dict:
    return {
        "entity_id": entity_id,
        "tenant_id": tenant_id,
        "fact_type": "rep_assignment",
        "value": rep_id,
        "measured_at": _RECENT_TS,
    }


class TestOpsTerritoryBriefScopeRepAuth:
    """Regression tests: rep-scope enforcement in ops_territory_brief_scope."""

    def test_field_operator_cannot_access_unassigned_account_by_account_id(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """A rep with no assignment to an account gets an empty scope (no-op)
        even when that account_id is explicitly supplied."""
        unassigned_customer = _make_customer_row(_UNASSIGNED_ACCOUNT_ID, _TENANT_ID)
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [unassigned_customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, _UNASSIGNED_ACCOUNT_ID,
            )
        assert result == [], (
            "A field_operator must not generate a brief for an account outside their assigned scope"
        )

    def test_field_operator_accesses_own_assigned_account_by_account_id(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """A rep can request a brief for an account assigned to them via entity data."""
        assigned_customer = _make_customer_row(
            _ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_REP_ID
        )
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [assigned_customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, _ASSIGNED_ACCOUNT_ID,
            )
        assert len(result) == 1
        assert result[0]["account_id"] == _ASSIGNED_ACCOUNT_ID

    def test_field_operator_accesses_account_assigned_via_fact(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """A rep can access an account assigned via rep_assignment entity fact."""
        customer = _make_customer_row(_ASSIGNED_ACCOUNT_ID, _TENANT_ID)
        assignment_fact = _make_rep_assignment_fact(_ASSIGNED_ACCOUNT_ID, _REP_ID, _TENANT_ID)
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [customer],
            "rental_current_relationships": [],
            "entity_facts": [assignment_fact],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, _ASSIGNED_ACCOUNT_ID,
            )
        assert len(result) == 1
        assert result[0]["account_id"] == _ASSIGNED_ACCOUNT_ID

    def test_rep_fanout_limited_to_assigned_accounts_only(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """When account_id is omitted and rep_id is set, only assigned accounts
        appear in the scope — not all tenant accounts."""
        assigned_customer = _make_customer_row(
            _ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_REP_ID
        )
        unassigned_customer = _make_customer_row(_UNASSIGNED_ACCOUNT_ID, _TENANT_ID)
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [assigned_customer, unassigned_customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, None,
            )
        account_ids = [r["account_id"] for r in result]
        assert _ASSIGNED_ACCOUNT_ID in account_ids, "Assigned account must be included"
        assert _UNASSIGNED_ACCOUNT_ID not in account_ids, (
            "Unassigned account must be excluded from rep's scope"
        )

    def test_admin_no_rep_id_gets_all_tenant_accounts(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """When rep_id is None (admin/branch_manager tenant-wide), all tenant
        accounts are returned regardless of assignment."""
        assigned_customer = _make_customer_row(
            _ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_REP_ID
        )
        unassigned_customer = _make_customer_row(_UNASSIGNED_ACCOUNT_ID, _TENANT_ID)
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [assigned_customer, unassigned_customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, None, None,
            )
        account_ids = [r["account_id"] for r in result]
        assert _ASSIGNED_ACCOUNT_ID in account_ids
        assert _UNASSIGNED_ACCOUNT_ID in account_ids

    def test_cross_rep_account_id_denied(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """A field_operator cannot access an account assigned to a *different* rep
        by passing that account's account_id explicitly."""
        other_reps_customer = _make_customer_row(
            _ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_OTHER_REP_ID
        )
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [other_reps_customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, _ASSIGNED_ACCOUNT_ID,
            )
        assert result == [], (
            "A rep cannot access an account assigned to a different rep via account_id"
        )

    def test_admin_can_access_any_account_by_account_id(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """Admin (rep_id=None) can request a brief for any tenant account."""
        customer = _make_customer_row(_ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_OTHER_REP_ID)
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, None, _ASSIGNED_ACCOUNT_ID,
            )
        assert len(result) == 1
        assert result[0]["account_id"] == _ASSIGNED_ACCOUNT_ID

    def test_rep_assigned_account_accessible_outside_top_window(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """A rep can trigger their own assigned account_id even when that account
        would be excluded by the _MAX_SCOPED_ACCOUNTS limit.

        Without the entity_id filter on the single-account path, the top-N
        limit would cut off the assigned account when N other customer rows
        come first in the result set, causing a false-denial (empty scope).
        With the fix, the entity_id filter is pushed to the DB layer regardless
        of rep_id, so only that row is fetched and the limit is irrelevant.
        """
        # Fill the table with _MAX_SCOPED_ACCOUNTS filler rows (no assignment
        # to _REP_ID) placed before the target account so they consume the
        # limit when no entity_id filter is applied.
        filler_rows = [
            _make_customer_row(f"filler-{i:04d}", _TENANT_ID)
            for i in range(ops_territory_brief._MAX_SCOPED_ACCOUNTS)
        ]
        assigned_customer = _make_customer_row(
            _ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_REP_ID
        )
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": filler_rows + [assigned_customer],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, _ASSIGNED_ACCOUNT_ID,
            )
        assert len(result) == 1, (
            "Rep must retrieve their assigned account even when it falls outside "
            "the newest-N customer rows"
        )
        assert result[0]["account_id"] == _ASSIGNED_ACCOUNT_ID

    def test_rep_fanout_accounts_accessible_outside_top_tenant_window(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """Fan-out (account_id omitted): a rep receives their assigned accounts even
        when _MAX_SCOPED_ACCOUNTS newer tenant customer rows exist before them.

        Previously the tenant-wide top-N DB limit was applied before the rep
        authorization filter, so assigned accounts falling outside the window were
        silently dropped.  With the fix, the limit is applied AFTER authorization.
        """
        _ASSIGNED_B = "customer-assigned-002"
        filler_rows = [
            _make_customer_row(f"filler-fanout-{i:04d}", _TENANT_ID)
            for i in range(ops_territory_brief._MAX_SCOPED_ACCOUNTS)
        ]
        assigned_a = _make_customer_row(_ASSIGNED_ACCOUNT_ID, _TENANT_ID, assigned_rep_id=_REP_ID)
        assigned_b = _make_customer_row(_ASSIGNED_B, _TENANT_ID, assigned_rep_id=_REP_ID)
        # Filler rows come first in the result set (simulating newer updated_at).
        # Without the fix both assigned accounts would be cut off by the limit.
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": filler_rows + [assigned_a, assigned_b],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, _REP_ID, None,
            )
        account_ids = {r["account_id"] for r in result}
        assert _ASSIGNED_ACCOUNT_ID in account_ids, (
            "Rep must receive their first assigned account even outside the newest-N window"
        )
        assert _ASSIGNED_B in account_ids, (
            "Rep must receive their second assigned account even outside the newest-N window"
        )
        # Filler accounts (not assigned to this rep) must be excluded.
        assert not any(aid.startswith("filler-fanout-") for aid in account_ids), (
            "Unassigned filler accounts must not appear in the rep's scope"
        )

    def test_admin_fanout_still_capped_at_max_scoped_accounts(
        self, activity_env: ActivityEnvironment
    ) -> None:
        """Admin / branch_manager tenant-wide fan-out is still capped at
        _MAX_SCOPED_ACCOUNTS — the fix must not remove that safety cap for the
        admin path (rep_id=None)."""
        # Build more rows than the cap; admin should still return exactly the cap.
        all_rows = [
            _make_customer_row(f"admin-cust-{i:04d}", _TENANT_ID)
            for i in range(ops_territory_brief._MAX_SCOPED_ACCOUNTS + 10)
        ]
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": all_rows,
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ), patch(
            "temporal.src.activities.ops_territory_brief.ops_revrec._json_object",
            side_effect=lambda x: x if isinstance(x, dict) else {},
        ):
            result = activity_env.run(
                ops_territory_brief.ops_territory_brief_scope,
                _TENANT_ID, None, None,
            )
        assert len(result) <= ops_territory_brief._MAX_SCOPED_ACCOUNTS, (
            "Admin fan-out must still be capped at _MAX_SCOPED_ACCOUNTS"
        )
