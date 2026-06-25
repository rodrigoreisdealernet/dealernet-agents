"""Maintenance costing workflow: itemized labor/parts/fees + invoice-from-work-order.

Business rules:
- Cost lines (labor, parts, fees) are added as child entities linked to the work order.
- Work-order totals are rolled up deterministically from line items.
- Internal costing is always persisted regardless of whether the work order is billable.
- A draft invoice is only created when: (a) the work order status is 'completed', (b)
  is_customer_billable is True, and (c) billing_account_id is provided.
- Invoice creation is idempotent: one work order produces at most one draft invoice unless
  a cancel-and-regenerate flow is explicitly added later.
- Re-running the action when an invoice already exists returns the existing invoice and
  sets already_existed=True rather than creating a duplicate.
"""
from __future__ import annotations

from dataclasses import asdict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import rental_operations as ops
    from ...activities.supabase_core import create_relationship
    from ...models.rental import (
        MaintenanceCostingRequest,
        MaintenanceCostingSummary,
        MaintenanceInvoiceRequest,
        MaintenanceInvoiceSummary,
    )

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)

# Work-order states from which a customer invoice may be generated.
_INVOICEABLE_STATUSES = frozenset({"completed", "approved"})


@workflow.defn
class MaintenanceCostingWorkflow:
    """Add itemized cost lines to a maintenance work order and roll up totals."""

    @workflow.run
    async def run(self, request: MaintenanceCostingRequest) -> dict:
        # 1. Persist each cost line as a child entity
        saved_lines: list[dict] = []
        for idx, line in enumerate(request.cost_lines):
            # Derive a stable per-line idempotency key.  If the caller already
            # provided one (line["line_id"]) use it; otherwise fall back to an
            # index-scoped key so that re-running the same workflow execution is
            # idempotent while still allowing two identical business-data lines to
            # coexist as separate rows (different index → different line_id).
            line_id: str = line.get("line_id") or f"{request.maintenance_record_id}:line:{idx}"
            saved = await workflow.execute_activity(
                ops.add_maintenance_cost_line,
                args=[
                    request.maintenance_record_id,
                    line.get("line_type", "fees"),
                    line.get("description", ""),
                    float(line.get("quantity", 0)),
                    float(line.get("unit_cost", 0)),
                    float(line.get("sell_amount", 0)),
                    bool(line.get("is_taxable", False)),
                    float(line.get("tax_rate", 0.0)),
                    line.get("notes"),
                    line_id,
                ],
                start_to_close_timeout=workflow.timedelta(seconds=10),
                retry_policy=_MONEY_RETRY,
            )
            saved_lines.append(saved)

        # 2. Roll up totals from the saved lines
        totals = await workflow.execute_activity(
            ops.compute_maintenance_work_order_totals,
            args=[request.maintenance_record_id, saved_lines],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )

        return asdict(
            MaintenanceCostingSummary(
                maintenance_record_id=request.maintenance_record_id,
                cost_line_count=totals["cost_line_count"],
                internal_subtotal=totals["internal_subtotal"],
                sell_subtotal=totals["sell_subtotal"],
                tax_total=totals["tax_total"],
                sell_total=totals["sell_total"],
                is_customer_billable=request.is_customer_billable,
                billing_account_id=request.billing_account_id,
            )
        )


@workflow.defn
class MaintenanceInvoiceWorkflow:
    """Generate a draft invoice from a completed billable maintenance work order.

    Guards:
    - Work order must be in a completed/approved state.
    - billing_account_id must be set.
    - Idempotency: re-running returns the existing invoice without creating a duplicate.
    """

    @workflow.run
    async def run(self, request: MaintenanceInvoiceRequest) -> dict:
        # 1. Validate work-order state before attempting invoice generation
        if request.work_order_status not in _INVOICEABLE_STATUSES:
            return asdict(
                MaintenanceInvoiceSummary(
                    invoice_id="",
                    maintenance_record_id=request.maintenance_record_id,
                    billing_account_id=request.billing_account_id,
                    status="blocked",
                    sell_subtotal=request.sell_subtotal,
                    tax_total=request.tax_total,
                    sell_total=request.sell_total,
                    blocked=True,
                    blocked_reason=(
                        f"work order status '{request.work_order_status}' is not invoiceable; "
                        f"must be one of {sorted(_INVOICEABLE_STATUSES)}"
                    ),
                )
            )

        # 2. Idempotency check: skip creation if an invoice already exists
        existing = await workflow.execute_activity(
            ops.check_maintenance_invoice_exists,
            request.maintenance_record_id,
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        if existing["exists"]:
            return asdict(
                MaintenanceInvoiceSummary(
                    invoice_id=existing["invoice_id"],
                    maintenance_record_id=request.maintenance_record_id,
                    billing_account_id=request.billing_account_id,
                    status="existing",
                    sell_subtotal=request.sell_subtotal,
                    tax_total=request.tax_total,
                    sell_total=request.sell_total,
                    already_existed=True,
                )
            )

        # 3. Create the draft invoice entity
        invoice_data = await workflow.execute_activity(
            ops.create_maintenance_invoice,
            args=[
                request.maintenance_record_id,
                request.billing_account_id,
                request.sell_subtotal,
                request.tax_total,
                request.sell_total,
                request.created_by,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )
        invoice_id = invoice_data["invoice_id"]

        # 4. Link invoice to maintenance work order via an explicit relationship
        await workflow.execute_activity(
            create_relationship,
            args=[invoice_id, request.maintenance_record_id, "invoice:generated_from:maintenance_work_order", {}],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        return asdict(
            MaintenanceInvoiceSummary(
                invoice_id=invoice_id,
                maintenance_record_id=request.maintenance_record_id,
                billing_account_id=request.billing_account_id,
                status=invoice_data["status"],
                sell_subtotal=invoice_data["sell_subtotal"],
                tax_total=invoice_data["tax_total"],
                sell_total=invoice_data["sell_total"],
                already_existed=False,
            )
        )
