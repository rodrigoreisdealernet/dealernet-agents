"""Inspection workflow: records a pass/fail inspection and handles state transitions.

Business rules:
- Inspection types: checkout, return, service.
- Pass at return/service → asset becomes available.
- Pass at checkout → asset status stays on_rent.
- Fail (any type) → asset moves to inspection_hold.
- Caller may optionally request a maintenance record be opened on fail.
"""
from __future__ import annotations

from dataclasses import asdict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import rental_operations as ops
    from ...models.rental import InspectionRequest, InspectionResultSignal, InspectionSummary

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)


@workflow.defn
class InspectionWorkflow:
    """Orchestrates an inspection event and post-result asset state transition."""

    def __init__(self) -> None:
        self._result_signal: InspectionResultSignal | None = None
        self._status = "in_progress"

    @workflow.run
    async def run(self, request: InspectionRequest) -> dict:
        # 1. Create inspection entity
        inspection_data = await workflow.execute_activity(
            ops.create_inspection_record,
            args=[request.asset_id, request.inspection_type.value, request.inspector_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )
        inspection_id = inspection_data["inspection_id"]

        # 2. Wait for inspector to submit pass/fail result
        await workflow.wait_condition(lambda: self._result_signal is not None)
        result = self._result_signal

        # 3. Determine and apply post-inspection asset status
        new_status = await workflow.execute_activity(
            ops.resolve_post_inspection_status,
            args=[request.asset_id, request.inspection_type.value, result.outcome.value],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        with workflow.unsafe.imports_passed_through():
            from ...activities.supabase_core import update_entity_scd2
        await workflow.execute_activity(
            update_entity_scd2,
            args=[request.asset_id, {"status": new_status}, request.inspector_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        self._status = "complete"

        # 4. Optionally trigger maintenance on fail
        maintenance_triggered = False
        if result.outcome.value == "fail" and result.open_maintenance:
            maintenance_triggered = True
            await workflow.execute_activity(
                ops.create_maintenance_record,
                args=[request.asset_id, "inspection_fail", request.inspector_id],
                start_to_close_timeout=workflow.timedelta(seconds=10),
                retry_policy=_MONEY_RETRY,
            )

        return asdict(
            InspectionSummary(
                inspection_id=inspection_id,
                asset_id=request.asset_id,
                outcome=result.outcome.value,
                final_asset_status=new_status,
                maintenance_triggered=maintenance_triggered,
            )
        )

    @workflow.signal
    async def submit_result(self, signal: InspectionResultSignal) -> None:
        self._result_signal = signal

    @workflow.query
    def get_status(self) -> str:
        return self._status
