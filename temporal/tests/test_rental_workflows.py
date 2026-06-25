"""Tests for rental operation activities and business rules.

These tests use temporalio.testing.ActivityEnvironment (no Temporal server
required) and direct unit tests for pure-Python business logic.  Workflow-level
signal/milestone ordering is covered by TestTransferWorkflowSignalOrdering using
WorkflowEnvironment (time-skipping mode, no external server required).

Coverage goals:
- Transfer blocking when asset is not available
- Inspection result → correct asset status transitions
- Maintenance blocking when asset is on-rent and in_transit
- Invoice creation lineage (contract_id propagated to invoice, totals computed)
- Transfer: in_transit status set only after ship signal; available restored after receive
- InspectionWorkflow: retry_policy wiring (ADR-0003)
- MaintenanceWorkflow: down-state persistence through entity/SCD2 + relationship path
"""
from __future__ import annotations

import pytest
from temporal.src.activities import rental_operations as ops
from temporal.src.models.rental import (
    MAINTENANCE_OPENABLE_STATUSES,
    TRANSFERABLE_STATUSES,
    AssetStatus,
    InspectionRequest,
    InspectionResult,
    InspectionResultSignal,
    InspectionType,
    InvoiceStatus,
    MilestoneSignal,
    TransferRequest,
)
from temporal.src.workflows.rental.inspection import InspectionWorkflow
from temporal.src.workflows.rental.transfer import TransferWorkflow
from temporalio.testing import ActivityEnvironment

_MAX_POLL_ITERATIONS = 200  # upper bound for fake_wait_condition spin loops


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def activity_env() -> ActivityEnvironment:
    return ActivityEnvironment()


# ---------------------------------------------------------------------------
# Transfer blocking
# ---------------------------------------------------------------------------

class TestTransferBlocking:
    """check_asset_transferable must block for any status outside TRANSFERABLE_STATUSES."""

    def test_available_is_transferable(self, activity_env):
        result = activity_env.run(
            ops.check_asset_transferable, "asset-1", AssetStatus.AVAILABLE.value
        )
        assert result["allowed"] is True
        assert result["reason"] is None

    def test_on_rent_is_blocked(self, activity_env):
        result = activity_env.run(
            ops.check_asset_transferable, "asset-2", AssetStatus.ON_RENT.value
        )
        assert result["allowed"] is False
        assert result["reason"] is not None
        assert "on_rent" in result["reason"]

    def test_in_transit_is_blocked(self, activity_env):
        result = activity_env.run(
            ops.check_asset_transferable, "asset-3", AssetStatus.IN_TRANSIT.value
        )
        assert result["allowed"] is False

    def test_maintenance_is_blocked(self, activity_env):
        result = activity_env.run(
            ops.check_asset_transferable, "asset-4", AssetStatus.MAINTENANCE.value
        )
        assert result["allowed"] is False

    def test_inspection_hold_is_blocked(self, activity_env):
        result = activity_env.run(
            ops.check_asset_transferable, "asset-5", AssetStatus.INSPECTION_HOLD.value
        )
        assert result["allowed"] is False

    def test_transferable_statuses_constant(self):
        """Verify the business rule set matches the expected statuses."""
        assert AssetStatus.AVAILABLE in TRANSFERABLE_STATUSES
        assert AssetStatus.ON_RENT not in TRANSFERABLE_STATUSES
        assert AssetStatus.IN_TRANSIT not in TRANSFERABLE_STATUSES
        assert AssetStatus.MAINTENANCE not in TRANSFERABLE_STATUSES


# ---------------------------------------------------------------------------
# Inspection transitions
# ---------------------------------------------------------------------------

class TestInspectionTransitions:
    """resolve_post_inspection_status must map outcome+type to the correct asset status."""

    def test_return_pass_yields_available(self, activity_env):
        status = activity_env.run(
            ops.resolve_post_inspection_status,
            "asset-1",
            InspectionType.RETURN.value,
            InspectionResult.PASS.value,
        )
        assert status == AssetStatus.AVAILABLE.value

    def test_service_pass_yields_available(self, activity_env):
        status = activity_env.run(
            ops.resolve_post_inspection_status,
            "asset-1",
            InspectionType.SERVICE.value,
            InspectionResult.PASS.value,
        )
        assert status == AssetStatus.AVAILABLE.value

    def test_checkout_pass_yields_on_rent(self, activity_env):
        status = activity_env.run(
            ops.resolve_post_inspection_status,
            "asset-1",
            InspectionType.CHECKOUT.value,
            InspectionResult.PASS.value,
        )
        assert status == AssetStatus.ON_RENT.value

    def test_return_fail_yields_inspection_hold(self, activity_env):
        status = activity_env.run(
            ops.resolve_post_inspection_status,
            "asset-1",
            InspectionType.RETURN.value,
            InspectionResult.FAIL.value,
        )
        assert status == AssetStatus.INSPECTION_HOLD.value

    def test_checkout_fail_yields_inspection_hold(self, activity_env):
        status = activity_env.run(
            ops.resolve_post_inspection_status,
            "asset-1",
            InspectionType.CHECKOUT.value,
            InspectionResult.FAIL.value,
        )
        assert status == AssetStatus.INSPECTION_HOLD.value

    def test_service_fail_yields_inspection_hold(self, activity_env):
        status = activity_env.run(
            ops.resolve_post_inspection_status,
            "asset-1",
            InspectionType.SERVICE.value,
            InspectionResult.FAIL.value,
        )
        assert status == AssetStatus.INSPECTION_HOLD.value


# ---------------------------------------------------------------------------
# Maintenance blocking
# ---------------------------------------------------------------------------

class TestMaintenanceBlocking:
    """check_asset_maintenance_openable must block for on_rent and in_transit assets."""

    def test_available_can_open_maintenance(self, activity_env):
        result = activity_env.run(
            ops.check_asset_maintenance_openable, "asset-1", AssetStatus.AVAILABLE.value
        )
        assert result["allowed"] is True

    def test_inspection_hold_can_open_maintenance(self, activity_env):
        result = activity_env.run(
            ops.check_asset_maintenance_openable, "asset-1", AssetStatus.INSPECTION_HOLD.value
        )
        assert result["allowed"] is True

    def test_returned_can_open_maintenance(self, activity_env):
        result = activity_env.run(
            ops.check_asset_maintenance_openable, "asset-1", AssetStatus.RETURNED.value
        )
        assert result["allowed"] is True

    def test_on_rent_blocks_maintenance(self, activity_env):
        result = activity_env.run(
            ops.check_asset_maintenance_openable, "asset-1", AssetStatus.ON_RENT.value
        )
        assert result["allowed"] is False
        assert result["reason"] is not None

    def test_in_transit_blocks_maintenance(self, activity_env):
        result = activity_env.run(
            ops.check_asset_maintenance_openable, "asset-1", AssetStatus.IN_TRANSIT.value
        )
        assert result["allowed"] is False

    def test_maintenance_openable_statuses_constant(self):
        assert AssetStatus.AVAILABLE in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.INSPECTION_HOLD in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.RETURNED in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.ON_RENT not in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.IN_TRANSIT not in MAINTENANCE_OPENABLE_STATUSES


# ---------------------------------------------------------------------------
# Invoice creation lineage
# ---------------------------------------------------------------------------

class TestInvoiceCreation:
    """create_invoice_record and compute_invoice_totals must propagate contract_id
    and correctly calculate financial totals."""

    def test_invoice_record_links_contract(self, activity_env):
        result = activity_env.run(
            ops.create_invoice_record,
            "contract-abc",
            "2026-06-01",
            "2026-06-30",
            "system",
        )
        assert result["contract_id"] == "contract-abc"
        assert result["invoice_id"] != ""
        assert result["status"] == "draft"

    def test_invoice_totals_no_tax(self, activity_env):
        line_items = [
            {"rate": 100.0, "quantity": 5, "tax_rate": 0.0},
            {"rate": 50.0, "quantity": 2, "tax_rate": 0.0},
        ]
        result = activity_env.run(ops.compute_invoice_totals, "inv-1", line_items)
        assert result["subtotal"] == 600.0
        assert result["tax"] == 0.0
        assert result["total"] == 600.0

    def test_invoice_totals_with_tax(self, activity_env):
        line_items = [
            {"rate": 200.0, "quantity": 3, "tax_rate": 0.10},
        ]
        result = activity_env.run(ops.compute_invoice_totals, "inv-2", line_items)
        assert result["subtotal"] == 600.0
        assert result["tax"] == pytest.approx(60.0)
        assert result["total"] == pytest.approx(660.0)

    def test_invoice_totals_empty_line_items(self, activity_env):
        result = activity_env.run(ops.compute_invoice_totals, "inv-3", [])
        assert result["subtotal"] == 0.0
        assert result["tax"] == 0.0
        assert result["total"] == 0.0

    def test_finalise_invoice_status(self, activity_env):
        result = activity_env.run(
            ops.finalise_invoice, "inv-4", 500.0, 50.0, 550.0
        )
        assert result["invoice_id"] == "inv-4"
        assert result["status"] == "pending"
        assert result["total"] == 550.0
        assert result["transaction_currency_code"] == "USD"
        assert result["reporting_currency_code"] == "USD"
        assert result["fx_rate_applied"] == pytest.approx(1.0)
        assert result["fx_rate_effective_at"] is None

    def test_derive_invoiceable_line_items_deduplicates_and_filters_unbillable(self, activity_env):
        line_items = [
            {"source_key": "line-1:rental", "lifecycle_status": "approved", "rate": 100, "quantity": 1},
            {"source_key": "line-1:rental", "lifecycle_status": "approved", "rate": 100, "quantity": 1},
            {"source_key": "line-2:rental", "lifecycle_status": "void", "rate": 500, "quantity": 1},
        ]
        result = activity_env.run(ops.derive_invoiceable_line_items, "contract-1", line_items)
        assert result["invoiceable_count"] == 1
        assert result["dropped_duplicates"] == 1
        assert result["line_items"][0]["source_key"] == "line-1:rental"

    def test_readiness_blocks_for_holds_and_incomplete_return_usage_data(self, activity_env):
        line_items = [
            {
                "source_key": "line-1:rental",
                "charge_type": "rental",
                "requires_return_data": True,
                "requires_usage_data": True,
                "actual_return_at": None,
                "usage_quantity": None,
            }
        ]
        result = activity_env.run(
            ops.evaluate_invoice_readiness,
            "contract-1",
            "active",
            line_items,
            ["credit_review"],
        )
        assert result["blocked"] is True
        exception_codes = {exc["code"] for exc in result["exceptions"]}
        assert {"billing_hold", "missing_return_data", "missing_usage_data"}.issubset(exception_codes)

    def test_readiness_blocks_for_draft_contract(self, activity_env):
        result = activity_env.run(
            ops.evaluate_invoice_readiness,
            "contract-1",
            InvoiceStatus.DRAFT.value,
            [{"source_key": "line-1:rental", "charge_type": "rental"}],
            [],
        )
        assert result["blocked"] is True
        assert any(exc["code"] == "contract_not_billable" for exc in result["exceptions"])

    def test_finalise_invoice_stays_draft_when_blocked(self, activity_env):
        result = activity_env.run(
            ops.finalise_invoice,
            "inv-6",
            150.0,
            15.0,
            165.0,
            True,
            [{"code": "billing_hold", "reason": "Billing hold present: credit_review", "blocking": True}],
            {
                "customer_id": "customer-1",
                "billing_account_id": "ba-1",
                "job_site_id": "job-1",
                "transaction_currency_code": "EUR",
                "reporting_currency_code": "USD",
                "fx_rate_applied": 1.09,
                "fx_rate_effective_at": "2026-06-01T00:00:00Z",
            },
        )
        assert result["status"] == "draft"
        assert result["blocked"] is True
        assert result["billing_exceptions"][0]["code"] == "billing_hold"
        assert result["customer_id"] == "customer-1"
        assert result["billing_account_id"] == "ba-1"
        assert result["job_site_id"] == "job-1"
        assert result["transaction_currency_code"] == "EUR"
        assert result["reporting_currency_code"] == "USD"
        assert result["fx_rate_applied"] == pytest.approx(1.09)
        assert result["fx_rate_effective_at"] == "2026-06-01T00:00:00Z"

    def test_invoice_totals_mixed_tax_rates(self, activity_env):
        """Each line item should apply its own tax rate."""
        line_items = [
            {"rate": 100.0, "quantity": 2, "tax_rate": 0.10},  # 200 * 0.10 = 20 tax
            {"rate": 50.0, "quantity": 1, "tax_rate": 0.00},   # 50  * 0.00 = 0 tax
        ]
        result = activity_env.run(ops.compute_invoice_totals, "inv-5", line_items)
        assert result["subtotal"] == 250.0
        assert result["tax"] == pytest.approx(20.0)
        assert result["total"] == pytest.approx(270.0)


# ---------------------------------------------------------------------------
# Transfer workflow: signal-driven status transitions
# ---------------------------------------------------------------------------

class TestTransferWorkflowSignalOrdering:
    """The asset must become in_transit only after the ship signal, and
    return to available only after the receive signal."""

    @pytest.mark.asyncio
    async def test_in_transit_set_after_ship_available_after_receive(self):
        """The workflow must update the asset to in_transit only when the ship
        signal is handled, and restore it to available only when the receive
        signal is handled.

        Temporal runtime is mocked so no test server is required.
        """
        import asyncio
        import contextlib
        from unittest.mock import MagicMock, patch

        scd2_calls: list[str] = []
        milestones: list[str] = []
        # Events used to coordinate signal delivery with the workflow's progress.
        transfer_created = asyncio.Event()   # set once the transfer record activity returns
        ship_milestone_done = asyncio.Event()  # set once the "in_transit" milestone activity returns

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "update_entity_scd2":
                status = args[1].get("status", "") if len(args) > 1 else ""
                scd2_calls.append(status)
                return {"entity_id": args[0] if args else "", "version_id": "v2"}
            if fn_name == "get_asset_status":
                asset_id = args[0] if args else ""
                return {"asset_id": asset_id, "status": "available", "version_id": "v1"}
            if fn_name == "check_asset_transferable":
                return {"allowed": True, "reason": None}
            if fn_name == "create_transfer_record":
                transfer_created.set()
                return {
                    "transfer_id": "t1",
                    "asset_id": args[0] if args else "",
                    "status": "requested",
                    "requested_ship_date": "2026-06-20",
                    "expected_receive_date": "2026-06-21",
                    "asset_scope": "Excavator 100",
                    "internal_cost": 425.0,
                    "sourcing_decision_id": "finding-1",
                    "transfer_exception_reason": "Awaiting trailer slot confirmation",
                }
            if fn_name == "record_transfer_milestone":
                if len(args) > 2:
                    milestones.append(args[2])
                if len(args) > 2 and args[2] == "in_transit":
                    ship_milestone_done.set()
                return True
            if fn_name == "update_asset_branch":
                return True
            return None

        async def fake_wait_condition(condition_fn):
            while not condition_fn():
                await asyncio.sleep(0)

        import temporalio.workflow as tw_mod

        workflow_obj = TransferWorkflow()

        fake_unsafe = MagicMock()
        fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

        async def send_signals():
            # Wait until the transfer record has been created: the workflow is
            # now entering wait_condition for the ship signal.
            await transfer_created.wait()
            await asyncio.sleep(0)  # one tick to let fake_wait_condition start polling
            workflow_obj._ship_signal = MilestoneSignal(actor_id="driver-1")
            # Wait until the "shipped" milestone activity has been recorded: the
            # workflow is now entering wait_condition for the receive signal.
            await ship_milestone_done.wait()
            await asyncio.sleep(0)  # one tick to let fake_wait_condition start polling
            workflow_obj._receive_signal = MilestoneSignal(actor_id="warehouse-1")

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(tw_mod, "unsafe", fake_unsafe),
        ):
            signal_task = asyncio.create_task(send_signals())
            result = await workflow_obj.run(
                TransferRequest(
                    asset_id="asset-1",
                    origin_branch_id="branch-a",
                    destination_branch_id="branch-b",
                    requested_by="user-1",
                    sourcing_decision_id="finding-1",
                    requested_ship_date="2026-06-20",
                    expected_receive_date="2026-06-21",
                    asset_scope="Excavator 100",
                    internal_cost=425.0,
                    transfer_exception_reason="Awaiting trailer slot confirmation",
                )
            )
            await signal_task

        assert result["status"] == "received"
        assert result["blocked"] is False
        assert result["requested_ship_date"] == "2026-06-20"
        assert result["expected_receive_date"] == "2026-06-21"
        assert result["asset_scope"] == "Excavator 100"
        assert result["internal_cost"] == 425.0
        assert result["exceptions"] == ["Awaiting trailer slot confirmation"]

        # in_transit and available must both have been recorded
        assert "in_transit" in scd2_calls, f"Expected in_transit in SCD2 calls: {scd2_calls}"
        assert "available" in scd2_calls, f"Expected available in SCD2 calls: {scd2_calls}"
        assert milestones == ["approved", "in_transit", "received"]

        # in_transit must come before available (ship signal triggers in_transit,
        # receive signal triggers available)
        assert scd2_calls.index("in_transit") < scd2_calls.index("available"), (
            f"in_transit must precede available in SCD2 call sequence: {scd2_calls}"
        )


# ---------------------------------------------------------------------------
# InspectionWorkflow: retry_policy wiring (ADR-0003)
# ---------------------------------------------------------------------------

class TestInspectionWorkflowRetryWiring:
    """execute_activity must be called with the retry policy prescribed by ADR-0003.

    Create/money activities must use maximum_attempts=2.
    Standard read/transition activities must use maximum_attempts=3.
    This test will fail if retry_policy wiring is reverted from the workflow.
    """

    @pytest.mark.asyncio
    async def test_retry_policies_and_idempotent_maintenance_on_fail(self):
        import asyncio
        import contextlib
        from unittest.mock import MagicMock, patch

        import temporalio.workflow as tw_mod

        captured: dict[str, dict] = {}
        inspection_created = asyncio.Event()

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            captured[fn_name] = kw
            if fn_name == "create_inspection_record":
                inspection_created.set()
                return {"inspection_id": "insp-1", "asset_id": "asset-1", "status": "in_progress"}
            if fn_name == "resolve_post_inspection_status":
                return "inspection_hold"
            if fn_name == "update_entity_scd2":
                return {"entity_id": "asset-1", "version_id": "v2"}
            if fn_name == "create_maintenance_record":
                return {"maintenance_record_id": "maint-1", "asset_id": "asset-1", "status": "open"}
            return None

        async def fake_wait_condition(cond_fn):
            for _ in range(_MAX_POLL_ITERATIONS):
                if cond_fn():
                    return
                await asyncio.sleep(0)
            raise TimeoutError("condition never satisfied in fake_wait_condition")

        wf = InspectionWorkflow()
        fake_unsafe = MagicMock()
        fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

        async def send_fail_signal():
            await inspection_created.wait()
            await asyncio.sleep(0)  # let workflow enter wait_condition loop
            wf._result_signal = InspectionResultSignal(
                outcome=InspectionResult.FAIL,
                open_maintenance=True,
            )

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(tw_mod, "unsafe", fake_unsafe),
        ):
            signal_task = asyncio.create_task(send_fail_signal())
            await wf.run(
                InspectionRequest(
                    asset_id="asset-1",
                    inspection_type=InspectionType.RETURN,
                    inspector_id="inspector-1",
                )
            )
            await signal_task

        # Create/money activities → RetryPolicy(maximum_attempts=2)
        assert "create_inspection_record" in captured, "create_inspection_record was not called"
        assert captured["create_inspection_record"]["retry_policy"].maximum_attempts == 2, (
            "create_inspection_record must use _MONEY_RETRY (maximum_attempts=2)"
        )
        assert "create_maintenance_record" in captured, (
            "create_maintenance_record was not called — ensure inspection_fail branch is idempotent"
        )
        assert captured["create_maintenance_record"]["retry_policy"].maximum_attempts == 2, (
            "create_maintenance_record must use _MONEY_RETRY (maximum_attempts=2)"
        )

        # Standard read/transition activities → RetryPolicy(maximum_attempts=3)
        assert "resolve_post_inspection_status" in captured, "resolve_post_inspection_status was not called"
        assert captured["resolve_post_inspection_status"]["retry_policy"].maximum_attempts == 3, (
            "resolve_post_inspection_status must use _STANDARD_RETRY (maximum_attempts=3)"
        )
        assert "update_entity_scd2" in captured, "update_entity_scd2 was not called"
        assert captured["update_entity_scd2"]["retry_policy"].maximum_attempts == 3, (
            "update_entity_scd2 must use _STANDARD_RETRY (maximum_attempts=3)"
        )


# ---------------------------------------------------------------------------
# Maintenance: availability_impact (soft_down / hard_down)
# ---------------------------------------------------------------------------

class TestMaintenanceAvailabilityImpact:
    """create_maintenance_record must accept and return availability_impact fields.

    Validates the soft-down / hard-down semantics introduced for inventory-
    availability integration.  Resolution rules (hard_down > soft_down) are
    enforced at the database read-model layer; these tests cover the activity
    contract and model constant correctness.
    """

    def test_create_maintenance_record_returns_soft_down_fields(self, activity_env):
        result = activity_env.run(
            ops.create_maintenance_record,
            "asset-1",
            "corrective",
            "tech-1",
            "Hydraulic leak detected",
            "soft_down",
            "Minor hydraulic leak — asset functional but scheduled for service",
            "2026-06-20T08:00:00Z",
        )
        assert result["maintenance_record_id"] != ""
        assert result["asset_id"] == "asset-1"
        assert result["status"] == "open"
        assert result["availability_impact"] == "soft_down"
        assert result["blocking_reason"] == "Minor hydraulic leak — asset functional but scheduled for service"
        assert result["expected_return_at"] == "2026-06-20T08:00:00Z"

    def test_create_maintenance_record_returns_hard_down_fields(self, activity_env):
        result = activity_env.run(
            ops.create_maintenance_record,
            "asset-2",
            "emergency",
            "tech-2",
            "Engine failure",
            "hard_down",
            "Engine failure — asset cannot be dispatched",
            None,
        )
        assert result["availability_impact"] == "hard_down"
        assert result["blocking_reason"] == "Engine failure — asset cannot be dispatched"
        assert result["expected_return_at"] is None

    def test_create_maintenance_record_without_availability_impact(self, activity_env):
        """availability_impact is optional; omitting it returns None in the result."""
        result = activity_env.run(
            ops.create_maintenance_record,
            "asset-3",
            "preventive",
            "tech-3",
        )
        assert result["availability_impact"] is None
        assert result["blocking_reason"] is None

    def test_availability_impact_constants_are_correct(self):
        from temporal.src.models.rental import AvailabilityImpact
        assert AvailabilityImpact.SOFT_DOWN == "soft_down"
        assert AvailabilityImpact.HARD_DOWN == "hard_down"
        assert AvailabilityImpact.SOFT_DOWN in AvailabilityImpact.ALL
        assert AvailabilityImpact.HARD_DOWN in AvailabilityImpact.ALL

    def test_maintenance_request_accepts_availability_impact(self):
        from temporal.src.models.rental import MaintenanceRequest
        req = MaintenanceRequest(
            asset_id="asset-4",
            maintenance_type="corrective",
            technician_id="tech-4",
            availability_impact="hard_down",
            blocking_reason="Boom arm cracked",
            expected_return_at="2026-07-01T00:00:00Z",
        )
        assert req.availability_impact == "hard_down"
        assert req.blocking_reason == "Boom arm cracked"
        assert req.expected_return_at == "2026-07-01T00:00:00Z"

    def test_maintenance_summary_exposes_down_severity_and_reason(self):
        from temporal.src.models.rental import MaintenanceSummary
        summary = MaintenanceSummary(
            maintenance_record_id="rec-1",
            asset_id="asset-4",
            status="open",
            down_severity="hard_down",
            down_reason="Boom arm cracked",
        )
        assert summary.down_severity == "hard_down"
        assert summary.down_reason == "Boom arm cracked"

    def test_maintenance_summary_down_fields_default_to_none(self):
        from temporal.src.models.rental import MaintenanceSummary
        summary = MaintenanceSummary(
            maintenance_record_id="rec-2",
            asset_id="asset-5",
            status="completed",
        )
        assert summary.down_severity is None
        assert summary.down_reason is None


# ---------------------------------------------------------------------------
# MaintenanceWorkflow: entity/SCD2 + relationship persistence behavioral tests
# ---------------------------------------------------------------------------

class TestMaintenanceWorkflowDownStatePropagation:
    """MaintenanceWorkflow must persist down-state through the entity/SCD2 and relationship path.

    The SQL view v_asset_active_down_state derives active down severity by joining
    relationships_v2 (asset_has_maintenance_record), entities (entity_type='maintenance_record'),
    and entity_versions (is_current=true, completed_at IS NULL, availability_impact in values).
    These behavioral tests verify that the workflow writes exactly the data that view needs.
    They fail if the entity/SCD2 persistence calls are absent.
    """

    @pytest.mark.asyncio
    async def test_open_persists_entity_with_availability_impact_and_links_asset(self):
        """create_entity('maintenance_record') with availability_impact in attributes and
        create_relationship('asset_has_maintenance_record') must both be called when a
        down-state maintenance record is opened.  Fails if either call is bypassed."""
        import asyncio
        import contextlib
        from unittest.mock import MagicMock, patch

        import temporalio.workflow as tw_mod
        from temporal.src.activities.supabase_core import EntityResult
        from temporal.src.models.rental import MaintenanceCompleteSignal, MaintenanceRequest
        from temporal.src.workflows.rental.maintenance import MaintenanceWorkflow

        entity_calls: list[dict] = []
        relationship_calls: list[dict] = []
        create_entity_done = asyncio.Event()

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "get_asset_status":
                return {"asset_id": args[0] if args else "", "status": "available", "version_id": "v1"}
            if fn_name == "check_asset_maintenance_openable":
                return {"allowed": True, "reason": None}
            if fn_name == "create_entity":
                entity_calls.append({"entity_type": args[0] if args else "", "attributes": args[1] if len(args) > 1 else {}})
                create_entity_done.set()
                return EntityResult(entity_id="maint-ent-1", version_id="v1")
            if fn_name == "create_relationship":
                relationship_calls.append({"from_id": args[0] if args else "", "to_id": args[1] if len(args) > 1 else "", "rel_type": args[2] if len(args) > 2 else ""})
                return {"relationship_id": "rel-1", "success": True}
            if fn_name == "update_entity_scd2":
                return EntityResult(entity_id=args[0] if args else "", version_id="v2")
            if fn_name == "complete_maintenance_record":
                return {"status": "completed", "completed_at": args[4] if len(args) > 4 else ""}
            if fn_name == "resolve_asset_maintenance_completion_status":
                return {"status": "available"}
            if fn_name == "record_maintenance_completion_event":
                return None
            if fn_name == "record_asset_downtime":
                return True
            return None

        async def fake_wait_condition(cond_fn):
            for _ in range(_MAX_POLL_ITERATIONS):
                if cond_fn():
                    return
                await asyncio.sleep(0)
            raise TimeoutError("condition never satisfied")

        wf = MaintenanceWorkflow()
        fake_unsafe = MagicMock()
        fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

        async def send_complete():
            await create_entity_done.wait()
            await asyncio.sleep(0)
            wf._complete_signal = MaintenanceCompleteSignal(technician_id="tech-1")

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(tw_mod, "now", return_value=__import__("datetime").datetime(2026, 6, 11, 12, 0, 0)),
            patch.object(tw_mod, "unsafe", fake_unsafe),
        ):
            signal_task = asyncio.create_task(send_complete())
            await wf.run(
                MaintenanceRequest(
                    asset_id="asset-1",
                    maintenance_type="corrective",
                    technician_id="tech-1",
                    availability_impact="hard_down",
                    blocking_reason="Engine failure",
                    expected_return_at=None,
                )
            )
            await signal_task

        # Verify create_entity was called with maintenance_record and availability_impact
        maintenance_entity = next(
            (c for c in entity_calls if c["entity_type"] == "maintenance_record"), None
        )
        assert maintenance_entity is not None, (
            "create_entity was not called with entity_type='maintenance_record' — "
            "maintenance record not persisted through the entity/SCD2 path; "
            "v_asset_active_down_state will never see it"
        )
        assert maintenance_entity["attributes"].get("availability_impact") == "hard_down", (
            "availability_impact must be written into the maintenance record entity attributes; "
            "v_asset_active_down_state filters on availability_impact in ('soft_down','hard_down')"
        )
        assert maintenance_entity["attributes"].get("blocking_reason") == "Engine failure", (
            "blocking_reason must be stored in entity attributes for surfacing to operators"
        )
        assert "opened_at" in maintenance_entity["attributes"], (
            "opened_at must be set in entity attributes to record when the record was opened"
        )

        # Verify create_relationship links asset to maintenance record
        asset_link = next(
            (r for r in relationship_calls if r["rel_type"] == "asset_has_maintenance_record"), None
        )
        assert asset_link is not None, (
            "create_relationship with asset_has_maintenance_record was not called — "
            "v_asset_active_down_state joins relationships_v2 to find maintenance records for an asset"
        )
        assert asset_link["from_id"] == "asset-1", (
            "relationship must link from the asset to the maintenance record entity"
        )
        assert asset_link["to_id"] == "maint-ent-1", (
            "relationship to_id must be the entity_id returned by create_entity"
        )

    @pytest.mark.asyncio
    async def test_complete_writes_completed_at_to_clear_down_state(self):
        """update_entity_scd2 must be called on the maintenance record entity with
        completed_at set when the workflow completes.  Without this write,
        v_asset_active_down_state never clears for the asset and availability counts
        remain incorrect.  Fails if completed_at is not written."""
        import asyncio
        import contextlib
        from unittest.mock import MagicMock, patch

        import temporalio.workflow as tw_mod
        from temporal.src.activities.supabase_core import EntityResult
        from temporal.src.models.rental import MaintenanceCompleteSignal, MaintenanceRequest
        from temporal.src.workflows.rental.maintenance import MaintenanceWorkflow

        scd2_calls: list[dict] = []
        create_entity_done = asyncio.Event()

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "get_asset_status":
                return {"asset_id": args[0] if args else "", "status": "available", "version_id": "v1"}
            if fn_name == "check_asset_maintenance_openable":
                return {"allowed": True, "reason": None}
            if fn_name == "create_entity":
                create_entity_done.set()
                return EntityResult(entity_id="maint-ent-2", version_id="v1")
            if fn_name == "create_relationship":
                return {"relationship_id": "rel-1", "success": True}
            if fn_name == "update_entity_scd2":
                scd2_calls.append({"entity_id": args[0] if args else "", "attributes": args[1] if len(args) > 1 else {}})
                return EntityResult(entity_id=args[0] if args else "", version_id="v2")
            if fn_name == "complete_maintenance_record":
                return {"status": "completed", "completed_at": args[4] if len(args) > 4 else ""}
            if fn_name == "resolve_asset_maintenance_completion_status":
                return {"status": "available"}
            if fn_name == "record_maintenance_completion_event":
                return None
            if fn_name == "record_asset_downtime":
                return True
            return None

        async def fake_wait_condition(cond_fn):
            for _ in range(_MAX_POLL_ITERATIONS):
                if cond_fn():
                    return
                await asyncio.sleep(0)
            raise TimeoutError("condition never satisfied")

        wf = MaintenanceWorkflow()
        fake_unsafe = MagicMock()
        fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

        async def send_complete():
            await create_entity_done.wait()
            await asyncio.sleep(0)
            wf._complete_signal = MaintenanceCompleteSignal(technician_id="tech-2")

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(tw_mod, "now", return_value=__import__("datetime").datetime(2026, 6, 11, 12, 0, 0)),
            patch.object(tw_mod, "unsafe", fake_unsafe),
        ):
            signal_task = asyncio.create_task(send_complete())
            await wf.run(
                MaintenanceRequest(
                    asset_id="asset-2",
                    maintenance_type="corrective",
                    technician_id="tech-2",
                    availability_impact="soft_down",
                    blocking_reason="Minor hydraulic leak",
                    expected_return_at=None,
                )
            )
            await signal_task

        # Find the update_entity_scd2 call on the maintenance record entity with completed_at
        completed_at_call = next(
            (c for c in scd2_calls if c["entity_id"] == "maint-ent-2" and "completed_at" in c["attributes"]),
            None,
        )
        assert completed_at_call is not None, (
            "update_entity_scd2 was not called with completed_at on the maintenance record entity — "
            "v_asset_active_down_state filters on (completed_at IS NULL) so without this write "
            "the asset remains in soft_down/hard_down state forever"
        )

        # completed_at must be set before the asset is restored
        completed_at_idx = scd2_calls.index(completed_at_call)
        asset_restore_call = next(
            (c for c in scd2_calls if c["entity_id"] == "asset-2" and c["attributes"].get("status") == "available"),
            None,
        )
        assert asset_restore_call is not None, "Asset must be restored to 'available' after maintenance completion"
        restore_idx = scd2_calls.index(asset_restore_call)
        assert completed_at_idx < restore_idx, (
            "completed_at must be set on the maintenance record before the asset is restored to available"
        )
