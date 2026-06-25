from __future__ import annotations

import logging
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.integrations.mulesoft import (
    MuleSoftInboundCallbackWorkflow,
    MuleSoftInboundCallbackWorkflowInput,
    MuleSoftOutboundWorkflow,
    MuleSoftOutboundWorkflowInput,
)


@pytest.mark.asyncio
async def test_outbound_workflow_records_partial_failures() -> None:
    state: dict[str, list] = {"prepare": [], "send": []}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "mulesoft_prepare_outbound_delivery":
            state["prepare"].append(args)
            return {"entity_id": args[2], "delivery_log_id": f"log-{args[2]}", "skip": False}
        if fn_name == "mulesoft_send_outbound_delivery":
            state["send"].append(args[0])
            if args[0]["entity_id"] == "invoice-2":
                raise RuntimeError("temporary mulesoft outage")
            return {"entity_id": args[0]["entity_id"], "status": "sent"}
        raise AssertionError(fn_name)

    wf = MuleSoftOutboundWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_mulesoft_workflow")),
    ):
        result = await wf.run(
            MuleSoftOutboundWorkflowInput(
                tenant_id="tenant-a-id",
                exchange_key="invoice_snapshot",
                entity_ids=["invoice-1", "invoice-2"],
            )
        )

    assert result["sent"] == 1
    assert result["failed"] == 1
    assert state["prepare"][0][2] == "invoice-1"


@pytest.mark.asyncio
async def test_outbound_workflow_passes_explicit_replay_token() -> None:
    captured_prepare_args: list[list] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "mulesoft_prepare_outbound_delivery":
            captured_prepare_args.append(args)
            return {"entity_id": args[2], "delivery_log_id": "log-1", "skip": True, "status": "skipped"}
        if fn_name == "mulesoft_send_outbound_delivery":
            return {"entity_id": args[0]["entity_id"], "status": "skipped"}
        raise AssertionError(fn_name)

    wf = MuleSoftOutboundWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_mulesoft_workflow")),
    ):
        await wf.run(
            MuleSoftOutboundWorkflowInput(
                tenant_id="tenant-a-id",
                exchange_key="rental_contract_snapshot",
                entity_ids=["contract-1"],
                mode="replay",
                replay_token="operator-retry-token",
            )
        )

    assert captured_prepare_args[0][-1] == "operator-retry-token"


@pytest.mark.asyncio
async def test_inbound_callback_workflow_dispatches_process_activity() -> None:
    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        assert fn_name == "mulesoft_process_inbound_callback"
        return {"status": "processed", "delivery_id": args[2]["delivery_id"]}

    wf = MuleSoftInboundCallbackWorkflow()
    with patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity):
        result = await wf.run(
            MuleSoftInboundCallbackWorkflowInput(
                tenant_id="tenant-a-id",
                delivery_log_id="log-1",
                payload={"delivery_id": "delivery-1"},
            )
        )

    assert result == {"status": "processed", "delivery_id": "delivery-1"}
