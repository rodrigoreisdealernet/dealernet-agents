from __future__ import annotations

import asyncio
import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.activities.ops_revrec import PromptTemplateInterpolationError
from temporal.src.workflows.ops.revrec import (
    ApproveFindingSignal,
    RejectFindingSignal,
    RevenueRecognitionWorkflow,
    RevenueRecognitionWorkflowInput,
)

_MAX_CONDITION_CHECKS = 200


def _build_harness(
    *,
    config: dict,
    contracts: list[dict],
    analysis_by_contract: dict[str, dict],
    existing_fingerprints: list[str] | None = None,
):
    state = {
        "recorded_findings": [],
        "draft_adjustments": [],
        "dispositions": [],
        "finalized": None,
        "created_workflow_key": None,
    }
    existing = existing_fingerprints or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            state["created_workflow_key"] = args[0]
            return {"run_id": "run-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1]
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_scope_revrec_contracts":
            return contracts
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_revrec_analyze":
            contract_id = str(args[0]["contract_id"])
            return analysis_by_contract[contract_id]
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        if fn_name == "ops_draft_invoice_adjustment":
            state["draft_adjustments"].append({"finding": args[0], "approver": args[2]})
            return {"adjustment_id": f"adj-{len(state['draft_adjustments'])}"}
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

    async def fake_wait_condition(cond_fn, *, timeout=None):
        for _ in range(_MAX_CONDITION_CHECKS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out waiting for decision")

    return state, fake_execute_activity, fake_wait_condition


def _default_config(**overrides):
    base = {
        "auto_apply": False,
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 1},
        "system_prompt": "x",
        "user_prompt_template": "x",
        "tools": [],
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_money_moving_finding_waits_for_approval_and_forces_auto_apply_false():
    config = _default_config(auto_apply=True)
    contracts = [{"contract_id": "c1"}]
    analysis = {
        "c1": {
            "contract_id": "c1",
            "findings": [
                {
                    "finding_type": "unbilled_on_rent",
                    "line_item_id": "l1",
                    "severity": "high",
                    "expected": {"amount": 100},
                    "billed": {"amount": 0},
                    "delta": 100,
                    "evidence": ["missing invoice line"],
                    "proposed_action": "create_invoice_adjustment",
                    "confidence": 0.9,
                    "rationale": "unbilled rental",
                }
            ],
        }
    }
    state, fake_execute, fake_wait = _build_harness(
        config=config,
        contracts=contracts,
        analysis_by_contract=analysis,
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        run_task = asyncio.create_task(
            wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1))
        )
        await asyncio.sleep(0)
        assert state["draft_adjustments"] == []
        assert not run_task.done()
        await wf.approve_finding(
            ApproveFindingSignal(
                contract_id="c1",
                line_item_id="l1",
                finding_type="unbilled_on_rent",
                approver_id="manager-1",
                approver_name="Manager",
                note="looks good",
            )
        )
        result = await asyncio.wait_for(run_task, timeout=2)

    assert result["auto_apply"] is False
    assert result["approved_findings"] == 1
    assert result["draft_adjustments_created"] == 1
    assert len(state["draft_adjustments"]) == 1


@pytest.mark.asyncio
async def test_findings_are_deduped_by_contract_line_and_type():
    contracts = [{"contract_id": "c1"}]
    analysis = {
        "c1": {
            "contract_id": "c1",
            "findings": [
                {
                    "finding_type": "unbilled_on_rent",
                    "line_item_id": "l1",
                    "severity": "high",
                    "expected": {},
                    "billed": {},
                    "delta": 1,
                    "evidence": [],
                    "proposed_action": None,
                    "confidence": 0.8,
                    "rationale": "duplicate existing",
                },
                {
                    "finding_type": "rate_tier_mismatch",
                    "line_item_id": "l2",
                    "severity": "medium",
                    "expected": {},
                    "billed": {},
                    "delta": 1,
                    "evidence": [],
                    "proposed_action": None,
                    "confidence": 0.8,
                    "rationale": "first new",
                },
                {
                    "finding_type": "rate_tier_mismatch",
                    "line_item_id": "l2",
                    "severity": "medium",
                    "expected": {},
                    "billed": {},
                    "delta": 1,
                    "evidence": [],
                    "proposed_action": None,
                    "confidence": 0.8,
                    "rationale": "duplicate in-run",
                },
            ],
        }
    }
    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        contracts=contracts,
        analysis_by_contract=analysis,
        existing_fingerprints=["c1:l1:unbilled_on_rent"],
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        result = await wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a"))

    assert result["recorded_findings"] == 1
    assert result["deduped_findings"] == 2
    assert len(state["recorded_findings"]) == 1


@pytest.mark.asyncio
async def test_bounding_limits_processed_findings_and_reports_remainder():
    contracts = [{"contract_id": "c1"}]
    analysis = {
        "c1": {
            "contract_id": "c1",
            "findings": [
                {
                    "finding_type": "unbilled_on_rent",
                    "line_item_id": "l1",
                    "severity": "high",
                    "expected": {},
                    "billed": {},
                    "delta": 1,
                    "evidence": [],
                    "proposed_action": None,
                    "confidence": 0.8,
                    "rationale": "f1",
                },
                {
                    "finding_type": "rate_tier_mismatch",
                    "line_item_id": "l2",
                    "severity": "medium",
                    "expected": {},
                    "billed": {},
                    "delta": 1,
                    "evidence": [],
                    "proposed_action": None,
                    "confidence": 0.8,
                    "rationale": "f2",
                },
                {
                    "finding_type": "over_billed",
                    "line_item_id": "l3",
                    "severity": "medium",
                    "expected": {},
                    "billed": {},
                    "delta": 1,
                    "evidence": [],
                    "proposed_action": None,
                    "confidence": 0.8,
                    "rationale": "f3",
                },
            ],
        }
    }
    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 1, "max_tool_rounds": 1}),
        contracts=contracts,
        analysis_by_contract=analysis,
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        result = await wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a"))

    assert result["processed_findings"] == 1
    assert result["remaining_findings_count"] == 2
    assert len(state["recorded_findings"]) == 1


@pytest.mark.asyncio
async def test_prompt_interpolation_fails_closed_on_missing_variable():
    contracts = [{"contract_id": "c1"}]
    analysis = {"c1": {"contract_id": "c1", "findings": []}}
    config = _default_config(
        system_prompt="System prompt",
        user_prompt_template="Contract {contract_id} tenant {tenant_display_name}",
    )
    state, fake_execute, fake_wait = _build_harness(
        config=config,
        contracts=contracts,
        analysis_by_contract=analysis,
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
        pytest.raises(PromptTemplateInterpolationError, match="tenant_display_name"),
    ):
        await wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a"))
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_rejected_finding_does_not_create_draft_adjustment():
    contracts = [{"contract_id": "c1"}]
    analysis = {
        "c1": {
            "contract_id": "c1",
            "findings": [
                {
                    "finding_type": "over_billed",
                    "line_item_id": "l1",
                    "severity": "high",
                    "expected": {},
                    "billed": {},
                    "delta": 10,
                    "evidence": [],
                    "proposed_action": "create_invoice_adjustment",
                    "confidence": 0.8,
                    "rationale": "requires review",
                }
            ],
        }
    }
    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        contracts=contracts,
        analysis_by_contract=analysis,
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        run_task = asyncio.create_task(wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a")))
        await asyncio.sleep(0)
        await wf.reject_finding(
            RejectFindingSignal(
                contract_id="c1",
                line_item_id="l1",
                finding_type="over_billed",
                approver_id="manager-2",
                note="not enough evidence",
            )
        )
        result = await asyncio.wait_for(run_task, timeout=2)

    assert result["rejected_findings"] == 1
    assert result["draft_adjustments_created"] == 0
    assert state["draft_adjustments"] == []
    assert state["dispositions"][0]["disposition"] == "rejected"


@pytest.mark.asyncio
async def test_timeout_records_disposition_without_drafting_adjustment():
    contracts = [{"contract_id": "c1"}]
    analysis = {
        "c1": {
            "contract_id": "c1",
            "findings": [
                {
                    "finding_type": "billing_past_return",
                    "line_item_id": "l1",
                    "severity": "high",
                    "expected": {},
                    "billed": {},
                    "delta": 10,
                    "evidence": [],
                    "proposed_action": "stop_billing_at_return",
                    "confidence": 0.8,
                    "rationale": "billing exceeded return date",
                }
            ],
        }
    }
    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        contracts=contracts,
        analysis_by_contract=analysis,
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        result = await wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a", approval_timeout_seconds=1))

    assert result["timed_out_findings"] == 1
    assert result["draft_adjustments_created"] == 0
    assert state["draft_adjustments"] == []
    assert state["dispositions"][0]["disposition"] == "timed_out"


@pytest.mark.asyncio
async def test_workflow_run_persists_agent_key_for_status_alignment():
    contracts: list[dict[str, str]] = []
    state, fake_execute, fake_wait = _build_harness(
        config=_default_config(),
        contracts=contracts,
        analysis_by_contract={},
    )
    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        await wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a"))

    assert state["created_workflow_key"] == "revrec-analyst"


@pytest.mark.asyncio
async def test_ai_analyst_activity_has_heartbeat_timeout_and_retry_cap():
    """ops_revrec_analyze must be called with heartbeat_timeout=45 s and retry_policy
    capped at 2 attempts (ADR-0003).  This test fails if either wiring is reverted.
    """
    contracts = [{"contract_id": "c1"}]
    analysis = {"c1": {"contract_id": "c1", "findings": []}}

    ai_activity_kwargs: dict = {}

    state, base_execute, fake_wait = _build_harness(
        config=_default_config(),
        contracts=contracts,
        analysis_by_contract=analysis,
    )

    async def capturing_execute(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "ops_revrec_analyze":
            ai_activity_kwargs.update(kw)
        return await base_execute(fn_or_str, *pos_args, **kw)

    wf = RevenueRecognitionWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=capturing_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "logger", logging.getLogger("test_revrec_workflow")),
    ):
        await wf.run(RevenueRecognitionWorkflowInput(tenant_id="tenant-a"))

    assert ai_activity_kwargs, "ops_revrec_analyze was never called"

    # heartbeat_timeout must be set to 45 s
    heartbeat_timeout = ai_activity_kwargs.get("heartbeat_timeout")
    assert heartbeat_timeout is not None, "heartbeat_timeout must be passed to ops_revrec_analyze"
    assert heartbeat_timeout.total_seconds() == 45, (
        f"heartbeat_timeout must be 45 s, got {heartbeat_timeout.total_seconds()} s"
    )

    # retry_policy must cap at 2 attempts (AI/HTTP activity)
    retry_policy = ai_activity_kwargs.get("retry_policy")
    assert retry_policy is not None, "retry_policy must be passed to ops_revrec_analyze"
    assert retry_policy.maximum_attempts == 2, (
        f"ops_revrec_analyze retry_policy must have maximum_attempts=2, got {retry_policy.maximum_attempts}"
    )
