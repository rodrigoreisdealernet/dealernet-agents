from __future__ import annotations

import asyncio
import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.ops.credit import (
    ApproveCreditFindingSignal,
    CreditRiskWorkflow,
    CreditRiskWorkflowInput,
    RejectCreditFindingSignal,
)

# Maximum poll iterations before we give up waiting for a simulated approval
# signal in tests.  200 × asyncio.sleep(0) flushes the event loop without any
# real wall-clock delay while still being a clear test-harness bound.
_MAX_APPROVAL_WAIT_ITERATIONS = 200


def _default_config(**overrides: object) -> dict:
    base: dict = {
        "auto_apply": False,
        "thresholds": {
            "min_confidence_to_surface": 0.6,
            "overdue_threshold": 500,
        },
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "Assess credit risk.",
        "user_prompt_template": "Assess {account_id}.",
        "tools": [],
    }
    base.update(overrides)
    return base


def _build_harness(
    *,
    config: dict,
    scoped_accounts: list[dict],
    assessments_by_account: dict[str, dict],
    existing_fingerprints: list[str] | None = None,
):
    state: dict = {
        "recorded_findings": [],
        "dispositions": [],
        "finalized": None,
        "scope_run_context": None,
    }
    existing = existing_fingerprints or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-credit-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1]
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_scope_credit_accounts":
            # Capture the run_context so tests can assert on forwarded thresholds
            state["scope_run_context"] = args[1] if len(args) > 1 else {}
            return scoped_accounts
        if fn_name == "ops_credit_assess":
            return assessments_by_account[str(args[0]["account_id"])]
        if fn_name == "ops_list_existing_findings":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        if fn_name == "ops_record_finding_disposition":
            state["dispositions"].append(
                {"finding": args[0], "disposition": args[1], "approver": args[3]}
            )
            return True
        raise AssertionError(f"Unexpected activity: {fn_name}")

    async def fake_wait_condition(cond_fn, *, timeout=None):
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out waiting for decision")

    return state, fake_execute_activity, fake_wait_condition


@pytest.mark.asyncio
async def test_credit_workflow_records_no_op_run_state_when_no_material_signal_exists():
    account_id_1 = "aaaa0001-0000-0000-0000-000000000001"
    account_id_2 = "aaaa0002-0000-0000-0000-000000000002"
    scoped = [
        {"account_id": account_id_1, "tenant_id": "tenant-a"},
        {"account_id": account_id_2, "tenant_id": "tenant-a"},
    ]
    assessments = {
        account_id_1: {
            "account_id": account_id_1,
            "risk_level": "low",
            "proposed_action": "no_op",
            "current_exposure": 500.0,
            "overdue_amount": 0.0,
            "oldest_overdue_days": 0,
            "escalation_stage": "no_op",
            "material_signal_key": "sig-1",
            "aging_trend": "stable",
            "payment_behavior_score": 0.9,
            "evidence": ["all paid"],
            "confidence": 0.85,
            "rationale": "stable",
        },
        account_id_2: {
            "account_id": account_id_2,
            "risk_level": "medium",
            "proposed_action": "no_op",
            "current_exposure": 2000.0,
            "overdue_amount": 0.0,
            "oldest_overdue_days": 0,
            "escalation_stage": "no_op",
            "material_signal_key": "sig-2",
            "aging_trend": "stable",
            "payment_behavior_score": 0.75,
            "evidence": ["slight delay"],
            "confidence": 0.70,
            "rationale": "monitor",
        },
    }

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(CreditRiskWorkflowInput(tenant_id="tenant-a"))

    assert result["total_accounts_scoped"] == 2
    assert result["recorded_findings"] == 0
    assert result["approved_findings"] == 0
    assert result["no_op_accounts"] == 2
    assert result["status"] == "no_op"
    assert result["workflow_state"] == "no_op"
    assert state["dispositions"] == []


@pytest.mark.asyncio
async def test_credit_workflow_deduplicates_existing_fingerprints():
    account_id_1 = "bbbb0001-0000-0000-0000-000000000001"
    account_id_2 = "bbbb0002-0000-0000-0000-000000000002"
    existing_fp = f"{account_id_2}:collections_priority"
    scoped = [
        {"account_id": account_id_1, "tenant_id": "tenant-a"},
        {"account_id": account_id_2, "tenant_id": "tenant-a"},
    ]
    assessment = {
        "risk_level": "high",
        "proposed_action": "review_notice_of_intent",
        "current_exposure": 8000.0,
        "overdue_amount": 6400.0,
        "oldest_overdue_days": 61,
        "escalation_stage": "approaching_formal_escalation",
        "aging_trend": "deteriorating",
        "payment_behavior_score": 0.3,
        "evidence": ["overdue"],
        "confidence": 0.88,
        "rationale": "high risk",
    }
    assessments = {
        account_id_1: {**assessment, "account_id": account_id_1, "material_signal_key": "new-signal"},
        account_id_2: {**assessment, "account_id": account_id_2, "material_signal_key": "same-signal"},
    }

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
        existing_fingerprints=[{"fingerprint": existing_fp, "expected": {"material_signal_key": "same-signal"}}],
    )

    wf = CreditRiskWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(
            CreditRiskWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=300)
        )

    assert result["total_accounts_scoped"] == 2
    assert result["no_op_accounts"] == 1
    assert result["recorded_findings"] == 1
    assert len(state["recorded_findings"]) == 1
    assert state["recorded_findings"][0]["account_id"] == account_id_1


@pytest.mark.asyncio
async def test_credit_workflow_approve_signal_records_approved_recommendation():
    account_id = "cccc0001-0000-0000-0000-000000000001"
    action = "review_notice_of_intent"
    risk = "high"
    fingerprint = f"{account_id}:collections_priority"
    scoped = [{"account_id": account_id, "tenant_id": "tenant-a"}]
    assessments = {
        account_id: {
            "account_id": account_id,
            "risk_level": risk,
            "proposed_action": action,
            "current_exposure": 9500.0,
            "overdue_amount": 7200.0,
            "oldest_overdue_days": 65,
            "escalation_stage": "approaching_formal_escalation",
            "material_signal_key": "signal-approve",
            "aging_trend": "deteriorating",
            "payment_behavior_score": 0.4,
            "evidence": ["overdue threshold crossed"],
            "confidence": 0.85,
            "rationale": "review NOI",
        }
    }

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()

    async def fake_wait_condition_inject_signal(cond_fn, *, timeout=None):
        # Inject approval signal before first check
        wf._decisions[fingerprint] = {  # noqa: SLF001
            "decision": "approved",
            "approver": {
                "approver_id": "credit.manager@example.com",
                "approver_name": "Credit Manager",
                "note": "Approved",
            },
        }
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_inject_signal),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(CreditRiskWorkflowInput(tenant_id="tenant-a"))

    assert result["approved_findings"] == 1
    assert state["dispositions"][0]["disposition"] == "approved"


@pytest.mark.asyncio
async def test_credit_workflow_reject_signal_records_rejection():
    account_id = "dddd0001-0000-0000-0000-000000000001"
    action = "review_lien_preparation"
    risk = "high"
    fingerprint = f"{account_id}:collections_priority"
    scoped = [{"account_id": account_id, "tenant_id": "tenant-a"}]
    assessments = {
        account_id: {
            "account_id": account_id,
            "risk_level": risk,
            "proposed_action": action,
            "current_exposure": 7500.0,
            "overdue_amount": 7300.0,
            "oldest_overdue_days": 97,
            "escalation_stage": "formal_escalation_review",
            "material_signal_key": "signal-reject",
            "aging_trend": "deteriorating",
            "payment_behavior_score": 0.3,
            "evidence": ["overdue"],
            "confidence": 0.82,
            "rationale": "lien review recommended",
        }
    }

    state, fake_execute, _ = _build_harness(
        config=_default_config(),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()

    async def fake_wait_condition_inject_reject(cond_fn, *, timeout=None):
        wf._decisions[fingerprint] = {  # noqa: SLF001
            "decision": "rejected",
            "approver": {
                "approver_id": "credit.manager@example.com",
                "approver_name": "Credit Manager",
                "note": "Long-standing customer, not a risk",
            },
        }
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_inject_reject),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(CreditRiskWorkflowInput(tenant_id="tenant-a"))

    assert result["rejected_findings"] == 1
    assert result["approved_findings"] == 0
    assert state["dispositions"][0]["disposition"] == "rejected"


@pytest.mark.asyncio
async def test_credit_workflow_timeout_records_timed_out():
    account_id = "eeee0001-0000-0000-0000-000000000001"
    scoped = [{"account_id": account_id, "tenant_id": "tenant-a"}]
    assessments = {
        account_id: {
            "account_id": account_id,
            "risk_level": "high",
            "proposed_action": "review_notice_of_intent",
            "current_exposure": 6000.0,
            "overdue_amount": 5400.0,
            "oldest_overdue_days": 62,
            "escalation_stage": "approaching_formal_escalation",
            "material_signal_key": "signal-timeout",
            "aging_trend": "deteriorating",
            "payment_behavior_score": 0.4,
            "evidence": ["overdue"],
            "confidence": 0.79,
            "rationale": "notify customer",
        }
    }

    state, fake_execute, _ = _build_harness(
        config=_default_config(),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()

    async def fake_wait_condition_timeout(cond_fn, *, timeout=None):
        # Never resolves — simulates timeout
        raise TimeoutError("timeout")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_timeout),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(CreditRiskWorkflowInput(tenant_id="tenant-a"))

    assert result["timed_out_findings"] == 1
    assert result["approved_findings"] == 0
    assert state["dispositions"][0]["disposition"] == "timed_out"


@pytest.mark.asyncio
async def test_credit_workflow_filters_low_confidence_proposals():
    """Collections recommendations below min_confidence_to_surface should not be surfaced."""
    account_id = "ffff0001-0000-0000-0000-000000000001"
    scoped = [{"account_id": account_id, "tenant_id": "tenant-a"}]
    assessments = {
        account_id: {
            "account_id": account_id,
            "risk_level": "medium",
            "proposed_action": "routine_follow_up",
            "current_exposure": 4000.0,
            "overdue_amount": 1200.0,
            "oldest_overdue_days": 32,
            "escalation_stage": "routine_follow_up",
            "material_signal_key": "signal-low-confidence",
            "aging_trend": "stable",
            "payment_behavior_score": 0.6,
            "evidence": ["minor delay"],
            "confidence": 0.40,  # Below 0.6 threshold
            "rationale": "borderline",
        }
    }

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(CreditRiskWorkflowInput(tenant_id="tenant-a"))

    assert result["processed_findings"] == 0
    assert result["recorded_findings"] == 0
    assert len(state["recorded_findings"]) == 0


@pytest.mark.asyncio
async def test_credit_workflow_approve_signal_handler():
    wf = CreditRiskWorkflow()
    sig = ApproveCreditFindingSignal(
        account_id="acct-1",
        finding_type="collections_priority",
        approver_id="mgr-1",
        fingerprint="fp-test",
        approver_name="Manager",
        note="Approved",
    )
    await wf.approve_finding(sig)
    assert "fp-test" in wf._decisions  # noqa: SLF001
    assert wf._decisions["fp-test"]["decision"] == "approved"  # noqa: SLF001


@pytest.mark.asyncio
async def test_credit_workflow_reject_signal_handler():
    wf = CreditRiskWorkflow()
    sig = RejectCreditFindingSignal(
        account_id="acct-2",
        finding_type="collections_priority",
        approver_id="mgr-2",
        fingerprint="fp-reject",
        approver_name="Manager",
        note="Not approved",
    )
    await wf.reject_finding(sig)
    assert "fp-reject" in wf._decisions  # noqa: SLF001
    assert wf._decisions["fp-reject"]["decision"] == "rejected"  # noqa: SLF001


@pytest.mark.asyncio
async def test_credit_workflow_bounds_max_findings_per_run():
    """Only max_findings_per_run proposals should be surfaced and recorded."""
    account_ids = [f"aaaa{i:04d}-0000-0000-0000-000000000001" for i in range(5)]
    scoped = [{"account_id": aid, "tenant_id": "tenant-a"} for aid in account_ids]
    assessments = {
        aid: {
            "account_id": aid,
            "risk_level": "high",
            "proposed_action": "review_notice_of_intent",
            "current_exposure": 9000.0,
            "overdue_amount": 6000.0,
            "oldest_overdue_days": 63,
            "escalation_stage": "approaching_formal_escalation",
            "material_signal_key": f"signal-{aid}",
            "aging_trend": "deteriorating",
            "payment_behavior_score": 0.3,
            "evidence": ["overdue"],
            "confidence": 0.85,
            "rationale": "high risk",
        }
        for aid in account_ids
    }

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 2, "max_tool_rounds": 1}),
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        result = await wf.run(
            CreditRiskWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1)
        )

    assert result["processed_findings"] == 2
    assert result["remaining_findings_count"] == 3


@pytest.mark.asyncio
async def test_credit_workflow_forwards_thresholds_to_scope_activity():
    """Thresholds from agent config must be threaded into the scope activity run_context."""
    account_id = "gggg0001-0000-0000-0000-000000000001"
    scoped = [{"account_id": account_id, "tenant_id": "tenant-a"}]
    assessments = {
        account_id: {
            "account_id": account_id,
            "risk_level": "low",
            "proposed_action": "no_op",
            "current_exposure": 100.0,
            "overdue_amount": 0.0,
            "oldest_overdue_days": 0,
            "escalation_stage": "no_op",
            "material_signal_key": "signal-forwarded",
            "aging_trend": "stable",
            "payment_behavior_score": 0.95,
            "evidence": [],
            "confidence": 0.9,
            "rationale": "healthy",
        }
    }

    config = _default_config(
        thresholds={
            "min_confidence_to_surface": 0.6,
            "overdue_threshold": 750,
            "exposure_utilization_pct": 85,
        }
    )
    state, fake_execute, fake_wait = _build_harness(
        config=config,
        scoped_accounts=scoped,
        assessments_by_account=assessments,
    )

    wf = CreditRiskWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_workflow")),
    ):
        await wf.run(CreditRiskWorkflowInput(tenant_id="tenant-a"))

    run_ctx = state["scope_run_context"]
    assert run_ctx is not None, "scope activity was not called"
    forwarded = run_ctx.get("thresholds") or {}
    assert forwarded.get("overdue_threshold") == 750
    assert forwarded.get("exposure_utilization_pct") == 85
