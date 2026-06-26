"""Deterministic vehicle-inventory risk signals (anticipatory stock analysis).

The Vehicle Stock-Aging Analyst no longer fires on a naive "90 days in stock"
threshold (everyone at the dealership already knows how long a unit has sat).
Instead it anticipates *real, non-obvious* inventory problems, the biggest of
which is **floor plan** (inventory financing).

Grounded in the DealerNet ERP (GeneXus KB ``CarenciaFloorPlan``): the floor-plan
percentage charged on a vehicle is **not linear** — it escalates by day band,
after an initial grace period (carência). What matters is the *transition*
between bands: when the grace period ends, or the unit crosses into a higher
percentage band, the monthly carrying cost jumps. This module models that curve
and derives anticipatory signals from it.

Everything here is pure and deterministic so the finding's type, severity and
money exposure never depend on free-form model output (the LLM only prioritizes,
recommends a reviewable action, and explains).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

# ---------------------------------------------------------------------------
# Finding types (one per anticipatory signal). These replace the legacy
# ``stock_aging_90d`` day-threshold finding.
# ---------------------------------------------------------------------------
FINDING_FLOOR_PLAN_ESCALATION = "floor_plan_band_escalation"
FINDING_MARGIN_EROSION = "margin_erosion"
FINDING_CARRYOVER_MODEL_YEAR = "carryover_model_year"

# Fixed tie-break priority when several signals share the top severity.
SIGNAL_PRIORITY = (
    FINDING_FLOOR_PLAN_ESCALATION,
    FINDING_MARGIN_EROSION,
    FINDING_CARRYOVER_MODEL_YEAR,
)

_SEVERITY_RANK = {"medium": 1, "high": 2, "critical": 3}

# ERP-grounded defaults for the floor-plan carry curve (overridable via
# ``thresholds.floor_plan``). ``monthly_rate`` is the financing cost per 30 days
# as a fraction of vehicle cost; ``until_day`` is the inclusive upper bound of
# the band (``None`` = open-ended top band).
_DEFAULT_FLOOR_PLAN = {
    "grace_days": 30,
    "bands": [
        {"until_day": 60, "monthly_rate": 0.010},
        {"until_day": 90, "monthly_rate": 0.015},
        {"until_day": 120, "monthly_rate": 0.020},
        {"until_day": None, "monthly_rate": 0.025},
    ],
    "escalation_window_days": 7,
}

# Money thresholds (BRL) for floor-plan escalation severity (monthly carry jump).
_DEFAULT_ESCALATION_HIGH_BRL = 800.0
_DEFAULT_ESCALATION_CRITICAL_BRL = 1500.0

# Margin-erosion: fraction of gross margin the accrued floor plan may consume
# before the unit is flagged, plus the look-ahead window for "about to go
# underwater".
_DEFAULT_MARGIN_FLOOR_PCT = 0.50
_DEFAULT_MARGIN_LOOKAHEAD_DAYS = 30

# Carryover: a NEW unit whose model_year is behind the current calendar year and
# has sat at least this many days is leftover/obsolescing stock.
_DEFAULT_CARRYOVER_MIN_DAYS = 45


def _coerce_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------------------
# Floor-plan carry curve
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _Band:
    until_day: int | None
    monthly_rate: float


@dataclass(frozen=True)
class FloorPlanCurve:
    """A grace period followed by ordered, escalating day-bands.

    ``grace_days`` charge nothing (carência). After that, the band whose
    ``until_day`` first covers ``days`` applies; the last band (``until_day``
    ``None``) is open-ended.
    """

    grace_days: int
    bands: tuple[_Band, ...]
    escalation_window_days: int

    @classmethod
    def from_config(cls, config: Mapping[str, Any] | None) -> FloorPlanCurve:
        cfg = dict(_DEFAULT_FLOOR_PLAN)
        if isinstance(config, Mapping):
            cfg.update({k: v for k, v in config.items() if v is not None or k == "bands"})
        raw_bands = cfg.get("bands") or _DEFAULT_FLOOR_PLAN["bands"]
        bands: list[_Band] = []
        for entry in raw_bands:
            if not isinstance(entry, Mapping):
                continue
            until = entry.get("until_day")
            bands.append(
                _Band(
                    until_day=None if until is None else _coerce_int(until),
                    monthly_rate=max(0.0, _coerce_float(entry.get("monthly_rate"))),
                )
            )
        if not bands:
            bands = [_Band(None, _DEFAULT_FLOOR_PLAN["bands"][-1]["monthly_rate"])]
        grace = max(0, _coerce_int(cfg.get("grace_days")))
        window = max(0, _coerce_int(cfg.get("escalation_window_days")) or _DEFAULT_FLOOR_PLAN["escalation_window_days"])
        return cls(grace_days=grace, bands=tuple(bands), escalation_window_days=window)

    def monthly_rate_at(self, days: int) -> float:
        """Floor-plan monthly rate in effect on day ``days`` (0 within grace)."""
        if days <= self.grace_days:
            return 0.0
        for band in self.bands:
            if band.until_day is None or days <= band.until_day:
                return band.monthly_rate
        return self.bands[-1].monthly_rate

    def _boundaries(self) -> list[int]:
        """Day numbers where the effective rate can step up (grace end + bands)."""
        edges: list[int] = []
        if self.grace_days > 0:
            edges.append(self.grace_days)
        for band in self.bands:
            if band.until_day is not None:
                edges.append(band.until_day)
        return sorted(set(edges))

    def next_escalation(self, days: int) -> tuple[int, float] | None:
        """Days until the next *higher* rate boundary and that higher rate.

        Returns ``None`` when the unit is already in the top band (no further
        escalation possible).
        """
        current = self.monthly_rate_at(days)
        for edge in self._boundaries():
            if edge < days:
                continue
            rate_after = self.monthly_rate_at(edge + 1)
            if rate_after > current:
                return edge - days, rate_after
        return None

    def monthly_carry(self, cost: float, days: int) -> float:
        return round(cost * self.monthly_rate_at(days), 2)

    def accrued(self, cost: float, days: int) -> float:
        """Total floor-plan cost accrued from day 0 to ``days`` (piecewise)."""
        if cost <= 0 or days <= self.grace_days:
            return 0.0
        total = 0.0
        prev = self.grace_days
        for band in self.bands:
            upper = days if band.until_day is None else min(days, band.until_day)
            if upper > prev:
                span_days = upper - prev
                total += cost * band.monthly_rate * (span_days / 30.0)
                prev = upper
            if band.until_day is not None and days <= band.until_day:
                break
        return round(total, 2)

    def projected_accrued(self, cost: float, days: int, ahead_days: int) -> float:
        return self.accrued(cost, days + max(0, ahead_days))


# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Signal:
    finding_type: str
    severity: str
    estimated_exposure: float
    evidence: tuple[str, ...]


@dataclass
class VehicleAssessment:
    """Deterministic result of analysing one in-stock vehicle."""

    triggered: bool
    finding_type: str = "monitor"
    severity: str = "medium"
    estimated_exposure: float = 0.0
    signals: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    # Carried through for context / prompting (never a trigger by itself).
    monthly_carry: float = 0.0
    accrued_floor_plan: float = 0.0
    gross_margin: float = 0.0


@dataclass(frozen=True)
class SignalThresholds:
    escalation_high_brl: float = _DEFAULT_ESCALATION_HIGH_BRL
    escalation_critical_brl: float = _DEFAULT_ESCALATION_CRITICAL_BRL
    margin_floor_pct: float = _DEFAULT_MARGIN_FLOOR_PCT
    margin_lookahead_days: int = _DEFAULT_MARGIN_LOOKAHEAD_DAYS
    carryover_min_days: int = _DEFAULT_CARRYOVER_MIN_DAYS

    @classmethod
    def from_config(cls, thresholds: Mapping[str, Any] | None) -> SignalThresholds:
        t = thresholds if isinstance(thresholds, Mapping) else {}
        return cls(
            escalation_high_brl=_coerce_float(t.get("escalation_high_brl")) or _DEFAULT_ESCALATION_HIGH_BRL,
            escalation_critical_brl=(
                _coerce_float(t.get("escalation_critical_brl")) or _DEFAULT_ESCALATION_CRITICAL_BRL
            ),
            margin_floor_pct=(
                _coerce_float(t.get("margin_floor_pct")) if t.get("margin_floor_pct") is not None
                else _DEFAULT_MARGIN_FLOOR_PCT
            ),
            margin_lookahead_days=_coerce_int(t.get("margin_lookahead_days")) or _DEFAULT_MARGIN_LOOKAHEAD_DAYS,
            carryover_min_days=_coerce_int(t.get("carryover_min_days")) or _DEFAULT_CARRYOVER_MIN_DAYS,
        )


def _money(value: float) -> str:
    return f"R$ {value:,.2f}"


def _floor_plan_escalation_signal(
    *, cost: float, days: int, curve: FloorPlanCurve, limits: SignalThresholds
) -> Signal | None:
    if cost <= 0:
        return None
    nxt = curve.next_escalation(days)
    if nxt is None:
        return None
    days_to_next, next_rate = nxt
    if days_to_next > curve.escalation_window_days:
        return None
    current_rate = curve.monthly_rate_at(days)
    if next_rate <= current_rate:
        return None
    carry_now = round(cost * current_rate, 2)
    carry_after = round(cost * next_rate, 2)
    monthly_jump = round(carry_after - carry_now, 2)

    leaving_grace = current_rate <= 0.0
    if monthly_jump >= limits.escalation_critical_brl:
        severity = "critical"
    elif monthly_jump >= limits.escalation_high_brl or leaving_grace:
        severity = "high"
    else:
        severity = "medium"

    if leaving_grace:
        head = (
            f"Carência de floor plan termina em {days_to_next} dia(s): "
            f"o carry mensal passa de R$ 0,00 para {_money(carry_after)}."
        )
    else:
        head = (
            f"Cruza para a próxima faixa de floor plan em {days_to_next} dia(s): "
            f"carry mensal sobe de {_money(carry_now)} para {_money(carry_after)} "
            f"(+{_money(monthly_jump)}/mês)."
        )
    return Signal(
        finding_type=FINDING_FLOOR_PLAN_ESCALATION,
        severity=severity,
        estimated_exposure=monthly_jump,
        evidence=(
            head,
            f"Taxa mensal atual {current_rate * 100:.2f}% → próxima {next_rate * 100:.2f}% sobre custo {_money(cost)}.",
        ),
    )


def _margin_erosion_signal(
    *, cost: float, sale_price: float, days: int, curve: FloorPlanCurve, limits: SignalThresholds
) -> Signal | None:
    if cost <= 0 or sale_price <= 0:
        return None
    gross_margin = round(sale_price - cost, 2)
    if gross_margin <= 0:
        # Already non-positive margin before any carry — surface it.
        accrued = curve.accrued(cost, days)
        return Signal(
            finding_type=FINDING_MARGIN_EROSION,
            severity="critical",
            estimated_exposure=round(max(accrued, -gross_margin), 2),
            evidence=(
                f"Margem bruta não-positiva: preço {_money(sale_price)} ≤ custo {_money(cost)}.",
                f"Floor plan acumulado {_money(accrued)} aprofunda o prejuízo.",
            ),
        )
    accrued = curve.accrued(cost, days)
    residual = round(gross_margin - accrued, 2)
    projected = curve.projected_accrued(cost, days, limits.margin_lookahead_days)
    projected_residual = round(gross_margin - projected, 2)

    consumes_floor = accrued >= limits.margin_floor_pct * gross_margin
    if residual < 0:
        severity, fires = "critical", True
    elif projected_residual <= 0:
        severity, fires = "high", True
    elif consumes_floor:
        severity, fires = "medium", True
    else:
        severity, fires = "medium", False
    if not fires:
        return None

    consumed_pct = (accrued / gross_margin * 100.0) if gross_margin else 0.0
    return Signal(
        finding_type=FINDING_MARGIN_EROSION,
        severity=severity,
        estimated_exposure=round(accrued, 2),
        evidence=(
            f"Floor plan acumulado {_money(accrued)} já consumiu {consumed_pct:.0f}% da "
            f"margem bruta {_money(gross_margin)} (resta {_money(residual)}).",
            f"Em {limits.margin_lookahead_days} dias a margem residual projetada cai para "
            f"{_money(projected_residual)}.",
        ),
    )


def _carryover_signal(
    *, condition: str, model_year: int | None, days: int, cost: float, curve: FloorPlanCurve,
    limits: SignalThresholds, current_year: int,
) -> Signal | None:
    if condition != "novo" or model_year is None or model_year <= 0:
        return None
    if model_year >= current_year:
        return None
    if days < limits.carryover_min_days:
        return None
    years_behind = current_year - model_year
    severity = "critical" if years_behind >= 2 else "high"
    cost_to_wait = round(
        curve.projected_accrued(cost, days, 30) - curve.accrued(cost, days), 2
    ) if cost > 0 else 0.0
    return Signal(
        finding_type=FINDING_CARRYOVER_MODEL_YEAR,
        severity=severity,
        estimated_exposure=cost_to_wait,
        evidence=(
            f"Unidade nova de ano-modelo {model_year} ({years_behind} ano(s) atrás do ano corrente "
            f"{current_year}) parada há {days} dias: leftover/obsolescência.",
            f"Custo estimado de manter mais 30 dias em floor plan: {_money(cost_to_wait)}.",
        ),
    )


def assess_vehicle(
    vehicle: Mapping[str, Any],
    *,
    floor_plan_config: Mapping[str, Any] | None = None,
    thresholds: Mapping[str, Any] | None = None,
    today: date | None = None,
) -> VehicleAssessment:
    """Run all anticipatory signals against one in-stock vehicle row.

    ``vehicle`` mirrors ``v_dia_vehicle_current`` columns (cost, sale_price,
    days_in_stock, model_year, condition, ...). Returns a deterministic
    :class:`VehicleAssessment`; ``triggered`` is ``False`` when no signal fires
    (e.g. an old-but-healthy unit), in which case no finding should be recorded.
    """
    curve = FloorPlanCurve.from_config(floor_plan_config)
    limits = SignalThresholds.from_config(thresholds)
    current_year = (today or date.today()).year

    cost = _coerce_float(vehicle.get("cost"))
    sale_price = _coerce_float(vehicle.get("sale_price"))
    days = max(0, _coerce_int(vehicle.get("days_in_stock")))
    condition = str(vehicle.get("condition") or "").strip().lower()
    raw_my = vehicle.get("model_year")
    model_year = _coerce_int(raw_my) if raw_my not in (None, "") else None

    signals = [
        _floor_plan_escalation_signal(cost=cost, days=days, curve=curve, limits=limits),
        _margin_erosion_signal(
            cost=cost, sale_price=sale_price, days=days, curve=curve, limits=limits
        ),
        _carryover_signal(
            condition=condition, model_year=model_year, days=days, cost=cost,
            curve=curve, limits=limits, current_year=current_year,
        ),
    ]
    fired = [s for s in signals if s is not None]

    gross_margin = round(sale_price - cost, 2) if (cost > 0 and sale_price > 0) else 0.0
    assessment = VehicleAssessment(
        triggered=bool(fired),
        monthly_carry=curve.monthly_carry(cost, days),
        accrued_floor_plan=curve.accrued(cost, days),
        gross_margin=gross_margin,
    )
    if not fired:
        return assessment

    primary = _pick_primary(fired)
    assessment.finding_type = primary.finding_type
    assessment.severity = primary.severity
    assessment.estimated_exposure = round(primary.estimated_exposure, 2)
    assessment.signals = _ordered_signal_types(fired)
    assessment.evidence = [line for s in _order_signals(fired) for line in s.evidence]
    return assessment


def _order_signals(signals: Sequence[Signal]) -> list[Signal]:
    return sorted(
        signals,
        key=lambda s: (
            -_SEVERITY_RANK.get(s.severity, 0),
            SIGNAL_PRIORITY.index(s.finding_type) if s.finding_type in SIGNAL_PRIORITY else 99,
        ),
    )


def _ordered_signal_types(signals: Sequence[Signal]) -> list[str]:
    return [s.finding_type for s in _order_signals(signals)]


def _pick_primary(signals: Sequence[Signal]) -> Signal:
    return _order_signals(signals)[0]


__all__ = [
    "FINDING_CARRYOVER_MODEL_YEAR",
    "FINDING_FLOOR_PLAN_ESCALATION",
    "FINDING_MARGIN_EROSION",
    "FloorPlanCurve",
    "Signal",
    "SignalThresholds",
    "VehicleAssessment",
    "assess_vehicle",
]
