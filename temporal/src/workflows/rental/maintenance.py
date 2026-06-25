"""Maintenance workflow: opens and completes a maintenance record with downtime tracking.

Business rules:
- Opening maintenance is blocked unless asset status is available, inspection_hold, or returned.
- Asset transitions to 'maintenance' when the record is opened.
- Downtime (minutes) is calculated from workflow start to completion signal.
- Downtime is written to time_series_points via record_asset_downtime activity.
- Completing maintenance transitions asset back to 'available'.
- availability_impact ('soft_down' | 'hard_down') is persisted in the maintenance entity's
  JSONB data blob via create_entity (entity_type='maintenance_record').  The asset is linked
  via create_relationship(asset_has_maintenance_record) so that v_asset_active_down_state can
  derive the active down state from open (completed_at IS NULL) maintenance records.
- On completion, update_entity_scd2 sets completed_at on the maintenance record entity.
  This clears the record from v_asset_active_down_state with no additional writes, restoring
  the asset's availability automatically in all downstream read models.
"""
from __future__ import annotations

import datetime
from dataclasses import asdict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import rental_operations as ops
    from ...models.rental import MaintenanceCompleteSignal, MaintenanceRequest, MaintenanceSummary

_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
_STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)


@workflow.defn
class MaintenanceWorkflow:
    """Orchestrates opening and completing a maintenance record for an asset."""

    def __init__(self) -> None:
        self._complete_signal: MaintenanceCompleteSignal | None = None
        self._status = "pending"

    @workflow.run
    async def run(self, request: MaintenanceRequest) -> dict:
        # 1. Fetch current asset status
        asset_state = await workflow.execute_activity(
            ops.get_asset_status,
            request.asset_id,
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        current_status = asset_state.get("status", "")

        # 2. Check whether maintenance can be opened
        check = await workflow.execute_activity(
            ops.check_asset_maintenance_openable,
            args=[request.asset_id, current_status],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        if not check["allowed"]:
            self._status = "blocked"
            return asdict(
                MaintenanceSummary(
                    maintenance_record_id="",
                    asset_id=request.asset_id,
                    status="blocked",
                    blocked=True,
                    blocked_reason=check["reason"],
                )
            )

        # 3a. Create maintenance entity through the entity/SCD2 persistence path.
        #     All down-state fields (availability_impact, blocking_reason, expected_return_at,
        #     opened_at) are written into entity_versions.data so that v_asset_active_down_state
        #     can derive the active down severity for this asset from open maintenance records.
        with workflow.unsafe.imports_passed_through():
            from ...activities.supabase_core import create_entity, create_relationship, update_entity_scd2

        maintenance_attrs = {
            "maintenance_type": request.maintenance_type,
            "technician_id": request.technician_id,
            "notes": request.notes,
            "availability_impact": request.availability_impact,
            "blocking_reason": request.blocking_reason,
            "expected_return_at": request.expected_return_at,
            "opened_at": workflow.now().isoformat(),
        }
        record_result = await workflow.execute_activity(
            create_entity,
            args=["maintenance_record", maintenance_attrs, request.technician_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )
        record_id: str = record_result.entity_id

        # 3b. Link the maintenance record to the asset via asset_has_maintenance_record.
        #     v_asset_active_down_state reads this relationship to find open records for an asset.
        await workflow.execute_activity(
            create_relationship,
            args=[request.asset_id, record_id, "asset_has_maintenance_record"],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )

        # 4. Update asset to 'maintenance' status; capture start time
        await workflow.execute_activity(
            update_entity_scd2,
            args=[
                request.asset_id,
                {"status": "maintenance", "operational_status": "maintenance"},
                request.technician_id,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        self._status = "open"
        start_time: datetime.datetime = workflow.now()

        # 5. Wait for completion signal
        await workflow.wait_condition(lambda: self._complete_signal is not None)
        end_time: datetime.datetime = workflow.now()
        downtime_minutes = (end_time - start_time).total_seconds() / 60.0
        complete = self._complete_signal

        await workflow.execute_activity(
            ops.complete_maintenance_record,
            args=[
                record_id,
                request.asset_id,
                complete.technician_id,
                complete.outcome,
                end_time.isoformat(),
                complete.resolution_notes,
                complete.cost_summary,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        # 6. Record downtime in time_series_points
        await workflow.execute_activity(
            ops.record_asset_downtime,
            args=[
                request.asset_id,
                record_id,
                downtime_minutes,
                start_time.isoformat(),
                end_time.isoformat(),
                "maintenance",
                None,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        restore_state = await workflow.execute_activity(
            ops.resolve_asset_maintenance_completion_status,
            args=[request.asset_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        final_asset_status = restore_state.get("status")
        if not final_asset_status:
            workflow.logger.warning(
                f"maintenance completion status missing resolved state; defaulting to available asset_id={request.asset_id} record_id={record_id}"
            )
            final_asset_status = "available"

        await workflow.execute_activity(
            ops.record_maintenance_completion_event,
            args=[
                request.asset_id,
                record_id,
                end_time.isoformat(),
                complete.outcome,
                downtime_minutes,
                final_asset_status,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )

        # 7. Set completed_at on the maintenance record entity.
        #    This clears the record from v_asset_active_down_state; no additional writes are needed.
        await workflow.execute_activity(
            update_entity_scd2,
            args=[record_id, {"completed_at": end_time.isoformat()}, complete.technician_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_MONEY_RETRY,
        )

        # 8. Restore asset to the explicitly resolved lifecycle state
        await workflow.execute_activity(
            update_entity_scd2,
            args=[
                request.asset_id,
                {"status": final_asset_status, "operational_status": final_asset_status},
                complete.technician_id,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=_STANDARD_RETRY,
        )
        self._status = "completed"

        return asdict(
            MaintenanceSummary(
                maintenance_record_id=record_id,
                asset_id=request.asset_id,
                status="completed",
                blocked=False,
                downtime_minutes=downtime_minutes,
                final_asset_status=final_asset_status,
                down_severity=request.availability_impact,
                down_reason=request.blocking_reason,
            )
        )

    @workflow.signal
    async def complete(self, signal: MaintenanceCompleteSignal) -> None:
        self._complete_signal = signal

    @workflow.query
    def get_status(self) -> str:
        return self._status
