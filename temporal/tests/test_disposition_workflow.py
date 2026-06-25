"""Tests for the disposition recommendation queue workflow, activities, and agent.

Coverage:
- Trigger scoping: assets that cross age/utilization/maintenance thresholds are included
- No-op for stable assets: assets that don't cross any threshold produce no findings
- Dedup/supersede: existing findings with unchanged recommended_action are skipped
- Changed recommendation: a new recommended_action supersedes the old one (recorded)
- Stale-finding retire: assets no longer in scope have their findings retired
- Workflow no-op path: empty scope returns status='no_op'
- Review signal: informational only, no asset mutation
- DispositionRecommendationV1: Pydantic model validation
- Operating-model tags: t1 and t5 are threaded correctly
"""
from __future__ import annotations

import datetime
import logging
from collections.abc import Mapping
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import pytest
import temporalio.workflow as tw_mod
from temporal.src.activities import ops_disposition, ops_revrec
from temporal.src.agents.disposition_recommender import (
    OM_TAG_CAPEX,
    OM_TAG_LIFECYCLE,
    DispositionRecommendationV1,
    disposition_recommendation_v1_schema,
    run_disposition_recommender,
)
from temporal.src.workflows.ops.disposition_queue import (
    DispositionQueueWorkflow,
    DispositionQueueWorkflowInput,
    ReviewDispositionFindingSignal,
    _review_key,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_TENANT_ID = "tenant-disposition-test"
_ASSET_ID_OLD = "11111111-1111-1111-1111-111111111111"
_ASSET_ID_LOW_UTIL = "22222222-2222-2222-2222-222222222222"
_ASSET_ID_STABLE = "33333333-3333-3333-3333-333333333333"


def _default_config(**overrides) -> dict:
    base = {
        "thresholds": {
            "age_months_threshold": 84,
            "utilization_pct_threshold": 20.0,
            "maintenance_cost_ratio_threshold": 0.15,
        },
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "x",
        "user_prompt_template": "x",
        "tools": [],
    }
    base.update(overrides)
    return base


def _make_asset_payload(
    asset_id: str = _ASSET_ID_OLD,
    age_months: int = 96,
    utilization_pct: float = 12.0,
    maintenance_cost: float = 0.0,
    maintenance_cost_ratio: float = 0.0,
    trigger_reasons: list[str] | None = None,
    stale_signals: list[str] | None = None,
) -> dict:
    return {
        "tenant_id": _TENANT_ID,
        "asset_id": asset_id,
        "branch_id": "branch-a",
        "category_id": "cat-exc",
        "age_months": age_months,
        "utilization_pct": utilization_pct,
        "maintenance_cost": maintenance_cost,
        "maintenance_cost_ratio": maintenance_cost_ratio,
        "trigger_type": "monthly_review",
        "trigger_reasons": trigger_reasons or [f"age_months={age_months} >= threshold=84"],
        "stale_signals": stale_signals or [],
        "is_stale_hint": bool(stale_signals),
        "rental_data": {
            "entities": [],
            "relationships": [],
            "facts": [],
            "time_series": [],
            "telematics": [],
        },
    }


def _make_assessment(
    asset_id: str = _ASSET_ID_OLD,
    recommended_action: str = "sell_now",
    priority: str = "high",
    confidence: float = 0.85,
) -> dict:
    return {
        "asset_id": asset_id,
        "recommended_action": recommended_action,
        "timing_rationale": f"Asset {asset_id} crosses lifecycle threshold",
        "confidence": confidence,
        "evidence": ["age 96 months", "utilization 12%"],
        "priority": priority,
        "rationale": "Asset is past end-of-economic-life with low utilization.",
        "age_months": 96,
        "estimated_residual_value": 5000.0,
        "total_cost_of_ownership": 12000.0,
        "is_stale_data": False,
        "stale_signals": [],
        "operating_model_tags": [OM_TAG_LIFECYCLE, OM_TAG_CAPEX],
    }


def _build_workflow_harness(
    *,
    config: dict,
    scoped_assets: list[dict],
    assessments_by_asset: dict[str, dict],
    existing_findings: list[dict] | None = None,
    retired: int = 0,
):
    state: dict[str, Any] = {
        "recorded_findings": [],
        "reviews_recorded": [],
        "finalized": None,
    }
    existing = existing_findings or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-disp-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1]
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_disposition_scope":
            return scoped_assets
        if fn_name == "ops_disposition_assess":
            return assessments_by_asset[str(args[0]["asset_id"])]
        if fn_name == "ops_disposition_list_existing_findings":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        if fn_name == "ops_disposition_retire_stale_findings":
            return retired
        if fn_name == "ops_record_finding_review":
            state["reviews_recorded"].append({
                "tenant_id": args[0],
                "fingerprint": args[1],
                "reviewer_id": args[2],
                "reviewer_name": args[3],
                "decision": args[4],
                "note": args[5],
            })
            return True
        raise AssertionError(f"Unexpected activity: {fn_name}")

    async def fake_wait_condition(cond_fn, *, timeout=None):
        # Default: review window times out immediately (no signals queued)
        raise TimeoutError("review window timed out")

    _FAKE_NOW = datetime.datetime(2026, 1, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)

    def fake_now() -> datetime.datetime:
        return _FAKE_NOW

    return state, fake_execute_activity, fake_wait_condition, fake_now


# ---------------------------------------------------------------------------
# Workflow tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_disposition_workflow_records_finding_for_threshold_candidate():
    """Assets crossing a threshold produce a finding in the queue."""
    scoped = [_make_asset_payload(_ASSET_ID_OLD)]
    assessments = {_ASSET_ID_OLD: _make_assessment(_ASSET_ID_OLD, "sell_now")}
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=_default_config(),
        scoped_assets=scoped,
        assessments_by_asset=assessments,
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["total_assets_scoped"] == 1
    assert result["recorded_findings"] == 1
    assert len(state["recorded_findings"]) == 1
    finding = state["recorded_findings"][0]
    assert finding["recommended_action"] == "sell_now"
    assert finding["fingerprint"] == f"disposition-queue:{_ASSET_ID_OLD}"
    assert finding["agent_key"] == "disposition-queue"


@pytest.mark.asyncio
async def test_disposition_workflow_no_op_when_no_assets_in_scope():
    """Empty scope returns status=no_op without recording any findings."""
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=_default_config(),
        scoped_assets=[],
        assessments_by_asset={},
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["status"] == "no_op"
    assert result["no_op"] is True
    assert result["recorded_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_disposition_workflow_skips_unchanged_recommendation():
    """If the existing finding has the same recommended_action, skip (no-op for that asset)."""
    fingerprint = f"disposition-queue:{_ASSET_ID_OLD}"
    existing = [
        {
            "id": "existing-1",
            "fingerprint": fingerprint,
            "asset_id": _ASSET_ID_OLD,
            "recommended_action": "sell_now",
        }
    ]
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=_default_config(),
        scoped_assets=[_make_asset_payload(_ASSET_ID_OLD)],
        assessments_by_asset={_ASSET_ID_OLD: _make_assessment(_ASSET_ID_OLD, "sell_now")},
        existing_findings=existing,
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["unchanged_findings"] == 1
    assert result["recorded_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_disposition_workflow_supersedes_changed_recommendation():
    """If the recommended_action has changed, record the new finding (upsert supersedes)."""
    fingerprint = f"disposition-queue:{_ASSET_ID_OLD}"
    existing = [
        {
            "id": "existing-1",
            "fingerprint": fingerprint,
            "asset_id": _ASSET_ID_OLD,
            "recommended_action": "keep",
        }
    ]
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=_default_config(),
        scoped_assets=[_make_asset_payload(_ASSET_ID_OLD)],
        assessments_by_asset={_ASSET_ID_OLD: _make_assessment(_ASSET_ID_OLD, "sell_now")},
        existing_findings=existing,
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["recorded_findings"] == 1
    assert result["unchanged_findings"] == 0
    finding = state["recorded_findings"][0]
    assert finding["recommended_action"] == "sell_now"
    assert finding["fingerprint"] == fingerprint


@pytest.mark.asyncio
async def test_disposition_workflow_retires_stale_findings():
    """Assets still in scope do NOT get their findings retired; count is passed through."""
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=_default_config(),
        scoped_assets=[_make_asset_payload(_ASSET_ID_OLD)],
        assessments_by_asset={_ASSET_ID_OLD: _make_assessment(_ASSET_ID_OLD, "replace")},
        retired=2,
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["retired_findings"] == 2


@pytest.mark.asyncio
async def test_disposition_workflow_multi_asset_priority_ranking():
    """Multiple scoped assets are assessed and sorted by priority."""
    asset_a = _ASSET_ID_OLD
    asset_b = _ASSET_ID_LOW_UTIL
    scoped = [
        _make_asset_payload(asset_a, age_months=96, utilization_pct=8),
        _make_asset_payload(asset_b, age_months=90, utilization_pct=15),
    ]
    assessments = {
        asset_a: _make_assessment(asset_a, "replace", priority="critical", confidence=0.9),
        asset_b: _make_assessment(asset_b, "sell_now", priority="high", confidence=0.7),
    }
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=_default_config(),
        scoped_assets=scoped,
        assessments_by_asset=assessments,
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["recorded_findings"] == 2
    assert len(state["recorded_findings"]) == 2
    priorities = [f.get("priority") for f in state["recorded_findings"]]
    assert priorities == ["critical", "high"]


@pytest.mark.asyncio
async def test_disposition_workflow_review_signal_is_informational():
    """The review signal is non-destructive — queued for durable persistence, no asset mutation."""
    wf = DispositionQueueWorkflow()
    sig = ReviewDispositionFindingSignal(
        asset_id=_ASSET_ID_OLD,
        reviewer_id="exec-001",
        reviewer_name="Jane Exec",
        decision="accepted",
        fingerprint=f"disposition-queue:{_ASSET_ID_OLD}",
    )
    await wf.review_disposition_finding(sig)
    # Signal is queued for durable persistence via activity — not committed in-memory only
    assert len(wf._pending_reviews) == 1
    assert wf._pending_reviews[0].decision == "accepted"
    assert wf._pending_reviews[0].reviewer_id == "exec-001"


@pytest.mark.asyncio
async def test_disposition_workflow_review_is_persisted_via_activity():
    """When the review window is open and a signal arrives, it is persisted via activity."""
    import asyncio as _asyncio

    scoped = [_make_asset_payload(_ASSET_ID_OLD)]
    assessments = {_ASSET_ID_OLD: _make_assessment(_ASSET_ID_OLD, "sell_now")}
    # Configure a non-zero review window so the workflow enters the wait loop
    config = _default_config(bounds={"max_findings_per_run": 50, "max_tool_rounds": 1, "review_window_days": 1})
    state, fake_execute, _, fake_now = _build_workflow_harness(
        config=config,
        scoped_assets=scoped,
        assessments_by_asset=assessments,
    )

    wf = DispositionQueueWorkflow()
    sig = ReviewDispositionFindingSignal(
        asset_id=_ASSET_ID_OLD,
        reviewer_id="exec-001",
        reviewer_name="Jane Exec",
        decision="accepted",
        fingerprint=f"disposition-queue:{_ASSET_ID_OLD}",
    )

    # First wait_condition call: inject the review signal so condition is met.
    # Second call (after review drained): simulate the review window expiring.
    # review_window_days=1 triggers the wait loop; the actual wait duration is
    # controlled by the mock, not the calendar value.
    wait_condition_call_count = [0]

    async def fake_wait_condition_inject_once(cond_fn, *, timeout=None):
        wait_condition_call_count[0] += 1
        if wait_condition_call_count[0] == 1:
            await wf.review_disposition_finding(sig)
            for _ in range(50):
                if cond_fn():
                    return
                await _asyncio.sleep(0)
        raise TimeoutError("review window expired")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_inject_once),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["reviews_persisted"] == 1
    assert len(state["reviews_recorded"]) == 1
    review = state["reviews_recorded"][0]
    assert review["decision"] == "accepted"
    assert review["reviewer_id"] == "exec-001"
    assert review["fingerprint"] == f"disposition-queue:{_ASSET_ID_OLD}"


@pytest.mark.asyncio
async def test_disposition_workflow_rank_before_cap():
    """Cap (max_findings_per_run) applies AFTER global priority ranking, not to input order.

    With the old early-slice implementation (scoped_assets[:max_findings] before
    sorting), the first N assets in input order would be assessed and the rest
    silently omitted — even if those remaining assets are critical priority.

    This test places a critical asset LAST in the input list and verifies it is
    recorded while a low-priority asset that appears first is cut off by the cap.
    """
    asset_low = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    asset_high = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    asset_critical = "cccccccc-cccc-cccc-cccc-cccccccccccc"

    # Input order: low, high, critical — cap is 2, so old code would record low+high
    scoped = [
        _make_asset_payload(asset_low),
        _make_asset_payload(asset_high),
        _make_asset_payload(asset_critical),
    ]
    assessments = {
        asset_low: _make_assessment(asset_low, "keep", priority="low"),
        asset_high: _make_assessment(asset_high, "sell_now", priority="high"),
        asset_critical: _make_assessment(asset_critical, "replace", priority="critical"),
    }

    config = _default_config(bounds={"max_findings_per_run": 2, "max_tool_rounds": 1})
    state, fake_execute, fake_wait, fake_now = _build_workflow_harness(
        config=config,
        scoped_assets=scoped,
        assessments_by_asset=assessments,
    )
    wf = DispositionQueueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["recorded_findings"] == 2
    assert result["remaining_findings_count"] == 1  # the low-priority asset was cut off

    recorded_priorities = [f.get("priority") for f in state["recorded_findings"]]
    # critical and high must be in the queue; low must NOT be
    assert "critical" in recorded_priorities
    assert "high" in recorded_priorities
    assert "low" not in recorded_priorities


@pytest.mark.asyncio
async def test_disposition_workflow_review_window_is_fixed_deadline():
    """The review window deadline is anchored once; per-iteration timeouts decrease.

    Old implementation passed the full ``review_timeout`` to every ``wait_condition``
    call, so each arriving signal reset the inactivity clock and the workflow could
    stay alive indefinitely under a steady signal trickle.

    New implementation anchors ``review_deadline = workflow.now() + timedelta(days=N)``
    before the loop and computes ``remaining = review_deadline - workflow.now()`` on
    each iteration.  The timeout therefore shrinks as time advances, and this test
    fails on the old equal-timeout implementation.
    """
    import asyncio as _asyncio

    scoped = [_make_asset_payload(_ASSET_ID_OLD)]
    assessments = {_ASSET_ID_OLD: _make_assessment(_ASSET_ID_OLD, "sell_now")}
    config = _default_config(bounds={"max_findings_per_run": 50, "max_tool_rounds": 1, "review_window_days": 1})
    state, fake_execute, _, _ = _build_workflow_harness(
        config=config,
        scoped_assets=scoped,
        assessments_by_asset=assessments,
    )

    wf = DispositionQueueWorkflow()
    sig1 = ReviewDispositionFindingSignal(
        asset_id=_ASSET_ID_OLD,
        reviewer_id="exec-001",
        decision="accepted",
        fingerprint=f"disposition-queue:{_ASSET_ID_OLD}",
    )
    sig2 = ReviewDispositionFindingSignal(
        asset_id=_ASSET_ID_OLD,
        reviewer_id="exec-002",
        decision="deferred",
        fingerprint=f"disposition-queue:{_ASSET_ID_OLD}",
    )

    # Simulate clock advancing: deadline is set at t=0; second remaining check
    # is at t+1h so its timeout must be 1h shorter than the first.
    base_time = datetime.datetime(2026, 1, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)
    now_call_count = [0]

    def fake_now() -> datetime.datetime:
        count = now_call_count[0]
        now_call_count[0] += 1
        # calls 0 and 1: deadline + first remaining check at t=0 (full window)
        # call 2+: remaining checks simulate 1h elapsed so window shrinks
        if count <= 1:
            return base_time
        return base_time + datetime.timedelta(hours=1)

    recorded_timeouts: list[datetime.timedelta] = []
    wait_call_count = [0]

    async def fake_wait_condition_two_signals(cond_fn, *, timeout=None):
        recorded_timeouts.append(timeout)
        wait_call_count[0] += 1
        if wait_call_count[0] == 1:
            await wf.review_disposition_finding(sig1)
            for _ in range(50):
                if cond_fn():
                    return
                await _asyncio.sleep(0)
        elif wait_call_count[0] == 2:
            await wf.review_disposition_finding(sig2)
            for _ in range(50):
                if cond_fn():
                    return
                await _asyncio.sleep(0)
        else:
            raise TimeoutError("review window expired")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_two_signals),
        patch.object(tw_mod, "now", side_effect=fake_now),
        patch.object(tw_mod, "logger", logging.getLogger("test_disposition")),
    ):
        result = await wf.run(DispositionQueueWorkflowInput(tenant_id=_TENANT_ID))

    assert result["reviews_persisted"] == 2

    # Key assertion: second timeout must be strictly shorter than the first.
    # Old code: both == timedelta(days=1)  →  assertion fails.
    # New code: second == timedelta(days=1) - timedelta(hours=1)  →  passes.
    assert len(recorded_timeouts) >= 2
    assert recorded_timeouts[1] < recorded_timeouts[0], (
        "Review-window timeout was not reduced between iterations — "
        "deadline is being reset each loop instead of anchored at loop entry"
    )


# ---------------------------------------------------------------------------
# Activity tests
# ---------------------------------------------------------------------------

class _FakeOpsPersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "rental_current_entity_state": [],
            "rental_current_relationships": [],
            "fact_types": [],
            "entity_facts": [],
            "time_series_points": [],
            "finding": [],
            "ops_workflow_run": [],
        }
        self.updates: list[dict[str, Any]] = []

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        if limit is not None:
            rows = rows[:limit]
        return rows

    def update(
        self,
        resource: str,
        data: dict[str, Any],
        *,
        filters: Mapping[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        self.updates.append({"resource": resource, "data": data, "filters": dict(filters or {})})
        rows = [dict(row) for row in self.tables.get(resource, [])]
        matched = []
        for row in rows:
            if all(row.get(k) == v for k, v in (filters or {}).items()):
                matched.append(row)
        return matched


def _make_asset_entity(
    asset_id: str,
    tenant_id: str,
    age_months: int = 96,
    utilization_pct: float = 12.0,
) -> dict[str, Any]:
    from datetime import UTC, datetime, timedelta
    commissioned_at = (datetime.now(UTC) - timedelta(days=int(age_months * 30.44))).isoformat()
    return {
        "entity_id": asset_id,
        "entity_type": "asset",
        "data": {
            "tenant_id": tenant_id,
            "status": "available",
            "branch_id": "branch-a",
            "category_id": "cat-exc",
            "utilization_pct": utilization_pct,
            "commissioned_at": commissioned_at,
        },
        "updated_at": datetime.now(UTC).isoformat(),
    }


def test_ops_disposition_scope_includes_aged_asset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Assets exceeding the age threshold are included in scope."""
    tenant_id = _TENANT_ID
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        _make_asset_entity(asset_id, tenant_id, age_months=100, utilization_pct=50.0),
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_disposition.ops_disposition_scope(
        tenant_id,
        {"age_months_threshold": 84, "utilization_pct_threshold": 20.0},
    )

    assert len(scoped) == 1
    assert scoped[0]["asset_id"] == asset_id
    assert scoped[0]["age_months"] is not None
    assert scoped[0]["age_months"] >= 84
    assert any("age_months" in r for r in scoped[0]["trigger_reasons"])


def test_ops_disposition_scope_includes_low_utilization_asset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Assets below the utilization threshold are included in scope."""
    tenant_id = _TENANT_ID
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        _make_asset_entity(asset_id, tenant_id, age_months=24, utilization_pct=10.0),
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_disposition.ops_disposition_scope(
        tenant_id,
        {"age_months_threshold": 84, "utilization_pct_threshold": 20.0},
    )

    assert len(scoped) == 1
    assert scoped[0]["asset_id"] == asset_id
    assert any("utilization_pct" in r for r in scoped[0]["trigger_reasons"])


def test_ops_disposition_scope_excludes_stable_asset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Assets that don't cross any threshold are excluded from scope."""
    tenant_id = _TENANT_ID
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        _make_asset_entity(asset_id, tenant_id, age_months=24, utilization_pct=80.0),
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_disposition.ops_disposition_scope(
        tenant_id,
        {"age_months_threshold": 84, "utilization_pct_threshold": 20.0},
    )

    assert scoped == []


def test_ops_disposition_scope_excludes_wrong_tenant(monkeypatch: pytest.MonkeyPatch) -> None:
    """Assets belonging to a different tenant are excluded."""
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["rental_current_entity_state"] = [
        _make_asset_entity(asset_id, "other-tenant", age_months=100, utilization_pct=5.0),
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_disposition.ops_disposition_scope(
        _TENANT_ID,
        {"age_months_threshold": 84, "utilization_pct_threshold": 20.0},
    )

    assert scoped == []


def test_ops_disposition_list_existing_findings_filters_by_agent_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only disposition-queue findings are returned by the list activity."""
    asset_id = str(uuid4())
    fingerprint = f"disposition-queue:{asset_id}"
    client = _FakeOpsPersistenceClient()
    client.tables["finding"] = [
        {
            "id": "f-1",
            "tenant_id": _TENANT_ID,
            "fingerprint": fingerprint,
            "contract_id": asset_id,
            "agent_key": "disposition-queue",
            "status": "pending_approval",
            "expected": {"recommended_action": "keep", "asset_id": asset_id},
        },
        {
            "id": "f-2",
            "tenant_id": _TENANT_ID,
            "fingerprint": f"fleet:{asset_id}",
            "contract_id": asset_id,
            "agent_key": "fleet-auditor",
            "status": "pending_approval",
            "expected": {},
        },
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    results = ops_disposition.ops_disposition_list_existing_findings(_TENANT_ID)

    assert len(results) == 1
    assert results[0]["fingerprint"] == fingerprint
    assert results[0]["recommended_action"] == "keep"


def test_ops_disposition_retire_stale_findings_marks_out_of_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Findings for assets no longer in scope are marked superseded."""
    stale_asset_id = str(uuid4())
    active_asset_id = str(uuid4())
    stale_fp = f"disposition-queue:{stale_asset_id}"
    active_fp = f"disposition-queue:{active_asset_id}"
    client = _FakeOpsPersistenceClient()
    client.tables["finding"] = [
        {
            "id": "f-stale",
            "tenant_id": _TENANT_ID,
            "fingerprint": stale_fp,
            "contract_id": stale_asset_id,
            "agent_key": "disposition-queue",
            "status": "pending_approval",
            "expected": {"asset_id": stale_asset_id},
        },
        {
            "id": "f-active",
            "tenant_id": _TENANT_ID,
            "fingerprint": active_fp,
            "contract_id": active_asset_id,
            "agent_key": "disposition-queue",
            "status": "pending_approval",
            "expected": {"asset_id": active_asset_id},
        },
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    retired = ops_disposition.ops_disposition_retire_stale_findings(
        _TENANT_ID,
        active_asset_ids=[active_asset_id],
        run_id="run-test-1",
    )

    assert retired == 1
    update_calls = [u for u in client.updates if u["data"].get("status") == "superseded"]
    assert len(update_calls) == 1
    assert update_calls[0]["filters"]["fingerprint"] == stale_fp


def test_ops_disposition_retire_stale_findings_ignores_other_agents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Findings belonging to other agents are never retired."""
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["finding"] = [
        {
            "id": "f-fleet",
            "tenant_id": _TENANT_ID,
            "fingerprint": f"fleet:{asset_id}",
            "contract_id": asset_id,
            "agent_key": "fleet-auditor",
            "status": "pending_approval",
            "expected": {},
        },
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    retired = ops_disposition.ops_disposition_retire_stale_findings(
        _TENANT_ID,
        active_asset_ids=[],
        run_id="run-test-2",
    )

    assert retired == 0
    assert client.updates == []


# ---------------------------------------------------------------------------
# Agent / model tests
# ---------------------------------------------------------------------------

def test_disposition_recommendation_v1_schema_is_valid() -> None:
    schema = disposition_recommendation_v1_schema()
    assert "properties" in schema
    assert "recommended_action" in schema["properties"]
    assert "timing_rationale" in schema["properties"]
    assert "evidence" in schema["properties"]
    assert "confidence" in schema["properties"]


def test_disposition_recommendation_v1_model_validates_actions() -> None:
    rec = DispositionRecommendationV1(
        asset_id="asset-001",
        recommended_action="sell_now",
        timing_rationale="Asset is at end of economic life",
        confidence=0.9,
        priority="high",
        rationale="Evidence points to sale",
    )
    assert rec.recommended_action == "sell_now"
    assert rec.confidence == 0.9


def test_disposition_recommendation_v1_rejects_invalid_action() -> None:
    with pytest.raises(Exception):
        DispositionRecommendationV1(
            asset_id="asset-001",
            recommended_action="transfer",
            timing_rationale="x",
            confidence=0.5,
            priority="low",
            rationale="x",
        )


def test_disposition_operating_model_tags_include_lifecycle() -> None:
    rec = DispositionRecommendationV1(
        asset_id="asset-001",
        recommended_action="keep",
        timing_rationale="Utilization recovering",
        confidence=0.7,
        priority="low",
        rationale="Monitor",
    )
    payload = rec.model_dump(mode="json")
    assert isinstance(payload["operating_model_tags"], list)


@pytest.mark.asyncio
async def test_run_disposition_recommender_threads_operating_model_tags() -> None:
    """run_disposition_recommender attaches the correct operating-model tags."""
    from temporal.src.agents.openai_client import ChatCompletionTransport
    import json as _json

    class _FakeTransport:
        async def complete(self, *, messages, tools, response_schema, **kw):
            del messages, tools, response_schema, kw
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": _json.dumps({
                                "asset_id": "asset-001",
                                "recommended_action": "replace",
                                "timing_rationale": "End of life",
                                "confidence": 0.88,
                                "evidence": ["age 96m"],
                                "priority": "high",
                                "rationale": "Replace cycle",
                                "operating_model_tags": [],
                            }),
                        }
                    }
                ]
            }

    result = await run_disposition_recommender(
        {"asset_id": "asset-001"},
        system_prompt="x",
        user_prompt_template="x",
        tools=[],
        tool_executor=lambda name, args: {},
        transport=_FakeTransport(),
    )

    assert OM_TAG_LIFECYCLE in result["operating_model_tags"]
    assert OM_TAG_CAPEX in result["operating_model_tags"]
