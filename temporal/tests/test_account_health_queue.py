"""Tests for the account health queue workflow, activities, and agent.

Coverage:
- Queue ranking: critical > high > medium > low
- Signal classification: lost > dormant > growth_opportunity > at_risk
- No-op state: empty scoped accounts returns status='no_op' without recording
- Freshness / stale detection: _is_stale returns True for old or absent timestamps
- Days since: _days_since returns correct day counts
- Recommendation rendering: assessed threads carry recommended_angle + evidence
- Dedup: accounts with existing fingerprints are skipped
- Review signal: recorded as informational, no account-stage mutation
- Operating-model tags: t6 threaded for dormant/lost, t7 for at_risk/growth
- ops_account_health_scope: correctly classifies customers by rental history
- AccountHealthThreadV1: Pydantic model validation
- Thread finding storage mapping
"""
from __future__ import annotations

import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from temporal.src.activities import ops_account_health
from temporal.src.agents.account_health_assistant import (
    OM_TAG_ACCOUNT_HEALTH,
    OM_TAG_WIN_BACK,
    AccountHealthThreadV1,
    account_health_thread_v1_schema,
    run_account_health_assistant,
)
from temporal.src.workflows.ops.account_health_queue import (
    AccountHealthQueueWorkflow,
    AccountHealthQueueWorkflowInput,
    ReviewAccountThreadSignal,
)
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-acct-health-test"
_CUSTOMER_ID = "customer-001"
_CUSTOMER_NAME = "Apex Contractors"

_NOW = datetime.datetime(2026, 6, 15, 8, 0, 0, tzinfo=datetime.UTC)
_DORMANT_TS = (_NOW - datetime.timedelta(days=90)).isoformat()
_LOST_TS = (_NOW - datetime.timedelta(days=200)).isoformat()
_RECENT_TS = (_NOW - datetime.timedelta(days=10)).isoformat()
_OLD_ENTITY_TS = (_NOW - datetime.timedelta(days=14)).isoformat()


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
    customer_id: str = _CUSTOMER_ID,
    health_signal: str = "dormant",
    days_since_rental: int | None = 90,
    contact_gap_days: int | None = 30,
    utilization_trend: str = "unknown",
    open_opportunities: int = 0,
    is_stale: bool = False,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "account_id": customer_id,
        "customer_id": customer_id,
        "account_name": _CUSTOMER_NAME,
        "health_signal": health_signal,
        "last_rental_date": _DORMANT_TS if days_since_rental and days_since_rental >= 60 else _RECENT_TS,
        "days_since_rental": days_since_rental,
        "contact_gap_days": contact_gap_days,
        "utilization_trend": utilization_trend,
        "open_opportunities": open_opportunities,
        "last_updated_at": _OLD_ENTITY_TS if is_stale else _NOW.isoformat(),
        "is_stale_hint": is_stale,
        "rental_data": {
            "entities": [],
            "relationships": [],
            "facts": [],
            "time_series": [],
            "telematics": [],
        },
    }


def _make_assessment(
    account_id: str = _CUSTOMER_ID,
    health_signal: str = "dormant",
    priority: str = "high",
    is_stale: bool = False,
) -> dict:
    return {
        "account_id": account_id,
        "account_name": _CUSTOMER_NAME,
        "health_signal": health_signal,
        "priority": priority,
        "recommended_angle": "Re-engage with upcoming project pipeline check.",
        "outreach_draft": "Hi [Name], we noticed it's been a while since your last rental...",
        "evidence": ["Last contract: 90 days ago", "No contact logged in 30 days"],
        "contact_gap_days": 30,
        "last_rental_date": _DORMANT_TS,
        "utilization_trend": "unknown",
        "open_opportunities": 0,
        "confidence": 0.75,
        "rationale": "Account has gone quiet after consistent rental history.",
        "is_stale_data": is_stale,
        "stale_signals": ["Customer entity last updated 14 days ago"] if is_stale else [],
        "operating_model_tags": [],
        "tenant_id": _TENANT_ID,
    }


# ---------------------------------------------------------------------------
# Fake ops persistence for scoping tests
# ---------------------------------------------------------------------------

class _FakeOpsPersistence:
    """Minimal fake for testing ops_account_health_scope without a real DB."""

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
        assert ops_account_health._is_stale(None)

    def test_empty_string_is_stale(self) -> None:
        assert ops_account_health._is_stale("")

    def test_old_timestamp_is_stale(self) -> None:
        old = (_NOW - datetime.timedelta(days=14)).isoformat()
        assert ops_account_health._is_stale(old, threshold_days=7)

    def test_fresh_timestamp_is_not_stale(self) -> None:
        fresh = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=2)).isoformat()
        assert not ops_account_health._is_stale(fresh, threshold_days=7)

    def test_invalid_string_is_stale(self) -> None:
        assert ops_account_health._is_stale("not-a-date")


# ---------------------------------------------------------------------------
# Unit: _days_since helper
# ---------------------------------------------------------------------------

class TestDaysSince:
    def test_none_returns_none(self) -> None:
        assert ops_account_health._days_since(None) is None

    def test_empty_returns_none(self) -> None:
        assert ops_account_health._days_since("") is None

    def test_invalid_returns_none(self) -> None:
        assert ops_account_health._days_since("not-a-date") is None

    def test_known_date_returns_correct_days(self) -> None:
        ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=45)).isoformat()
        days = ops_account_health._days_since(ts)
        assert days is not None
        assert 44 <= days <= 46

    def test_recent_date_is_zero_or_positive(self) -> None:
        ts = datetime.datetime.now(datetime.UTC).isoformat()
        days = ops_account_health._days_since(ts)
        assert days is not None and days >= 0


# ---------------------------------------------------------------------------
# Unit: _classify_health_signal
# ---------------------------------------------------------------------------

class TestClassifyHealthSignal:
    def test_lost_when_over_180_days(self) -> None:
        result = ops_account_health._classify_health_signal(200, None, "unknown", 0)
        assert result == "lost"

    def test_dormant_when_60_to_179_days(self) -> None:
        result = ops_account_health._classify_health_signal(90, None, "unknown", 0)
        assert result == "dormant"

    def test_growth_opportunity_with_open_opps(self) -> None:
        result = ops_account_health._classify_health_signal(30, None, "stable", 2)
        assert result == "growth_opportunity"

    def test_growth_opportunity_with_improving_trend(self) -> None:
        result = ops_account_health._classify_health_signal(30, None, "improving", 0)
        assert result == "growth_opportunity"

    def test_at_risk_with_declining_utilization(self) -> None:
        result = ops_account_health._classify_health_signal(30, 20, "declining", 0)
        assert result == "at_risk"

    def test_at_risk_with_long_contact_gap(self) -> None:
        result = ops_account_health._classify_health_signal(30, 50, "stable", 0)
        assert result == "at_risk"

    def test_lost_takes_priority_over_growth(self) -> None:
        # Even with open opps, if 200+ days → lost
        result = ops_account_health._classify_health_signal(200, None, "improving", 3)
        assert result == "lost"

    def test_dormant_when_no_rental_date(self) -> None:
        result = ops_account_health._classify_health_signal(None, None, "unknown", 0)
        assert result == "dormant"


# ---------------------------------------------------------------------------
# Unit: _thread_finding_for_storage mapping
# ---------------------------------------------------------------------------

class TestThreadFindingForStorage:
    def test_maps_account_id_to_contract_id(self) -> None:
        thread = _make_assessment(account_id="customer-xyz", health_signal="dormant")
        stored = ops_account_health._thread_finding_for_storage(thread)
        assert stored["contract_id"] == "customer-xyz"

    def test_finding_type_is_health_signal(self) -> None:
        thread = _make_assessment(health_signal="lost")
        stored = ops_account_health._thread_finding_for_storage(thread)
        assert stored["finding_type"] == "lost"

    def test_severity_maps_from_priority(self) -> None:
        for priority, expected in [("critical", "critical"), ("high", "high"), ("medium", "medium"), ("low", "low")]:
            thread = _make_assessment(priority=priority)
            stored = ops_account_health._thread_finding_for_storage(thread)
            assert stored["severity"] == expected, f"priority={priority}"

    def test_expected_contains_recommended_angle(self) -> None:
        thread = _make_assessment()
        stored = ops_account_health._thread_finding_for_storage(thread)
        assert "recommended_angle" in stored["expected"]
        assert stored["expected"]["recommended_angle"] == thread["recommended_angle"]

    def test_expected_contains_stale_signals_when_stale(self) -> None:
        thread = _make_assessment(is_stale=True)
        stored = ops_account_health._thread_finding_for_storage(thread)
        assert stored["expected"]["is_stale_data"] is True
        assert len(stored["expected"]["stale_signals"]) > 0

    def test_expected_contains_operating_model_tags(self) -> None:
        thread = _make_assessment(health_signal="dormant")
        thread["operating_model_tags"] = [OM_TAG_WIN_BACK]
        stored = ops_account_health._thread_finding_for_storage(thread)
        assert OM_TAG_WIN_BACK in stored["expected"]["operating_model_tags"]


# ---------------------------------------------------------------------------
# Unit: AccountHealthThreadV1 Pydantic model validation
# ---------------------------------------------------------------------------

class TestAccountHealthThreadV1:
    def test_valid_dormant_thread(self) -> None:
        thread = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="dormant",
            priority="high",
            recommended_angle="Reach out to check on upcoming project pipeline.",
            rationale="No rental activity in 90 days.",
        )
        assert thread.health_signal == "dormant"
        assert thread.priority == "high"
        assert thread.is_stale_data is False
        assert thread.operating_model_tags == []

    def test_invalid_health_signal_raises(self) -> None:
        with pytest.raises(ValueError):
            AccountHealthThreadV1(
                account_id=_CUSTOMER_ID,
                health_signal="unknown_signal",
                priority="high",
                recommended_angle="x",
                rationale="x",
            )

    def test_invalid_priority_raises(self) -> None:
        with pytest.raises(ValueError):
            AccountHealthThreadV1(
                account_id=_CUSTOMER_ID,
                health_signal="dormant",
                priority="urgent",
                recommended_angle="x",
                rationale="x",
            )

    def test_invalid_utilization_trend_raises(self) -> None:
        with pytest.raises(ValueError):
            AccountHealthThreadV1(
                account_id=_CUSTOMER_ID,
                health_signal="dormant",
                priority="high",
                utilization_trend="sideways",
                recommended_angle="x",
                rationale="x",
            )

    def test_all_health_signals_accepted(self) -> None:
        for signal in ("dormant", "lost", "at_risk", "growth_opportunity"):
            t = AccountHealthThreadV1(
                account_id=_CUSTOMER_ID,
                health_signal=signal,
                priority="medium",
                recommended_angle="x",
                rationale="x",
            )
            assert t.health_signal == signal

    def test_schema_output_is_dict(self) -> None:
        schema = account_health_thread_v1_schema()
        assert isinstance(schema, dict)
        assert "properties" in schema or "required" in schema

    def test_outreach_draft_is_optional(self) -> None:
        thread = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="at_risk",
            priority="medium",
            recommended_angle="Review declining utilization.",
            rationale="Utilization down 20% month-on-month.",
        )
        assert thread.outreach_draft == ""


# ---------------------------------------------------------------------------
# Unit: operating-model tags threaded by run_account_health_assistant
# ---------------------------------------------------------------------------

class TestOperatingModelTags:
    @pytest.mark.asyncio
    async def test_dormant_gets_win_back_tag(self) -> None:
        mock_response = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="dormant",
            priority="high",
            recommended_angle="Win-back angle.",
            rationale="No rental in 90 days.",
        )
        mock_result = MagicMock()
        mock_result.response = mock_response

        async def fake_chat_with_tools(**kwargs):
            return mock_result

        with patch("temporal.src.agents.account_health_assistant.chat_with_tools", side_effect=fake_chat_with_tools):
            result = await run_account_health_assistant(
                {"account_id": _CUSTOMER_ID, "health_signal": "dormant"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_WIN_BACK in result.get("operating_model_tags", [])
        assert OM_TAG_ACCOUNT_HEALTH not in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_lost_gets_win_back_tag(self) -> None:
        mock_response = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="lost",
            priority="critical",
            recommended_angle="Win-back campaign.",
            rationale="No rental in 200 days.",
        )
        mock_result = MagicMock()
        mock_result.response = mock_response

        async def fake_chat_with_tools(**kwargs):
            return mock_result

        with patch("temporal.src.agents.account_health_assistant.chat_with_tools", side_effect=fake_chat_with_tools):
            result = await run_account_health_assistant(
                {"account_id": _CUSTOMER_ID, "health_signal": "lost"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_WIN_BACK in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_at_risk_gets_account_health_tag(self) -> None:
        mock_response = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="at_risk",
            priority="high",
            recommended_angle="Retention check-in.",
            rationale="Declining utilization.",
        )
        mock_result = MagicMock()
        mock_result.response = mock_response

        async def fake_chat_with_tools(**kwargs):
            return mock_result

        with patch("temporal.src.agents.account_health_assistant.chat_with_tools", side_effect=fake_chat_with_tools):
            result = await run_account_health_assistant(
                {"account_id": _CUSTOMER_ID, "health_signal": "at_risk"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_ACCOUNT_HEALTH in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_growth_opportunity_gets_account_health_tag(self) -> None:
        mock_response = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="growth_opportunity",
            priority="medium",
            recommended_angle="Upsell on open project phase.",
            rationale="2 open opportunities.",
        )
        mock_result = MagicMock()
        mock_result.response = mock_response

        async def fake_chat_with_tools(**kwargs):
            return mock_result

        with patch("temporal.src.agents.account_health_assistant.chat_with_tools", side_effect=fake_chat_with_tools):
            result = await run_account_health_assistant(
                {"account_id": _CUSTOMER_ID, "health_signal": "growth_opportunity"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert OM_TAG_ACCOUNT_HEALTH in result.get("operating_model_tags", [])

    @pytest.mark.asyncio
    async def test_tag_not_duplicated_when_already_present(self) -> None:
        mock_response = AccountHealthThreadV1(
            account_id=_CUSTOMER_ID,
            health_signal="dormant",
            priority="high",
            recommended_angle="Win-back.",
            rationale="Dormant.",
            operating_model_tags=[OM_TAG_WIN_BACK],
        )
        mock_result = MagicMock()
        mock_result.response = mock_response

        async def fake_chat_with_tools(**kwargs):
            return mock_result

        with patch("temporal.src.agents.account_health_assistant.chat_with_tools", side_effect=fake_chat_with_tools):
            result = await run_account_health_assistant(
                {"account_id": _CUSTOMER_ID, "health_signal": "dormant"},
                system_prompt="sys",
                user_prompt_template="user",
                tools=[],
                tool_executor=AsyncMock(return_value={}),
            )
        assert result["operating_model_tags"].count(OM_TAG_WIN_BACK) == 1


# ---------------------------------------------------------------------------
# Unit: scope activity — dormant customer detection
# ---------------------------------------------------------------------------

class TestAccountHealthScope:
    def test_scope_returns_dormant_customer(self, activity_env: ActivityEnvironment) -> None:
        """Customers with last rental 90 days ago appear as dormant."""
        dormant_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=90)).isoformat()
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": _TENANT_ID, "name": _CUSTOMER_NAME},
                    "updated_at": dormant_ts,
                },
                {
                    "entity_id": "contract-001",
                    "entity_type": "rental_contract",
                    "data": {"tenant_id": _TENANT_ID, "customer_id": _CUSTOMER_ID},
                    "updated_at": dormant_ts,
                },
            ],
            "rental_current_relationships": [
                {
                    "relationship_type": "customer_has_billing_account",
                    "parent_id": _CUSTOMER_ID,
                    "child_id": "billing-001",
                }
            ],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_account_health.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_account_health.ops_account_health_scope,
                _TENANT_ID, None, None,
            )
        assert len(result) >= 1
        assert result[0]["customer_id"] == _CUSTOMER_ID
        assert result[0]["health_signal"] == "dormant"

    def test_scope_returns_lost_customer(self, activity_env: ActivityEnvironment) -> None:
        """Customers with last rental 200+ days ago appear as lost."""
        lost_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=210)).isoformat()
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": _TENANT_ID, "name": _CUSTOMER_NAME},
                    "updated_at": lost_ts,
                },
                {
                    "entity_id": "contract-002",
                    "entity_type": "rental_contract",
                    "data": {"tenant_id": _TENANT_ID, "customer_id": _CUSTOMER_ID},
                    "updated_at": lost_ts,
                },
            ],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_account_health.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_account_health.ops_account_health_scope,
                _TENANT_ID, None, None,
            )
        assert len(result) >= 1
        assert result[0]["health_signal"] == "lost"

    def test_scope_returns_growth_opportunity_with_open_orders(self, activity_env: ActivityEnvironment) -> None:
        """Customers with open orders appear as growth_opportunity."""
        recent_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=10)).isoformat()
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": _TENANT_ID, "name": _CUSTOMER_NAME},
                    "updated_at": recent_ts,
                },
                {
                    "entity_id": "contract-003",
                    "entity_type": "rental_contract",
                    "data": {"tenant_id": _TENANT_ID, "customer_id": _CUSTOMER_ID},
                    "updated_at": recent_ts,
                },
                {
                    "entity_id": "order-001",
                    "entity_type": "rental_order",
                    "data": {"tenant_id": _TENANT_ID, "customer_id": _CUSTOMER_ID, "status": "proposed"},
                    "updated_at": recent_ts,
                },
            ],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_account_health.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_account_health.ops_account_health_scope,
                _TENANT_ID, None, None,
            )
        growth_items = [r for r in result if r["health_signal"] == "growth_opportunity"]
        assert growth_items, f"Expected growth_opportunity items, got: {[r['health_signal'] for r in result]}"

    def test_scope_deduplicates_same_customer(self, activity_env: ActivityEnvironment) -> None:
        """The same customer_id appears at most once in scoped output."""
        ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=90)).isoformat()
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": _TENANT_ID, "name": _CUSTOMER_NAME},
                    "updated_at": ts,
                },
                # Duplicate entry for same customer (should be collapsed)
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": _TENANT_ID, "name": _CUSTOMER_NAME},
                    "updated_at": ts,
                },
                {
                    "entity_id": "contract-004",
                    "entity_type": "rental_contract",
                    "data": {"tenant_id": _TENANT_ID, "customer_id": _CUSTOMER_ID},
                    "updated_at": ts,
                },
            ],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_account_health.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_account_health.ops_account_health_scope,
                _TENANT_ID, None, None,
            )
        customer_ids = [r["customer_id"] for r in result]
        assert customer_ids.count(_CUSTOMER_ID) == 1

    def test_scope_skips_cross_tenant_customers(self, activity_env: ActivityEnvironment) -> None:
        """Customers belonging to a different tenant are excluded."""
        ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=90)).isoformat()
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": "other-tenant", "name": _CUSTOMER_NAME},
                    "updated_at": ts,
                },
                {
                    "entity_id": "contract-005",
                    "entity_type": "rental_contract",
                    "data": {"tenant_id": "other-tenant", "customer_id": _CUSTOMER_ID},
                    "updated_at": ts,
                },
            ],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_account_health.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_account_health.ops_account_health_scope,
                _TENANT_ID, None, None,
            )
        assert result == []

    def test_scope_flags_stale_data_on_old_entity(self, activity_env: ActivityEnvironment) -> None:
        """Customers whose entity record is stale are flagged is_stale_hint=True."""
        old_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=14)).isoformat()
        contract_ts = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(days=90)).isoformat()
        fake_client = _FakeOpsPersistence({
            "rental_current_entity_state": [
                {
                    "entity_id": _CUSTOMER_ID,
                    "entity_type": "customer",
                    "name": _CUSTOMER_NAME,
                    "data": {"tenant_id": _TENANT_ID, "name": _CUSTOMER_NAME},
                    "updated_at": old_ts,
                },
                {
                    "entity_id": "contract-006",
                    "entity_type": "rental_contract",
                    "data": {"tenant_id": _TENANT_ID, "customer_id": _CUSTOMER_ID},
                    "updated_at": contract_ts,
                },
            ],
            "rental_current_relationships": [],
            "entity_facts": [],
            "time_series_points": [],
        })
        with patch(
            "temporal.src.activities.ops_account_health.ops_revrec._get_ops_persistence_client",
            return_value=fake_client,
        ):
            result = activity_env.run(
                ops_account_health.ops_account_health_scope,
                _TENANT_ID, None, None,
            )
        assert result[0]["is_stale_hint"] is True


# ---------------------------------------------------------------------------
# Unit: ReviewAccountThreadSignal — recorded as informational
# ---------------------------------------------------------------------------

class TestReviewSignal:
    def test_review_signal_stored_without_stage_mutation(self) -> None:
        workflow = AccountHealthQueueWorkflow()
        sig = ReviewAccountThreadSignal(
            account_id=_CUSTOMER_ID,
            health_signal="dormant",
            reviewer_id="rep-001",
            decision="accepted_angle",
            fingerprint=None,
            reviewer_name="Jane Rep",
            note="Will call Monday.",
        )
        import asyncio
        asyncio.run(workflow.review_account_thread(sig))
        key = f"{_CUSTOMER_ID}:dormant"
        assert key in workflow._reviews
        assert workflow._reviews[key]["decision"] == "accepted_angle"
        assert workflow._reviews[key]["reviewed"] is True

    def test_review_signal_uses_fingerprint_when_provided(self) -> None:
        workflow = AccountHealthQueueWorkflow()
        sig = ReviewAccountThreadSignal(
            account_id=_CUSTOMER_ID,
            health_signal="dormant",
            reviewer_id="rep-001",
            decision="rejected",
            fingerprint="account-health:customer-001:dormant",
        )
        import asyncio
        asyncio.run(workflow.review_account_thread(sig))
        assert "account-health:customer-001:dormant" in workflow._reviews


# ---------------------------------------------------------------------------
# Workflow: no-op state when no accounts are scoped
# ---------------------------------------------------------------------------

class TestWorkflowNoOp:
    @pytest.mark.asyncio
    async def test_no_op_when_no_accounts_scoped(self) -> None:
        """Workflow returns status=no_op when scope returns empty list."""
        wf = AccountHealthQueueWorkflow()
        inp = AccountHealthQueueWorkflowInput(tenant_id=_TENANT_ID)

        call_seq = iter([
            {"run_id": "run-noop-001"},  # ops_create_workflow_run
            _default_config(),           # ops_load_agent_config
            [],                          # ops_account_health_scope → empty
            # ops_finalize_workflow_run is called in finally
            True,
        ])

        async def fake_execute(fn, args=None, **kwargs):
            return next(call_seq)

        import unittest.mock as _mock
        with _mock.patch("temporalio.workflow.execute_activity", side_effect=fake_execute):
            result = await wf.run(inp)

        assert result["no_op"] is True
        assert result["status"] == "no_op"
        assert result["total_accounts_scoped"] == 0

    @pytest.mark.asyncio
    async def test_workflow_deduplicates_existing_findings(self) -> None:
        """Accounts whose fingerprint already exists in findings are skipped."""
        wf = AccountHealthQueueWorkflow()
        inp = AccountHealthQueueWorkflowInput(tenant_id=_TENANT_ID)

        existing_fp = f"account-health:{_CUSTOMER_ID}:dormant"
        assessed = [_make_assessment(account_id=_CUSTOMER_ID, health_signal="dormant")]

        call_seq = iter([
            {"run_id": "run-dedup-001"},           # ops_create_workflow_run
            _default_config(),                      # ops_load_agent_config
            [_make_account_payload()],              # ops_account_health_scope
            [existing_fp],                          # ops_list_open_finding_fingerprints
            assessed[0],                            # ops_account_health_assess
            True,                                   # ops_finalize_workflow_run
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

        assert result["deduped_threads"] == 1
        assert result["recorded_threads"] == 0

    @pytest.mark.asyncio
    async def test_workflow_records_new_findings(self) -> None:
        """New account health threads are recorded when fingerprint is fresh."""
        wf = AccountHealthQueueWorkflow()
        inp = AccountHealthQueueWorkflowInput(tenant_id=_TENANT_ID)

        assessed = [_make_assessment(account_id=_CUSTOMER_ID, health_signal="dormant")]

        call_seq = iter([
            {"run_id": "run-new-001"},              # ops_create_workflow_run
            _default_config(),                      # ops_load_agent_config
            [_make_account_payload()],              # ops_account_health_scope
            [],                                     # ops_list_open_finding_fingerprints (empty)
            assessed[0],                            # ops_account_health_assess
            {"finding_id": "f-001"},                # ops_record_finding
            True,                                   # ops_finalize_workflow_run
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

        assert result["recorded_threads"] == 1
        assert result["deduped_threads"] == 0

    @pytest.mark.asyncio
    async def test_workflow_sorts_by_priority(self) -> None:
        """Workflow sorts assessed threads: critical before high before low."""
        wf = AccountHealthQueueWorkflow()
        inp = AccountHealthQueueWorkflowInput(tenant_id=_TENANT_ID)

        payloads = [
            _make_account_payload("c-low", health_signal="dormant"),
            _make_account_payload("c-critical", health_signal="lost"),
            _make_account_payload("c-high", health_signal="at_risk"),
        ]
        assessed_low = _make_assessment("c-low", "dormant", "low")
        assessed_critical = _make_assessment("c-critical", "lost", "critical")
        assessed_high = _make_assessment("c-high", "at_risk", "high")

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
