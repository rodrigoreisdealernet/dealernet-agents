"""Branch morning-brief workflow.

Builds a disposition-ready ranked morning brief for the branch operations
manager by aggregating contract/AP/utilization exceptions, dispatch risks,
maintenance blockers, unavailable units, and customer follow-up prompts.

Design (issue #1685, operating-model tags t1/t4/t5/t6):
- assist only — no automatic customer outreach, status changes, re-rents,
  transfers, or purchase actions.
- Explicit no-op state when no new branch signals exist.
- Stale signals are surfaced as evidence, not suppressed.
- Prefer one canonical brief per branch/day; dedup against existing open
  findings to avoid duplicate threads.
- Manager acknowledges items via signal; no downstream writes occur.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_branch_brief

_DEFAULT_MAX_ITEMS_PER_RUN = 100

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class BranchMorningBriefWorkflowInput:
    tenant_id: str
    branch_id: str | None = None
    approval_timeout_seconds: int = 300


@dataclass
class AcknowledgeBriefItemSignal:
    """Manager acknowledges a brief item (informational only — no status change)."""
    item_id: str
    item_type: str
    approver_id: str
    fingerprint: str | None = None
    approver_name: str | None = None
    note: str | None = None


def _signal_key(item_id: str, item_type: str, fingerprint: str | None) -> str:
    return fingerprint or f"{item_id}:{item_type}"


@workflow.defn
class BranchMorningBriefWorkflow:
    """Build a ranked morning brief for the branch operations manager.

    Scopes contract/AP/utilization exceptions, dispatch risks, maintenance
    blockers, unavailable units, and customer follow-up prompts; runs AI
    assessment per item; surfaces the ranked brief as findings for manager
    review.

    Signals:
      acknowledge_brief_item — manager marks an item reviewed (informational,
                               no status or record is changed).

    No-op path:
      If no new branch signals exist (scoped_items is empty), the workflow
      returns immediately with status='no_op' so the caller knows there is
      nothing materially new to act on.
    """

    def __init__(self) -> None:
        self._acknowledgements: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: BranchMorningBriefWorkflowInput) -> dict[str, Any]:
        workflow_key = "branch-morning-brief"
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
                ops_branch_brief.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "branch_id": inp.branch_id,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_branch_brief.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            # Scope candidates.
            scoped_items: list[dict[str, Any]] = await workflow.execute_activity(
                ops_branch_brief.ops_branch_brief_scope,
                args=[inp.tenant_id, inp.branch_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_items_scoped"] = len(scoped_items)

            # Explicit no-op state: nothing new in the branch.
            if not scoped_items:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            # Deduplicate against existing open findings.
            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_branch_brief.ops_list_open_finding_fingerprints,
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
                    ops_branch_brief.ops_branch_brief_assess,
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
                item_id = str(item.get("item_id") or "")
                item_type = str(item.get("item_type") or "contract_exception")
                source_record_id = str(item.get("source_record_id") or item_id)
                fingerprint = f"branch:{item_type}:{source_record_id}"
                item["fingerprint"] = fingerprint
                item["agent_key"] = workflow_key
                item["workflow_id"] = f"branch-morning-brief:{run_id}"

                if fingerprint in seen:
                    summary["deduped_items"] += 1
                    continue
                seen.add(fingerprint)

                await workflow.execute_activity(
                    ops_branch_brief.ops_record_finding,
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
                    ops_branch_brief.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def acknowledge_brief_item(self, sig: AcknowledgeBriefItemSignal) -> None:
        """Manager acknowledges a brief item — informational only.

        No contract status, customer record, asset status, or branch promise
        is changed.  The acknowledgement is recorded so the manager can track
        reviewed items.
        """
        key = _signal_key(sig.item_id, sig.item_type, sig.fingerprint)
        self._acknowledgements[key] = {
            "approver_id": sig.approver_id,
            "approver_name": sig.approver_name,
            "note": sig.note,
            "acknowledged": True,
        }
