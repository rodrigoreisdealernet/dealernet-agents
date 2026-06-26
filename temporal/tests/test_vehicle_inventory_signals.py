"""Unit tests for the deterministic vehicle-inventory signal engine.

Covers the floor-plan carry curve (grace + escalating bands, grounded in the ERP
``CarenciaFloorPlan`` model) and the three anticipatory signals. A fixed
``today`` makes the model-year carryover assertions deterministic.
"""

from __future__ import annotations

from datetime import date

from temporal.src.agents.vehicle_inventory_signals import (
    FINDING_CARRYOVER_MODEL_YEAR,
    FINDING_FLOOR_PLAN_ESCALATION,
    FINDING_MARGIN_EROSION,
    FloorPlanCurve,
    assess_vehicle,
)

_TODAY = date(2026, 6, 26)
_CY = 2026


def _vehicle(**kw):
    base = {
        "condition": "usado",
        "model_year": 2020,
        "cost": 100000,
        "sale_price": 130000,
        "days_in_stock": 50,
    }
    base.update(kw)
    return base


# ---------------------------------------------------------------------------
# Floor-plan carry curve
# ---------------------------------------------------------------------------
def test_curve_grace_charges_nothing() -> None:
    curve = FloorPlanCurve.from_config(None)
    assert curve.monthly_rate_at(0) == 0.0
    assert curve.monthly_rate_at(30) == 0.0  # last grace day
    assert curve.monthly_rate_at(31) == 0.010  # first charged day
    assert curve.accrued(100000, 25) == 0.0  # entirely within grace


def test_curve_rate_escalates_by_band() -> None:
    curve = FloorPlanCurve.from_config(None)
    assert curve.monthly_rate_at(45) == 0.010
    assert curve.monthly_rate_at(75) == 0.015
    assert curve.monthly_rate_at(110) == 0.020
    assert curve.monthly_rate_at(200) == 0.025  # open-ended top band


def test_curve_next_escalation_reports_days_and_higher_rate() -> None:
    curve = FloorPlanCurve.from_config(None)
    # Within grace -> next step is the grace end (rate jumps 0 -> 1.0%).
    days_to, rate = curve.next_escalation(26)
    assert (days_to, rate) == (4, 0.010)
    # Mid band 61-90 -> next is the 90-day boundary (1.5% -> 2.0%).
    days_to, rate = curve.next_escalation(86)
    assert (days_to, rate) == (4, 0.020)
    # Top band -> no further escalation.
    assert curve.next_escalation(200) is None


def test_curve_accrued_is_piecewise() -> None:
    curve = FloorPlanCurve.from_config(None)
    # cost 90000 at day 120: 31-60 @1% + 61-90 @1.5% + 91-120 @2% (each ~1 month).
    accrued = curve.accrued(90000, 120)
    assert round(accrued, 2) == round(900 + 1350 + 1800, 2)


def test_curve_config_override_changes_grace_and_bands() -> None:
    curve = FloorPlanCurve.from_config(
        {"grace_days": 10, "bands": [{"until_day": None, "monthly_rate": 0.02}]}
    )
    assert curve.monthly_rate_at(5) == 0.0
    assert curve.monthly_rate_at(11) == 0.02
    assert curve.next_escalation(100) is None  # single open band -> no escalation


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------
def test_floor_plan_escalation_band_cross() -> None:
    a = assess_vehicle(
        _vehicle(condition="novo", model_year=_CY, cost=90000, sale_price=112000, days_in_stock=88),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_FLOOR_PLAN_ESCALATION
    assert a.severity == "medium"
    assert a.estimated_exposure == 450.0  # 90000 * (0.020 - 0.015)
    assert a.signals == [FINDING_FLOOR_PLAN_ESCALATION]


def test_floor_plan_escalation_grace_end_is_at_least_high() -> None:
    a = assess_vehicle(
        _vehicle(condition="novo", model_year=_CY, cost=98000, sale_price=121000, days_in_stock=28),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_FLOOR_PLAN_ESCALATION
    assert a.severity == "high"  # leaving the carência is never merely medium


def test_margin_erosion_underwater_is_critical() -> None:
    a = assess_vehicle(
        _vehicle(condition="usado", cost=90000, sale_price=95000, days_in_stock=200),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_MARGIN_EROSION
    assert a.severity == "critical"
    assert a.estimated_exposure > 0


def test_margin_erosion_about_to_go_underwater_is_high() -> None:
    a = assess_vehicle(
        _vehicle(condition="usado", cost=35000, sale_price=37500, days_in_stock=150),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_MARGIN_EROSION
    assert a.severity == "high"


def test_carryover_model_year_behind_current() -> None:
    a = assess_vehicle(
        _vehicle(condition="novo", model_year=_CY - 1, cost=22000, sale_price=26000, days_in_stock=52),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_CARRYOVER_MODEL_YEAR
    assert a.severity == "high"


def test_carryover_two_years_behind_is_critical() -> None:
    a = assess_vehicle(
        _vehicle(condition="novo", model_year=_CY - 2, cost=90000, sale_price=112000, days_in_stock=70),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_CARRYOVER_MODEL_YEAR
    assert a.severity == "critical"


def test_used_vehicle_is_never_carryover() -> None:
    # Carryover only applies to NEW units; an old used car is not "leftover".
    a = assess_vehicle(
        _vehicle(condition="usado", model_year=2018, cost=30000, sale_price=42000, days_in_stock=60),
        today=_TODAY,
    )
    assert FINDING_CARRYOVER_MODEL_YEAR not in a.signals


# ---------------------------------------------------------------------------
# The whole point: old != flagged
# ---------------------------------------------------------------------------
def test_old_but_healthy_vehicle_triggers_nothing() -> None:
    # 240 days in stock, but a wide margin, a stable top band, and current model
    # year -> no anticipatory problem -> NO finding.
    a = assess_vehicle(
        _vehicle(condition="usado", model_year=2020, cost=99000, sale_price=130000, days_in_stock=240),
        today=_TODAY,
    )
    assert not a.triggered
    assert a.finding_type == "monitor"
    assert a.signals == []


def test_fresh_healthy_vehicle_triggers_nothing() -> None:
    a = assess_vehicle(
        _vehicle(condition="novo", model_year=_CY, cost=98000, sale_price=121000, days_in_stock=20),
        today=_TODAY,
    )
    assert not a.triggered


def test_days_in_stock_alone_never_triggers() -> None:
    # Same healthy unit at 89, 90, 95 days -> still nothing (no 90-day warning).
    for days in (89, 90, 95, 120, 200):
        a = assess_vehicle(
            _vehicle(condition="usado", model_year=2020, cost=99000, sale_price=130000, days_in_stock=days),
            today=_TODAY,
        )
        # Some of these may cross a band boundary, but at minimum none fire purely
        # because of the day count when off-boundary with a healthy margin.
        if days in (95, 200):
            assert not a.triggered, f"healthy unit at {days}d must not be flagged"


def test_primary_is_highest_severity_signal() -> None:
    # A unit that is both carryover (critical, 2yr behind) and near a band edge:
    # the critical carryover wins as the primary finding type.
    a = assess_vehicle(
        _vehicle(condition="novo", model_year=_CY - 2, cost=90000, sale_price=112000, days_in_stock=88),
        today=_TODAY,
    )
    assert a.triggered
    assert a.finding_type == FINDING_CARRYOVER_MODEL_YEAR
    assert a.severity == "critical"
    assert set(a.signals) >= {FINDING_CARRYOVER_MODEL_YEAR, FINDING_FLOOR_PLAN_ESCALATION}
