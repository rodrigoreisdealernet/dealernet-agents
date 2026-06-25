"""Rental domain activities.

All database writes are stubbed (log-only) so that the worker and workflow tests
run without a live Supabase instance.  When a real database connection is
available, replace the STUB bodies with actual SQL via the Supabase client.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from temporalio import activity

from ..models.rental import (
    AssetAvailabilityStatus,
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _new_id() -> str:
    return str(uuid.uuid4())


def _version_id() -> str:
    return str(uuid.uuid4())


def _idempotent_id(seed: str) -> str:
    """Return a deterministic UUID derived from *seed* using UUID v5 (SHA-1 namespaced).

    Using a stable seed means re-running the same activity (on retry) produces the
    same entity ID, so concurrent retries cannot mint duplicate rows in production.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def _log_stub(activity_name: str, **kwargs: Any) -> None:
    logger.info("[STUB] %s", activity_name, extra=kwargs)


# ---------------------------------------------------------------------------
# Order activities
# ---------------------------------------------------------------------------

@activity.defn
def create_rental_order(inp: CreateRentalOrderInput) -> RentalOrderResult:
    """Create a new rental order entity in draft status with its line items."""
    # Derive a stable entity ID from the workflow-scoped idempotency key so that
    # Temporal retries do not insert duplicate rows (ADR-0003).
    # Priority: (1) explicit idempotency_key from caller, (2) workflow_id from
    # activity context, (3) random fallback (non-production paths only).
    if inp.idempotency_key:
        seed = inp.idempotency_key
    else:
        try:
            seed = activity.info().workflow_id
        except RuntimeError:
            seed = _new_id()
    order_id = _idempotent_id(f"rental_order:{seed}")
    version_id = _version_id()

    _log_stub(
        "create_rental_order",
        order_id=order_id,
        requester_id=inp.requester_id,
        rental_type=inp.rental_type,
        line_count=len(inp.lines),
        created_by=inp.created_by,
    )

    # STUB: in production, execute in a single transaction:
    #   1. INSERT INTO entities (entity_type) VALUES ('rental_order') RETURNING id
    #   2. INSERT INTO entity_versions (entity_id, version_number, data) VALUES (...)
    #   3. For each line: INSERT INTO entities + entity_versions + relationships_v2

    return RentalOrderResult(
        order_entity_id=order_id,
        version_id=version_id,
        status=OrderStatus.DRAFT,
    )


@activity.defn
def transition_order_status(inp: TransitionOrderInput) -> RentalOrderResult:
    """Transition a rental order to a new lifecycle status.

    NOTE: Workflow-level validation currently enforces the state machine.
    Activity-level validation is deferred until this stub fetches the real
    current status from entity_versions.
    """
    # STUB: in production, fetch current status from entity_versions,
    # validate the transition, then INSERT a new entity_versions row.

    version_id = _version_id()
    _log_stub(
        "transition_order_status",
        order_entity_id=inp.order_entity_id,
        new_status=inp.new_status,
        actor_id=inp.actor_id,
        reason=inp.reason,
    )

    return RentalOrderResult(
        order_entity_id=inp.order_entity_id,
        version_id=version_id,
        status=inp.new_status,
    )


@activity.defn
def assign_asset_to_order_line(inp: AssignAssetInput) -> RentalLineResult:
    """Assign a specific asset to an order line item."""
    version_id = _version_id()

    _log_stub(
        "assign_asset_to_order_line",
        order_line_entity_id=inp.order_line_entity_id,
        asset_id=inp.asset_id,
        actor_id=inp.actor_id,
    )

    # STUB: INSERT new entity_versions row with updated asset_id in data JSONB.
    # Also INSERT / update relationships_v2 row for line_assigned_asset.

    return RentalLineResult(
        line_entity_id=inp.order_line_entity_id,
        version_id=version_id,
        status=LineStatus.PENDING,
    )


# ---------------------------------------------------------------------------
# Contract activities
# ---------------------------------------------------------------------------

@activity.defn
def convert_order_to_contract(inp: ConvertOrderInput) -> RentalContractResult:
    """Convert an approved order into a rental contract.

    Creates:
    - A new `rental_contract` entity (status=pending_execution)
    - A `rental_contract_line` entity for each order line
    - An `order_converted_to` relationship between order and contract
    - A new SCD2 version on the order entity with status=converted
    """
    contract_id = _idempotent_id(f"rental_contract:{inp.order_entity_id}")
    version_id = _version_id()

    _log_stub(
        "convert_order_to_contract",
        order_entity_id=inp.order_entity_id,
        contract_entity_id=contract_id,
        actor_id=inp.actor_id,
    )

    # STUB: full transaction:
    #   1. Fetch order entity_versions (ensure status == approved)
    #   2. INSERT entities for contract + contract lines
    #   3. INSERT entity_versions for each with pending_execution / pending status
    #   4. INSERT relationships_v2: order_converted_to, contract_has_line
    #   5. INSERT new entity_versions for order with status=converted

    return RentalContractResult(
        contract_entity_id=contract_id,
        version_id=version_id,
        status=ContractStatus.PENDING_EXECUTION,
        order_entity_id=inp.order_entity_id,
    )


@activity.defn
def transition_contract_status(
    contract_entity_id: str,
    new_status: str,
    actor_id: str | None = None,
) -> RentalContractResult:
    """Transition a rental contract to a new lifecycle status.

    NOTE: Workflow-level validation currently enforces the state machine.
    Activity-level validation is deferred until this stub fetches the real
    current status from entity_versions.
    """
    version_id = _version_id()
    _log_stub(
        "transition_contract_status",
        contract_entity_id=contract_entity_id,
        new_status=new_status,
        actor_id=actor_id,
    )

    return RentalContractResult(
        contract_entity_id=contract_entity_id,
        version_id=version_id,
        status=new_status,
        order_entity_id="",
    )


# ---------------------------------------------------------------------------
# Line-item activities (checkout / return)
# ---------------------------------------------------------------------------

@activity.defn
def get_asset_availability(asset_id: str) -> dict[str, Any]:
    """Return the current availability status of an asset.

    In production this queries entity_versions for the asset entity and
    returns availability_status from the JSONB data blob.
    """
    _log_stub("get_asset_availability", asset_id=asset_id)
    # STUB: returns available by default; tests override this
    return {
        "asset_id": asset_id,
        "availability_status": AssetAvailabilityStatus.AVAILABLE,
        "blocks_checkout": False,
    }


@activity.defn
def checkout_contract_line(inp: CheckoutLineInput) -> RentalLineResult:
    """Check out a contract line item.

    Blocks if the assigned asset is unavailable.
    Sets actual_start and transitions line status to checked_out.
    Activates the parent contract if it was pending_execution.
    """
    # STUB: in production:
    #   1. Fetch contract line entity_versions (ensure status == pending, asset_id set)
    #   2. Fetch asset availability — block if status is in BLOCKING set
    #   3. INSERT new entity_versions for the line: status=checked_out, actual_start set
    #   4. Insert time_series_points event
    #   5. Activate parent contract if needed

    version_id = _version_id()
    _log_stub(
        "checkout_contract_line",
        contract_line_entity_id=inp.contract_line_entity_id,
        actual_start=inp.actual_start,
        actor_id=inp.actor_id,
    )

    return RentalLineResult(
        line_entity_id=inp.contract_line_entity_id,
        version_id=version_id,
        status=LineStatus.CHECKED_OUT,
    )


@activity.defn
def return_contract_line(inp: ReturnLineInput) -> RentalLineResult:
    """Return a checked-out contract line item.

    Sets actual_end and transitions line status to returned.
    Preserves asset_id and actual_start in the new SCD2 version.
    Closes the parent contract if all lines are now returned or cancelled.
    """
    # STUB: in production:
    #   1. Fetch contract line entity_versions (ensure status == checked_out)
    #   2. INSERT new entity_versions: status=returned, actual_end set,
    #      asset_id and actual_start copied from previous version
    #   3. Insert time_series_points event
    #   4. If all sibling lines are in terminal status, close the contract

    version_id = _version_id()
    _log_stub(
        "return_contract_line",
        contract_line_entity_id=inp.contract_line_entity_id,
        actual_end=inp.actual_end,
        actor_id=inp.actor_id,
    )

    return RentalLineResult(
        line_entity_id=inp.contract_line_entity_id,
        version_id=version_id,
        status=LineStatus.RETURNED,
    )
