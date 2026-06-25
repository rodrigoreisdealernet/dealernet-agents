from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import mulesoft


_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_HTTP_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=["ValueError", "ApplicationError"])


@dataclass
class MuleSoftOutboundWorkflowInput:
    tenant_id: str
    exchange_key: Literal["rental_contract_snapshot", "invoice_snapshot"]
    entity_ids: list[str]
    mode: Literal["publish", "replay", "backfill"] = "publish"
    replay_token: str | None = None


@dataclass
class MuleSoftInboundCallbackWorkflowInput:
    tenant_id: str
    delivery_log_id: str
    payload: dict[str, Any]


@workflow.defn
class MuleSoftOutboundWorkflow:
    @workflow.run
    async def run(self, inp: MuleSoftOutboundWorkflowInput) -> dict[str, Any]:
        summary = {
            "exchange_key": inp.exchange_key,
            "mode": inp.mode,
            "requested": len(inp.entity_ids),
            "sent": 0,
            "skipped": 0,
            "failed": 0,
            "results": [],
        }
        for entity_id in inp.entity_ids:
            prepared = await workflow.execute_activity(
                mulesoft.mulesoft_prepare_outbound_delivery,
                args=[inp.tenant_id, inp.exchange_key, entity_id, inp.replay_token],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            try:
                result = await workflow.execute_activity(
                    mulesoft.mulesoft_send_outbound_delivery,
                    args=[prepared],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_HTTP_RETRY,
                )
            except Exception as exc:  # noqa: BLE001
                summary["failed"] += 1
                summary["results"].append({"entity_id": entity_id, "status": "failed", "error": str(exc)})
                continue

            status = str(result.get("status") or "")
            if status == "sent":
                summary["sent"] += 1
            elif status == "skipped":
                summary["skipped"] += 1
            else:
                summary["failed"] += 1
            summary["results"].append(dict(result))
        return summary


@workflow.defn
class MuleSoftInboundCallbackWorkflow:
    @workflow.run
    async def run(self, inp: MuleSoftInboundCallbackWorkflowInput) -> dict[str, Any]:
        return await workflow.execute_activity(
            mulesoft.mulesoft_process_inbound_callback,
            args=[inp.tenant_id, inp.delivery_log_id, inp.payload],
            start_to_close_timeout=workflow.timedelta(seconds=30),
            retry_policy=_STANDARD_RETRY,
        )
