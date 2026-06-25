"""Regression tests for the operational-flow domain models restored in PR #60.

Three layers:

1. **Model symbol regression** – imports every operational-flow symbol at module
   level (AssetStatus, InspectionType, InspectionResult, InvoiceStatus,
   TRANSFERABLE_STATUSES, MAINTENANCE_OPENABLE_STATUSES, and all request/result
   dataclasses).  A future removal of any symbol from
   ``temporal/src/models/rental.py`` will cause pytest collection to fail,
   catching the regression before any test is even executed.

2. **Model contract tests** – validates enum member values, frozenset membership,
   and dataclass field construction for every operational-flow type.

3. **Workflow regression tests** – exercises InspectionWorkflow,
   MaintenanceWorkflow, and InvoiceWorkflow using patched Temporal primitives
   (no Temporal test-server or network required).
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime
from dataclasses import asdict
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from temporal.src.activities import rental_operations as ops

# ---------------------------------------------------------------------------
# Layer 1 – module-level import regression
#
# Any removal of the symbols below from temporal/src/models/rental.py causes
# an ImportError at collection time, making the whole test run fail.
# ---------------------------------------------------------------------------
from temporal.src.models.rental import (
    MAINTENANCE_OPENABLE_STATUSES,
    # Operational-flow constants
    TRANSFERABLE_STATUSES,
    # Operational-flow enums
    AssetStatus,
    # Inspection dataclasses
    InspectionRequest,
    InspectionResult,
    InspectionResultSignal,
    InspectionSummary,
    InspectionType,
    # Invoice dataclasses
    InvoiceRequest,
    InvoiceStatus,
    InvoiceSummary,
    MaintenanceCompleteSignal,
    # Maintenance dataclasses
    MaintenanceRequest,
    MaintenanceSummary,
    MilestoneSignal,
    # Transfer dataclasses
    TransferRequest,
    TransferResult,
)
from temporal.src.workflows.rental.inspection import InspectionWorkflow
from temporal.src.workflows.rental.invoice import InvoiceWorkflow
from temporal.src.workflows.rental.maintenance import MaintenanceWorkflow

# ---------------------------------------------------------------------------
# Layer 2 – model contract tests
# ---------------------------------------------------------------------------


class TestAssetStatusEnum:
    """AssetStatus must be a str-Enum with exactly the eight operational values."""

    _EXPECTED = {
        "AVAILABLE": "available",
        "ON_RENT": "on_rent",
        "RETURNED": "returned",
        "IN_TRANSIT": "in_transit",
        "INSPECTION_HOLD": "inspection_hold",
        "MAINTENANCE": "maintenance",
        "UNAVAILABLE": "unavailable",
        "RETIRED": "retired",
    }

    @pytest.mark.parametrize("name,value", list(_EXPECTED.items()))
    def test_member_value(self, name, value):
        assert AssetStatus[name].value == value

    def test_is_str_subclass(self):
        assert isinstance(AssetStatus.AVAILABLE, str)

    def test_str_equality(self):
        assert AssetStatus.AVAILABLE == "available"
        assert AssetStatus.ON_RENT == "on_rent"

    def test_member_count(self):
        assert len(AssetStatus) == 8


class TestInspectionTypeEnum:
    def test_checkout_value(self):
        assert InspectionType.CHECKOUT.value == "checkout"

    def test_return_value(self):
        assert InspectionType.RETURN.value == "return"

    def test_service_value(self):
        assert InspectionType.SERVICE.value == "service"

    def test_member_count(self):
        assert len(InspectionType) == 3


class TestInspectionResultEnum:
    def test_pass_value(self):
        assert InspectionResult.PASS.value == "pass"

    def test_fail_value(self):
        assert InspectionResult.FAIL.value == "fail"

    def test_member_count(self):
        assert len(InspectionResult) == 2


class TestInvoiceStatusEnum:
    _EXPECTED = {
        "DRAFT": "draft",
        "PENDING": "pending",
        "SENT": "sent",
        "PAID": "paid",
        "VOID": "void",
    }

    @pytest.mark.parametrize("name,value", list(_EXPECTED.items()))
    def test_member_value(self, name, value):
        assert InvoiceStatus[name].value == value

    def test_member_count(self):
        assert len(InvoiceStatus) == 5


class TestOperationalFlowConstants:
    """TRANSFERABLE_STATUSES and MAINTENANCE_OPENABLE_STATUSES must contain
    exactly the documented operational statuses."""

    def test_transferable_statuses_is_frozenset(self):
        assert isinstance(TRANSFERABLE_STATUSES, frozenset)

    def test_only_available_is_transferable(self):
        assert frozenset({AssetStatus.AVAILABLE}) == TRANSFERABLE_STATUSES

    def test_non_available_statuses_not_transferable(self):
        non_transferable = {
            AssetStatus.ON_RENT,
            AssetStatus.RETURNED,
            AssetStatus.IN_TRANSIT,
            AssetStatus.INSPECTION_HOLD,
            AssetStatus.MAINTENANCE,
            AssetStatus.UNAVAILABLE,
            AssetStatus.RETIRED,
        }
        for status in non_transferable:
            assert status not in TRANSFERABLE_STATUSES, f"{status} must not be transferable"

    def test_maintenance_openable_statuses_is_frozenset(self):
        assert isinstance(MAINTENANCE_OPENABLE_STATUSES, frozenset)

    def test_maintenance_openable_contains_expected(self):
        assert AssetStatus.AVAILABLE in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.INSPECTION_HOLD in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.RETURNED in MAINTENANCE_OPENABLE_STATUSES

    def test_maintenance_openable_excludes_active_statuses(self):
        assert AssetStatus.ON_RENT not in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.IN_TRANSIT not in MAINTENANCE_OPENABLE_STATUSES
        assert AssetStatus.MAINTENANCE not in MAINTENANCE_OPENABLE_STATUSES


class TestOperationalFlowDataclasses:
    """All operational-flow dataclasses must be constructible with their
    required fields and expose those fields as attributes."""

    def test_transfer_request_required_fields(self):
        req = TransferRequest(
            asset_id="a-1",
            origin_branch_id="b-origin",
            destination_branch_id="b-dest",
            requested_by="user-1",
            sourcing_decision_id="finding-1",
            requested_ship_date="2026-06-20",
            expected_receive_date="2026-06-21",
            asset_scope="Excavator 100",
            internal_cost=425.5,
            transfer_exception_reason="Awaiting trailer slot confirmation",
        )
        assert req.asset_id == "a-1"
        assert req.origin_branch_id == "b-origin"
        assert req.destination_branch_id == "b-dest"
        assert req.requested_by == "user-1"
        assert req.sourcing_decision_id == "finding-1"
        assert req.asset_scope == "Excavator 100"
        assert req.internal_cost == 425.5

    def test_transfer_result_defaults(self):
        res = TransferResult(transfer_id="t-1", asset_id="a-1", status="requested")
        assert res.blocked is False
        assert res.blocked_reason is None
        assert res.exceptions == []

    def test_transfer_result_blocked(self):
        res = TransferResult(
            transfer_id="",
            asset_id="a-1",
            status="blocked",
            blocked=True,
            blocked_reason="not transferable",
            exceptions=["not transferable"],
        )
        assert res.blocked is True
        assert res.blocked_reason == "not transferable"
        assert res.exceptions == ["not transferable"]

    def test_milestone_signal_required_fields(self):
        sig = MilestoneSignal(actor_id="driver-1")
        assert sig.actor_id == "driver-1"
        assert sig.notes is None

    def test_milestone_signal_with_notes(self):
        sig = MilestoneSignal(actor_id="driver-2", notes="fragile cargo")
        assert sig.notes == "fragile cargo"

    def test_inspection_request_required_fields(self):
        req = InspectionRequest(
            asset_id="a-2",
            inspection_type=InspectionType.RETURN,
            inspector_id="insp-1",
        )
        assert req.asset_id == "a-2"
        assert req.inspection_type == InspectionType.RETURN
        assert req.inspector_id == "insp-1"

    def test_inspection_result_signal_defaults(self):
        sig = InspectionResultSignal(outcome=InspectionResult.PASS)
        assert sig.notes is None
        assert sig.open_maintenance is False

    def test_inspection_result_signal_fail_with_maintenance(self):
        sig = InspectionResultSignal(
            outcome=InspectionResult.FAIL,
            notes="crack in frame",
            open_maintenance=True,
        )
        assert sig.open_maintenance is True

    def test_inspection_summary_fields(self):
        summary = InspectionSummary(
            inspection_id="i-1",
            asset_id="a-1",
            outcome="pass",
            final_asset_status="available",
        )
        assert summary.maintenance_triggered is False

    def test_maintenance_request_required_fields(self):
        req = MaintenanceRequest(
            asset_id="a-3",
            maintenance_type="corrective",
            technician_id="tech-1",
        )
        assert req.asset_id == "a-3"
        assert req.maintenance_type == "corrective"
        assert req.notes is None

    def test_maintenance_complete_signal_required_fields(self):
        sig = MaintenanceCompleteSignal(technician_id="tech-1")
        assert sig.technician_id == "tech-1"
        assert sig.resolution_notes is None

    def test_maintenance_summary_defaults(self):
        summary = MaintenanceSummary(
            maintenance_record_id="mr-1",
            asset_id="a-1",
            status="completed",
        )
        assert summary.blocked is False
        assert summary.blocked_reason is None
        assert summary.downtime_minutes is None

    def test_invoice_request_required_fields(self):
        req = InvoiceRequest(
            contract_id="c-1",
            billing_period_start="2026-06-01",
            billing_period_end="2026-06-30",
        )
        assert req.contract_id == "c-1"
        assert req.line_items == []
        assert req.created_by == "system"

    def test_invoice_summary_fields(self):
        summary = InvoiceSummary(
            invoice_id="inv-1",
            contract_id="c-1",
            status="pending",
            subtotal=500.0,
            tax=50.0,
            total=550.0,
        )
        assert summary.blocked is False
        assert summary.billing_exceptions == []
        assert summary.customer_id is None

    def test_dataclasses_are_dict_serialisable(self):
        """asdict() must work for all operational-flow dataclasses."""
        for obj in [
            TransferRequest("a", "b", "c", "u"),
            TransferResult("t", "a", "requested"),
            MilestoneSignal("actor"),
            InspectionRequest("a", InspectionType.SERVICE, "i"),
            InspectionResultSignal(InspectionResult.PASS),
            InspectionSummary("i", "a", "pass", "available"),
            MaintenanceRequest("a", "preventive", "tech"),
            MaintenanceCompleteSignal("tech"),
            MaintenanceSummary("mr", "a", "completed"),
            InvoiceRequest("c", "2026-01-01", "2026-01-31"),
            InvoiceSummary("inv", "c", "pending", 100.0, 10.0, 110.0),
        ]:
            d = asdict(obj)
            assert isinstance(d, dict)


# ---------------------------------------------------------------------------
# Layer 3 – workflow regression tests
# ---------------------------------------------------------------------------

# Shared Temporal primitive helpers
# ───────────────────────────────────

def _make_fake_unsafe() -> MagicMock:
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()
    return fake_unsafe


async def _poll_condition(condition_fn):
    """Fake workflow.wait_condition: poll until condition_fn() is truthy."""
    while not condition_fn():
        await asyncio.sleep(0)


# ── InspectionWorkflow ──────────────────────────────────────────────────────

class TestInspectionWorkflowSignalHandlers:
    """Signal handlers and query methods work as plain Python; no runtime needed."""

    @pytest.mark.asyncio
    async def test_submit_result_stores_signal(self):
        wf = InspectionWorkflow()
        assert wf._result_signal is None
        sig = InspectionResultSignal(outcome=InspectionResult.PASS)
        await wf.submit_result(sig)
        assert wf._result_signal is sig

    def test_get_status_returns_in_progress_initially(self):
        wf = InspectionWorkflow()
        assert wf.get_status() == "in_progress"


class TestInspectionWorkflowLifecycle:
    """Full run() lifecycle with patched Temporal primitives."""

    @staticmethod
    def _build_activity_mock(
        inspection_id: str,
        resolved_status: str,
        *,
        inspection_created_event: asyncio.Event,
        scd2_calls: list,
        entity_calls: list,
    ):
        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "create_inspection_record":
                inspection_created_event.set()
                return {
                    "inspection_id": inspection_id,
                    "asset_id": args[0] if args else "",
                    "status": "in_progress",
                }
            if fn_name == "resolve_post_inspection_status":
                return resolved_status
            if fn_name == "update_entity_scd2":
                status = args[1].get("status", "") if len(args) > 1 else ""
                scd2_calls.append(status)
                return {"entity_id": args[0] if args else "", "version_id": "v2"}
            if fn_name == "create_maintenance_record":
                entity_calls.append(args)
                return {"maintenance_record_id": "mock-maint-id", "asset_id": args[0] if args else "", "status": "open"}
            return None

        return fake_execute_activity

    @pytest.mark.asyncio
    async def test_pass_return_inspection_yields_available(self):
        inspection_created = asyncio.Event()
        scd2_calls: list[str] = []
        entity_calls: list = []

        wf = InspectionWorkflow()
        fake_execute_activity = self._build_activity_mock(
            "insp-1",
            AssetStatus.AVAILABLE.value,
            inspection_created_event=inspection_created,
            scd2_calls=scd2_calls,
            entity_calls=entity_calls,
        )

        import temporalio.workflow as tw_mod

        async def send_signal():
            await inspection_created.wait()
            await asyncio.sleep(0)
            await wf.submit_result(InspectionResultSignal(outcome=InspectionResult.PASS))

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_signal())
            result = await wf.run(
                InspectionRequest(
                    asset_id="asset-pass",
                    inspection_type=InspectionType.RETURN,
                    inspector_id="inspector-1",
                )
            )
            await signal_task

        assert result["outcome"] == "pass"
        assert result["asset_id"] == "asset-pass"
        assert result["inspection_id"] == "insp-1"
        assert result["maintenance_triggered"] is False
        assert result["final_asset_status"] == AssetStatus.AVAILABLE.value
        assert AssetStatus.AVAILABLE.value in scd2_calls
        assert entity_calls == [], "No maintenance entity should be created on pass"

    @pytest.mark.asyncio
    async def test_fail_inspection_triggers_maintenance_entity(self):
        inspection_created = asyncio.Event()
        scd2_calls: list[str] = []
        entity_calls: list = []

        wf = InspectionWorkflow()
        fake_execute_activity = self._build_activity_mock(
            "insp-2",
            AssetStatus.INSPECTION_HOLD.value,
            inspection_created_event=inspection_created,
            scd2_calls=scd2_calls,
            entity_calls=entity_calls,
        )

        import temporalio.workflow as tw_mod

        async def send_signal():
            await inspection_created.wait()
            await asyncio.sleep(0)
            await wf.submit_result(
                InspectionResultSignal(
                    outcome=InspectionResult.FAIL,
                    notes="crack found",
                    open_maintenance=True,
                )
            )

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_signal())
            result = await wf.run(
                InspectionRequest(
                    asset_id="asset-fail",
                    inspection_type=InspectionType.RETURN,
                    inspector_id="inspector-2",
                )
            )
            await signal_task

        assert result["outcome"] == "fail"
        assert result["maintenance_triggered"] is True
        assert result["final_asset_status"] == AssetStatus.INSPECTION_HOLD.value
        assert AssetStatus.INSPECTION_HOLD.value in scd2_calls
        assert len(entity_calls) == 1, "A maintenance entity must be created on fail+open_maintenance"
        assert entity_calls[0][1] == "inspection_fail"

    @pytest.mark.asyncio
    async def test_fail_without_open_maintenance_no_entity_created(self):
        inspection_created = asyncio.Event()
        scd2_calls: list[str] = []
        entity_calls: list = []

        wf = InspectionWorkflow()
        fake_execute_activity = self._build_activity_mock(
            "insp-3",
            AssetStatus.INSPECTION_HOLD.value,
            inspection_created_event=inspection_created,
            scd2_calls=scd2_calls,
            entity_calls=entity_calls,
        )

        import temporalio.workflow as tw_mod

        async def send_signal():
            await inspection_created.wait()
            await asyncio.sleep(0)
            await wf.submit_result(
                InspectionResultSignal(outcome=InspectionResult.FAIL, open_maintenance=False)
            )

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_signal())
            result = await wf.run(
                InspectionRequest(
                    asset_id="asset-fail-nomaint",
                    inspection_type=InspectionType.CHECKOUT,
                    inspector_id="inspector-3",
                )
            )
            await signal_task

        assert result["maintenance_triggered"] is False
        assert entity_calls == []


# ── MaintenanceWorkflow ─────────────────────────────────────────────────────

class TestMaintenanceWorkflowSignalHandlers:
    """Signal handlers and query methods work as plain Python; no runtime needed."""

    @pytest.mark.asyncio
    async def test_complete_signal_stores_signal(self):
        wf = MaintenanceWorkflow()
        assert wf._complete_signal is None
        sig = MaintenanceCompleteSignal(technician_id="tech-1", resolution_notes="fixed")
        await wf.complete(sig)
        assert wf._complete_signal is sig

    def test_get_status_returns_pending_initially(self):
        wf = MaintenanceWorkflow()
        assert wf.get_status() == "pending"


class _FakeMaintenancePersistenceClient:
    """In-memory persistence double for maintenance workflow regression tests."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "fact_types": [
                {"id": "fact-asset-downtime", "key": "asset_downtime"},
            ],
            "rental_current_entity_state": [],
            "rental_current_relationships": [],
            "time_series_points": [],
            "entity_versions": [],
        }

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: dict[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        if limit is not None:
            rows = rows[:limit]
        return rows

    def insert(self, resource: str, payload: dict[str, Any]) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", f"{resource}-{len(self.tables.setdefault(resource, [])) + 1}")
        self.tables.setdefault(resource, []).append(row)
        return row

    def upsert(self, resource: str, payload: dict[str, Any], *, on_conflict: str) -> dict[str, Any]:
        conflict_keys = [part.strip() for part in on_conflict.split(",")]
        row = dict(payload)
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(existing.get(key) == row.get(key) for key in conflict_keys):
                merged = {**existing, **row}
                table[idx] = merged
                return merged
        row.setdefault("id", f"{resource}-{len(table) + 1}")
        table.append(row)
        return row

    def rpc(self, function_name: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        if function_name != "rental_upsert_entity_current_state":
            raise AssertionError(f"unexpected rpc {function_name}")
        entity_id = str(payload["p_entity_id"])
        entity_type = str(payload["p_entity_type"])
        data = dict(payload["p_data"])
        for idx, row in enumerate(self.tables["rental_current_entity_state"]):
            if row.get("entity_id") == entity_id and row.get("entity_type") == entity_type:
                version_number = int(row.get("version_number", 0)) + 1
                updated = {**row, "data": data, "version_number": version_number}
                self.tables["rental_current_entity_state"][idx] = updated
                entity_version_id = f"{entity_id}-v{version_number}"
                self.tables["entity_versions"].append(
                    {
                        "entity_id": entity_id,
                        "entity_type": entity_type,
                        "entity_version_id": entity_version_id,
                        "version_number": version_number,
                        "data": data,
                    }
                )
                return [
                    {
                        "entity_id": entity_id,
                        "entity_type": entity_type,
                        "entity_version_id": entity_version_id,
                        "version_number": version_number,
                        "data": data,
                    }
                ]
        raise AssertionError(f"entity {entity_type}:{entity_id} not seeded in fake client")


class TestMaintenanceWorkflowLifecycle:
    """Full run() lifecycle: blocked path and completed path."""

    @pytest.mark.asyncio
    async def test_blocked_when_asset_on_rent(self):
        """Maintenance must be blocked when the asset is on_rent."""
        import temporalio.workflow as tw_mod

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "get_asset_status":
                return {
                    "asset_id": args[0] if args else "",
                    "status": AssetStatus.ON_RENT.value,
                    "version_id": "v1",
                }
            if fn_name == "check_asset_maintenance_openable":
                return {"allowed": False, "reason": "asset status 'on_rent' does not allow opening maintenance"}
            return None

        wf = MaintenanceWorkflow()

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            result = await wf.run(
                MaintenanceRequest(
                    asset_id="asset-on-rent",
                    maintenance_type="corrective",
                    technician_id="tech-1",
                )
            )

        assert result["blocked"] is True
        assert result["status"] == "blocked"
        assert result["maintenance_record_id"] == ""
        assert "on_rent" in (result["blocked_reason"] or "")
        assert wf.get_status() == "blocked"

    @pytest.mark.asyncio
    async def test_completed_maintenance_records_downtime_and_restores_available(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Happy path: maintenance completion leaves durable record/event/downtime state.

        The workflow persists the maintenance record through create_entity + create_relationship
        (entity/SCD2 path) and sets completed_at on the entity when done, which clears the
        active down state from v_asset_active_down_state automatically.
        """
        import temporalio.workflow as tw_mod

        client = _FakeMaintenancePersistenceClient()
        monkeypatch.setattr(ops, "_rental_ops_client", client)
        monkeypatch.setattr(ops, "_fact_type_id_cache", {})
        client.tables["rental_current_entity_state"] = [
            {
                "entity_id": "asset-maint",
                "entity_type": "asset",
                "version_number": 1,
                "name": "Asset Maint",
                "data": {"status": "available", "operational_status": "available"},
            }
        ]
        scd2_calls: list[dict] = []
        maintenance_opened = asyncio.Event()
        now_calls: list[datetime.datetime] = []

        _t0 = datetime.datetime(2026, 6, 1, 10, 0, 0)
        _t1 = datetime.datetime(2026, 6, 1, 10, 30, 0)  # 30 minutes later

        def fake_now():
            idx = len(now_calls)
            # Call 0: opened_at attribute in step 3a → t0
            # Call 1: start_time capture in step 4 → t0
            # Call 2: end_time after completion signal → t1 (30 minutes later)
            val = _t1 if idx >= 2 else _t0
            now_calls.append(val)
            return val

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "get_asset_status":
                return {
                    "asset_id": args[0] if args else "",
                    "status": AssetStatus.AVAILABLE.value,
                    "version_id": "v1",
                }
            if fn_name == "check_asset_maintenance_openable":
                return {"allowed": True, "reason": None}
            if fn_name == "create_entity":
                # The workflow creates the maintenance record through the entity/SCD2 path.
                # args = [entity_type, attrs, technician_id]
                maintenance_opened.set()
                from temporal.src.activities.supabase_core import EntityResult
                client.tables["rental_current_entity_state"].append(
                    {
                        "entity_id": "mr-1",
                        "entity_type": "maintenance_record",
                        "version_number": 1,
                        "name": "Maintenance 1",
                        "data": {
                            "status": "open",
                            "maintenance_type": "preventive",
                            "opened_at": _t0.isoformat(),
                        },
                    }
                )
                return EntityResult(entity_id="mr-1", version_id="v1")
            if fn_name == "create_relationship":
                # args = [asset_id, record_id, relationship_type]
                asset_id_arg = args[0] if args else ""
                child_id_arg = args[1] if len(args) > 1 else "mr-1"
                rel_type_arg = args[2] if len(args) > 2 else "asset_has_maintenance_record"
                client.tables["rental_current_relationships"].append(
                    {
                        "relationship_id": f"rel-{child_id_arg}",
                        "relationship_type": rel_type_arg,
                        "parent_id": asset_id_arg,
                        "child_id": child_id_arg,
                        "child_entity_type": "maintenance_record",
                    }
                )
                return {"relationship_id": f"rel-{child_id_arg}", "success": True}
            if fn_name == "complete_maintenance_record":
                return ops.complete_maintenance_record(*args)
            if fn_name == "update_entity_scd2":
                entity_id = args[0] if args else ""
                attrs = args[1] if len(args) > 1 else {}
                scd2_calls.append({"entity_id": entity_id, "attributes": attrs})
                # For the asset entity, propagate to fake client so state assertions work.
                rows = [
                    r for r in client.tables["rental_current_entity_state"]
                    if r["entity_id"] == entity_id and r["entity_type"] == "asset"
                ]
                if rows:
                    updated_data = {**rows[0]["data"], **attrs}
                    return client.rpc(
                        "rental_upsert_entity_current_state",
                        {"p_entity_type": "asset", "p_entity_id": entity_id, "p_data": updated_data},
                    )[0]
                # For the maintenance record entity (completed_at write), update in-place.
                mr_rows = [
                    r for r in client.tables["rental_current_entity_state"]
                    if r["entity_id"] == entity_id and r["entity_type"] == "maintenance_record"
                ]
                if mr_rows:
                    mr_rows[0]["data"] = {**mr_rows[0]["data"], **attrs}
                from temporal.src.activities.supabase_core import EntityResult
                return EntityResult(entity_id=entity_id, version_id="v2")
            if fn_name == "record_asset_downtime":
                return ops.record_asset_downtime(*args)
            if fn_name == "resolve_asset_maintenance_completion_status":
                return ops.resolve_asset_maintenance_completion_status(*args)
            if fn_name == "record_maintenance_completion_event":
                return ops.record_maintenance_completion_event(*args)
            return None

        wf = MaintenanceWorkflow()

        async def send_complete_signal():
            await maintenance_opened.wait()
            await asyncio.sleep(0)
            await wf.complete(MaintenanceCompleteSignal(technician_id="tech-1", resolution_notes="replaced part"))

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "now", side_effect=fake_now),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_complete_signal())
            result = await wf.run(
                MaintenanceRequest(
                    asset_id="asset-maint",
                    maintenance_type="preventive",
                    technician_id="tech-1",
                    notes="annual service",
                )
            )
            await signal_task

        assert result["status"] == "completed"
        assert result["blocked"] is False
        assert result["maintenance_record_id"] == "mr-1"
        assert result["downtime_minutes"] == pytest.approx(30.0)
        assert result["final_asset_status"] == AssetStatus.AVAILABLE.value

        # SCD2 sequence: maintenance → completed_at → available
        statuses = [c["attributes"].get("status", "") for c in scd2_calls]
        assert "maintenance" in statuses, "Asset must transition to maintenance"
        assert "available" in statuses, "Asset must be restored to available on completion"
        assert statuses.index("maintenance") < statuses.index("available"), (
            "maintenance must precede available in SCD2 sequence"
        )

        # completed_at must be written to the maintenance record entity (not the asset)
        completed_at_call = next(
            (c for c in scd2_calls if "completed_at" in c["attributes"] and c["entity_id"] == "mr-1"),
            None,
        )
        assert completed_at_call is not None, (
            "update_entity_scd2 was not called with completed_at on the maintenance record — "
            "v_asset_active_down_state will not clear for this asset"
        )

        asset_row = client.select(
            "rental_current_entity_state",
            filters={"entity_id": "asset-maint", "entity_type": "asset"},
            limit=1,
        )[0]
        maintenance_row = client.select(
            "rental_current_entity_state",
            filters={"entity_id": "mr-1", "entity_type": "maintenance_record"},
            limit=1,
        )[0]
        assert asset_row["data"]["status"] == "available"
        assert asset_row["data"]["operational_status"] == "available"
        assert maintenance_row["data"]["status"] == "completed"
        assert maintenance_row["data"]["resolution_notes"] == "replaced part"
        assert maintenance_row["data"]["completed_by"] == "tech-1"
        # completed_at must also be set on the maintenance record via update_entity_scd2
        assert "completed_at" in maintenance_row["data"], (
            "completed_at not found in maintenance record data — v_asset_active_down_state will not clear"
        )
        downtime_rows = [
            row for row in client.tables["time_series_points"] if row["data_payload"].get("maintenance_record_id") == "mr-1"
        ]
        assert len(downtime_rows) == 2
        assert any(row["data_payload"].get("downtime_minutes") == pytest.approx(30.0) for row in downtime_rows)
        assert any(row["data_payload"].get("event_type") == "maintenance_completed" for row in downtime_rows)
        assert wf.get_status() == "completed"

    @pytest.mark.asyncio
    async def test_completed_maintenance_keeps_blocking_hold_status(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Completion must not restore availability when another blocking hold remains."""
        import temporalio.workflow as tw_mod

        client = _FakeMaintenancePersistenceClient()
        monkeypatch.setattr(ops, "_rental_ops_client", client)
        monkeypatch.setattr(ops, "_fact_type_id_cache", {})
        client.tables["rental_current_entity_state"] = [
            {
                "entity_id": "asset-hold",
                "entity_type": "asset",
                "version_number": 1,
                "name": "Asset Hold",
                "data": {"status": "inspection_hold", "operational_status": "inspection_hold"},
            },
            {
                "entity_id": "inspection-open",
                "entity_type": "inspection",
                "version_number": 1,
                "name": "Inspection Open",
                "data": {"status": "open"},
            },
        ]
        client.tables["rental_current_relationships"] = [
            {
                "relationship_id": "rel-inspection",
                "relationship_type": "asset_has_inspection",
                "parent_id": "asset-hold",
                "child_id": "inspection-open",
                "child_entity_type": "inspection",
            }
        ]
        maintenance_opened = asyncio.Event()
        now_calls: list[datetime.datetime] = []

        _t0 = datetime.datetime(2026, 6, 1, 10, 0, 0)
        _t1 = datetime.datetime(2026, 6, 1, 10, 20, 0)

        def fake_now():
            idx = len(now_calls)
            # Call 0: opened_at in step 3a → _t0
            # Call 1: start_time after step 4 → _t0
            # Call 2: end_time after completion signal → _t1
            val = _t0 if idx <= 1 else _t1
            now_calls.append(val)
            return val

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "get_asset_status":
                return {"asset_id": args[0] if args else "", "status": AssetStatus.INSPECTION_HOLD.value, "version_id": "v1"}
            if fn_name == "check_asset_maintenance_openable":
                return {"allowed": True, "reason": None}
            if fn_name == "create_entity":
                maintenance_opened.set()
                from temporal.src.activities.supabase_core import EntityResult
                client.tables["rental_current_entity_state"].append(
                    {
                        "entity_id": "mr-hold",
                        "entity_type": "maintenance_record",
                        "version_number": 1,
                        "name": "Maintenance Hold",
                        "data": {"status": "open", "opened_at": _t0.isoformat()},
                    }
                )
                return EntityResult(entity_id="mr-hold", version_id="v1")
            if fn_name == "create_relationship":
                asset_id_arg = args[0] if args else ""
                child_id_arg = args[1] if len(args) > 1 else "mr-hold"
                rel_type_arg = args[2] if len(args) > 2 else "asset_has_maintenance_record"
                client.tables["rental_current_relationships"].append(
                    {
                        "relationship_id": f"rel-{child_id_arg}",
                        "relationship_type": rel_type_arg,
                        "parent_id": asset_id_arg,
                        "child_id": child_id_arg,
                        "child_entity_type": "maintenance_record",
                    }
                )
                return {"relationship_id": f"rel-{child_id_arg}", "success": True}
            if fn_name == "complete_maintenance_record":
                return ops.complete_maintenance_record(*args)
            if fn_name == "record_asset_downtime":
                return ops.record_asset_downtime(*args)
            if fn_name == "resolve_asset_maintenance_completion_status":
                return ops.resolve_asset_maintenance_completion_status(*args)
            if fn_name == "record_maintenance_completion_event":
                return ops.record_maintenance_completion_event(*args)
            if fn_name == "update_entity_scd2":
                entity_id = args[0] if args else ""
                attrs = args[1] if len(args) > 1 else {}
                asset_rows = client.select(
                    "rental_current_entity_state",
                    filters={"entity_id": entity_id, "entity_type": "asset"},
                    limit=1,
                )
                if asset_rows:
                    updated_data = {**asset_rows[0]["data"], **attrs}
                    return client.rpc(
                        "rental_upsert_entity_current_state",
                        {"p_entity_type": "asset", "p_entity_id": entity_id, "p_data": updated_data},
                    )[0]
                mr_rows = [
                    r for r in client.tables["rental_current_entity_state"]
                    if r["entity_id"] == entity_id and r["entity_type"] == "maintenance_record"
                ]
                if mr_rows:
                    mr_rows[0]["data"] = {**mr_rows[0]["data"], **attrs}
                from temporal.src.activities.supabase_core import EntityResult
                return EntityResult(entity_id=entity_id, version_id="v2")
            return None

        wf = MaintenanceWorkflow()

        async def send_complete_signal():
            await maintenance_opened.wait()
            await asyncio.sleep(0)
            await wf.complete(MaintenanceCompleteSignal(technician_id="tech-2", resolution_notes="awaiting inspection release"))

        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "now", side_effect=fake_now),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            signal_task = asyncio.create_task(send_complete_signal())
            result = await wf.run(
                MaintenanceRequest(
                    asset_id="asset-hold",
                    maintenance_type="corrective",
                    technician_id="tech-2",
                )
            )
            await signal_task

        assert result["status"] == "completed"
        assert result["final_asset_status"] == AssetStatus.INSPECTION_HOLD.value
        asset_row = client.select(
            "rental_current_entity_state",
            filters={"entity_id": "asset-hold", "entity_type": "asset"},
            limit=1,
        )[0]
        assert asset_row["data"]["status"] == AssetStatus.INSPECTION_HOLD.value
        assert asset_row["data"]["operational_status"] == AssetStatus.INSPECTION_HOLD.value
        completion_event = [
            row for row in client.tables["time_series_points"] if row["data_payload"].get("event_type") == "maintenance_completed"
        ][0]
        assert completion_event["data_payload"]["final_asset_status"] == AssetStatus.INSPECTION_HOLD.value

    @pytest.mark.asyncio
    async def test_repeated_maintenance_cycles_keep_availability_and_analytics_in_sync(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Repeated open/complete cycles should record distinct downtime intervals and restore availability each time."""
        import temporalio.workflow as tw_mod

        client = _FakeMaintenancePersistenceClient()
        monkeypatch.setattr(ops, "_rental_ops_client", client)
        monkeypatch.setattr(ops, "_fact_type_id_cache", {})
        client.tables["rental_current_entity_state"] = [
            {
                "entity_id": "asset-repeat",
                "entity_type": "asset",
                "version_number": 1,
                "name": "Asset Repeat",
                "data": {"status": "available", "operational_status": "available"},
            }
        ]

        async def run_cycle(record_id: str, start_time: datetime.datetime, end_time: datetime.datetime):
            maintenance_opened = asyncio.Event()
            now_calls: list[datetime.datetime] = []

            def fake_now():
                idx = len(now_calls)
                # Call 0: opened_at attribute in step 3a → start_time
                # Call 1: start_time capture after step 4 → start_time
                # Call 2: end_time after completion signal → end_time
                val = start_time if idx <= 1 else end_time
                now_calls.append(val)
                return val

            async def fake_execute_activity(fn_or_str, *pos_args, **kw):
                fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
                args = kw.get("args", list(pos_args))
                if fn_name == "get_asset_status":
                    return {"asset_id": args[0] if args else "", "status": AssetStatus.AVAILABLE.value, "version_id": "v1"}
                if fn_name == "check_asset_maintenance_openable":
                    return {"allowed": True, "reason": None}
                if fn_name == "create_entity":
                    maintenance_opened.set()
                    from temporal.src.activities.supabase_core import EntityResult
                    client.tables["rental_current_entity_state"].append(
                        {
                            "entity_id": record_id,
                            "entity_type": "maintenance_record",
                            "version_number": 1,
                            "name": record_id,
                            "data": {"status": "open", "opened_at": start_time.isoformat()},
                        }
                    )
                    return EntityResult(entity_id=record_id, version_id="v1")
                if fn_name == "create_relationship":
                    asset_id_arg = args[0] if args else ""
                    child_id_arg = args[1] if len(args) > 1 else record_id
                    rel_type_arg = args[2] if len(args) > 2 else "asset_has_maintenance_record"
                    client.tables["rental_current_relationships"].append(
                        {
                            "relationship_id": f"rel-{child_id_arg}",
                            "relationship_type": rel_type_arg,
                            "parent_id": asset_id_arg,
                            "child_id": child_id_arg,
                            "child_entity_type": "maintenance_record",
                        }
                    )
                    return {"relationship_id": f"rel-{child_id_arg}", "success": True}
                if fn_name == "complete_maintenance_record":
                    return ops.complete_maintenance_record(*args)
                if fn_name == "record_asset_downtime":
                    return ops.record_asset_downtime(*args)
                if fn_name == "resolve_asset_maintenance_completion_status":
                    return ops.resolve_asset_maintenance_completion_status(*args)
                if fn_name == "record_maintenance_completion_event":
                    return ops.record_maintenance_completion_event(*args)
                if fn_name == "update_entity_scd2":
                    entity_id = args[0] if args else ""
                    attrs = args[1] if len(args) > 1 else {}
                    asset_rows = client.select(
                        "rental_current_entity_state",
                        filters={"entity_id": entity_id, "entity_type": "asset"},
                        limit=1,
                    )
                    if asset_rows:
                        updated_data = {**asset_rows[0]["data"], **attrs}
                        return client.rpc(
                            "rental_upsert_entity_current_state",
                            {"p_entity_type": "asset", "p_entity_id": entity_id, "p_data": updated_data},
                        )[0]
                    mr_rows = [
                        r for r in client.tables["rental_current_entity_state"]
                        if r["entity_id"] == entity_id and r["entity_type"] == "maintenance_record"
                    ]
                    if mr_rows:
                        mr_rows[0]["data"] = {**mr_rows[0]["data"], **attrs}
                    from temporal.src.activities.supabase_core import EntityResult
                    return EntityResult(entity_id=entity_id, version_id="v2")
                return None

            wf = MaintenanceWorkflow()

            async def send_complete_signal():
                await maintenance_opened.wait()
                await asyncio.sleep(0)
                await wf.complete(MaintenanceCompleteSignal(technician_id="tech-repeat", resolution_notes="cycle complete"))

            with (
                patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
                patch.object(tw_mod, "wait_condition", side_effect=_poll_condition),
                patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
                patch.object(tw_mod, "now", side_effect=fake_now),
                patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
            ):
                signal_task = asyncio.create_task(send_complete_signal())
                result = await wf.run(
                    MaintenanceRequest(
                        asset_id="asset-repeat",
                        maintenance_type="preventive",
                        technician_id="tech-repeat",
                    )
                )
                await signal_task

            return result

        result_one = await run_cycle(
            "mr-cycle-1",
            datetime.datetime(2026, 6, 1, 8, 0, 0),
            datetime.datetime(2026, 6, 1, 8, 45, 0),
        )
        result_two = await run_cycle(
            "mr-cycle-2",
            datetime.datetime(2026, 6, 2, 9, 0, 0),
            datetime.datetime(2026, 6, 2, 9, 30, 0),
        )

        assert result_one["final_asset_status"] == AssetStatus.AVAILABLE.value
        assert result_two["final_asset_status"] == AssetStatus.AVAILABLE.value
        downtime_rows = [
            row
            for row in client.tables["time_series_points"]
            if row.get("metadata", {}).get("source") == "maintenance"
        ]
        assert [(row["data_payload"]["maintenance_record_id"], row["data_payload"]["downtime_minutes"]) for row in downtime_rows] == [
            ("mr-cycle-1", pytest.approx(45.0)),
            ("mr-cycle-2", pytest.approx(30.0)),
        ]
        completion_events = [
            row for row in client.tables["time_series_points"] if row["data_payload"].get("event_type") == "maintenance_completed"
        ]
        assert [(row["data_payload"]["maintenance_record_id"], row["data_payload"]["final_asset_status"]) for row in completion_events] == [
            ("mr-cycle-1", AssetStatus.AVAILABLE.value),
            ("mr-cycle-2", AssetStatus.AVAILABLE.value),
        ]
        asset_row = client.select(
            "rental_current_entity_state",
            filters={"entity_id": "asset-repeat", "entity_type": "asset"},
            limit=1,
        )[0]
        assert asset_row["data"]["status"] == AssetStatus.AVAILABLE.value
        assert asset_row["data"]["operational_status"] == AssetStatus.AVAILABLE.value


# ── InvoiceWorkflow ─────────────────────────────────────────────────────────

class TestInvoiceWorkflowLifecycle:
    """InvoiceWorkflow end-to-end runs through all activity steps."""

    @staticmethod
    def _make_activity_mock(
        *,
        blocked: bool,
        exceptions: list,
        invoice_id: str = "inv-test",
        subtotal: float = 300.0,
        tax: float = 30.0,
        total: float = 330.0,
    ):
        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "create_invoice_record":
                return {
                    "invoice_id": invoice_id,
                    "contract_id": args[0] if args else "",
                    "status": "draft",
                }
            if fn_name == "create_relationship":
                return {"relationship_id": "rel-1"}
            if fn_name == "derive_invoiceable_line_items":
                return {"line_items": args[1] if len(args) > 1 else [], "invoiceable_count": 1, "dropped_duplicates": 0}
            if fn_name == "evaluate_invoice_readiness":
                return {"blocked": blocked, "exceptions": exceptions}
            if fn_name == "compute_invoice_totals":
                return {"subtotal": subtotal, "tax": tax, "total": total}
            if fn_name == "finalise_invoice":
                final_status = "draft" if args[4] else "pending"
                return {
                    "invoice_id": args[0] if args else invoice_id,
                    "status": final_status,
                    "subtotal": args[1] if len(args) > 1 else subtotal,
                    "tax": args[2] if len(args) > 2 else tax,
                    "total": args[3] if len(args) > 3 else total,
                    "blocked": args[4] if len(args) > 4 else blocked,
                    "billing_exceptions": args[5] if len(args) > 5 else exceptions,
                    "customer_id": args[6].get("customer_id") if len(args) > 6 else None,
                    "billing_account_id": args[6].get("billing_account_id") if len(args) > 6 else None,
                    "job_site_id": args[6].get("job_site_id") if len(args) > 6 else None,
                    "transaction_currency_code": args[6].get("transaction_currency_code", "USD") if len(args) > 6 else "USD",
                    "reporting_currency_code": args[6].get("reporting_currency_code", "USD") if len(args) > 6 else "USD",
                    "fx_rate_applied": args[6].get("fx_rate_applied", 1.0) if len(args) > 6 else 1.0,
                    "fx_rate_effective_at": args[6].get("fx_rate_effective_at") if len(args) > 6 else None,
                }
            return None

        return fake_execute_activity

    @pytest.mark.asyncio
    async def test_happy_path_invoice_reaches_pending(self):
        import temporalio.workflow as tw_mod

        line_items = [
            {"source_key": "line-1", "rate": 100.0, "quantity": 3, "tax_rate": 0.10},
        ]
        wf = InvoiceWorkflow()

        with (
            patch.object(
                tw_mod,
                "execute_activity",
                side_effect=self._make_activity_mock(blocked=False, exceptions=[]),
            ),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            result = await wf.run(
                InvoiceRequest(
                    contract_id="contract-happy",
                    billing_period_start="2026-06-01",
                    billing_period_end="2026-06-30",
                    line_items=line_items,
                    customer_id="cust-1",
                    billing_account_id="ba-1",
                    job_site_id="job-1",
                    transaction_currency_code="EUR",
                    reporting_currency_code="USD",
                    fx_rate_applied=1.09,
                    fx_rate_effective_at="2026-06-01T00:00:00Z",
                )
            )

        assert result["status"] == "pending"
        assert result["contract_id"] == "contract-happy"
        assert result["invoice_id"] == "inv-test"
        assert result["blocked"] is False
        assert result["subtotal"] == pytest.approx(300.0)
        assert result["total"] == pytest.approx(330.0)
        assert result["transaction_currency_code"] == "EUR"
        assert result["reporting_currency_code"] == "USD"
        assert result["fx_rate_applied"] == pytest.approx(1.09)
        assert result["fx_rate_effective_at"] == "2026-06-01T00:00:00Z"

    @pytest.mark.asyncio
    async def test_blocked_invoice_stays_draft(self):
        import temporalio.workflow as tw_mod

        billing_hold = {"code": "billing_hold", "reason": "Billing hold present: credit_review", "blocking": True}
        wf = InvoiceWorkflow()

        with (
            patch.object(
                tw_mod,
                "execute_activity",
                side_effect=self._make_activity_mock(
                    blocked=True,
                    exceptions=[billing_hold],
                ),
            ),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: datetime.timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            result = await wf.run(
                InvoiceRequest(
                    contract_id="contract-blocked",
                    billing_period_start="2026-06-01",
                    billing_period_end="2026-06-30",
                    billing_holds=["credit_review"],
                )
            )

        assert result["status"] == "draft"
        assert result["blocked"] is True
        assert len(result["billing_exceptions"]) == 1
        assert result["billing_exceptions"][0]["code"] == "billing_hold"
