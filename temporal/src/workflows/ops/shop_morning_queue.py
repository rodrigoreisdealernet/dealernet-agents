"""Shop morning-queue workflow.

Builds a disposition-ready ranked morning queue for the service/maintenance
manager by aggregating PM-due work orders, open work-order priorities, parts
blockers, and not-available equipment.

Design (issue #1701, operating-model tags t1/t2/t3/t6):
- assist only — no automatic status mutations, work-order approvals,
  technician reassignments, or branch/customer promise changes.
- Explicit no-op state when no new shop signals exist.
- Stale meter/tech/parts signals are surfaced as evidence, not suppressed.
- Manager acknowledges items via signal; no downstream writes occur.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_shop_queue

_DEFAULT_MAX_ITEMS_PER_RUN = 100

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class ShopMorningQueueWorkflowInput:
    tenant_id: str
    branch_id: str | None = None
    run_date: str | None = None
    approval_timeout_seconds: int = 300


@dataclass
class AcknowledgeQueueItemSignal:
    """Manager acknowledges a queue item (informational only — no status change)."""
    asset_id: str
    item_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


def _signal_key(asset_id: str, item_type: str, fingerprint: str | None) -> str:
    return fingerprint or f"{asset_id}:{item_type}"


@workflow.defn
class ShopMorningQueueWorkflow:
    """Build a ranked morning shop queue for the service/maintenance manager.

    Scopes PM-due work orders, open maintenance work orders, parts blockers,
    and not-available equipment; runs AI assessment per item; surfaces the
    ranked queue as findings for manager review.

    Signals:
      acknowledge_queue_item — manager marks an item reviewed (informational,
                                no equipment status or WO status is changed).

    No-op path:
      If no new shop signals exist (scoped_items is empty), the workflow
      returns immediately with status='no_op' so the caller knows there is
      nothing materially new to act on.
    """

    def __init__(self) -> None:
        self._acknowledgements: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: ShopMorningQueueWorkflowInput) -> dict[str, Any]:
        workflow_key = _DEFAULT_SHOP_QUEUE_AGENT_KEY = "shop-morning-queue"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_items_scoped": 0,
            "processed_items": 0,
            "recorded_items": 0,
            "deduped_items": 0,
            "acknowledged_items": 0,
            "no_op": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_shop_queue.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "branch_id": inp.branch_id,
                        "run_date": inp.run_date,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_shop_queue.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            # Scope candidates.
            scoped_items: list[dict[str, Any]] = await workflow.execute_activity(
                ops_shop_queue.ops_shop_queue_scope,
                args=[inp.tenant_id, inp.branch_id, inp.run_date],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_items_scoped"] = len(scoped_items)

            # Explicit no-op state: nothing new in the shop.
            if not scoped_items:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            # Deduplicate against existing open findings.
            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_shop_queue.ops_list_open_finding_fingerprints,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            seen: set[str] = set(existing_fingerprints)

            try:
                max_items = int(
                    (config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_ITEMS_PER_RUN)
                )
            except (TypeError, ValueError):
                max_items = _DEFAULT_MAX_ITEMS_PER_RUN
            max_items = max(0, max_items)

            # AI assessment per item (concurrent).
            assess_tasks = [
                workflow.execute_activity(
                    ops_shop_queue.ops_shop_queue_assess,
                    args=[item_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for item_payload in scoped_items[:max_items]
            ]
            assessed: list[dict[str, Any]] = await asyncio.gather(*assess_tasks) if assess_tasks else []
            summary["processed_items"] = len(assessed)

            # Sort by priority (critical > high > medium > low).
            _priority_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
            assessed.sort(key=lambda x: _priority_rank.get(str(x.get("priority") or "low"), 3))

            for item in assessed:
                asset_id = str(item.get("asset_id") or "")
                item_type = str(item.get("item_type") or "pm_due")
                work_order_id = str(item.get("work_order_id") or "")
                fingerprint = (
                    f"shop:{asset_id}:{item_type}:{work_order_id}"
                    if work_order_id
                    else f"shop:{asset_id}:{item_type}"
                )
                item["fingerprint"] = fingerprint
                item["agent_key"] = workflow_key
                item["workflow_id"] = f"shop-morning-queue:{run_id}"

                if fingerprint in seen:
                    summary["deduped_items"] += 1
                    continue
                seen.add(fingerprint)

                await workflow.execute_activity(
                    ops_shop_queue.ops_record_finding,
                    args=[item, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_items"] += 1

            return {"run_id": run_id, **summary}

        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_shop_queue.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def acknowledge_queue_item(self, sig: AcknowledgeQueueItemSignal) -> None:
        """Manager acknowledges a queue item — informational only.

        No equipment status, work order status, or branch promise is changed.
        The acknowledgement is recorded so the manager can track reviewed items.
        """
        key = _signal_key(sig.asset_id, sig.item_type, sig.fingerprint)
        self._acknowledgements[key] = {
            "approver_id": sig.approver_id,
            "approver_name": sig.approver_name,
            "note": sig.note,
            "acknowledged": True,
        }
