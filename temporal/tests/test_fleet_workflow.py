from __future__ import annotations

import asyncio
import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.ops.fleet import (
    ApproveFleetFindingSignal,
    FleetUtilizationWorkflow,
    FleetUtilizationWorkflowInput,
    RejectFleetFindingSignal,
)

_MAX_CONDITION_CHECKS = 10


def _default_config(**overrides):
    base = {
        "auto_apply": False,
        "thresholds": {"utilization_pct_threshold": 30},
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "x",
        "user_prompt_template": "x",
        "tools": [],
    }
    base.update(overrides)
    return base


def _build_harness(
    *,
    config: dict,
    scoped_assets: list[dict],
    assessments_by_asset: dict[str, dict],
    existing_fingerprints: list[str] | None = None,
):
    state = {
        "recorded_findings": [],
        "dispositions": [],
        "transfer_requests": [],
        "handoff_drafts": [],
        "finalized": None,
    }
    existing = existing_fingerprints or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-fleet-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1]
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_scope_fleet_assets":
            return scoped_assets
        if fn_name == "ops_fleet_assess":
            return assessments_by_asset[str(args[0]["asset_id"])]
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        if fn_name == "ops_requires_transfer_approval":
            return bool(config.get("force_transfer_approval", False))
        if fn_name == "ops_transfer_request_payload":
            finding = args[0]
            approver = args[1] if len(args) >= 2 else None
            requested_by = str((approver or {}).get("approver_id") or "ops-fleet-auditor")
            payload = {
                "asset_id": str(finding.get("asset_id") or ""),
                "origin_branch_id": str(finding.get("home_branch_id") or ""),
                "destination_branch_id": str(finding.get("target_branch_id") or ""),
                "requested_by": requested_by,
                "sourcing_decision_id": str(finding.get("fingerprint") or ""),
                "requested_ship_date": finding.get("requested_ship_date"),
                "expected_receive_date": finding.get("expected_receive_date"),
                "asset_scope": finding.get("asset_id"),
                "internal_cost": finding.get("estimated_transfer_cost"),
                "transfer_exception_reason": finding.get("transfer_exception_reason"),
                "origin_project_id": finding.get("origin_project_id"),
                "destination_project_id": finding.get("destination_project_id"),
            }
            return payload
        if fn_name == "ops_draft_disposition_handoff":
            state["handoff_drafts"].append(
                {"finding": args[0], "approver": args[1] if len(args) >= 2 else None}
            )
            return {
                "handoff_id": "handoff-1",
                "status": "draft",
                "handoff_path": "procurement",
                "disposition": "replace",
            }
        if fn_name == "ops_record_finding_disposition":
            state["dispositions"].append(
                {
                    "finding": args[0],
                    "disposition": args[1],
                    "approver": args[3],
                }
            )
            return True
        raise AssertionError(f"Unexpected activity: {fn_name}")
    return state, fake_execute_activity


@pytest.mark.asyncio
async def test_fleet_brief_collapses_same_branch_category_to_canonical_item():
    asset_id_1 = "11111111-1111-1111-1111-111111111111"
    asset_id_2 = "22222222-2222-2222-2222-222222222222"
    branch_id = "branch-a"
    category_id = "cat-exc"
    scoped_assets = [
        {
            "asset_id": asset_id_1,
            "home_branch_id": branch_id,
            "category_id": category_id,
            "utilization_pct": 12,
            "benchmark_utilization_pct": 70,
            "benchmark_evidence": ["benchmark available"],
            "kpi_evidence": ["2 KPI signals in audit window."],
            "telematics_evidence": ["4 telematics signals in audit window."],
            "stale_signals": [],
        },
        {
            "asset_id": asset_id_2,
            "home_branch_id": branch_id,
            "category_id": category_id,
            "utilization_pct": 19,
            "benchmark_utilization_pct": 68,
            "benchmark_evidence": ["benchmark available"],
            "kpi_evidence": ["2 KPI signals in audit window."],
            "telematics_evidence": ["4 telematics signals in audit window."],
            "stale_signals": [],
        },
    ]
    assessments = {
        asset_id_1: {
            "asset_id": asset_id_1,
            "disposition": "transfer",
            "target_branch_id": None,
            "utilization_pct": 12,
            "estimated_monthly_revenue_uplift": 0,
            "evidence": ["idle 45 days"],
            "confidence": 0.9,
            "rationale": "low demand locally",
        },
        asset_id_2: {
            "asset_id": asset_id_2,
            "disposition": "keep",
            "target_branch_id": None,
            "utilization_pct": 19,
            "estimated_monthly_revenue_uplift": 0,
            "evidence": ["idle 31 days"],
            "confidence": 0.8,
            "rationale": "monitor",
        },
    }
    state, fake_execute = _build_harness(
        config=_default_config(),
        scoped_assets=scoped_assets,
        assessments_by_asset=assessments,
    )
    wf = FleetUtilizationWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a"))

    assert result["total_assets_scoped"] == 2
    assert result["recorded_findings"] == 1
    assert result["deduped_findings"] == 1
    assert len(state["recorded_findings"]) == 1
    finding = state["recorded_findings"][0]
    assert finding["finding_type"] == "cross_branch_utilization_outlier"
    assert finding["recommendation_path"] == "transfer"
    assert finding["fingerprint"] == f"cross_branch_utilization:{branch_id}:{category_id}:cross_branch_utilization_outlier:transfer"


@pytest.mark.asyncio
async def test_fleet_workflow_explicit_no_op_when_no_network_signal():
    state, fake_execute = _build_harness(
        config=_default_config(),
        scoped_assets=[],
        assessments_by_asset={},
    )
    wf = FleetUtilizationWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a"))

    assert result["status"] == "no_op"
    assert result["no_op"] is True
    assert result["recorded_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_fleet_workflow_no_op_when_all_findings_are_deduped():
    asset_id = "11111111-1111-1111-1111-111111111111"
    branch_id = "branch-a"
    category_id = "cat-exc"
    fingerprint = f"cross_branch_utilization:{branch_id}:{category_id}:cross_branch_utilization_outlier:transfer"
    state, fake_execute = _build_harness(
        config=_default_config(),
        scoped_assets=[
            {
                "asset_id": asset_id,
                "home_branch_id": branch_id,
                "category_id": category_id,
                "utilization_pct": 12,
                "benchmark_utilization_pct": 70,
                "benchmark_evidence": ["benchmark available"],
                "kpi_evidence": ["2 KPI signals in audit window."],
                "telematics_evidence": ["4 telematics signals in audit window."],
                "stale_signals": [],
            }
        ],
        assessments_by_asset={
            asset_id: {
                "asset_id": asset_id,
                "disposition": "transfer",
                "target_branch_id": None,
                "utilization_pct": 12,
                "estimated_monthly_revenue_uplift": 0,
                "evidence": ["idle 45 days"],
                "confidence": 0.9,
                "rationale": "low demand locally",
            }
        },
        existing_fingerprints=[fingerprint],
    )
    wf = FleetUtilizationWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a"))

    assert result["status"] == "no_op"
    assert result["no_op"] is True
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 1
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_fleet_brief_threads_operating_model_tags_and_stale_uncertainty():
    asset_id = "11111111-1111-1111-1111-111111111111"
    scoped_assets = [
        {
            "asset_id": asset_id,
            "home_branch_id": "branch-a",
            "category_id": "cat-telehandler",
            "utilization_pct": 10,
            "benchmark_utilization_pct": None,
            "benchmark_evidence": ["Benchmark unavailable for this branch/asset class."],
            "kpi_evidence": ["1 KPI signals in audit window."],
            "telematics_evidence": ["0 telematics signals in audit window."],
            "stale_signals": ["Telematics signal is stale or missing."],
        }
    ]
    assessments = {
        asset_id: {
            "asset_id": asset_id,
            "home_branch_id": "branch-a",
            "disposition": "sell",
            "target_branch_id": None,
            "utilization_pct": 10,
            "estimated_monthly_revenue_uplift": 900,
            "evidence": ["utilization below target"],
            "confidence": 0.6,
            "rationale": "consider buy-vs-redeploy analysis",
        }
    }
    state, fake_execute = _build_harness(
        config=_default_config(),
        scoped_assets=scoped_assets,
        assessments_by_asset=assessments,
    )
    wf = FleetUtilizationWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a"))

    assert result["recorded_findings"] == 1
    finding = state["recorded_findings"][0]
    assert finding["recommendation_path"] == "regional_follow_up"
    assert "Telematics signal is stale or missing." in finding["stale_signals"]
    assert sorted(finding["operating_model_tags"]) == sorted(
        [
            "operations-executive:t1",
            "operations-executive:t3",
            "operations-executive:t4",
            "operations-executive:t7",
        ]
    )


@pytest.mark.asyncio
async def test_fleet_workflow_blocks_recommendation_with_missing_snapshot_sources():
    asset_id = "33333333-3333-3333-3333-333333333333"
    scoped_assets = [
        {
            "asset_id": asset_id,
            "home_branch_id": "branch-a",
            "category_id": "cat-exc",
            "utilization_pct": 12,
            "benchmark_utilization_pct": 65,
            "benchmark_evidence": ["benchmark available"],
            "kpi_evidence": ["1 KPI signals in audit window."],
            "telematics_evidence": ["0 telematics signals in audit window."],
            "stale_signals": ["Utilization signal is stale or missing."],
            "source_gaps": ["missing_market_context", "stale_utilization"],
            "source_gap_state": "blocked",
            "demand_gap_state": "manual_evidence_required",
            "demand_gap_snapshot": {
                "category_id": "cat-exc",
                "home_branch_id": "branch-a",
                "manual_evidence": ["No branch/category demand evidence was found in the audit window."],
            },
            "threshold_flags": ["utilization_pct_threshold"],
            "lifecycle_snapshot": {"market_context": {"resale_value": None, "replacement_cost": None}},
        }
    ]
    assessments = {
        asset_id: {
            "asset_id": asset_id,
            "disposition": "transfer",
            "target_branch_id": "branch-b",
            "utilization_pct": 12,
            "estimated_monthly_revenue_uplift": 1250,
            "evidence": ["idle 40 days"],
            "confidence": 0.92,
            "rationale": "under-utilized locally",
        }
    }
    state, fake_execute = _build_harness(
        config=_default_config(),
        scoped_assets=scoped_assets,
        assessments_by_asset=assessments,
    )
    wf = FleetUtilizationWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a"))

    assert result["recorded_findings"] == 1
    finding = state["recorded_findings"][0]
    assert finding["recommendation_path"] == "regional_follow_up"
    assert finding["recommendation_blocked"] is True
    assert finding["source_gap_state"] == "blocked"
    assert finding["demand_gap_state"] == "manual_evidence_required"
    assert "missing_market_context" in finding["source_gaps"]
    assert finding["target_branch_id"] is None
    assert "manual evidence required before branch action" in " ".join(finding["assumptions"]).lower()
    assert finding["confidence"] == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_fleet_workflow_approved_dispatch_writes_and_persists_final_plan():
    asset_id = "44444444-4444-4444-4444-444444444444"
    fingerprint = "cross_branch_utilization:branch-a:cat-exc:cross_branch_utilization_outlier:buy"
    state, fake_execute = _build_harness(
        config=_default_config(force_transfer_approval=True),
        scoped_assets=[{"asset_id": asset_id, "home_branch_id": "branch-a", "category_id": "cat-exc"}],
        assessments_by_asset={
            asset_id: {
                "asset_id": asset_id,
                "home_branch_id": "branch-a",
                "target_branch_id": "branch-b",
                "finding_type": "cross_branch_utilization_outlier",
                "disposition": "replace",
                "utilization_pct": 12,
                "estimated_monthly_revenue_uplift": 1500,
                "evidence": ["idle 41 days"],
                "confidence": 0.93,
                "rationale": "transfer to demand branch",
                "fingerprint": fingerprint,
            }
        },
    )
    wf = FleetUtilizationWorkflow()

    async def fake_wait_condition_inject_approve(cond_fn, *, timeout=None):
        _ = timeout
        await wf.approve_finding(
            ApproveFleetFindingSignal(
                asset_id=asset_id,
                finding_type="cross_branch_utilization_outlier",
                approver_id="manager-1",
                fingerprint=fingerprint,
                approver_name="Manager",
                note="approve dispatch plan",
            )
        )
        await _wait_until_condition(cond_fn, error_message="timed out waiting for approval")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_inject_approve),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1))

    assert result["approved_findings"] == 1
    assert result["dispatch_plan_writes"] == 1
    assert result["rejected_findings"] == 0
    assert result["timed_out_findings"] == 0
    assert len(state["handoff_drafts"]) == 1
    assert state["handoff_drafts"][0]["approver"]["approver_id"] == "manager-1"
    disposition = state["dispositions"][0]
    assert disposition["disposition"] == "approved"
    assert disposition["finding"]["dispatch_outcome"] == "approved"
    assert disposition["finding"]["dispatch_proposal"]["requested_by"] == "ops-fleet-auditor"
    assert disposition["finding"]["approved_dispatch_plan"]["handoff_id"] == "handoff-1"


@pytest.mark.asyncio
async def test_fleet_workflow_reject_and_timeout_are_audit_only():
    asset_id = "55555555-5555-5555-5555-555555555555"
    fingerprint = "cross_branch_utilization:branch-a:cat-exc:cross_branch_utilization_outlier:buy"
    scoped_assets = [{"asset_id": asset_id, "home_branch_id": "branch-a", "category_id": "cat-exc"}]
    assessments = {
        asset_id: {
            "asset_id": asset_id,
            "home_branch_id": "branch-a",
            "target_branch_id": "branch-b",
            "finding_type": "cross_branch_utilization_outlier",
            "disposition": "sell",
            "utilization_pct": 11,
            "estimated_monthly_revenue_uplift": 1300,
            "evidence": ["idle 39 days"],
            "confidence": 0.9,
            "rationale": "transfer recommended",
            "fingerprint": fingerprint,
        }
    }

    reject_state, reject_execute = _build_harness(
        config=_default_config(force_transfer_approval=True),
        scoped_assets=scoped_assets,
        assessments_by_asset=assessments,
    )
    reject_wf = FleetUtilizationWorkflow()

    async def fake_wait_condition_inject_reject(cond_fn, *, timeout=None):
        _ = timeout
        await reject_wf.reject_finding(
            RejectFleetFindingSignal(
                asset_id=asset_id,
                finding_type="cross_branch_utilization_outlier",
                approver_id="manager-2",
                fingerprint=fingerprint,
                approver_name="Manager",
                note="reject dispatch plan",
            )
        )
        await _wait_until_condition(cond_fn, error_message="timed out waiting for rejection")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=reject_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_inject_reject),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        reject_result = await reject_wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1))

    assert reject_result["rejected_findings"] == 1
    assert reject_result["dispatch_plan_writes"] == 0
    assert reject_state["handoff_drafts"] == []
    assert reject_state["dispositions"][0]["disposition"] == "rejected"
    assert reject_state["dispositions"][0]["finding"]["dispatch_outcome"] == "rejected"
    assert reject_state["dispositions"][0]["finding"]["dispatch_proposal"]["requested_by"] == "ops-fleet-auditor"

    timeout_state, timeout_execute = _build_harness(
        config=_default_config(force_transfer_approval=True),
        scoped_assets=scoped_assets,
        assessments_by_asset=assessments,
    )
    timeout_wf = FleetUtilizationWorkflow()

    async def fake_wait_condition_timeout(_cond_fn, *, timeout=None):
        _ = timeout
        raise TimeoutError("timeout")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=timeout_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_timeout),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        timeout_result = await timeout_wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1))

    assert timeout_result["timed_out_findings"] == 1
    assert timeout_result["dispatch_plan_writes"] == 0
    assert timeout_state["handoff_drafts"] == []
    assert timeout_state["dispositions"][0]["disposition"] == "timed_out"
    assert timeout_state["dispositions"][0]["finding"]["dispatch_outcome"] == "timed_out"
    assert timeout_state["dispositions"][0]["finding"]["dispatch_proposal"]["asset_id"] == asset_id


@pytest.mark.asyncio
async def test_fleet_workflow_duplicate_signal_key_is_accepted_for_approval():
    asset_id = "66666666-6666-6666-6666-666666666666"
    fingerprint = "cross_branch_utilization:branch-a:cat-exc:cross_branch_utilization_outlier:buy"
    state, fake_execute = _build_harness(
        config=_default_config(force_transfer_approval=True),
        scoped_assets=[{"asset_id": asset_id, "home_branch_id": "branch-a", "category_id": "cat-exc"}],
        assessments_by_asset={
            asset_id: {
                "asset_id": asset_id,
                "home_branch_id": "branch-a",
                "target_branch_id": "branch-b",
                "finding_type": "cross_branch_utilization_outlier",
                "disposition": "replace",
                "utilization_pct": 9,
                "estimated_monthly_revenue_uplift": 1800,
                "evidence": ["retire and replace"],
                "confidence": 0.95,
                "rationale": "asset lifecycle replacement recommendation",
                "fingerprint": fingerprint,
            }
        },
    )
    wf = FleetUtilizationWorkflow()

    async def inject_approval_signal_during_wait(cond_fn, *, timeout=None):
        _ = timeout
        await wf.approve_finding(
            ApproveFleetFindingSignal(
                asset_id=asset_id,
                finding_type="cross_branch_utilization_outlier",
                approver_id="manager-3",
                approver_name="Manager",
                note="duplicate signal using canonical key",
            )
        )
        await _wait_until_condition(cond_fn, error_message="timed out waiting for duplicate key approval")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=inject_approval_signal_during_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_fleet_workflow")),
    ):
        result = await wf.run(FleetUtilizationWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1))

    assert result["approved_findings"] == 1
    assert result["dispatch_plan_writes"] == 1
    assert state["dispositions"][0]["disposition"] == "approved"


async def _wait_until_condition(cond_fn, *, error_message: str) -> None:
    for _ in range(_MAX_CONDITION_CHECKS):
        if cond_fn():
            return
        await asyncio.sleep(0)
    raise TimeoutError(error_message)
