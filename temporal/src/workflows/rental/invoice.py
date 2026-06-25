"""Invoice workflow: generates an operational invoice from contract activity.

Business rules:
- Invoice is created in 'draft' status, linked to the contract entity.
- Line items are derived from approved lifecycle records and de-duplicated by source.
- Billing holds or incomplete return/usage data keep the invoice in 'draft' with actionable exceptions.
- Line item totals (subtotal, tax, total) are computed from invoiceable line items.
- Invoice is advanced to 'pending' once totals are persisted and no blocking exceptions remain.
- Invoicing is operational billing only; no GL/AP integration.
"""
from __future__ import annotations

from dataclasses import asdict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import rental_operations as ops
    from ...models.rental import InvoiceRequest, InvoiceSummary

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)


@workflow.defn
class InvoiceWorkflow:
    """Generates an invoice from a contract billing period."""

    @workflow.run
    async def run(self, request: InvoiceRequest) -> dict:
        # 1. Create invoice entity (draft)
        invoice_data = await workflow.execute_activity(
            ops.create_invoice_record,
            args=[
                request.contract_id,
                request.billing_period_start,
                request.billing_period_end,
                request.created_by,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )
        invoice_id = invoice_data["invoice_id"]

        # 2. Link invoice to contract via relationship
        with workflow.unsafe.imports_passed_through():
            from ...activities.supabase_core import create_relationship
        await workflow.execute_activity(
            create_relationship,
            args=[invoice_id, request.contract_id, "invoice:generated_from:contract", {}],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        # 3. Generate invoiceable line items from lifecycle records
        invoiceable = await workflow.execute_activity(
            ops.derive_invoiceable_line_items,
            args=[request.contract_id, request.line_items],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        # 4. Evaluate billing holds and data completeness
        readiness = await workflow.execute_activity(
            ops.evaluate_invoice_readiness,
            args=[
                request.contract_id,
                request.contract_status,
                invoiceable["line_items"],
                request.billing_holds,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        # 5. Compute totals from invoiceable line items
        totals = await workflow.execute_activity(
            ops.compute_invoice_totals,
            args=[invoice_id, invoiceable["line_items"]],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        # 6. Persist totals and advance status when unblocked
        final = await workflow.execute_activity(
            ops.finalise_invoice,
            args=[
                invoice_id,
                totals["subtotal"],
                totals["tax"],
                totals["total"],
                readiness["blocked"],
                readiness["exceptions"],
                {
                    "customer_id": request.customer_id,
                    "billing_account_id": request.billing_account_id,
                    "job_site_id": request.job_site_id,
                    "transaction_currency_code": request.transaction_currency_code,
                    "reporting_currency_code": request.reporting_currency_code,
                    "fx_rate_applied": request.fx_rate_applied,
                    "fx_rate_effective_at": request.fx_rate_effective_at,
                },
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )

        return asdict(
            InvoiceSummary(
                invoice_id=invoice_id,
                contract_id=request.contract_id,
                status=final["status"],
                subtotal=final["subtotal"],
                tax=final["tax"],
                total=final["total"],
                blocked=final["blocked"],
                billing_exceptions=final["billing_exceptions"],
                customer_id=final["customer_id"],
                billing_account_id=final["billing_account_id"],
                job_site_id=final["job_site_id"],
                transaction_currency_code=final["transaction_currency_code"],
                reporting_currency_code=final["reporting_currency_code"],
                fx_rate_applied=final["fx_rate_applied"],
                fx_rate_effective_at=final["fx_rate_effective_at"],
            )
        )
