"""Accounting posting workflow: auto ledger entries for financial events."""
from __future__ import annotations

from dataclasses import asdict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import accounting as acct

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_POSTING_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)


@workflow.defn
class AccountingPostingWorkflow:
    """Post accrual and cash-basis journal entries for a single financial event.

    Supports event types: invoice_issued, invoice_void, payment_applied,
    payment_refund, fee_charged, credit_applied.

    Each event produces two journal entries — one per posting basis — unless
    the caller sets *posting_bases* to a single-element list.

    Idempotency: the underlying ``post_journal_entry`` DB function enforces
    uniqueness on (source_event_id, posting_basis); replaying this workflow
    with the same event_id is safe.
    """

    @workflow.run
    async def run(self, request: dict) -> dict:
        event_type = request["source_event_type"]
        bases = request.get("posting_bases") or ["accrual", "cash"]

        results: list[dict] = []
        for basis in bases:
            result = await self._post_for_basis(event_type, basis, request)
            results.append(result)

        return {"results": results, "source_event_id": request["source_event_id"]}

    async def _post_for_basis(
        self, event_type: str, basis: str, request: dict
    ) -> dict:
        common = dict(
            tenant_id=request["tenant_id"],
            source_event_id=request["source_event_id"],
            source_event_type=event_type,
            source_record_id=request.get("source_record_id"),
            posting_date=request["posting_date"],
            currency_code=request.get("currency_code", "USD"),
            posting_basis=basis,
            branch_id=request.get("branch_id"),
            actor_id=request.get("actor_id"),
            actor_type=request.get("actor_type", "workflow"),
            audit_metadata=request.get("audit_metadata"),
        )

        if event_type == "invoice_issued":
            req = acct.InvoicePostingRequest(
                **common,
                subtotal=float(request.get("subtotal", 0)),
                tax=float(request.get("tax", 0)),
            )
            result = await workflow.execute_activity(
                acct.post_invoice_issued,
                args=[req],
                start_to_close_timeout=workflow.timedelta(seconds=15),
                retry_policy=_POSTING_RETRY,
            )

        elif event_type == "invoice_void":
            req = acct.InvoicePostingRequest(
                **common,
                subtotal=float(request.get("subtotal", 0)),
                tax=float(request.get("tax", 0)),
            )
            result = await workflow.execute_activity(
                acct.post_invoice_void,
                args=[req],
                start_to_close_timeout=workflow.timedelta(seconds=15),
                retry_policy=_POSTING_RETRY,
            )

        elif event_type == "payment_applied":
            req = acct.PaymentPostingRequest(
                **common,
                amount=float(request.get("amount", 0)),
                subtotal=float(request["subtotal"]) if request.get("subtotal") is not None else None,
                tax=float(request["tax"]) if request.get("tax") is not None else None,
            )
            result = await workflow.execute_activity(
                acct.post_payment_applied,
                args=[req],
                start_to_close_timeout=workflow.timedelta(seconds=15),
                retry_policy=_POSTING_RETRY,
            )

        elif event_type == "payment_refund":
            req = acct.PaymentPostingRequest(
                **common,
                amount=float(request.get("amount", 0)),
                subtotal=float(request["subtotal"]) if request.get("subtotal") is not None else None,
                tax=float(request["tax"]) if request.get("tax") is not None else None,
            )
            result = await workflow.execute_activity(
                acct.post_payment_refund,
                args=[req],
                start_to_close_timeout=workflow.timedelta(seconds=15),
                retry_policy=_POSTING_RETRY,
            )

        elif event_type == "fee_charged":
            req = acct.FeePostingRequest(
                **common,
                amount=float(request.get("amount", 0)),
            )
            result = await workflow.execute_activity(
                acct.post_fee_charged,
                args=[req],
                start_to_close_timeout=workflow.timedelta(seconds=15),
                retry_policy=_POSTING_RETRY,
            )

        elif event_type == "credit_applied":
            req = acct.FeePostingRequest(
                **common,
                amount=float(request.get("amount", 0)),
            )
            result = await workflow.execute_activity(
                acct.post_credit_applied,
                args=[req],
                start_to_close_timeout=workflow.timedelta(seconds=15),
                retry_policy=_POSTING_RETRY,
            )

        else:
            raise ValueError(f"Unsupported accounting event_type: {event_type!r}")

        return asdict(result)
