"""Unit tests for rental domain models: status constants, transition tables, and
availability blocking rules.  No Temporal runtime required."""
from __future__ import annotations

import pytest
from temporal.src.models.rental import (
    AssetAvailabilityStatus,
    ContractStatus,
    LineStatus,
    OrderStatus,
    RateType,
    RentalType,
)

# ---------------------------------------------------------------------------
# OrderStatus
# ---------------------------------------------------------------------------

class TestOrderStatusTransitions:
    def test_draft_can_go_to_quoted(self):
        assert OrderStatus.QUOTED in OrderStatus.TRANSITIONS[OrderStatus.DRAFT]

    def test_draft_can_be_cancelled(self):
        assert OrderStatus.CANCELLED in OrderStatus.TRANSITIONS[OrderStatus.DRAFT]

    def test_draft_cannot_jump_to_approved(self):
        assert OrderStatus.APPROVED not in OrderStatus.TRANSITIONS[OrderStatus.DRAFT]

    def test_quoted_can_go_to_approved(self):
        assert OrderStatus.APPROVED in OrderStatus.TRANSITIONS[OrderStatus.QUOTED]

    def test_quoted_can_be_cancelled(self):
        assert OrderStatus.CANCELLED in OrderStatus.TRANSITIONS[OrderStatus.QUOTED]

    def test_quoted_can_expire(self):
        assert OrderStatus.EXPIRED in OrderStatus.TRANSITIONS[OrderStatus.QUOTED]

    def test_approved_can_convert(self):
        assert OrderStatus.CONVERTED in OrderStatus.TRANSITIONS[OrderStatus.APPROVED]

    def test_approved_can_be_cancelled(self):
        assert OrderStatus.CANCELLED in OrderStatus.TRANSITIONS[OrderStatus.APPROVED]

    def test_terminal_statuses_have_no_transitions(self):
        for status in OrderStatus.TERMINAL:
            assert OrderStatus.TRANSITIONS[status] == frozenset(), (
                f"Terminal status {status!r} must not allow transitions"
            )

    def test_converted_is_terminal(self):
        assert OrderStatus.CONVERTED in OrderStatus.TERMINAL

    def test_cancelled_is_terminal(self):
        assert OrderStatus.CANCELLED in OrderStatus.TERMINAL

    def test_expired_is_terminal(self):
        assert OrderStatus.EXPIRED in OrderStatus.TERMINAL


# ---------------------------------------------------------------------------
# ContractStatus
# ---------------------------------------------------------------------------

class TestContractStatusTransitions:
    def test_pending_execution_can_activate(self):
        assert ContractStatus.ACTIVE in ContractStatus.TRANSITIONS[ContractStatus.PENDING_EXECUTION]

    def test_pending_execution_can_be_cancelled(self):
        assert ContractStatus.CANCELLED in ContractStatus.TRANSITIONS[ContractStatus.PENDING_EXECUTION]

    def test_active_can_close(self):
        assert ContractStatus.CLOSED in ContractStatus.TRANSITIONS[ContractStatus.ACTIVE]

    def test_active_can_be_cancelled(self):
        assert ContractStatus.CANCELLED in ContractStatus.TRANSITIONS[ContractStatus.ACTIVE]

    def test_terminal_statuses_have_no_transitions(self):
        for status in ContractStatus.TERMINAL:
            assert ContractStatus.TRANSITIONS[status] == frozenset()

    def test_closed_is_terminal(self):
        assert ContractStatus.CLOSED in ContractStatus.TERMINAL

    def test_cancelled_is_terminal(self):
        assert ContractStatus.CANCELLED in ContractStatus.TERMINAL


# ---------------------------------------------------------------------------
# LineStatus
# ---------------------------------------------------------------------------

class TestLineStatus:
    def test_returned_is_terminal(self):
        assert LineStatus.RETURNED in LineStatus.TERMINAL

    def test_cancelled_is_terminal(self):
        assert LineStatus.CANCELLED in LineStatus.TERMINAL

    def test_pending_is_not_terminal(self):
        assert LineStatus.PENDING not in LineStatus.TERMINAL

    def test_checked_out_is_not_terminal(self):
        assert LineStatus.CHECKED_OUT not in LineStatus.TERMINAL


# ---------------------------------------------------------------------------
# AssetAvailabilityStatus
# ---------------------------------------------------------------------------

class TestAssetAvailabilityBlocking:
    """All six blocking reasons must block checkout."""

    @pytest.mark.parametrize("status", [
        AssetAvailabilityStatus.ON_TRANSFER,
        AssetAvailabilityStatus.IN_MAINTENANCE,
        AssetAvailabilityStatus.ON_INSPECTION_HOLD,
        AssetAvailabilityStatus.RETIRED,
        AssetAvailabilityStatus.LOST,
        AssetAvailabilityStatus.CONFLICTING_ASSIGNMENT,
    ])
    def test_blocking_statuses_block_checkout(self, status):
        assert status in AssetAvailabilityStatus.BLOCKING

    def test_available_does_not_block(self):
        assert AssetAvailabilityStatus.AVAILABLE not in AssetAvailabilityStatus.BLOCKING

    def test_blocking_set_has_six_entries(self):
        assert len(AssetAvailabilityStatus.BLOCKING) == 6


# ---------------------------------------------------------------------------
# Misc constants
# ---------------------------------------------------------------------------

class TestConstants:
    def test_rental_types(self):
        assert RentalType.INTERNAL == "internal"
        assert RentalType.EXTERNAL == "external"

    def test_rate_types_present(self):
        for rt in ("daily", "weekly", "monthly", "fixed"):
            assert rt in (RateType.DAILY, RateType.WEEKLY, RateType.MONTHLY, RateType.FIXED)
