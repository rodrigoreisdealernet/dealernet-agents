from __future__ import annotations

import asyncio
import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.ops.credit_lien_control import (
    ApproveCreditLienFindingSignal,
    CreditLienControlWorkflow,
    CreditLienControlWorkflowInput,
    RejectCreditLienFindingSignal,
)

_MAX_APPROVAL_WAIT_ITERATIONS = 200


def _default_config(**overrides: object) -> dict:
    base: dict = {
        "auto_apply": False,
        "thresholds": {
            "min_confidence_to_surface": 0.6,
            "max_applications": 50,
            "max_obligations": 50,
        },
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "Assess.",
        "user_prompt_template": "Assess {obligation_id}.",
        "tools": [],
    }
    base.update(overrides)
    return base


def _make_application(n: int, *, signal_key: str = "", confidence: float = 0.85) -> dict:
    aid = f"app{n:04d}-0000-0000-0000-{n:012d}"
    return {
        "application_id": aid,
        "customer_id": f"cust-{n}",
        "account_id": f"acct-{n}",
        "risk_level": "medium",
        "recommended_action": "approve",
        "proposed_credit_limit": 30000.0,
        "proposed_terms": "net30",
        "current_credit_limit": 15000.0,
        "requested_credit_limit": 30000.0,
        "operating_model_tags": ["credit-billing-analyst:t2"],
        "evidence": ["trade reference verified"],
        "stale_inputs": [],
        "material_signal_key": signal_key or f"app-signal-{n}",
        "confidence": confidence,
        "rationale": "Approve.",
    }


def _make_deadline(n: int, *, signal_key: str = "", confidence: float = 0.85) -> dict:
    oid = f"dead{n:04d}-0000-0000-0000-{n:012d}"
    return {
        "obligation_id": oid,
        "project_id": f"proj-{n}",
        "account_id": f"acct-d{n}",
        "state": "CA",
        "deadline_date": "2026-07-01",
        "days_remaining": 14,
        "deadline_type": "preliminary_notice",
        "urgency": "warning",
        "notice_sent": False,
        "recommended_action": "schedule_notice",
        "operating_model_tags": ["credit-billing-analyst:t4"],
        "evidence": ["contract evidence"],
        "stale_inputs": [],
        "material_signal_key": signal_key or f"deadline-signal-{n}",
        "confidence": confidence,
        "rationale": "Schedule notice.",
    }


def _make_waiver(n: int, *, signal_key: str = "", confidence: float = 0.85) -> dict:
    oid = f"waiv{n:04d}-0000-0000-0000-{n:012d}"
    return {
        "obligation_id": oid,
        "project_id": f"proj-w{n}",
        "account_id": f"acct-w{n}",
        "payment_id": f"pay-{n}",
        "waiver_type": "conditional_partial",
        "payment_amount": 12000.0,
        "waiver_status": "pending_receipt",
        "recommended_action": "request_waiver",
        "operating_model_tags": ["credit-billing-analyst:t5"],
        "evidence": ["payment processed"],
        "stale_inputs": [],
        "material_signal_key": signal_key or f"waiver-signal-{n}",
        "confidence": confidence,
        "rationale": "Request waiver.",
    }


def _build_harness(
    *,
    config: dict,
    credit_applications: list[dict],
    lien_deadlines: list[dict],
    lien_waivers: list[dict],
    assessments_by_id: dict[str, dict],
    existing_fingerprints: list[dict] | None = None,
):
    existing = existing_fingerprints or []
    state: dict = {
        "recorded_findings": [],
        "dispositions": [],
        "finalized": None,
    }

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-lien-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1]
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_scope_credit_applications":
            return credit_applications
        if fn_name == "ops_scope_lien_deadlines":
            return lien_deadlines
        if fn_name == "ops_scope_lien_waivers":
            return lien_waivers
        if fn_name in ("ops_application_assess", "ops_lien_deadline_assess", "ops_lien_waiver_assess"):
            payload = args[0] if args else {}
            key = str(
                payload.get("application_id")
                or payload.get("obligation_id")
                or ""
            )
            return assessments_by_id[key]
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


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_credit_lien_workflow_no_op_when_all_no_op_actions() -> None:
    """Findings with no_op recommended_action should not be recorded."""
    app = _make_application(1)
    app["recommended_action"] = "no_op"
    dl = _make_deadline(1)
    dl["recommended_action"] = "no_op"
    wv = _make_waiver(1)
    wv["recommended_action"] = "no_op"

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        credit_applications=[{"application_id": app["application_id"]}],
        lien_deadlines=[{"obligation_id": dl["obligation_id"]}],
        lien_waivers=[{"obligation_id": wv["obligation_id"]}],
        assessments_by_id={
            app["application_id"]: app,
            dl["obligation_id"]: dl,
            wv["obligation_id"]: wv,
        },
    )

    wf = CreditLienControlWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(CreditLienControlWorkflowInput(tenant_id="tenant-a"))

    assert result["status"] == "no_op"
    assert result["recorded_findings"] == 0
    assert result["no_op_findings"] == 3


@pytest.mark.asyncio
async def test_credit_lien_workflow_deduplicates_existing_fingerprints() -> None:
    """Findings whose material_signal_key matches existing findings should be skipped."""
    app = _make_application(2, signal_key="existing-signal")
    dl = _make_deadline(2, signal_key="new-deadline-signal")

    existing_fp = f"{app['application_id']}:credit_application_review"
    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        credit_applications=[{"application_id": app["application_id"]}],
        lien_deadlines=[{"obligation_id": dl["obligation_id"]}],
        lien_waivers=[],
        assessments_by_id={
            app["application_id"]: app,
            dl["obligation_id"]: dl,
        },
        existing_fingerprints=[
            {"fingerprint": existing_fp, "expected": {"material_signal_key": "existing-signal"}}
        ],
    )

    wf = CreditLienControlWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(
            CreditLienControlWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=300)
        )

    assert result["credit_applications_scoped"] == 1
    assert result["lien_deadlines_scoped"] == 1
    assert result["no_op_findings"] == 1   # app deduped
    assert result["recorded_findings"] == 1  # deadline is new


@pytest.mark.asyncio
async def test_credit_lien_workflow_approve_signal_records_approved() -> None:
    """An approve signal must result in an approved disposition."""
    app = _make_application(3)
    fingerprint = f"{app['application_id']}:credit_application_review"

    state, fake_execute, _ = _build_harness(
        config=_default_config(),
        credit_applications=[{"application_id": app["application_id"]}],
        lien_deadlines=[],
        lien_waivers=[],
        assessments_by_id={app["application_id"]: app},
    )

    wf = CreditLienControlWorkflow()

    async def inject_approve(cond_fn, *, timeout=None):
        wf._decisions[fingerprint] = {  # noqa: SLF001
            "decision": "approved",
            "approver": {"approver_id": "analyst@example.com", "approver_name": "Analyst", "note": "OK"},
        }
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=inject_approve),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(CreditLienControlWorkflowInput(tenant_id="tenant-a"))

    assert result["approved_findings"] == 1
    assert state["dispositions"][0]["disposition"] == "approved"


@pytest.mark.asyncio
async def test_credit_lien_workflow_reject_signal_records_rejection() -> None:
    """A reject signal must result in a rejected disposition."""
    dl = _make_deadline(4)
    fingerprint = f"{dl['obligation_id']}:lien_deadline"

    state, fake_execute, _ = _build_harness(
        config=_default_config(),
        credit_applications=[],
        lien_deadlines=[{"obligation_id": dl["obligation_id"]}],
        lien_waivers=[],
        assessments_by_id={dl["obligation_id"]: dl},
    )

    wf = CreditLienControlWorkflow()

    async def inject_reject(cond_fn, *, timeout=None):
        wf._decisions[fingerprint] = {  # noqa: SLF001
            "decision": "rejected",
            "approver": {"approver_id": "analyst@example.com", "approver_name": "Analyst", "note": "No"},
        }
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=inject_reject),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(CreditLienControlWorkflowInput(tenant_id="tenant-a"))

    assert result["rejected_findings"] == 1
    assert result["approved_findings"] == 0
    assert state["dispositions"][0]["disposition"] == "rejected"


@pytest.mark.asyncio
async def test_credit_lien_workflow_timeout_records_timed_out() -> None:
    """When no approval arrives within timeout, finding must be recorded as timed_out."""
    wv = _make_waiver(5)

    state, fake_execute, _ = _build_harness(
        config=_default_config(),
        credit_applications=[],
        lien_deadlines=[],
        lien_waivers=[{"obligation_id": wv["obligation_id"]}],
        assessments_by_id={wv["obligation_id"]: wv},
    )

    wf = CreditLienControlWorkflow()

    async def fake_timeout(cond_fn, *, timeout=None):
        raise TimeoutError("timeout")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_timeout),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(CreditLienControlWorkflowInput(tenant_id="tenant-a"))

    assert result["timed_out_findings"] == 1
    assert result["approved_findings"] == 0
    assert state["dispositions"][0]["disposition"] == "timed_out"


@pytest.mark.asyncio
async def test_credit_lien_workflow_filters_low_confidence() -> None:
    """Proposals below min_confidence_to_surface must not be recorded."""
    app = _make_application(6, confidence=0.40)  # Below 0.6 threshold

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        credit_applications=[{"application_id": app["application_id"]}],
        lien_deadlines=[],
        lien_waivers=[],
        assessments_by_id={app["application_id"]: app},
    )

    wf = CreditLienControlWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(CreditLienControlWorkflowInput(tenant_id="tenant-a"))

    assert result["processed_findings"] == 0
    assert result["recorded_findings"] == 0


@pytest.mark.asyncio
async def test_credit_lien_workflow_bounds_max_findings_per_run() -> None:
    """Only max_findings_per_run findings should be processed."""
    applications = [_make_application(i) for i in range(5)]
    assessments = {a["application_id"]: a for a in applications}
    scoped = [{"application_id": a["application_id"]} for a in applications]

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 2, "max_tool_rounds": 1}),
        credit_applications=scoped,
        lien_deadlines=[],
        lien_waivers=[],
        assessments_by_id=assessments,
    )

    wf = CreditLienControlWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(
            CreditLienControlWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1)
        )

    assert result["processed_findings"] == 2
    assert result["remaining_findings_count"] == 3


@pytest.mark.asyncio
async def test_credit_lien_workflow_scopes_all_three_obligation_types() -> None:
    """Workflow must scope credit_applications, lien_deadlines, and lien_waivers in parallel."""
    app = _make_application(7)
    dl = _make_deadline(7)
    wv = _make_waiver(7)

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        credit_applications=[{"application_id": app["application_id"]}],
        lien_deadlines=[{"obligation_id": dl["obligation_id"]}],
        lien_waivers=[{"obligation_id": wv["obligation_id"]}],
        assessments_by_id={
            app["application_id"]: app,
            dl["obligation_id"]: dl,
            wv["obligation_id"]: wv,
        },
    )

    wf = CreditLienControlWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(
            CreditLienControlWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1)
        )

    assert result["credit_applications_scoped"] == 1
    assert result["lien_deadlines_scoped"] == 1
    assert result["lien_waivers_scoped"] == 1


@pytest.mark.asyncio
async def test_credit_lien_workflow_approve_signal_handler() -> None:
    wf = CreditLienControlWorkflow()
    sig = ApproveCreditLienFindingSignal(
        obligation_id="obl-1",
        finding_type="lien_deadline",
        approver_id="analyst-1",
        fingerprint="fp-approve-test",
        approver_name="Analyst",
        note="OK",
    )
    await wf.approve_finding(sig)
    assert "fp-approve-test" in wf._decisions  # noqa: SLF001
    assert wf._decisions["fp-approve-test"]["decision"] == "approved"  # noqa: SLF001


@pytest.mark.asyncio
async def test_credit_lien_workflow_reject_signal_handler() -> None:
    wf = CreditLienControlWorkflow()
    sig = RejectCreditLienFindingSignal(
        obligation_id="obl-2",
        finding_type="lien_waiver",
        approver_id="analyst-2",
        fingerprint="fp-reject-test",
        approver_name="Analyst",
        note="No",
    )
    await wf.reject_finding(sig)
    assert "fp-reject-test" in wf._decisions  # noqa: SLF001
    assert wf._decisions["fp-reject-test"]["decision"] == "rejected"  # noqa: SLF001


@pytest.mark.asyncio
async def test_credit_lien_workflow_operating_model_tags_in_recorded_findings() -> None:
    """Each finding type must carry its operating-model tag into storage."""
    app = _make_application(8)
    dl = _make_deadline(8)
    wv = _make_waiver(8)
    all_payloads = {
        app["application_id"]: app,
        dl["obligation_id"]: dl,
        wv["obligation_id"]: wv,
    }

    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        credit_applications=[{"application_id": app["application_id"]}],
        lien_deadlines=[{"obligation_id": dl["obligation_id"]}],
        lien_waivers=[{"obligation_id": wv["obligation_id"]}],
        assessments_by_id=all_payloads,
    )

    wf = CreditLienControlWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_credit_lien")),
    ):
        result = await wf.run(
            CreditLienControlWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1)
        )

    assert result["recorded_findings"] == 3

    all_tags: list[str] = []
    for f in state["recorded_findings"]:
        all_tags.extend(f.get("expected", {}).get("operating_model_tags") or [])

    assert "credit-billing-analyst:t2" in all_tags
    assert "credit-billing-analyst:t4" in all_tags
    assert "credit-billing-analyst:t5" in all_tags
