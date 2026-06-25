"""Rental order-to-contract Temporal workflow.

Lifecycle:
  order created (draft)
    ↓  signal: quote
  quoted
    ↓  signal: approve
  approved
    ↓  signal: convert  →  contract created (pending_execution)
                              ↓  (checkout signals on contract lines)
                            active
                              ↓  (return signals on contract lines)
                            closed

Cancellation and expiry signals are accepted at any non-terminal order state.
Contract cancellation is accepted at pending_execution or active.
"""
from __future__ import annotations

import datetime
import logging
from dataclasses import asdict, dataclass

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from temporalio.common import RetryPolicy

    from ...activities import ops_pm
    from ...activities import rental as rental_activities
    from ...models.rental import (
        AssignAssetInput,
        CheckoutLineInput,
        ContractStatus,
        ConvertOrderInput,
        CreateRentalOrderInput,
        LineStatus,
        OrderStatus,
        RentalContractResult,
        RentalLineResult,
        RentalOrderResult,
        ReturnLineInput,
        TransitionOrderInput,
    )

logger = logging.getLogger(__name__)

_ACTIVITY_TIMEOUT = datetime.timedelta(seconds=30)
_REJECT_REASON_ORDER_ALREADY_CONVERTED = "order_already_converted"

# RetryPolicy constants tuned per activity class (ADR-0003).
# Create/money activities: tight cap (2 attempts) to limit duplicate-row risk on
# non-idempotent retries; ValueError and similar business errors are non-retryable.
# Standard read/transition activities: 3 attempts is sufficient for transient failures.
_NON_RETRYABLE = ["ValueError", "ApplicationError"]
_MONEY_RETRY = RetryPolicy(
    maximum_attempts=2,
    non_retryable_error_types=_NON_RETRYABLE,
)
_STANDARD_RETRY = RetryPolicy(
    maximum_attempts=3,
    non_retryable_error_types=_NON_RETRYABLE,
)


# ---------------------------------------------------------------------------
# Signal / query parameter dataclasses
# ---------------------------------------------------------------------------

@dataclass
class QuoteOrderSignal:
    actor_id: str | None = None


@dataclass
class ApproveOrderSignal:
    actor_id: str | None = None


@dataclass
class CancelOrderSignal:
    actor_id: str | None = None
    reason: str | None = None


@dataclass
class ExpireOrderSignal:
    actor_id: str | None = None


@dataclass
class ConvertOrderSignal:
    actor_id: str | None = None


@dataclass
class CancelContractSignal:
    actor_id: str | None = None
    reason: str | None = None


@dataclass
class AssignAssetSignal:
    order_line_entity_id: str
    asset_id: str
    actor_id: str | None = None


@dataclass
class CheckoutLineSignal:
    contract_line_entity_id: str
    asset_id: str               # resolved asset assigned to this contract line
    actual_start: str           # ISO-8601
    actor_id: str | None = None


@dataclass
class ReturnLineSignal:
    contract_line_entity_id: str
    actual_end: str             # ISO-8601
    actor_id: str | None = None
    asset_id: str | None = None  # resolved asset on this line; used to emit PM rental-count fact


# ---------------------------------------------------------------------------
# Main workflow
# ---------------------------------------------------------------------------

@workflow.defn
class RentalOrderWorkflow:
    """Orchestrates the full rental order → contract lifecycle."""

    def __init__(self) -> None:
        self._order_status: str = OrderStatus.DRAFT
        self._order_entity_id: str = ""
        self._contract_entity_id: str = ""
        self._contract_status: str = ""

        # Pending signals queued before the workflow loop processes them
        self._pending_order_signal: str | None = None  # new status
        self._pending_order_signal_meta: dict = {}
        self._pending_contract_cancel: bool = False
        self._assign_asset_signals: list[AssignAssetSignal] = []
        self._checkout_signals: list[CheckoutLineSignal] = []
        self._return_signals: list[ReturnLineSignal] = []
        self._rejected_order_signal_metadata: dict[str, str | None] = {}

        # Line-count tracking for auto-close: set from inp.lines in run()
        self._total_lines: int = 0
        self._completed_lines: int = 0  # lines returned or cancelled

        # Checkout block results keyed by contract_line_entity_id
        self._checkout_results: dict[str, RentalLineResult] = {}

    # -----------------------------------------------------------------------
    # Run
    # -----------------------------------------------------------------------

    @workflow.run
    async def run(self, inp: CreateRentalOrderInput) -> dict:
        # 1. Create the order — pass the workflow ID as idempotency key so that
        # retries derive the same entity ID rather than minting a duplicate (ADR-0003).
        result: RentalOrderResult = await workflow.execute_activity(
            rental_activities.create_rental_order,
            CreateRentalOrderInput(
                requester_id=inp.requester_id,
                rental_type=inp.rental_type,
                lines=inp.lines,
                created_by=inp.created_by,
                notes=inp.notes,
                idempotency_key=workflow.info().workflow_id,
            ),
            start_to_close_timeout=_ACTIVITY_TIMEOUT,
            retry_policy=_MONEY_RETRY,
        )
        self._order_entity_id = result.order_entity_id
        self._order_status = result.status
        self._total_lines = len(inp.lines)

        workflow.logger.info(
            "rental_order_created",
            extra={"order_entity_id": self._order_entity_id, "status": self._order_status},
        )

        # 2. Drive order lifecycle via signals
        while self._order_status not in OrderStatus.TERMINAL:
            await workflow.wait_condition(
                lambda: self._pending_order_signal is not None
                or bool(self._assign_asset_signals)
            )

            # Handle asset assignment signals first (may arrive at any pre-terminal state)
            while self._assign_asset_signals:
                sig = self._assign_asset_signals.pop(0)
                await workflow.execute_activity(
                    rental_activities.assign_asset_to_order_line,
                    AssignAssetInput(
                        order_line_entity_id=sig.order_line_entity_id,
                        asset_id=sig.asset_id,
                        actor_id=sig.actor_id,
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )

            if self._pending_order_signal is None:
                continue

            new_status = self._pending_order_signal
            meta = self._pending_order_signal_meta
            self._pending_order_signal = None
            self._pending_order_signal_meta = {}

            # Validate the transition
            allowed = OrderStatus.TRANSITIONS.get(self._order_status, frozenset())
            if new_status not in allowed:
                workflow.logger.warning(
                    "invalid_order_transition",
                    extra={
                        "from": self._order_status,
                        "to": new_status,
                        "order_entity_id": self._order_entity_id,
                    },
                )
                continue

            order_result: RentalOrderResult = await workflow.execute_activity(
                rental_activities.transition_order_status,
                TransitionOrderInput(
                    order_entity_id=self._order_entity_id,
                    new_status=new_status,
                    actor_id=meta.get("actor_id"),
                    reason=meta.get("reason"),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_STANDARD_RETRY,
            )
            self._order_status = order_result.status

            workflow.logger.info(
                "order_status_transitioned",
                extra={"order_entity_id": self._order_entity_id, "status": self._order_status},
            )

            # If approved, kick off contract lifecycle
            if self._order_status == OrderStatus.APPROVED:
                await self._run_contract_lifecycle(meta.get("actor_id"))

        return {
            "order_entity_id": self._order_entity_id,
            "order_status": self._order_status,
            "contract_entity_id": self._contract_entity_id,
            "contract_status": self._contract_status,
        }

    # -----------------------------------------------------------------------
    # Contract lifecycle (called after order is approved then converted)
    # -----------------------------------------------------------------------

    async def _run_contract_lifecycle(self, actor_id: str | None) -> None:
        # Wait for the convert signal
        await workflow.wait_condition(
            lambda: self._pending_order_signal == OrderStatus.CONVERTED
            or self._pending_contract_cancel
            or self._pending_order_signal == OrderStatus.CANCELLED
        )

        if self._pending_order_signal == OrderStatus.CANCELLED or self._pending_contract_cancel:
            # Order cancelled before conversion; leave _pending_order_signal intact
            # so the outer loop can process the CANCELLED transition.
            self._pending_contract_cancel = False
            return

        # Consume convert signal
        self._pending_order_signal = None
        self._pending_order_signal_meta = {}

        # Convert order → contract
        contract_result: RentalContractResult = await workflow.execute_activity(
            rental_activities.convert_order_to_contract,
            ConvertOrderInput(
                order_entity_id=self._order_entity_id,
                actor_id=actor_id,
            ),
            start_to_close_timeout=_ACTIVITY_TIMEOUT,
            retry_policy=_MONEY_RETRY,
        )
        self._contract_entity_id = contract_result.contract_entity_id
        self._contract_status = contract_result.status
        self._order_status = OrderStatus.CONVERTED

        workflow.logger.info(
            "order_converted_to_contract",
            extra={
                "order_entity_id": self._order_entity_id,
                "contract_entity_id": self._contract_entity_id,
            },
        )

        # Drive contract lifecycle via checkout / return signals
        while self._contract_status not in ContractStatus.TERMINAL:
            await workflow.wait_condition(
                lambda: bool(self._checkout_signals)
                or bool(self._return_signals)
                or self._pending_contract_cancel
                or self._pending_order_signal == OrderStatus.CANCELLED
            )

            # Order-level cancel takes priority over contract signals
            if self._pending_order_signal == OrderStatus.CANCELLED:
                cancel_actor_id = self._pending_order_signal_meta.get("actor_id")
                self._pending_order_signal = None
                self._pending_order_signal_meta = {}
                self._pending_contract_cancel = False

                contract_cancel: RentalContractResult = await workflow.execute_activity(
                    rental_activities.transition_contract_status,
                    args=[self._contract_entity_id, ContractStatus.CANCELLED, cancel_actor_id],
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )
                self._contract_status = contract_cancel.status
                break

            if self._pending_contract_cancel:
                self._pending_contract_cancel = False
                contract_cancel: RentalContractResult = await workflow.execute_activity(
                    rental_activities.transition_contract_status,
                    args=[self._contract_entity_id, ContractStatus.CANCELLED, actor_id],
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )
                self._contract_status = contract_cancel.status
                break

            # Process checkout signals
            while self._checkout_signals:
                sig = self._checkout_signals.pop(0)
                # Check the assigned asset's availability before proceeding
                avail = await workflow.execute_activity(
                    rental_activities.get_asset_availability,
                    sig.asset_id,
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )
                if avail.get("blocks_checkout"):
                    block_reason = avail.get("availability_status", "unknown")
                    workflow.logger.warning(
                        "checkout_blocked",
                        extra={
                            "contract_line_entity_id": sig.contract_line_entity_id,
                            "block_reason": block_reason,
                        },
                    )
                    self._checkout_results[sig.contract_line_entity_id] = RentalLineResult(
                        line_entity_id=sig.contract_line_entity_id,
                        version_id="",
                        status=LineStatus.PENDING,
                        success=False,
                        block_reason=block_reason,
                    )
                    continue

                checkout_result: RentalLineResult = await workflow.execute_activity(
                    rental_activities.checkout_contract_line,
                    CheckoutLineInput(
                        contract_line_entity_id=sig.contract_line_entity_id,
                        actual_start=sig.actual_start,
                        actor_id=sig.actor_id,
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )
                self._checkout_results[sig.contract_line_entity_id] = checkout_result

                if self._contract_status == ContractStatus.PENDING_EXECUTION:
                    activate_result: RentalContractResult = await workflow.execute_activity(
                        rental_activities.transition_contract_status,
                        args=[self._contract_entity_id, ContractStatus.ACTIVE, sig.actor_id],
                        start_to_close_timeout=_ACTIVITY_TIMEOUT,
                        retry_policy=_STANDARD_RETRY,
                    )
                    self._contract_status = activate_result.status

            # Process return signals
            while self._return_signals:
                sig = self._return_signals.pop(0)
                await workflow.execute_activity(
                    rental_activities.return_contract_line,
                    ReturnLineInput(
                        contract_line_entity_id=sig.contract_line_entity_id,
                        actual_end=sig.actual_end,
                        actor_id=sig.actor_id,
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )
                self._completed_lines += 1
                # Emit the asset_rental_completion fact so the rental-count PM
                # trigger has an incrementing counter to evaluate against.
                if sig.asset_id:
                    await workflow.execute_activity(
                        ops_pm.pm_record_rental_completion,
                        args=[sig.asset_id, sig.contract_line_entity_id],
                        start_to_close_timeout=_ACTIVITY_TIMEOUT,
                        retry_policy=_STANDARD_RETRY,
                    )

            # Auto-close the contract when all lines have been returned
            if (
                self._contract_status == ContractStatus.ACTIVE
                and self._total_lines > 0
                and self._completed_lines >= self._total_lines
            ):
                close_result: RentalContractResult = await workflow.execute_activity(
                    rental_activities.transition_contract_status,
                    args=[self._contract_entity_id, ContractStatus.CLOSED, None],
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_STANDARD_RETRY,
                )
                self._contract_status = close_result.status

        # After contract lifecycle ends, set order status to converted (already set above)

    # -----------------------------------------------------------------------
    # Signals
    # -----------------------------------------------------------------------

    @workflow.signal
    async def quote_order(self, sig: QuoteOrderSignal) -> None:
        self._pending_order_signal = OrderStatus.QUOTED
        self._pending_order_signal_meta = {"actor_id": sig.actor_id}

    @workflow.signal
    async def approve_order(self, sig: ApproveOrderSignal) -> None:
        self._pending_order_signal = OrderStatus.APPROVED
        self._pending_order_signal_meta = {"actor_id": sig.actor_id}

    @workflow.signal
    async def cancel_order(self, sig: CancelOrderSignal) -> None:
        if self._order_status == OrderStatus.CONVERTED:
            self._rejected_order_signal_metadata = {
                "attempted_status": OrderStatus.CANCELLED,
                "reason": _REJECT_REASON_ORDER_ALREADY_CONVERTED,
                "actor_id": sig.actor_id,
            }
            logger.warning(
                "reject_order_cancel_after_conversion",
                extra={"order_entity_id": self._order_entity_id, "actor_id": sig.actor_id},
            )
            return
        self._pending_order_signal = OrderStatus.CANCELLED
        self._pending_order_signal_meta = {"actor_id": sig.actor_id, "reason": sig.reason}

    @workflow.signal
    async def expire_order(self, sig: ExpireOrderSignal) -> None:
        self._pending_order_signal = OrderStatus.EXPIRED
        self._pending_order_signal_meta = {"actor_id": sig.actor_id}

    @workflow.signal
    async def convert_order(self, sig: ConvertOrderSignal) -> None:
        self._pending_order_signal = OrderStatus.CONVERTED
        self._pending_order_signal_meta = {"actor_id": sig.actor_id}

    @workflow.signal
    async def cancel_contract(self, sig: CancelContractSignal) -> None:
        self._pending_contract_cancel = True

    @workflow.signal
    async def assign_asset(self, sig: AssignAssetSignal) -> None:
        self._assign_asset_signals.append(sig)

    @workflow.signal
    async def checkout_line(self, sig: CheckoutLineSignal) -> None:
        self._checkout_signals.append(sig)

    @workflow.signal
    async def return_line(self, sig: ReturnLineSignal) -> None:
        self._return_signals.append(sig)

    # -----------------------------------------------------------------------
    # Queries
    # -----------------------------------------------------------------------

    @workflow.query
    def get_order_status(self) -> str:
        return self._order_status

    @workflow.query
    def get_contract_status(self) -> str:
        return self._contract_status

    @workflow.query
    def get_contract_entity_id(self) -> str:
        return self._contract_entity_id

    @workflow.query
    def get_checkout_result(self, contract_line_entity_id: str) -> dict:
        result = self._checkout_results.get(contract_line_entity_id)
        if result is None:
            return {}
        return asdict(result)

    @workflow.query
    def get_last_rejected_order_signal(self) -> dict[str, str | None]:
        return dict(self._rejected_order_signal_metadata)
