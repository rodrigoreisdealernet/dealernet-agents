"""Integration and master-data exception queue workflow.

Builds a ranked, deduplicated exception queue for the rental software and
systems administrator by aggregating portal-integration failures, logistics/
mobile-integration failures, and stale master-data signals.

Design (issue #1741, operating-model tags t5/t6/t7):
- assist only — no automatic data correction, retry approval bypass, customer
  communication, or workflow status changes.
- Duplicate / sibling failures that share the same underlying outage or
  stale-data problem collapse into a canonical thread.
- Explicit no-op state when no materially new integration or data-quality
  signal exists.
- Stale or missing telemetry is surfaced explicitly rather than suppressed.
- Administrator reviews and routes the next fix step via signal; no downstream
  writes occur.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_integration_exception

_DEFAULT_MAX_EXCEPTIONS_PER_RUN = 100

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_AI_HEARTBEAT_TIMEOUT = workflow.timedelta(seconds=45)


@dataclass
class IntegrationExceptionQueueWorkflowInput:
    tenant_id: str
    run_date: str | None = None


@dataclass
class ReviewExceptionThreadSignal:
    """Administrator reviews an exception thread — informational only.

    No data correction, retry approval, outward-facing communication, or
    workflow status is changed.  The administrator's decision (routed /
    rejected / needs_more_info) is recorded so the thread can be tracked as
    reviewed.
    """
    exception_id: str
    exception_type: str
    reviewer_id: str
    decision: str  # "routed" | "rejected" | "needs_more_info"
    fingerprint: str | None = None
    reviewer_name: str | None = None
    note: str | None = None


def _thread_key(exception_id: str, exception_type: str, fingerprint: str | None) -> str:
    return fingerprint or f"{exception_id}:{exception_type}"


@workflow.defn
class IntegrationExceptionQueueWorkflow:
    """Build a ranked integration and master-data exception queue.

    Scopes portal-integration failures, logistics/mobile failures, and stale
    master-data signals; runs AI assessment per exception thread; surfaces the
    ranked queue as findings for administrator review with a recommended next
    investigation or fix path.

    Signals:
      review_exception_thread — administrator marks a thread reviewed
                                (informational, no data or status change).

    No-op path:
      If no new integration or data-quality signals exist (scoped_exceptions
      is empty), the workflow returns immediately with status='no_op' so the
      caller knows there is nothing materially new to act on.
    """

    def __init__(self) -> None:
        self._reviews: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: IntegrationExceptionQueueWorkflowInput) -> dict[str, Any]:
        workflow_key = "integration-exception-queue"
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_exceptions_scoped": 0,
            "processed_exceptions": 0,
            "recorded_threads": 0,
            "deduped_threads": 0,
            "reviewed_threads": 0,
            "no_op": False,
        }
        run_id = ""
        try:
            run = await workflow.execute_activity(
                ops_integration_exception.ops_create_workflow_run,
                args=[
                    workflow_key,
                    inp.tenant_id,
                    {
                        "run_date": inp.run_date,
                    },
                ],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_MONEY_RETRY,
            )
            run_id = str(run["run_id"])

            config = await workflow.execute_activity(
                ops_integration_exception.ops_load_agent_config,
                args=[inp.tenant_id, workflow_key],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )

            # Scope candidates: portal failures, logistics failures, master-data drift.
            scoped_exceptions: list[dict[str, Any]] = await workflow.execute_activity(
                ops_integration_exception.ops_integration_exception_scope,
                args=[inp.tenant_id, inp.run_date],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_exceptions_scoped"] = len(scoped_exceptions)

            # Explicit no-op state: no new integration or data-quality signals.
            if not scoped_exceptions:
                summary["status"] = "no_op"
                summary["no_op"] = True
                return {"run_id": run_id, **summary}

            # Deduplicate against existing open findings.
            existing_fingerprints: list[str] = await workflow.execute_activity(
                ops_integration_exception.ops_list_open_finding_fingerprints,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            seen: set[str] = set(existing_fingerprints)

            try:
                max_exceptions = int(
                    (config.get("bounds") or {}).get("max_findings_per_run", _DEFAULT_MAX_EXCEPTIONS_PER_RUN)
                )
            except (TypeError, ValueError):
                max_exceptions = _DEFAULT_MAX_EXCEPTIONS_PER_RUN
            max_exceptions = max(0, max_exceptions)

            # AI assessment per exception thread (concurrent).
            assess_tasks = [
                workflow.execute_activity(
                    ops_integration_exception.ops_integration_exception_assess,
                    args=[exception_payload, config],
                    start_to_close_timeout=workflow.timedelta(minutes=2),
                    heartbeat_timeout=_AI_HEARTBEAT_TIMEOUT,
                    retry_policy=_AI_RETRY,
                )
                for exception_payload in scoped_exceptions[:max_exceptions]
            ]
            assessed: list[dict[str, Any]] = await asyncio.gather(*assess_tasks) if assess_tasks else []
            summary["processed_exceptions"] = len(assessed)

            # Sort by priority (critical > high > medium > low).
            _priority_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
            assessed.sort(key=lambda x: _priority_rank.get(str(x.get("priority") or "low"), 3))

            for thread in assessed:
                exception_id = str(thread.get("exception_id") or "")
                exception_type = str(thread.get("exception_type") or "master_data_drift")
                source_connector = str(thread.get("source_connector") or "")
                fingerprint = (
                    f"integration-exception:{exception_type}:{source_connector}:{exception_id}"
                    if source_connector
                    else f"integration-exception:{exception_type}:{exception_id}"
                )
                thread["fingerprint"] = fingerprint
                thread["agent_key"] = workflow_key
                thread["workflow_id"] = f"integration-exception-queue:{run_id}"

                if fingerprint in seen:
                    summary["deduped_threads"] += 1
                    continue
                seen.add(fingerprint)

                await workflow.execute_activity(
                    ops_integration_exception.ops_record_finding,
                    args=[thread, run_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )
                summary["recorded_threads"] += 1

            return {"run_id": run_id, **summary}

        except Exception:
            summary["status"] = "failed"
            raise
        finally:
            if run_id:
                await workflow.execute_activity(
                    ops_integration_exception.ops_finalize_workflow_run,
                    args=[run_id, summary],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

    @workflow.signal
    async def review_exception_thread(self, sig: ReviewExceptionThreadSignal) -> None:
        """Administrator reviews an exception thread — informational only.

        No data is corrected, no retry is approved, no outward-facing
        communication or workflow status is changed.  The review decision is
        recorded so the administrator can track which threads have been acted on.
        """
        key = _thread_key(sig.exception_id, sig.exception_type, sig.fingerprint)
        self._reviews[key] = {
            "reviewer_id": sig.reviewer_id,
            "reviewer_name": sig.reviewer_name,
            "decision": sig.decision,
            "note": sig.note,
            "reviewed": True,
        }
