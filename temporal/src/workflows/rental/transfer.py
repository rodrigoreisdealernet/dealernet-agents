"""Transfer workflow: moves an asset between branches with ship/receive milestones.

Business rules:
- Transfer is blocked if asset status is not 'available'.
- Transfer lifecycle progresses requested → approved → in_transit → received.
- Two signals complete the transfer: 'ship' (origin) and 'receive' (destination).
- Asset status transitions: available → in_transit → available (at destination).
"""
from __future__ import annotations

from dataclasses import asdict

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import rental_operations as ops
    from ...models.rental import MilestoneSignal, TransferRequest, TransferResult


@workflow.defn
class TransferWorkflow:
    """Orchestrates an asset transfer between two branches."""

    def __init__(self) -> None:
        self._ship_signal: MilestoneSignal | None = None
        self._receive_signal: MilestoneSignal | None = None
        self._status = "requested"

    # RetryPolicy tuned per activity class (ADR-0003).
    _NON_RETRYABLE = ["ValueError", "ApplicationError"]
    _MONEY_RETRY = RetryPolicy(maximum_attempts=2, non_retryable_error_types=_NON_RETRYABLE)
    _STANDARD_RETRY = RetryPolicy(maximum_attempts=3, non_retryable_error_types=_NON_RETRYABLE)

    @workflow.run
    async def run(self, request: TransferRequest) -> dict:
        # 1. Fetch current asset status
        asset_state = await workflow.execute_activity(
            ops.get_asset_status,
            request.asset_id,
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )
        current_status = asset_state.get("status", "")

        # 2. Check transferability
        check = await workflow.execute_activity(
            ops.check_asset_transferable,
            args=[request.asset_id, current_status],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )
        if not check["allowed"]:
            self._status = "blocked"
            return asdict(
                TransferResult(
                    transfer_id="",
                    asset_id=request.asset_id,
                    status="blocked",
                    blocked=True,
                    blocked_reason=check["reason"],
                )
            )

        # 3. Create transfer entity
        transfer_data = await workflow.execute_activity(
            ops.create_transfer_record,
            args=[
                request.asset_id,
                request.origin_branch_id,
                request.destination_branch_id,
                request.requested_by,
                request.requested_ship_date,
                request.expected_receive_date,
                request.asset_scope,
                request.internal_cost,
                request.sourcing_decision_id,
                request.transfer_exception_reason,
                request.origin_project_id,
                request.destination_project_id,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._MONEY_RETRY,
        )
        transfer_id = transfer_data["transfer_id"]
        self._status = transfer_data.get("status", "requested")

        await workflow.execute_activity(
            ops.record_transfer_milestone,
            args=[
                transfer_id,
                request.asset_id,
                "approved",
                request.requested_by,
                request.sourcing_decision_id,
            ],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )
        self._status = "approved"

        # 4. Wait for shipped signal — asset enters in_transit only when physically shipped
        with workflow.unsafe.imports_passed_through():
            from ...activities.supabase_core import update_entity_scd2
        await workflow.wait_condition(lambda: self._ship_signal is not None)
        await workflow.execute_activity(
            update_entity_scd2,
            args=[request.asset_id, {"status": "in_transit"}, self._ship_signal.actor_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )
        self._status = "in_transit"
        await workflow.execute_activity(
            ops.record_transfer_milestone,
            args=[transfer_id, request.asset_id, "in_transit", self._ship_signal.actor_id, self._ship_signal.notes],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )

        # 5. Wait for received signal
        await workflow.wait_condition(lambda: self._receive_signal is not None)
        await workflow.execute_activity(
            ops.record_transfer_milestone,
            args=[transfer_id, request.asset_id, "received", self._receive_signal.actor_id, self._receive_signal.notes],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )

        # 6. Update asset branch and restore available status
        await workflow.execute_activity(
            ops.update_asset_branch,
            args=[request.asset_id, request.destination_branch_id, self._receive_signal.actor_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )
        await workflow.execute_activity(
            update_entity_scd2,
            args=[request.asset_id, {"status": "available"}, self._receive_signal.actor_id],
            start_to_close_timeout=workflow.timedelta(seconds=10),
            retry_policy=self._STANDARD_RETRY,
        )
        self._status = "received"

        return asdict(
            TransferResult(
                transfer_id=transfer_id,
                asset_id=request.asset_id,
                status="received",
                blocked=False,
                sourcing_decision_id=request.sourcing_decision_id,
                requested_ship_date=transfer_data.get("requested_ship_date") or request.requested_ship_date,
                expected_receive_date=transfer_data.get("expected_receive_date") or request.expected_receive_date,
                asset_scope=transfer_data.get("asset_scope") or request.asset_scope,
                internal_cost=transfer_data.get("internal_cost", request.internal_cost),
                origin_project_id=transfer_data.get("origin_project_id") or request.origin_project_id,
                destination_project_id=transfer_data.get("destination_project_id") or request.destination_project_id,
                exceptions=list(
                    dict.fromkeys(
                        reason
                        for reason in [
                            transfer_data.get("transfer_exception_reason"),
                            request.transfer_exception_reason,
                        ]
                        if reason
                    )
                ),
            )
        )

    @workflow.signal
    async def ship(self, signal: MilestoneSignal) -> None:
        self._ship_signal = signal

    @workflow.signal
    async def receive(self, signal: MilestoneSignal) -> None:
        self._receive_signal = signal

    @workflow.query
    def get_status(self) -> str:
        return self._status
