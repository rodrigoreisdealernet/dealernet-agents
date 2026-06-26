"""Regression tests for DIA predictive horizon fields (issue #127)."""

from __future__ import annotations

import datetime as dt
import hashlib

from temporal.src.activities.ops_collections import (
    _collections_days_to_breach,
    _collections_finding_for_storage,
    _collections_fingerprint,
    _collections_predicted_breach_at,
)
from temporal.src.activities.ops_parts_inventory import (
    _parts_days_to_breach,
    _parts_finding_for_storage,
    _parts_fingerprint,
    _parts_predicted_breach_at,
)
from temporal.src.activities.ops_service_estimate import (
    _estimate_fingerprint,
    _service_estimate_days_to_breach,
    _service_estimate_finding_for_storage,
    _service_estimate_predicted_breach_at,
)
from temporal.src.activities.ops_vehicle_aging import (
    _finding_fingerprint,
    _max_severity,
    _vehicle_days_to_breach,
    _vehicle_finding_for_storage,
    _vehicle_horizon_severity,
    _vehicle_predicted_breach_at,
)
from temporal.src.agents.vehicle_inventory_signals import FINDING_FLOOR_PLAN_ESCALATION

_TENANT = "tenant-a"
_TODAY = dt.date(2026, 6, 26)


def test_ac2_vehicle_horizon_boundaries_and_existing_severity_tiers() -> None:
    """AC2: 75/88 stock-day boundaries project 15/2 days and map to existing tiers."""
    assert _vehicle_days_to_breach(75) == 15
    assert _vehicle_days_to_breach(88) == 2

    # The implementation preserves the supported medium/high/critical taxonomy:
    # AC2's literal "attention" maps to the existing medium floor-plan tier.
    assert _vehicle_horizon_severity(15) == "medium"
    assert _vehicle_horizon_severity(2) == "high"
    assert _max_severity("medium", _vehicle_horizon_severity(15)) == "medium"
    assert _max_severity("medium", _vehicle_horizon_severity(2)) == "high"


def test_ac2_vehicle_predicted_breach_at_from_purchase_date_and_today_fallback() -> None:
    """AC2: vehicle breach date is purchase date + 90d, or derived from today - age."""
    assert _vehicle_predicted_breach_at("2026-01-01", 75) == "2026-04-01T00:00:00Z"
    assert (
        _vehicle_predicted_breach_at(None, 75, today=dt.date(2026, 4, 15))
        == "2026-04-30T00:00:00Z"
    )


def test_ac1_every_agent_projects_a_non_null_horizon_when_inputs_exist() -> None:
    """AC1: all four DIA agents expose deterministic horizons from existing fields."""
    assert _vehicle_days_to_breach(75) == 15
    assert _vehicle_predicted_breach_at("2026-01-01", 75) == "2026-04-01T00:00:00Z"

    collections_days = _collections_days_to_breach(45)
    assert collections_days == 15
    assert _collections_predicted_breach_at(collections_days, today=_TODAY) == "2026-07-11T00:00:00Z"

    parts_days = _parts_days_to_breach(12, 3)
    assert parts_days == 4
    assert _parts_predicted_breach_at(parts_days, today=_TODAY) == "2026-06-30T00:00:00Z"

    service_date = _service_estimate_predicted_breach_at({"valid_until": "2026-07-01"})
    assert service_date == "2026-07-01T00:00:00Z"
    assert _service_estimate_days_to_breach(service_date, today=_TODAY) == 5


def test_ac3_collections_band_crossing_math_is_deterministic() -> None:
    """AC3: collections horizon is the next 30/60/90-day band crossing."""
    assert _collections_days_to_breach(0) == 30
    assert _collections_days_to_breach(29) == 1
    assert _collections_days_to_breach(30) == 30
    assert _collections_days_to_breach(59) == 1
    assert _collections_days_to_breach(60) == 30
    assert _collections_days_to_breach(89) == 1
    assert _collections_days_to_breach(90) is None
    assert _collections_predicted_breach_at(1, today=_TODAY) == "2026-06-27T00:00:00Z"


def test_ac3_parts_days_to_stockout_math_uses_ceiling_and_no_demand_null() -> None:
    """AC3/AC4: parts stockout horizon is ceil(on_hand / average daily demand)."""
    assert _parts_days_to_breach(10, 2.5) == 4
    assert _parts_days_to_breach(10, 3) == 4
    assert _parts_days_to_breach(0, 3) == 0
    assert _parts_days_to_breach(10, 0) is None
    assert _parts_days_to_breach(10, None) is None


def test_ac4_missing_projection_inputs_return_null_horizons() -> None:
    """AC4: absent projection data yields null horizons instead of fabricated dates."""
    assert _vehicle_days_to_breach("") is None
    assert _vehicle_predicted_breach_at(None, "") is None
    assert _collections_days_to_breach(None) is None
    assert _collections_predicted_breach_at(None) is None
    assert _parts_days_to_breach(5, 0) is None
    assert _parts_predicted_breach_at(None) is None
    assert _service_estimate_predicted_breach_at({}) is None
    assert _service_estimate_days_to_breach(None) is None


def test_ac4_finding_storage_keeps_types_fingerprints_and_adds_horizon_payloads() -> None:
    """AC4: jsonb payload is additive and dedupe/finding_type inputs are unchanged."""
    vehicle_fingerprint = _finding_fingerprint(_TENANT, "veh-1", FINDING_FLOOR_PLAN_ESCALATION)
    vehicle_row = _vehicle_finding_for_storage(
        {
            "vehicle_id": "veh-1",
            "tenant_id": _TENANT,
            "finding_type": FINDING_FLOOR_PLAN_ESCALATION,
            "severity": "medium",
            "estimated_exposure": 100.0,
            "recommended_action": "markdown",
            "fingerprint": vehicle_fingerprint,
            "days_in_stock": 88,
            "predicted_breach_at": "2026-06-28T00:00:00Z",
            "days_to_breach": 2,
        }
    )
    assert vehicle_row["finding_type"] == FINDING_FLOOR_PLAN_ESCALATION
    assert vehicle_row["fingerprint"] == vehicle_fingerprint
    assert vehicle_row["expected"]["days_to_breach"] == 2
    assert vehicle_row["expected"]["predicted_breach_at"] == "2026-06-28T00:00:00Z"
    assert vehicle_fingerprint == hashlib.sha256(
        f"{_TENANT}:veh-1:{FINDING_FLOOR_PLAN_ESCALATION}".encode()
    ).hexdigest()

    collections_fingerprint = _collections_fingerprint(_TENANT, "cust-1")
    collections_row = _collections_finding_for_storage(
        {
            "customer_id": "cust-1",
            "tenant_id": _TENANT,
            "finding_type": "collections_priority",
            "severity": "high",
            "total_exposure": 900.0,
            "days_overdue": 59,
            "recommended_action": "call",
            "fingerprint": collections_fingerprint,
            "days_to_breach": 1,
            "predicted_breach_at": "2026-06-27T00:00:00Z",
        }
    )
    assert collections_row["finding_type"] == "collections_priority"
    assert collections_row["fingerprint"] == collections_fingerprint
    assert collections_row["expected"]["days_to_breach"] == 1
    assert collections_fingerprint == hashlib.sha256(
        f"{_TENANT}:cust-1:collections_priority".encode()
    ).hexdigest()

    parts_fingerprint = _parts_fingerprint(_TENANT, "part-1", "replenish_now")
    parts_row = _parts_finding_for_storage(
        {
            "part_id": "part-1",
            "tenant_id": _TENANT,
            "finding_type": "replenish_now",
            "severity": "medium",
            "value_at_risk": 40.0,
            "recommended_action": "order_now",
            "fingerprint": parts_fingerprint,
            "days_to_breach": 4,
            "predicted_breach_at": "2026-06-30T00:00:00Z",
        }
    )
    assert parts_row["finding_type"] == "replenish_now"
    assert parts_row["fingerprint"] == parts_fingerprint
    assert parts_row["expected"]["days_to_breach"] == 4
    assert parts_fingerprint == hashlib.sha256(f"{_TENANT}:part-1:replenish_now".encode()).hexdigest()

    estimate_fingerprint = _estimate_fingerprint(_TENANT, "est-1")
    estimate_row = _service_estimate_finding_for_storage(
        {
            "estimate_id": "est-1",
            "os_id": "os-1",
            "tenant_id": _TENANT,
            "finding_type": "estimate_rescue",
            "severity": "high",
            "recoverable_value": 8000.0,
            "recommended_action": "contact_customer",
            "fingerprint": estimate_fingerprint,
            "days_to_breach": 5,
            "predicted_breach_at": "2026-07-01T00:00:00Z",
        }
    )
    assert estimate_row["finding_type"] == "estimate_rescue"
    assert estimate_row["fingerprint"] == estimate_fingerprint
    assert estimate_row["expected"]["days_to_breach"] == 5
    assert estimate_fingerprint == hashlib.sha256(f"{_TENANT}:est-1:estimate_rescue".encode()).hexdigest()
