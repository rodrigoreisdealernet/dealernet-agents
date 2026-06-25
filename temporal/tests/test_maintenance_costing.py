"""Tests for maintenance costing: itemized labor/parts/fees and invoice-from-work-order.

Four layers:

1. **Model symbol regression** – imports every new costing symbol so that any future
   removal from ``temporal/src/models/rental.py`` fails at collection time.

2. **Activity unit tests (with fake client)** – validates business logic for:
   - Line-total computation (quantity × unit_cost, sell_amount, taxability)
   - Work-order total roll-ups across multiple lines
   - Idempotent invoice creation guard
   - Deterministic invoice ID (same inputs → same UUID)
   - **Persistence: tests fail unless the activity calls the Supabase client**

3. **Behavioral persistence tests** – explicitly assert that durable state is
   written to the in-memory tables of the fake client.  These tests fail if any
   Supabase call is removed from the activity body.

4. **Workflow regression tests** – exercises MaintenanceCostingWorkflow and
   MaintenanceInvoiceWorkflow using patched Temporal primitives (no test-server
   or network required).
"""
from __future__ import annotations

import contextlib
import datetime
from collections.abc import Mapping
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from temporal.src.activities import rental_operations as ops

# ---------------------------------------------------------------------------
# Layer 1 – module-level import regression
# ---------------------------------------------------------------------------
from temporal.src.models.rental import (
    MaintenanceCostingRequest,
    MaintenanceCostLineType,
    MaintenanceInvoiceRequest,
)
from temporal.src.workflows.rental.maintenance_costing import (
    MaintenanceCostingWorkflow,
    MaintenanceInvoiceWorkflow,
)

# ---------------------------------------------------------------------------
# Fake Supabase client (mirrors _FakeOpsPersistenceClient pattern)
# ---------------------------------------------------------------------------

class _FakeMaintenanceClient:
    """In-memory Supabase client that records all calls for assertion."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "maintenance_cost_lines": [],
            "entity_versions": [],
            "entities": [],
            "relationships_v2": [],
        }

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
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

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        # Simulate trg_entity_versions_scd2 BEFORE INSERT trigger: when a new
        # current entity_versions row is inserted, retire the existing current
        # row by closing its validity window (is_current=false, valid_to set).
        if resource == "entity_versions" and row.get("is_current") is True:
            # Mirror trg_entity_versions_scd2: coalesce(new.valid_from, now())
            valid_to = row.get("valid_from") or datetime.datetime.now(datetime.UTC).isoformat()
            table = self.tables.setdefault(resource, [])
            for idx, existing in enumerate(table):
                if existing.get("entity_id") == row.get("entity_id") and existing.get("is_current") is True:
                    table[idx] = {**existing, "is_current": False, "valid_to": valid_to}
        self.tables.setdefault(resource, []).append(row)
        return row

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        conflict_keys = [part.strip() for part in on_conflict.split(",")]
        row = dict(payload)
        # Simulate generated stored columns for maintenance_cost_lines (mirrors DB trigger).
        if resource == "maintenance_cost_lines":
            qty = float(row.get("quantity", 0))
            unit_cost = float(row.get("unit_cost", 0))
            sell_amount = float(row.get("sell_amount", 0))
            is_taxable = bool(row.get("is_taxable", False))
            tax_rate = float(row.get("tax_rate", 0))
            row["cost_total"] = round(qty * unit_cost, 4)
            row["sell_line_total"] = round(qty * sell_amount, 4)
            row["tax_amount"] = round((qty * sell_amount) * tax_rate, 4) if is_taxable else 0.0
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(existing.get(key) == row.get(key) for key in conflict_keys):
                merged = {**existing, **row}
                merged["id"] = existing.get("id", row.get("id", str(uuid4())))
                table[idx] = merged
                return merged
        row.setdefault("id", str(uuid4()))
        table.append(row)
        return row

    def update(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        updated: list[dict[str, Any]] = []
        table = self.tables.setdefault(resource, [])
        for idx, row in enumerate(table):
            if all(row.get(key) == value for key, value in filters.items()):
                merged = {**row, **dict(payload)}
                table[idx] = merged
                updated.append(merged)
        return updated


@pytest.fixture()
def fake_maintenance_client(monkeypatch: pytest.MonkeyPatch) -> _FakeMaintenanceClient:
    client = _FakeMaintenanceClient()
    monkeypatch.setattr(ops, "_rental_ops_client", client)
    return client


# ---------------------------------------------------------------------------
# Layer 2 – activity unit tests (require fake Supabase client)
# ---------------------------------------------------------------------------


class TestMaintenanceCostLineType:
    def test_enum_values(self):
        assert MaintenanceCostLineType.LABOR == "labor"
        assert MaintenanceCostLineType.PARTS == "parts"
        assert MaintenanceCostLineType.FEES == "fees"

    def test_is_str_subclass(self):
        assert isinstance(MaintenanceCostLineType.LABOR, str)

    def test_member_count(self):
        assert len(MaintenanceCostLineType) == 3


class TestAddMaintenanceCostLine:
    """add_maintenance_cost_line computes correct line totals and persists to DB."""

    def _call(self, fake_maintenance_client, **kw):
        defaults = dict(
            maintenance_record_id="mr-1",
            line_type="labor",
            description="Technician 2h",
            quantity=2.0,
            unit_cost=75.0,
            sell_amount=100.0,
            is_taxable=False,
            tax_rate=0.0,
            line_id="line-001",
        )
        defaults.update(kw)
        return ops.add_maintenance_cost_line(**defaults)

    def test_cost_total_computed(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, quantity=3.0, unit_cost=50.0)
        assert result["cost_total"] == pytest.approx(150.0)

    def test_sell_line_total_computed(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, quantity=2.0, sell_amount=100.0)
        assert result["sell_line_total"] == pytest.approx(200.0)

    def test_tax_amount_zero_when_not_taxable(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, is_taxable=False, tax_rate=0.10)
        assert result["tax_amount"] == pytest.approx(0.0)

    def test_tax_amount_computed_when_taxable(self, fake_maintenance_client):
        # 2 units × $100 sell = $200 sell total; 10% tax = $20
        result = self._call(fake_maintenance_client, quantity=2.0, sell_amount=100.0, is_taxable=True, tax_rate=0.10)
        assert result["tax_amount"] == pytest.approx(20.0)

    def test_deterministic_id_same_line_id(self, fake_maintenance_client):
        """Same line_id → same row id (retry is idempotent)."""
        r1 = self._call(fake_maintenance_client, line_id="line-abc")
        r2 = self._call(fake_maintenance_client, line_id="line-abc")
        assert r1["cost_line_id"] == r2["cost_line_id"]

    def test_different_line_id_different_row_id(self, fake_maintenance_client):
        """Different line_ids produce different row ids even with identical business data."""
        r1 = self._call(fake_maintenance_client, line_id="line-001")
        r2 = self._call(fake_maintenance_client, line_id="line-002")
        assert r1["cost_line_id"] != r2["cost_line_id"]

    def test_line_id_missing_raises(self, fake_maintenance_client):
        """Omitting line_id must raise ValueError, not silently hash business fields."""
        with pytest.raises(ValueError, match="line_id is required"):
            ops.add_maintenance_cost_line(
                maintenance_record_id="mr-1",
                line_type="labor",
                description="No key",
                quantity=1.0,
                unit_cost=10.0,
                sell_amount=0.0,
            )

    def test_returns_maintenance_record_id(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, maintenance_record_id="mr-999")
        assert result["maintenance_record_id"] == "mr-999"

    def test_fractional_quantity(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, quantity=0.5, unit_cost=80.0)
        assert result["cost_total"] == pytest.approx(40.0)

    # -- Persistence assertions --

    def test_persists_row_to_maintenance_cost_lines(self, fake_maintenance_client):
        """Fails if the activity never calls client.upsert on maintenance_cost_lines."""
        self._call(fake_maintenance_client)
        rows = fake_maintenance_client.tables["maintenance_cost_lines"]
        assert len(rows) == 1
        assert rows[0]["maintenance_record_id"] == "mr-1"
        assert rows[0]["line_type"] == "labor"
        assert rows[0]["line_id"] == "line-001"

    def test_retry_same_line_id_does_not_duplicate(self, fake_maintenance_client):
        """Retrying with the same line_id must produce exactly one row (idempotent)."""
        self._call(fake_maintenance_client, line_id="line-retry")
        self._call(fake_maintenance_client, line_id="line-retry")
        rows = fake_maintenance_client.tables["maintenance_cost_lines"]
        assert len(rows) == 1

    def test_identical_data_different_line_ids_produce_two_rows(self, fake_maintenance_client):
        """Two identical cost items entered on the same work order must both be persisted.

        This is the key regression: before the line_id fix, identical business-data
        fields collapsed into one row, silently discarding the second charge.
        """
        self._call(fake_maintenance_client, description="Labor 2h", quantity=2.0, unit_cost=75.0, line_id="line-001")
        self._call(fake_maintenance_client, description="Labor 2h", quantity=2.0, unit_cost=75.0, line_id="line-002")
        rows = fake_maintenance_client.tables["maintenance_cost_lines"]
        assert len(rows) == 2, "identical cost items with distinct line_ids must produce two separate rows"

    def test_identical_lines_both_contribute_to_totals(self, fake_maintenance_client):
        """Two identical cost lines must both contribute to rolled-up internal_subtotal.

        Regression: if they collapsed, cost_line_count would be 1 and totals halved.
        """
        self._call(fake_maintenance_client, description="Filter", quantity=1.0, unit_cost=50.0, sell_amount=60.0, line_id="line-001")
        self._call(fake_maintenance_client, description="Filter", quantity=1.0, unit_cost=50.0, sell_amount=60.0, line_id="line-002")
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["cost_line_count"] == 2
        assert result["internal_subtotal"] == pytest.approx(100.0)
        assert result["sell_subtotal"] == pytest.approx(120.0)


class TestComputeMaintenanceWorkOrderTotals:
    """compute_maintenance_work_order_totals: queries DB rows and persists SCD2 version."""

    def _seed_lines(self, fake_maintenance_client: _FakeMaintenanceClient, maintenance_record_id: str = "mr-1"):
        """Pre-populate fake DB with known cost-line rows (simulating add_maintenance_cost_line calls)."""
        fake_maintenance_client.tables["maintenance_cost_lines"] = [
            {"maintenance_record_id": maintenance_record_id, "cost_total": 150.0, "sell_line_total": 200.0, "tax_amount": 0.0},
            {"maintenance_record_id": maintenance_record_id, "cost_total": 50.0, "sell_line_total": 60.0, "tax_amount": 6.0},
            {"maintenance_record_id": maintenance_record_id, "cost_total": 40.0, "sell_line_total": 60.0, "tax_amount": 0.0},
        ]

    def test_internal_subtotal(self, fake_maintenance_client):
        # (2×75) + (1×50) + (4×10) = 150 + 50 + 40 = 240
        self._seed_lines(fake_maintenance_client)
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["internal_subtotal"] == pytest.approx(240.0)

    def test_sell_subtotal(self, fake_maintenance_client):
        # (2×100) + (1×60) + (4×15) = 200 + 60 + 60 = 320
        self._seed_lines(fake_maintenance_client)
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["sell_subtotal"] == pytest.approx(320.0)

    def test_tax_total_only_taxable_lines(self, fake_maintenance_client):
        # only line 2 is taxable: 6.0
        self._seed_lines(fake_maintenance_client)
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["tax_total"] == pytest.approx(6.0)

    def test_sell_total(self, fake_maintenance_client):
        # 320 + 6 = 326
        self._seed_lines(fake_maintenance_client)
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["sell_total"] == pytest.approx(326.0)

    def test_empty_lines(self, fake_maintenance_client):
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["internal_subtotal"] == 0.0
        assert result["sell_subtotal"] == 0.0
        assert result["tax_total"] == 0.0
        assert result["sell_total"] == 0.0
        assert result["cost_line_count"] == 0

    def test_cost_line_count(self, fake_maintenance_client):
        self._seed_lines(fake_maintenance_client)
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["cost_line_count"] == 3

    def test_internal_only_lines_have_zero_sell(self, fake_maintenance_client):
        fake_maintenance_client.tables["maintenance_cost_lines"] = [
            {"maintenance_record_id": "mr-1", "cost_total": 120.0, "sell_line_total": 0.0, "tax_amount": 0.0},
        ]
        result = ops.compute_maintenance_work_order_totals("mr-1", [])
        assert result["internal_subtotal"] == pytest.approx(120.0)
        assert result["sell_subtotal"] == pytest.approx(0.0)
        assert result["sell_total"] == pytest.approx(0.0)

    # -- Persistence assertions --

    def test_persists_new_entity_version_with_totals(self, fake_maintenance_client):
        """Fails if the activity never inserts a new entity_versions row."""
        self._seed_lines(fake_maintenance_client)
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ev_rows = [r for r in fake_maintenance_client.tables["entity_versions"] if r.get("entity_id") == "mr-1"]
        assert len(ev_rows) >= 1
        data = ev_rows[-1].get("data") or {}
        assert data.get("internal_subtotal") == pytest.approx(240.0)
        assert data.get("sell_total") == pytest.approx(326.0)

    def test_new_version_increments_version_number(self, fake_maintenance_client):
        """Version number must increase from 0 (no prior version) to 1."""
        self._seed_lines(fake_maintenance_client)
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ev_rows = [r for r in fake_maintenance_client.tables["entity_versions"] if r.get("entity_id") == "mr-1"]
        assert ev_rows[-1]["version_number"] == 1

    def test_carries_existing_data_forward(self, fake_maintenance_client):
        """Existing data fields in entity_versions.data must be preserved."""
        fake_maintenance_client.tables["entity_versions"] = [{
            "entity_id": "mr-1",
            "version_number": 2,
            "is_current": True,
            "data": {"status": "completed", "maintenance_type": "full_service"},
        }]
        self._seed_lines(fake_maintenance_client)
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ev_rows = [r for r in fake_maintenance_client.tables["entity_versions"] if r.get("entity_id") == "mr-1"]
        newest = max(ev_rows, key=lambda r: r.get("version_number", 0))
        assert newest["data"].get("status") == "completed"
        assert newest["data"].get("maintenance_type") == "full_service"
        assert newest["data"].get("internal_subtotal") == pytest.approx(240.0)

    def test_recompute_leaves_exactly_one_current_version(self, fake_maintenance_client):
        """Recomputing totals a second time must leave exactly one current version.

        Fails if compute_maintenance_work_order_totals does not retire the previous
        current version before inserting a new one (SCD2 invariant violation).
        """
        self._seed_lines(fake_maintenance_client)
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ev_rows = [r for r in fake_maintenance_client.tables["entity_versions"] if r.get("entity_id") == "mr-1"]
        current_rows = [r for r in ev_rows if r.get("is_current") is True]
        assert len(current_rows) == 1, (
            f"Expected exactly 1 current version but found {len(current_rows)}. "
            "compute_maintenance_work_order_totals must retire the previous current version."
        )

    def test_recompute_sets_valid_to_on_retired_version(self, fake_maintenance_client):
        """Superseded entity_versions rows must have a non-null valid_to.

        Fails if compute_maintenance_work_order_totals clears is_current without
        closing the validity window.  A retired row with valid_to=NULL breaks
        point-in-time history semantics and any query that treats
        valid_to IS NULL as an open-ended (current) version.
        """
        self._seed_lines(fake_maintenance_client)
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ops.compute_maintenance_work_order_totals("mr-1", [])
        ev_rows = [r for r in fake_maintenance_client.tables["entity_versions"] if r.get("entity_id") == "mr-1"]
        retired = [r for r in ev_rows if r.get("is_current") is False]
        assert len(retired) >= 1, "Expected at least one retired version after second recompute"
        for row in retired:
            assert row.get("valid_to") is not None, (
                f"Retired entity_versions row (version {row.get('version_number')}) has "
                "valid_to=NULL; the trg_entity_versions_scd2 trigger never closed the "
                "validity window because is_current was manually cleared before the insert."
            )


class TestCheckMaintenanceInvoiceExists:
    """check_maintenance_invoice_exists queries relationships_v2 for existing invoice."""

    def test_returns_not_exists_when_no_relationship(self, fake_maintenance_client):
        result = ops.check_maintenance_invoice_exists("mr-1")
        assert result["exists"] is False
        assert result["invoice_id"] is None

    def test_returns_exists_when_relationship_found(self, fake_maintenance_client):
        fake_maintenance_client.tables["relationships_v2"].append({
            "parent_id": "inv-123",
            "child_id": "mr-1",
            "relationship_type": "invoice:generated_from:maintenance_work_order",
            "is_current": True,
        })
        result = ops.check_maintenance_invoice_exists("mr-1")
        assert result["exists"] is True
        assert result["invoice_id"] == "inv-123"

    def test_does_not_return_invoice_for_different_work_order(self, fake_maintenance_client):
        fake_maintenance_client.tables["relationships_v2"].append({
            "parent_id": "inv-999",
            "child_id": "mr-OTHER",
            "relationship_type": "invoice:generated_from:maintenance_work_order",
            "is_current": True,
        })
        result = ops.check_maintenance_invoice_exists("mr-1")
        assert result["exists"] is False

    def test_does_not_return_stale_relationship(self, fake_maintenance_client):
        fake_maintenance_client.tables["relationships_v2"].append({
            "parent_id": "inv-old",
            "child_id": "mr-1",
            "relationship_type": "invoice:generated_from:maintenance_work_order",
            "is_current": False,
        })
        result = ops.check_maintenance_invoice_exists("mr-1")
        assert result["exists"] is False


class TestCreateMaintenanceInvoice:
    """create_maintenance_invoice persists entity, version, and relationship."""

    def _call(self, fake_maintenance_client, **kw):
        defaults = dict(
            maintenance_record_id="mr-1",
            billing_account_id="ba-1",
            sell_subtotal=320.0,
            tax_total=6.0,
            sell_total=326.0,
        )
        defaults.update(kw)
        return ops.create_maintenance_invoice(**defaults)

    def test_status_is_draft(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client)
        assert result["status"] == "draft"

    def test_deterministic_invoice_id(self, fake_maintenance_client):
        r1 = self._call(fake_maintenance_client)
        r2 = self._call(fake_maintenance_client)
        assert r1["invoice_id"] == r2["invoice_id"]

    def test_different_billing_account_different_id(self, fake_maintenance_client):
        r1 = self._call(fake_maintenance_client, billing_account_id="ba-1")
        r2 = self._call(fake_maintenance_client, billing_account_id="ba-2")
        assert r1["invoice_id"] != r2["invoice_id"]

    def test_returns_sell_totals(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, sell_subtotal=320.0, tax_total=6.0, sell_total=326.0)
        assert result["sell_subtotal"] == pytest.approx(320.0)
        assert result["tax_total"] == pytest.approx(6.0)
        assert result["sell_total"] == pytest.approx(326.0)

    def test_returns_maintenance_record_id(self, fake_maintenance_client):
        result = self._call(fake_maintenance_client, maintenance_record_id="mr-42")
        assert result["maintenance_record_id"] == "mr-42"

    # -- Persistence assertions --

    def test_creates_invoice_entity(self, fake_maintenance_client):
        """Fails if the activity never calls client.upsert on entities."""
        result = self._call(fake_maintenance_client)
        entities = fake_maintenance_client.tables["entities"]
        matching = [e for e in entities if e.get("id") == result["invoice_id"]]
        assert len(matching) == 1
        assert matching[0]["entity_type"] == "invoice"

    def test_creates_entity_version(self, fake_maintenance_client):
        """Fails if the activity never calls client.upsert on entity_versions."""
        result = self._call(fake_maintenance_client)
        versions = fake_maintenance_client.tables["entity_versions"]
        matching = [v for v in versions if v.get("entity_id") == result["invoice_id"]]
        assert len(matching) >= 1
        assert matching[0]["data"]["status"] == "draft"
        assert matching[0]["data"]["sell_total"] == pytest.approx(326.0)

    def test_creates_invoice_relationship(self, fake_maintenance_client):
        """Fails if the activity never persists the invoice→work-order relationship."""
        result = self._call(fake_maintenance_client)
        rels = fake_maintenance_client.tables["relationships_v2"]
        matching = [
            r for r in rels
            if r.get("relationship_type") == "invoice:generated_from:maintenance_work_order"
            and r.get("parent_id") == result["invoice_id"]
            and r.get("child_id") == "mr-1"
        ]
        assert len(matching) == 1

    def test_idempotent_does_not_duplicate_entity(self, fake_maintenance_client):
        """Two calls with the same inputs must produce exactly one entity row."""
        self._call(fake_maintenance_client)
        self._call(fake_maintenance_client)
        entities = fake_maintenance_client.tables["entities"]
        invoice_entities = [e for e in entities if e.get("entity_type") == "invoice"]
        assert len(invoice_entities) == 1

    def test_check_exists_finds_invoice_created_by_create(self, fake_maintenance_client):
        """End-to-end: create_maintenance_invoice then check_maintenance_invoice_exists returns True."""
        result = self._call(fake_maintenance_client)
        check = ops.check_maintenance_invoice_exists("mr-1")
        assert check["exists"] is True
        assert check["invoice_id"] == result["invoice_id"]


# ---------------------------------------------------------------------------
# Layer 4 – workflow regression tests
# ---------------------------------------------------------------------------


def _make_fake_unsafe() -> MagicMock:
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()
    return fake_unsafe


class TestMaintenanceCostingWorkflowLifecycle:
    """MaintenanceCostingWorkflow: happy path and edge cases."""

    @staticmethod
    async def _run_workflow(cost_lines: list, is_customer_billable: bool = False, billing_account_id=None):
        import temporalio.workflow as tw_mod

        call_log: list[str] = []

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            call_log.append(fn_name)
            if fn_name == "add_maintenance_cost_line":
                return {
                    "cost_line_id": f"cl-{len(call_log)}",
                    "maintenance_record_id": args[0],
                    "line_type": args[1],
                    "description": args[2],
                    "quantity": args[3],
                    "unit_cost": args[4],
                    "sell_amount": args[5],
                    "cost_total": args[3] * args[4],
                    "sell_line_total": args[3] * args[5],
                    "is_taxable": args[6] if len(args) > 6 else False,
                    "tax_rate": args[7] if len(args) > 7 else 0.0,
                    "tax_amount": 0.0,
                    "notes": None,
                }
            if fn_name == "compute_maintenance_work_order_totals":
                saved = args[1] if len(args) > 1 else []
                return {
                    "maintenance_record_id": args[0],
                    "cost_line_count": len(saved),
                    "internal_subtotal": sum(float(line.get("cost_total", 0)) for line in saved),
                    "sell_subtotal": sum(float(line.get("sell_line_total", 0)) for line in saved),
                    "tax_total": 0.0,
                    "sell_total": sum(float(line.get("sell_line_total", 0)) for line in saved),
                }
            return {}

        wf = MaintenanceCostingWorkflow()
        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            result = await wf.run(
                MaintenanceCostingRequest(
                    maintenance_record_id="mr-1",
                    cost_lines=cost_lines,
                    is_customer_billable=is_customer_billable,
                    billing_account_id=billing_account_id,
                )
            )
        return result, call_log

    @pytest.mark.asyncio
    async def test_saves_cost_lines_and_computes_totals(self):
        lines = [
            {"line_type": "labor", "description": "Tech work", "quantity": 2.0, "unit_cost": 75.0, "sell_amount": 100.0},
            {"line_type": "parts", "description": "Oil filter", "quantity": 1.0, "unit_cost": 20.0, "sell_amount": 30.0},
        ]
        result, call_log = await self._run_workflow(lines)
        assert result["maintenance_record_id"] == "mr-1"
        assert result["cost_line_count"] == 2
        # add_maintenance_cost_line called once per line
        assert call_log.count("add_maintenance_cost_line") == 2
        assert "compute_maintenance_work_order_totals" in call_log

    @pytest.mark.asyncio
    async def test_empty_lines_produces_zero_totals(self):
        result, _ = await self._run_workflow([])
        assert result["cost_line_count"] == 0
        assert result["internal_subtotal"] == 0.0
        assert result["sell_total"] == 0.0

    @pytest.mark.asyncio
    async def test_internal_only_work_order_sets_billing_flag_false(self):
        result, _ = await self._run_workflow([], is_customer_billable=False)
        assert result["is_customer_billable"] is False
        assert result["billing_account_id"] is None

    @pytest.mark.asyncio
    async def test_billable_work_order_passes_billing_context(self):
        result, _ = await self._run_workflow([], is_customer_billable=True, billing_account_id="ba-42")
        assert result["is_customer_billable"] is True
        assert result["billing_account_id"] == "ba-42"


class TestMaintenanceInvoiceWorkflowLifecycle:
    """MaintenanceInvoiceWorkflow: idempotency, blocked path, happy path."""

    @staticmethod
    async def _run_workflow(
        work_order_status: str = "completed",
        invoice_already_exists: bool = False,
        existing_invoice_id: str = "inv-existing",
    ):
        import temporalio.workflow as tw_mod

        async def fake_execute_activity(fn_or_str, *pos_args, **kw):
            fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
            args = kw.get("args", list(pos_args))
            if fn_name == "check_maintenance_invoice_exists":
                return {
                    "exists": invoice_already_exists,
                    "invoice_id": existing_invoice_id if invoice_already_exists else None,
                }
            if fn_name == "create_maintenance_invoice":
                return {
                    "invoice_id": "inv-new",
                    "maintenance_record_id": args[0],
                    "billing_account_id": args[1],
                    "status": "draft",
                    "sell_subtotal": args[2],
                    "tax_total": args[3],
                    "sell_total": args[4],
                }
            if fn_name == "create_relationship":
                return {"relationship_id": "rel-1"}
            return {}

        wf = MaintenanceInvoiceWorkflow()
        with (
            patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
            patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
            patch.object(tw_mod, "unsafe", _make_fake_unsafe()),
        ):
            result = await wf.run(
                MaintenanceInvoiceRequest(
                    maintenance_record_id="mr-1",
                    billing_account_id="ba-1",
                    work_order_status=work_order_status,
                    sell_subtotal=320.0,
                    tax_total=6.0,
                    sell_total=326.0,
                )
            )
        return result

    @pytest.mark.asyncio
    async def test_happy_path_generates_draft_invoice(self):
        result = await self._run_workflow("completed")
        assert result["invoice_id"] == "inv-new"
        assert result["status"] == "draft"
        assert result["blocked"] is False
        assert result["already_existed"] is False
        assert result["sell_total"] == pytest.approx(326.0)

    @pytest.mark.asyncio
    async def test_blocked_when_work_order_not_completed(self):
        result = await self._run_workflow("open")
        assert result["blocked"] is True
        assert result["invoice_id"] == ""
        assert "open" in (result["blocked_reason"] or "")

    @pytest.mark.asyncio
    async def test_blocked_when_work_order_draft(self):
        result = await self._run_workflow("draft")
        assert result["blocked"] is True

    @pytest.mark.asyncio
    async def test_approved_status_is_invoiceable(self):
        result = await self._run_workflow("approved")
        assert result["blocked"] is False
        assert result["invoice_id"] == "inv-new"

    @pytest.mark.asyncio
    async def test_idempotent_returns_existing_invoice(self):
        result = await self._run_workflow("completed", invoice_already_exists=True)
        assert result["invoice_id"] == "inv-existing"
        assert result["already_existed"] is True
        assert result["status"] == "existing"
        assert result["blocked"] is False

    @pytest.mark.asyncio
    async def test_idempotent_does_not_create_duplicate(self):
        """Running twice with pre-existing invoice must return existing, not new."""
        r1 = await self._run_workflow("completed", invoice_already_exists=True)
        r2 = await self._run_workflow("completed", invoice_already_exists=True)
        assert r1["invoice_id"] == r2["invoice_id"]
        assert r1["already_existed"] is True
        assert r2["already_existed"] is True
