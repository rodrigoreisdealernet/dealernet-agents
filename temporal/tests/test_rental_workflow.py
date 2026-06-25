"""
Tests for RentalOrderWorkflow.

Two test layers:

1.  **Signal / query tests** – call signal handlers and query methods directly
    as plain Python coroutines / functions on an instantiated workflow object.
    No Temporal runtime is needed.

2.  **Simulated lifecycle tests** – run the workflow's ``run()`` coroutine in a
    plain asyncio event loop with Temporal primitives patched so that
    ``execute_activity`` calls the real activity stub and ``wait_condition``
    polls the condition flag.  This validates the full lifecycle orchestration
    (draft→quoted→approved→converted→active→closed), cancellation, expiry, and
    checkout-blocking without requiring the Temporal test-server binary (which
    needs a network download unavailable in sandboxed CI).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from temporal.src.activities import rental as rental_activities
from temporal.src.models.rental import (
    AssetAvailabilityStatus,
    ContractStatus,
    CreateRentalOrderInput,
    LineStatus,
    OrderStatus,
    RateType,
    RentalContractResult,
    RentalLineInput,
    RentalLineResult,
    RentalOrderResult,
    RentalType,
)
from temporal.src.workflows.rental.rental_workflow import (
    _REJECT_REASON_ORDER_ALREADY_CONVERTED,
    ApproveOrderSignal,
    AssignAssetSignal,
    CancelContractSignal,
    CancelOrderSignal,
    CheckoutLineSignal,
    ConvertOrderSignal,
    ExpireOrderSignal,
    QuoteOrderSignal,
    RentalOrderWorkflow,
    ReturnLineSignal,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ORDER_ID = "order-sim-001"
_CONTRACT_ID = "contract-sim-001"
_LINE_ID = "cline-sim-001"


def _make_order_input(**kwargs) -> CreateRentalOrderInput:
    defaults = dict(
        requester_id="user-test",
        rental_type=RentalType.EXTERNAL,
        lines=[
            RentalLineInput(
                category_id="cat-excavator",
                quantity=1,
                planned_start="2025-01-01T08:00:00Z",
                planned_end="2025-01-07T18:00:00Z",
                rate_type=RateType.WEEKLY,
                rate_amount=50000,
                rental_type=RentalType.EXTERNAL,
            )
        ],
    )
    defaults.update(kwargs)
    return CreateRentalOrderInput(**defaults)


# ---------------------------------------------------------------------------
# Temporal primitive patches
#
# These replace workflow.execute_activity and workflow.wait_condition with
# asyncio-friendly equivalents so the workflow run() coroutine can execute
# inside a plain asyncio event loop.
# ---------------------------------------------------------------------------

# Stateful mock activities used by the simulated runs.
# Each call to transition_*_status returns the requested new_status so the
# workflow state machine advances correctly (the real stubs always assume
# current = draft which breaks multi-step flows).

def _mock_create_rental_order(inp: CreateRentalOrderInput) -> RentalOrderResult:
    return RentalOrderResult(
        order_entity_id=_ORDER_ID,
        version_id="v1",
        status=OrderStatus.DRAFT,
    )


def _mock_transition_order_status(inp) -> RentalOrderResult:
    return RentalOrderResult(
        order_entity_id=inp.order_entity_id,
        version_id="v2",
        status=inp.new_status,
    )


def _mock_assign_asset_to_order_line(inp) -> RentalLineResult:
    return RentalLineResult(
        line_entity_id=inp.order_line_entity_id,
        version_id="v1",
        status=LineStatus.PENDING,
    )


def _mock_convert_order_to_contract(inp) -> RentalContractResult:
    return RentalContractResult(
        contract_entity_id=_CONTRACT_ID,
        version_id="v1",
        status=ContractStatus.PENDING_EXECUTION,
        order_entity_id=inp.order_entity_id,
    )


def _mock_transition_contract_status(
    contract_entity_id: str,
    new_status: str,
    actor_id: str | None = None,
) -> RentalContractResult:
    return RentalContractResult(
        contract_entity_id=contract_entity_id,
        version_id="v2",
        status=new_status,
        order_entity_id="",
    )


# Default: asset is available (override per test for blocking scenarios)
_mock_asset_availability: dict[str, Any] = {
    "asset_id": "asset-default",
    "availability_status": AssetAvailabilityStatus.AVAILABLE,
    "blocks_checkout": False,
}


def _mock_get_asset_availability(asset_id: str) -> dict[str, Any]:
    result = dict(_mock_asset_availability)
    result["asset_id"] = asset_id
    return result


def _mock_checkout_contract_line(inp) -> RentalLineResult:
    return RentalLineResult(
        line_entity_id=inp.contract_line_entity_id,
        version_id="v2",
        status=LineStatus.CHECKED_OUT,
    )


def _mock_return_contract_line(inp) -> RentalLineResult:
    return RentalLineResult(
        line_entity_id=inp.contract_line_entity_id,
        version_id="v3",
        status=LineStatus.RETURNED,
    )


_ACTIVITY_MAP = {
    rental_activities.create_rental_order:          _mock_create_rental_order,
    rental_activities.transition_order_status:      _mock_transition_order_status,
    rental_activities.assign_asset_to_order_line:   _mock_assign_asset_to_order_line,
    rental_activities.convert_order_to_contract:    _mock_convert_order_to_contract,
    rental_activities.transition_contract_status:   _mock_transition_contract_status,
    rental_activities.get_asset_availability:       _mock_get_asset_availability,
    rental_activities.checkout_contract_line:       _mock_checkout_contract_line,
    rental_activities.return_contract_line:         _mock_return_contract_line,
}


async def _fake_execute_activity(fn, *pos_args, args=None, **kwargs):
    """Call the mock activity synchronously."""
    real_args = list(args) if args is not None else list(pos_args)
    mock_fn = _ACTIVITY_MAP.get(fn, fn)
    if asyncio.iscoroutinefunction(mock_fn):
        return await mock_fn(*real_args)
    return mock_fn(*real_args)


async def _fake_wait_condition(cond_fn, *, timeout=None):
    """Poll cond_fn() yielding to the event loop until it becomes True."""
    for _ in range(1_000):
        if cond_fn():
            return
        await asyncio.sleep(0)
    raise TimeoutError("wait_condition never became True")


_PATCHES = {
    "temporalio.workflow.execute_activity": _fake_execute_activity,
    "temporalio.workflow.wait_condition":   _fake_wait_condition,
    "temporalio.workflow.logger":           logging.getLogger("test_rental_workflow"),
    "temporalio.workflow.info":             MagicMock(return_value=MagicMock(workflow_id="test-workflow-id")),
}


def _apply_patches():
    """Return a list of started patches (caller must stop them)."""
    started = []
    for target, new_val in _PATCHES.items():
        p = patch(target, new=new_val)
        p.start()
        started.append(p)
    return started


def _stop_patches(patches):
    for p in patches:
        p.stop()


async def _yield(times: int = 20) -> None:
    """Yield to the asyncio event loop ``times`` times.

    Used in simulated workflow tests to give the workflow coroutine enough
    scheduler turns to process signals before the next signal is sent.
    A higher count is needed after signals that trigger multiple activity
    calls (e.g. approve→convert requires two wait_condition polls + two
    activity calls).
    """
    for _ in range(times):
        await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Layer 1: Signal handler and query tests (no Temporal runtime)
# ---------------------------------------------------------------------------

class TestWorkflowSignalHandlers:
    """Signal handlers are plain Python async methods; test without Temporal."""

    @pytest.mark.asyncio
    async def test_initial_state_is_draft(self):
        wf = RentalOrderWorkflow()
        assert wf._order_status == OrderStatus.DRAFT
        assert wf._pending_order_signal is None
        assert wf._pending_contract_cancel is False

    @pytest.mark.asyncio
    async def test_quote_signal_queues_quoted_status(self):
        wf = RentalOrderWorkflow()
        await wf.quote_order(QuoteOrderSignal(actor_id="sales"))
        assert wf._pending_order_signal == OrderStatus.QUOTED
        assert wf._pending_order_signal_meta.get("actor_id") == "sales"

    @pytest.mark.asyncio
    async def test_approve_signal_queues_approved_status(self):
        wf = RentalOrderWorkflow()
        await wf.approve_order(ApproveOrderSignal(actor_id="manager"))
        assert wf._pending_order_signal == OrderStatus.APPROVED

    @pytest.mark.asyncio
    async def test_cancel_order_signal_queues_cancelled(self):
        wf = RentalOrderWorkflow()
        await wf.cancel_order(CancelOrderSignal(actor_id="user", reason="changed mind"))
        assert wf._pending_order_signal == OrderStatus.CANCELLED
        assert wf._pending_order_signal_meta.get("reason") == "changed mind"

    @pytest.mark.asyncio
    async def test_cancel_order_signal_rejected_after_conversion(self):
        wf = RentalOrderWorkflow()
        wf._order_status = OrderStatus.CONVERTED
        await wf.cancel_order(CancelOrderSignal(actor_id="user", reason="changed mind"))
        assert wf._pending_order_signal is None
        assert wf.get_last_rejected_order_signal() == {
            "attempted_status": OrderStatus.CANCELLED,
            "reason": _REJECT_REASON_ORDER_ALREADY_CONVERTED,
            "actor_id": "user",
        }

    @pytest.mark.asyncio
    async def test_expire_order_signal_queues_expired(self):
        wf = RentalOrderWorkflow()
        await wf.expire_order(ExpireOrderSignal())
        assert wf._pending_order_signal == OrderStatus.EXPIRED

    @pytest.mark.asyncio
    async def test_convert_order_signal_queues_converted(self):
        wf = RentalOrderWorkflow()
        await wf.convert_order(ConvertOrderSignal(actor_id="ops"))
        assert wf._pending_order_signal == OrderStatus.CONVERTED

    @pytest.mark.asyncio
    async def test_cancel_contract_sets_flag(self):
        wf = RentalOrderWorkflow()
        await wf.cancel_contract(CancelContractSignal())
        assert wf._pending_contract_cancel is True

    @pytest.mark.asyncio
    async def test_assign_asset_appends_to_queue(self):
        wf = RentalOrderWorkflow()
        sig = AssignAssetSignal(order_line_entity_id="oline-1", asset_id="asset-007")
        await wf.assign_asset(sig)
        assert len(wf._assign_asset_signals) == 1
        assert wf._assign_asset_signals[0].asset_id == "asset-007"

    @pytest.mark.asyncio
    async def test_checkout_line_appends_to_queue(self):
        wf = RentalOrderWorkflow()
        await wf.checkout_line(CheckoutLineSignal(
            contract_line_entity_id=_LINE_ID,
            asset_id="asset-001",
            actual_start="2025-01-01T08:00:00Z",
        ))
        assert len(wf._checkout_signals) == 1

    @pytest.mark.asyncio
    async def test_return_line_appends_to_queue(self):
        wf = RentalOrderWorkflow()
        await wf.return_line(ReturnLineSignal(
            contract_line_entity_id=_LINE_ID,
            actual_end="2025-01-07T18:00:00Z",
        ))
        assert len(wf._return_signals) == 1

    def test_get_order_status_query(self):
        wf = RentalOrderWorkflow()
        wf._order_status = OrderStatus.QUOTED
        assert wf.get_order_status() == OrderStatus.QUOTED

    def test_get_contract_status_query(self):
        wf = RentalOrderWorkflow()
        wf._contract_status = ContractStatus.ACTIVE
        assert wf.get_contract_status() == ContractStatus.ACTIVE

    def test_get_checkout_result_returns_empty_for_unknown(self):
        wf = RentalOrderWorkflow()
        assert wf.get_checkout_result("not-a-line") == {}

    def test_get_checkout_result_returns_stored_result(self):
        wf = RentalOrderWorkflow()
        stored = RentalLineResult(
            line_entity_id=_LINE_ID,
            version_id="v1",
            status=LineStatus.PENDING,
            success=False,
            block_reason=AssetAvailabilityStatus.RETIRED,
        )
        wf._checkout_results[_LINE_ID] = stored
        result = wf.get_checkout_result(_LINE_ID)
        assert result["status"] == LineStatus.PENDING
        assert result["block_reason"] == AssetAvailabilityStatus.RETIRED
        assert result["success"] is False


# ---------------------------------------------------------------------------
# Layer 2: Simulated lifecycle tests (patched Temporal primitives)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_full_lifecycle_happy_path():
    """draft → quoted → approved → converted → (contract) active → closed."""
    patches = _apply_patches()
    try:
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))

        await _yield(10)
        await wf.quote_order(QuoteOrderSignal(actor_id="sales"))
        await _yield()
        await wf.approve_order(ApproveOrderSignal(actor_id="manager"))
        await _yield()
        await wf.convert_order(ConvertOrderSignal(actor_id="manager"))
        await _yield()
        await wf.checkout_line(CheckoutLineSignal(
            contract_line_entity_id=_LINE_ID,
            asset_id="asset-sim-001",
            actual_start="2025-01-01T08:00:00Z",
        ))
        await _yield()
        await wf.return_line(ReturnLineSignal(
            contract_line_entity_id=_LINE_ID,
            actual_end="2025-01-07T18:00:00Z",
        ))
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)

    assert result["order_status"] == OrderStatus.CONVERTED
    assert result["contract_entity_id"] == _CONTRACT_ID
    assert result["contract_status"] == ContractStatus.CLOSED


@pytest.mark.asyncio
async def test_conversion_handoff_contract_pending_execution():
    """Conversion handoff: immediately after the convert signal the contract must
    be in pending_execution and the contract entity ID must be accessible via
    the query handler.  This is the order-to-contract handoff check required by
    issue #36 – the intermediate state was previously not explicitly asserted.
    """
    patches = _apply_patches()
    try:
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))

        await _yield(10)
        await wf.quote_order(QuoteOrderSignal(actor_id="sales"))
        await _yield()
        await wf.approve_order(ApproveOrderSignal(actor_id="manager"))
        await _yield()
        await wf.convert_order(ConvertOrderSignal(actor_id="manager"))
        # Yield enough times for the convert_order_to_contract activity to
        # complete so the contract state is populated before we query it.
        await _yield(30)

        # --- Handoff assertions (pre-checkout, post-conversion) ---
        assert wf.get_order_status() == OrderStatus.CONVERTED, (
            "Order must be CONVERTED immediately after the convert signal"
        )
        assert wf.get_contract_status() == ContractStatus.PENDING_EXECUTION, (
            "Contract must be in PENDING_EXECUTION at the handoff point "
            "(before any checkout)"
        )
        assert wf.get_contract_entity_id() == _CONTRACT_ID, (
            "contract_entity_id must be populated from convert_order_to_contract result"
        )

        # Clean up: cancel the contract so the workflow terminates cleanly.
        await wf.cancel_contract(CancelContractSignal())
        await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)


@pytest.mark.asyncio
async def test_first_checkout_activates_contract_from_pending_execution():
    """The first checkout signal when the contract is pending_execution must
    trigger a transition_contract_status(ACTIVE) call and move the contract to
    active.  This exercises the pending_execution → active leg of the handoff
    that is not covered by the terminal-state assertions in
    test_full_lifecycle_happy_path.
    """
    transition_calls: list[tuple[str, str, str | None]] = []

    original_transition = _ACTIVITY_MAP[rental_activities.transition_contract_status]

    def _capture_transition_calls(contract_entity_id: str, new_status: str, actor_id: str | None = None):
        transition_calls.append((contract_entity_id, new_status, actor_id))
        return original_transition(contract_entity_id, new_status, actor_id)

    patches = []
    try:
        _ACTIVITY_MAP[rental_activities.transition_contract_status] = _capture_transition_calls
        patches = _apply_patches()
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))

        await _yield(10)
        await wf.quote_order(QuoteOrderSignal(actor_id="sales"))
        await _yield()
        await wf.approve_order(ApproveOrderSignal(actor_id="manager"))
        await _yield()
        await wf.convert_order(ConvertOrderSignal(actor_id="manager"))
        await _yield(30)

        # Contract is now pending_execution; send the first checkout.
        assert wf.get_contract_status() == ContractStatus.PENDING_EXECUTION
        await wf.checkout_line(CheckoutLineSignal(
            contract_line_entity_id=_LINE_ID,
            asset_id="asset-sim-001",
            actual_start="2025-01-01T08:00:00Z",
        ))
        await _yield(30)

        # The contract must have been activated by the checkout.
        assert wf.get_contract_status() == ContractStatus.ACTIVE, (
            "First checkout must transition contract from PENDING_EXECUTION to ACTIVE"
        )
        assert any(
            status == ContractStatus.ACTIVE for _, status, _ in transition_calls
        ), "transition_contract_status must be called with ACTIVE on first checkout"

        # Clean up: return the line and let the workflow close naturally.
        await wf.return_line(ReturnLineSignal(
            contract_line_entity_id=_LINE_ID,
            actual_end="2025-01-07T18:00:00Z",
        ))
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)
        _ACTIVITY_MAP[rental_activities.transition_contract_status] = original_transition

    assert result["contract_status"] == ContractStatus.CLOSED


@pytest.mark.asyncio
async def test_cancel_order_from_draft():
    patches = _apply_patches()
    try:
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))
        await _yield(10)
        await wf.cancel_order(CancelOrderSignal(reason="changed mind"))
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)

    assert result["order_status"] == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_expire_order_from_quoted():
    patches = _apply_patches()
    try:
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))
        await _yield(10)
        await wf.quote_order(QuoteOrderSignal())
        await _yield()
        await wf.expire_order(ExpireOrderSignal())
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)

    assert result["order_status"] == OrderStatus.EXPIRED


@pytest.mark.asyncio
async def test_cancel_contract():
    patches = _apply_patches()
    try:
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))
        await _yield(10)
        await wf.quote_order(QuoteOrderSignal())
        await _yield()
        await wf.approve_order(ApproveOrderSignal())
        await _yield()
        await wf.convert_order(ConvertOrderSignal())
        await _yield()
        await wf.cancel_contract(CancelContractSignal(reason="ops"))
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)

    assert result["order_status"] == OrderStatus.CONVERTED
    assert result["contract_status"] == ContractStatus.CANCELLED


@pytest.mark.asyncio
async def test_cancel_order_after_convert_is_rejected_and_contract_cancel_succeeds():
    observed: dict[str, str | None] = {}

    def _capture_contract_cancel(contract_entity_id: str, new_status: str, actor_id: str | None = None):
        observed["actor_id"] = actor_id
        return _mock_transition_contract_status(contract_entity_id, new_status, actor_id)

    original_transition = _ACTIVITY_MAP[rental_activities.transition_contract_status]
    patches = []
    try:
        _ACTIVITY_MAP[rental_activities.transition_contract_status] = _capture_contract_cancel
        patches = _apply_patches()
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))
        await _yield(10)
        await wf.quote_order(QuoteOrderSignal())
        await _yield()
        await wf.approve_order(ApproveOrderSignal())
        await _yield()
        await wf.convert_order(ConvertOrderSignal())
        await _yield()
        await wf.cancel_order(CancelOrderSignal(actor_id="cancel_actor", reason="customer request"))
        await _yield()
        assert run_task.done() is False
        assert wf.get_last_rejected_order_signal() == {
            "attempted_status": OrderStatus.CANCELLED,
            "reason": _REJECT_REASON_ORDER_ALREADY_CONVERTED,
            "actor_id": "cancel_actor",
        }
        await wf.cancel_contract(CancelContractSignal(reason="ops"))
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)
        _ACTIVITY_MAP[rental_activities.transition_contract_status] = original_transition

    assert result["order_status"] == OrderStatus.CONVERTED
    assert result["contract_status"] == ContractStatus.CANCELLED
    assert observed.get("actor_id") is None


@pytest.mark.asyncio
async def test_assign_asset_to_order_line():
    patches = _apply_patches()
    try:
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))
        await _yield(10)
        await wf.assign_asset(AssignAssetSignal(
            order_line_entity_id="oline-1",
            asset_id="asset-007",
            actor_id="planner",
        ))
        await _yield()
        await wf.cancel_order(CancelOrderSignal())
        result = await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        _stop_patches(patches)

    assert result["order_status"] == OrderStatus.CANCELLED


# ---------------------------------------------------------------------------
# Checkout-blocking tests – one per blocking reason
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("blocking_status", [
    AssetAvailabilityStatus.ON_TRANSFER,
    AssetAvailabilityStatus.IN_MAINTENANCE,
    AssetAvailabilityStatus.ON_INSPECTION_HOLD,
    AssetAvailabilityStatus.RETIRED,
    AssetAvailabilityStatus.LOST,
    AssetAvailabilityStatus.CONFLICTING_ASSIGNMENT,
])
@pytest.mark.asyncio
async def test_checkout_blocked_by_unavailable_asset(blocking_status: str):
    """Checkout must be blocked for each of the six unavailability reasons."""

    def _blocked_availability(asset_id: str) -> dict[str, Any]:
        return {
            "asset_id": asset_id,
            "availability_status": blocking_status,
            "blocks_checkout": True,
        }

    # Patch with a blocking availability mock
    activity_map = dict(_ACTIVITY_MAP)
    activity_map[rental_activities.get_asset_availability] = _blocked_availability

    async def _blocked_execute_activity(fn, *pos_args, args=None, **kwargs):
        real_args = list(args) if args is not None else list(pos_args)
        mock_fn = activity_map.get(fn, fn)
        if asyncio.iscoroutinefunction(mock_fn):
            return await mock_fn(*real_args)
        return mock_fn(*real_args)

    patches = [
        patch("temporalio.workflow.execute_activity", new=_blocked_execute_activity),
        patch("temporalio.workflow.wait_condition", new=_fake_wait_condition),
        patch("temporalio.workflow.logger", new=logging.getLogger("test")),
        patch("temporalio.workflow.info", new=MagicMock(return_value=MagicMock(workflow_id="test-workflow-id"))),
    ]
    for p in patches:
        p.start()

    try:
        blocked_line = f"cline-blocked-{blocking_status}"

        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(_make_order_input()))

        await _yield(10)
        await wf.quote_order(QuoteOrderSignal())
        await _yield()
        await wf.approve_order(ApproveOrderSignal())
        await _yield()
        await wf.convert_order(ConvertOrderSignal())
        await _yield()

        await wf.checkout_line(CheckoutLineSignal(
            contract_line_entity_id=blocked_line,
            asset_id=f"asset-blocked-{blocking_status}",
            actual_start="2025-01-01T08:00:00Z",
        ))
        await _yield(50)

        # Inspect the checkout result while the workflow is still running
        checkout_result = wf.get_checkout_result(blocked_line)

        # Clean up: cancel the contract so the workflow terminates
        await wf.cancel_contract(CancelContractSignal())
        await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        for p in patches:
            p.stop()

    # The checkout should be blocked
    assert checkout_result.get("success") is False
    assert checkout_result.get("block_reason") == blocking_status
    assert checkout_result.get("status") == LineStatus.PENDING


# ---------------------------------------------------------------------------
# Test: asset_id from signal (not contract_line_entity_id) gates checkout
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_checkout_uses_asset_id_not_line_id():
    """Checkout blocking must be decided by the signal's asset_id, not by the
    contract_line_entity_id.

    Setup: availability mock blocks 'asset-blocked' but allows 'asset-available'.
    The two checkout signals share the *same* contract_line_entity_id prefix so
    that the test would fail if the workflow mistakenly passes the line id to
    get_asset_availability.
    """
    _BLOCKED_ASSET = "asset-blocked"
    _AVAILABLE_ASSET = "asset-available"
    _LINE_BLOCKED = "line-shared-1"
    _LINE_AVAIL = "line-shared-2"

    called_with: list[str] = []

    def _selective_availability(asset_id: str) -> dict[str, Any]:
        called_with.append(asset_id)
        blocked = asset_id == _BLOCKED_ASSET
        return {
            "asset_id": asset_id,
            "availability_status": (
                AssetAvailabilityStatus.IN_MAINTENANCE if blocked
                else AssetAvailabilityStatus.AVAILABLE
            ),
            "blocks_checkout": blocked,
        }

    activity_map = dict(_ACTIVITY_MAP)
    activity_map[rental_activities.get_asset_availability] = _selective_availability

    async def _selective_execute_activity(fn, *pos_args, args=None, **kwargs):
        real_args = list(args) if args is not None else list(pos_args)
        mock_fn = activity_map.get(fn, fn)
        if asyncio.iscoroutinefunction(mock_fn):
            return await mock_fn(*real_args)
        return mock_fn(*real_args)

    patches = [
        patch("temporalio.workflow.execute_activity", new=_selective_execute_activity),
        patch("temporalio.workflow.wait_condition", new=_fake_wait_condition),
        patch("temporalio.workflow.logger", new=logging.getLogger("test")),
        patch("temporalio.workflow.info", new=MagicMock(return_value=MagicMock(workflow_id="test-workflow-id"))),
    ]
    for p in patches:
        p.start()

    try:
        inp = _make_order_input(
            lines=[
                RentalLineInput(
                    category_id="cat-excavator",
                    quantity=1,
                    planned_start="2025-01-01T08:00:00Z",
                    planned_end="2025-01-07T18:00:00Z",
                    rate_type=RateType.WEEKLY,
                    rate_amount=50000,
                    rental_type=RentalType.EXTERNAL,
                ),
                RentalLineInput(
                    category_id="cat-excavator",
                    quantity=1,
                    planned_start="2025-01-01T08:00:00Z",
                    planned_end="2025-01-07T18:00:00Z",
                    rate_type=RateType.WEEKLY,
                    rate_amount=50000,
                    rental_type=RentalType.EXTERNAL,
                ),
            ]
        )
        wf = RentalOrderWorkflow()
        run_task = asyncio.create_task(wf.run(inp))

        await _yield(10)
        await wf.quote_order(QuoteOrderSignal())
        await _yield()
        await wf.approve_order(ApproveOrderSignal())
        await _yield()
        await wf.convert_order(ConvertOrderSignal())
        await _yield()

        # Checkout line 1 with the blocked asset
        await wf.checkout_line(CheckoutLineSignal(
            contract_line_entity_id=_LINE_BLOCKED,
            asset_id=_BLOCKED_ASSET,
            actual_start="2025-01-01T08:00:00Z",
        ))
        # Checkout line 2 with the available asset
        await wf.checkout_line(CheckoutLineSignal(
            contract_line_entity_id=_LINE_AVAIL,
            asset_id=_AVAILABLE_ASSET,
            actual_start="2025-01-01T08:00:00Z",
        ))
        await _yield(50)

        blocked_result = wf.get_checkout_result(_LINE_BLOCKED)
        avail_result = wf.get_checkout_result(_LINE_AVAIL)

        # Terminate the workflow
        await wf.cancel_contract(CancelContractSignal())
        await asyncio.wait_for(run_task, timeout=5.0)
    finally:
        for p in patches:
            p.stop()

    # The blocked asset checkout must be rejected
    assert blocked_result.get("success") is False, "blocked asset should prevent checkout"
    assert blocked_result.get("block_reason") == AssetAvailabilityStatus.IN_MAINTENANCE
    assert blocked_result.get("status") == LineStatus.PENDING

    # The available asset checkout must proceed
    assert avail_result.get("success") is True, "available asset should allow checkout"
    assert avail_result.get("status") == LineStatus.CHECKED_OUT
    assert avail_result.get("block_reason") is None

    # Confirm get_asset_availability was called with the asset ids (not line ids)
    assert _BLOCKED_ASSET in called_with, "workflow must pass asset_id to get_asset_availability"
    assert _AVAILABLE_ASSET in called_with, "workflow must pass asset_id to get_asset_availability"
    assert _LINE_BLOCKED not in called_with, "workflow must not pass line_id to get_asset_availability"
    assert _LINE_AVAIL not in called_with, "workflow must not pass line_id to get_asset_availability"
