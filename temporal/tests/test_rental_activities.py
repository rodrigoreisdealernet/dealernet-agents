"""Unit tests for rental activities.

Activities are tested directly (no Temporal sandbox required) because they
are plain async/sync functions decorated with @activity.defn.  We call them
as regular functions after stripping the decorator at import time.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import rental_operations
from temporal.src.activities.rental import (
    assign_asset_to_order_line,
    checkout_contract_line,
    convert_order_to_contract,
    create_rental_order,
    get_asset_availability,
    return_contract_line,
    transition_contract_status,
    transition_order_status,
)
from temporal.src.activities.rental_operations import (
    complete_maintenance_record,
    create_inspection_record,
    create_invoice_record,
    create_maintenance_record,
    create_transfer_record,
    record_asset_downtime,
    record_maintenance_completion_event,
    resolve_asset_maintenance_completion_status,
)
from temporal.src.models.rental import (
    AssetAvailabilityStatus,
    AssignAssetInput,
    CheckoutLineInput,
    ContractStatus,
    ConvertOrderInput,
    CreateRentalOrderInput,
    LineStatus,
    OrderStatus,
    RateType,
    RentalLineInput,
    RentalType,
    ReturnLineInput,
    TransitionOrderInput,
)


class _FakeRentalOperationsPersistenceClient:
    """In-memory rental operations persistence double for direct activity tests."""

    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "fact_types": [
                {
                    "id": "fact-asset-downtime",
                    "key": "asset_downtime",
                    "label": "Asset Downtime",
                    "description": "Duration asset was unavailable due to maintenance",
                    "unit": "minutes",
                }
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
        self.tables.setdefault(resource, []).append(row)
        return row

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        conflict_keys = [part.strip() for part in on_conflict.split(",")]
        row = dict(payload)
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(existing.get(key) == row.get(key) for key in conflict_keys):
                merged = {**existing, **row}
                table[idx] = merged
                return merged
        row.setdefault("id", str(uuid4()))
        table.append(row)
        return row

    def rpc(self, function_name: str, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        if function_name != "rental_upsert_entity_current_state":
            raise AssertionError(f"unexpected rpc {function_name}")
        entity_id = str(payload["p_entity_id"])
        entity_type = str(payload["p_entity_type"])
        data = dict(payload["p_data"])
        table = self.tables["rental_current_entity_state"]
        for idx, row in enumerate(table):
            if row.get("entity_id") == entity_id and row.get("entity_type") == entity_type:
                version_number = int(row.get("version_number", 0)) + 1
                updated = {**row, "data": data, "version_number": version_number}
                table[idx] = updated
                entity_version_id = f"version-{version_number}"
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


@pytest.fixture()
def fake_rental_operations_client(monkeypatch: pytest.MonkeyPatch) -> _FakeRentalOperationsPersistenceClient:
    client = _FakeRentalOperationsPersistenceClient()
    monkeypatch.setattr(rental_operations, "_rental_ops_client", client)
    monkeypatch.setattr(rental_operations, "_fact_type_id_cache", {})
    return client


# ---------------------------------------------------------------------------
# create_rental_order
# ---------------------------------------------------------------------------

class TestCreateRentalOrder:
    def test_returns_draft_status(self):
        inp = CreateRentalOrderInput(
            requester_id="user-1",
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
        result = create_rental_order(inp)
        assert result.status == OrderStatus.DRAFT
        assert result.success is True
        assert result.order_entity_id  # non-empty UUID string

    def test_multiple_lines(self):
        lines = [
            RentalLineInput(
                category_id=f"cat-{i}",
                quantity=1,
                planned_start="2025-02-01T08:00:00Z",
                planned_end="2025-02-10T18:00:00Z",
                rate_type=RateType.DAILY,
                rate_amount=8000,
                rental_type=RentalType.INTERNAL,
            )
            for i in range(3)
        ]
        inp = CreateRentalOrderInput(requester_id="user-2", rental_type=RentalType.INTERNAL, lines=lines)
        result = create_rental_order(inp)
        assert result.status == OrderStatus.DRAFT

    def test_internal_rental_type(self):
        inp = CreateRentalOrderInput(
            requester_id="user-3",
            rental_type=RentalType.INTERNAL,
            lines=[],
        )
        result = create_rental_order(inp)
        assert result.success is True


# ---------------------------------------------------------------------------
# transition_order_status
# ---------------------------------------------------------------------------

class TestTransitionOrderStatus:
    def test_draft_to_quoted_allowed(self):
        """The stub always starts from draft; draft→quoted is valid."""
        inp = TransitionOrderInput(
            order_entity_id="order-abc",
            new_status=OrderStatus.QUOTED,
            actor_id="admin",
        )
        result = transition_order_status(inp)
        assert result.status == OrderStatus.QUOTED
        assert result.success is True

    def test_draft_to_approved_allowed_in_stub(self):
        inp = TransitionOrderInput(
            order_entity_id="order-abc",
            new_status=OrderStatus.APPROVED,
        )
        result = transition_order_status(inp)
        assert result.status == OrderStatus.APPROVED

    def test_draft_to_cancelled_allowed(self):
        inp = TransitionOrderInput(
            order_entity_id="order-abc",
            new_status=OrderStatus.CANCELLED,
        )
        result = transition_order_status(inp)
        assert result.status == OrderStatus.CANCELLED


class TestTransitionContractStatus:
    def test_pending_execution_to_active_allowed_in_stub(self):
        result = transition_contract_status("contract-abc", ContractStatus.ACTIVE, actor_id="operator")
        assert result.status == ContractStatus.ACTIVE

    def test_active_to_closed_allowed_in_stub(self):
        result = transition_contract_status("contract-abc", ContractStatus.CLOSED)
        assert result.status == ContractStatus.CLOSED


# ---------------------------------------------------------------------------
# assign_asset_to_order_line
# ---------------------------------------------------------------------------

class TestAssignAssetToOrderLine:
    def test_returns_pending_status(self):
        inp = AssignAssetInput(
            order_line_entity_id="line-1",
            asset_id="asset-excavator-007",
            actor_id="planner",
        )
        result = assign_asset_to_order_line(inp)
        assert result.line_entity_id == "line-1"
        assert result.status == LineStatus.PENDING
        assert result.success is True


# ---------------------------------------------------------------------------
# convert_order_to_contract
# ---------------------------------------------------------------------------

class TestConvertOrderToContract:
    def test_returns_pending_execution_status(self):
        inp = ConvertOrderInput(order_entity_id="order-xyz", actor_id="manager")
        result = convert_order_to_contract(inp)
        assert result.status == ContractStatus.PENDING_EXECUTION
        assert result.order_entity_id == "order-xyz"
        assert result.success is True
        assert result.contract_entity_id  # non-empty


# ---------------------------------------------------------------------------
# get_asset_availability
# ---------------------------------------------------------------------------

class TestGetAssetAvailability:
    def test_default_stub_returns_available(self):
        result = get_asset_availability("asset-001")
        assert result["availability_status"] == AssetAvailabilityStatus.AVAILABLE
        assert result["blocks_checkout"] is False

    def test_asset_id_preserved(self):
        result = get_asset_availability("asset-xyz")
        assert result["asset_id"] == "asset-xyz"


# ---------------------------------------------------------------------------
# checkout_contract_line
# ---------------------------------------------------------------------------

class TestCheckoutContractLine:
    def test_returns_checked_out_status(self):
        inp = CheckoutLineInput(
            contract_line_entity_id="cline-1",
            actual_start="2025-01-01T08:00:00Z",
            actor_id="operator",
        )
        result = checkout_contract_line(inp)
        assert result.status == LineStatus.CHECKED_OUT
        assert result.success is True
        assert result.block_reason is None


# ---------------------------------------------------------------------------
# return_contract_line
# ---------------------------------------------------------------------------

class TestReturnContractLine:
    def test_returns_returned_status(self):
        inp = ReturnLineInput(
            contract_line_entity_id="cline-1",
            actual_end="2025-01-07T18:00:00Z",
            actor_id="operator",
        )
        result = return_contract_line(inp)
        assert result.status == LineStatus.RETURNED
        assert result.success is True

    def test_historical_line_entity_id_preserved(self):
        """The line entity ID must be preserved so the SCD2 history is traceable."""
        inp = ReturnLineInput(
            contract_line_entity_id="cline-historical",
            actual_end="2025-03-15T12:00:00Z",
        )
        result = return_contract_line(inp)
        assert result.line_entity_id == "cline-historical"


# ---------------------------------------------------------------------------
# Idempotency: same inputs → same entity IDs
# ---------------------------------------------------------------------------

class TestIdempotentEntityIds:
    """Create activities must derive stable IDs from their natural keys so that
    Temporal retries do not mint duplicate rows in production (ADR-0003)."""

    def test_create_rental_order_is_idempotent_with_explicit_key(self):
        """When an idempotency_key is supplied, repeated calls produce the same order ID."""
        inp = CreateRentalOrderInput(
            requester_id="user-1",
            rental_type=RentalType.EXTERNAL,
            lines=[],
            idempotency_key="workflow-stable-id",
        )
        result_a = create_rental_order(inp)
        result_b = create_rental_order(inp)
        assert result_a.order_entity_id == result_b.order_entity_id, (
            "Repeated create_rental_order with the same idempotency_key must produce the same order_entity_id"
        )

    def test_create_rental_order_different_keys_differ(self):
        """Different idempotency keys must not collide."""
        inp_a = CreateRentalOrderInput(requester_id="u", rental_type=RentalType.EXTERNAL, lines=[], idempotency_key="wf-1")
        inp_b = CreateRentalOrderInput(requester_id="u", rental_type=RentalType.EXTERNAL, lines=[], idempotency_key="wf-2")
        assert create_rental_order(inp_a).order_entity_id != create_rental_order(inp_b).order_entity_id

    def test_convert_order_to_contract_is_idempotent(self):
        """The contract ID is derived deterministically from the order entity ID."""
        inp = ConvertOrderInput(order_entity_id="order-stable-key", actor_id="manager")
        result_a = convert_order_to_contract(inp)
        result_b = convert_order_to_contract(inp)
        assert result_a.contract_entity_id == result_b.contract_entity_id, (
            "Repeated convert_order_to_contract calls must produce the same contract_entity_id"
        )

    def test_create_transfer_record_is_idempotent(self):
        """The transfer ID is derived from the asset + branch pair + requester."""
        result_a = create_transfer_record(
            "asset-1",
            "branch-orig",
            "branch-dest",
            "user-1",
            "2026-06-20",
            "2026-06-21",
            "Excavator 100",
            425.0,
            "finding-1",
            "Awaiting trailer",
        )
        result_b = create_transfer_record(
            "asset-1",
            "branch-orig",
            "branch-dest",
            "user-1",
            "2026-06-20",
            "2026-06-21",
            "Excavator 100",
            425.0,
            "finding-1",
            "Awaiting trailer",
        )
        assert result_a["transfer_id"] == result_b["transfer_id"], (
            "Repeated create_transfer_record calls with the same args must produce the same transfer_id"
        )
        assert result_a["status"] == "requested"
        assert result_a["asset_scope"] == "Excavator 100"
        assert result_a["internal_cost"] == 425.0
        assert result_a["sourcing_decision_id"] == "finding-1"

    def test_create_transfer_record_different_args_differ(self):
        """Different natural keys must not collide."""
        result_a = create_transfer_record("asset-1", "branch-A", "branch-B", "user-1")
        result_b = create_transfer_record("asset-2", "branch-A", "branch-B", "user-1")
        assert result_a["transfer_id"] != result_b["transfer_id"]

    def test_create_inspection_record_is_idempotent(self):
        result_a = create_inspection_record("asset-1", "checkout", "inspector-1")
        result_b = create_inspection_record("asset-1", "checkout", "inspector-1")
        assert result_a["inspection_id"] == result_b["inspection_id"], (
            "Repeated create_inspection_record calls must produce the same inspection_id"
        )

    def test_create_maintenance_record_is_idempotent(self):
        result_a = create_maintenance_record("asset-1", "preventive", "tech-1")
        result_b = create_maintenance_record("asset-1", "preventive", "tech-1")
        assert result_a["maintenance_record_id"] == result_b["maintenance_record_id"], (
            "Repeated create_maintenance_record calls must produce the same maintenance_record_id"
        )

    def test_create_invoice_record_is_idempotent(self):
        result_a = create_invoice_record("contract-1", "2025-01-01", "2025-01-31", "user-1")
        result_b = create_invoice_record("contract-1", "2025-01-01", "2025-01-31", "user-1")
        assert result_a["invoice_id"] == result_b["invoice_id"], (
            "Repeated create_invoice_record calls must produce the same invoice_id"
        )

    def test_create_invoice_record_different_periods_differ(self):
        result_a = create_invoice_record("contract-1", "2025-01-01", "2025-01-31", "user-1")
        result_b = create_invoice_record("contract-1", "2025-02-01", "2025-02-28", "user-1")
        assert result_a["invoice_id"] != result_b["invoice_id"]


class TestMaintenanceCompletionActivities:
    def test_complete_maintenance_record_persists_completion_state(
        self,
        fake_rental_operations_client: _FakeRentalOperationsPersistenceClient,
    ):
        fake_rental_operations_client.tables["rental_current_entity_state"] = [
            {
                "entity_id": "maint-1",
                "entity_type": "maintenance_record",
                "version_number": 1,
                "name": "Maintenance 1",
                "data": {
                    "status": "open",
                    "maintenance_type": "corrective",
                    "opened_at": "2026-06-01T08:00:00Z",
                },
            }
        ]
        fake_rental_operations_client.tables["rental_current_relationships"] = [
            {
                "relationship_id": "rel-1",
                "relationship_type": "asset_has_maintenance_record",
                "parent_id": "asset-1",
                "child_id": "maint-1",
                "child_entity_type": "maintenance_record",
            }
        ]

        result = complete_maintenance_record(
            "maint-1",
            "asset-1",
            "tech-7",
            "returned_to_service",
            "2026-06-01T10:30:00",
            "replaced hose",
            "Labor $180 · Parts $95 · Total $275",
        )

        assert result["status"] == "completed"
        assert result["outcome"] == "returned_to_service"
        assert result["cost_summary"] == "Labor $180 · Parts $95 · Total $275"
        persisted = fake_rental_operations_client.tables["rental_current_entity_state"][0]
        assert persisted["version_number"] == 2
        assert persisted["data"]["status"] == "completed"
        assert persisted["data"]["completed_at"] == "2026-06-01T10:30:00"
        assert persisted["data"]["resolution_notes"] == "replaced hose"
        assert persisted["data"]["cost_summary"] == "Labor $180 · Parts $95 · Total $275"
        assert len(fake_rental_operations_client.tables["entity_versions"]) == 1

    def test_resolve_asset_maintenance_completion_status_defaults_to_available(
        self,
        fake_rental_operations_client: _FakeRentalOperationsPersistenceClient,
    ):
        fake_rental_operations_client.tables["rental_current_entity_state"] = [
            {
                "entity_id": "asset-1",
                "entity_type": "asset",
                "version_number": 3,
                "name": "Asset 1",
                "data": {"status": "maintenance", "operational_status": "maintenance"},
            },
            {
                "entity_id": "maint-1",
                "entity_type": "maintenance_record",
                "version_number": 2,
                "name": "Maintenance 1",
                "data": {"status": "completed"},
            },
        ]
        fake_rental_operations_client.tables["rental_current_relationships"] = [
            {
                "relationship_id": "rel-1",
                "relationship_type": "asset_has_maintenance_record",
                "parent_id": "asset-1",
                "child_id": "maint-1",
                "child_entity_type": "maintenance_record",
            }
        ]

        result = resolve_asset_maintenance_completion_status("asset-1")
        assert result["status"] == "available"
        assert result["restore_to_available"] is True

    def test_resolve_asset_maintenance_completion_status_keeps_other_open_hold(
        self,
        fake_rental_operations_client: _FakeRentalOperationsPersistenceClient,
    ):
        fake_rental_operations_client.tables["rental_current_entity_state"] = [
            {
                "entity_id": "asset-1",
                "entity_type": "asset",
                "version_number": 3,
                "name": "Asset 1",
                "data": {"status": "maintenance"},
            },
            {
                "entity_id": "maint-1",
                "entity_type": "maintenance_record",
                "version_number": 2,
                "name": "Maintenance 1",
                "data": {"status": "completed"},
            },
            {
                "entity_id": "maint-2",
                "entity_type": "maintenance_record",
                "version_number": 1,
                "name": "Maintenance 2",
                "data": {"status": "open"},
            },
        ]
        fake_rental_operations_client.tables["rental_current_relationships"] = [
            {
                "relationship_id": "rel-1",
                "relationship_type": "asset_has_maintenance_record",
                "parent_id": "asset-1",
                "child_id": "maint-1",
                "child_entity_type": "maintenance_record",
            },
            {
                "relationship_id": "rel-2",
                "relationship_type": "asset_has_maintenance_record",
                "parent_id": "asset-1",
                "child_id": "maint-2",
                "child_entity_type": "maintenance_record",
            },
        ]

        result = resolve_asset_maintenance_completion_status("asset-1")
        assert result["status"] == "maintenance"
        assert result["restore_to_available"] is False
        assert result["blocking_reason"] == "open maintenance record maint-2"

    def test_record_asset_downtime_persists_time_series_point(
        self,
        fake_rental_operations_client: _FakeRentalOperationsPersistenceClient,
    ):
        assert record_asset_downtime(
            "asset-1",
            "maint-1",
            45.0,
            "2026-06-01T09:45:00Z",
            "2026-06-01T10:30:00Z",
            "maintenance",
            None,
        )
        persisted = fake_rental_operations_client.tables["time_series_points"][0]
        assert persisted["entity_id"] == "asset-1"
        assert persisted["data_payload"]["maintenance_record_id"] == "maint-1"
        assert persisted["data_payload"]["downtime_minutes"] == 45.0
        assert persisted["metadata"]["source"] == "maintenance"

    def test_record_maintenance_completion_event_persists_service_event(
        self,
        fake_rental_operations_client: _FakeRentalOperationsPersistenceClient,
    ):
        assert record_maintenance_completion_event(
            "asset-1",
            "maint-1",
            "2026-06-01T10:30:00",
            "returned_to_service",
            45.0,
            "available",
        ) is True
        assert any(
            row["key"] == "maintenance_completion_event"
            for row in fake_rental_operations_client.tables["fact_types"]
        )
        persisted = fake_rental_operations_client.tables["time_series_points"][0]
        assert persisted["observed_at"] == "2026-06-01T10:30:00"
        assert persisted["data_payload"]["event_type"] == "maintenance_completed"
        assert persisted["data_payload"]["maintenance_record_id"] == "maint-1"
        assert persisted["data_payload"]["final_asset_status"] == "available"
