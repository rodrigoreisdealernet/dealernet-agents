"""Billing-contact and payment update approval workflow.

Routes customer-submitted billing-contact and payment-detail update requests
into an internal human-approval queue.  No payment or billing-contact change
is applied automatically — every mutation is gated behind an explicit approve
signal from an authorised reviewer.

When identity, authorization, or required detail is uncertain the workflow
records the request as timed-out and escalates to human follow-up rather than
guessing.

Operating-model tags:
  rental-customer-portal-user:t5  — customer self-service update initiation
  rental-customer-portal-user:t7  — change status visibility and confirmation
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_billing_update

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)


def _request_decision_key(request_id: str) -> str:
    return f"billing_update:{request_id}"


@dataclass
class BillingUpdateApprovalWorkflowInput:
    tenant_id: str
    approval_timeout_seconds: int = 300


@dataclass
class ApproveBillingUpdateSignal:
    request_id: str
    reviewer_id: str
    reviewer_name: str | None = None
    note: str | None = None


@dataclass
class RejectBillingUpdateSignal:
    request_id: str
    reviewer_id: str
    reviewer_name: str | None = None
    note: str | None = None


@workflow.defn
class BillingUpdateApprovalWorkflow:
    """Assist-only approval workflow for billing-contact and payment-detail requests.

    1. Loads all pending requests for the tenant.
    2. Transitions each to 'under_review' so the ops queue surfacing shows them.
    3. Waits for an approve or reject signal per request.
    4. On approval, calls the gated ops_apply_billing_update to record the
       'applied' outcome; no billing record is modified autonomously.
    5. Timed-out requests are left as 'under_review' for manual follow-up.
    """

    def __init__(self) -> None:
        self._decisions: dict[str, dict[str, Any]] = {}

    @workflow.run
    async def run(self, inp: BillingUpdateApprovalWorkflowInput) -> dict[str, Any]:
        # Capture the workflow_id once so tests can mock workflow.info safely.
        workflow_id = workflow.info().workflow_id
        summary: dict[str, Any] = {
            "status": "succeeded",
            "total_requests": 0,
            "approved_requests": 0,
            "rejected_requests": 0,
            "timed_out_requests": 0,
            "applied_requests": 0,
            "auto_apply": False,
        }
        try:
            requests: list[dict[str, Any]] = await workflow.execute_activity(
                ops_billing_update.ops_load_pending_billing_update_requests,
                args=[inp.tenant_id],
                start_to_close_timeout=workflow.timedelta(seconds=30),
                retry_policy=_STANDARD_RETRY,
            )
            summary["total_requests"] = len(requests)

            for req in requests:
                request_id = str(req.get("id") or "")
                if not request_id:
                    continue

                # Transition to under_review so the ops queue displays it
                await workflow.execute_activity(
                    ops_billing_update.ops_mark_billing_update_under_review,
                    args=[request_id, workflow_id],
                    start_to_close_timeout=workflow.timedelta(seconds=30),
                    retry_policy=_STANDARD_RETRY,
                )

                decision_key = _request_decision_key(request_id)
                try:
                    await workflow.wait_condition(
                        lambda dk=decision_key: dk in self._decisions,
                        timeout=workflow.timedelta(seconds=inp.approval_timeout_seconds),
                    )
                    decision = self._decisions.pop(decision_key)
                except TimeoutError:
                    summary["timed_out_requests"] += 1
                    # Leave the request in under_review for manual follow-up.
                    continue

                if decision["decision"] == "approve":
                    summary["approved_requests"] += 1
                    await workflow.execute_activity(
                        ops_billing_update.ops_record_billing_update_decision,
                        args=[
                            request_id,
                            "approve",
                            decision["reviewer"]["reviewer_id"],
                            decision["reviewer"].get("reviewer_name"),
                            decision["reviewer"].get("note"),
                        ],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )
                    # Gated apply: records 'applied' status; no autonomous change
                    await workflow.execute_activity(
                        ops_billing_update.ops_apply_billing_update,
                        args=[
                            request_id,
                            decision["reviewer"]["reviewer_id"],
                        ],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_MONEY_RETRY,
                    )
                    summary["applied_requests"] += 1
                else:
                    summary["rejected_requests"] += 1
                    await workflow.execute_activity(
                        ops_billing_update.ops_record_billing_update_decision,
                        args=[
                            request_id,
                            "reject",
                            decision["reviewer"]["reviewer_id"],
                            decision["reviewer"].get("reviewer_name"),
                            decision["reviewer"].get("note"),
                        ],
                        start_to_close_timeout=workflow.timedelta(seconds=30),
                        retry_policy=_STANDARD_RETRY,
                    )

            return summary
        except Exception:
            summary["status"] = "failed"
            raise

    @workflow.signal
    async def approve_request(self, sig: ApproveBillingUpdateSignal) -> None:
        """Signal to approve a specific billing update request."""
        decision_key = _request_decision_key(sig.request_id)
        self._decisions[decision_key] = {
            "decision": "approve",
            "reviewer": {
                "reviewer_id": sig.reviewer_id,
                "reviewer_name": sig.reviewer_name,
                "note": sig.note,
            },
        }

    @workflow.signal
    async def reject_request(self, sig: RejectBillingUpdateSignal) -> None:
        """Signal to reject a specific billing update request."""
        decision_key = _request_decision_key(sig.request_id)
        self._decisions[decision_key] = {
            "decision": "reject",
            "reviewer": {
                "reviewer_id": sig.reviewer_id,
                "reviewer_name": sig.reviewer_name,
                "note": sig.note,
            },
        }
