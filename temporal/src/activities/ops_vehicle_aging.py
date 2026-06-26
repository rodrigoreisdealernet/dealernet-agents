from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
from collections.abc import Mapping
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.vehicle_aging_analyst import run_vehicle_aging_analyst
from ..agents.vehicle_inventory_signals import (
    FINDING_FLOOR_PLAN_ESCALATION,
    assess_vehicle,
)
from . import ops_revrec

logger = logging.getLogger(__name__)

_AGENT_KEY = "vehicle-aging-analyst"

# Cap on how many in-stock vehicles a single run will surface as findings.
_DEFAULT_MAX_VEHICLES = 200
_MIN_SCOPED_VEHICLES = 1
_MAX_SCOPED_VEHICLES = 500

_SEVERITY_RANK = {"medium": 1, "high": 2, "critical": 3}
_VEHICLE_BREACH_DAYS = 90


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


def _parse_date(value: Any) -> dt.date | None:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if not value:
        return None
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _iso_midnight_utc(value: dt.date) -> str:
    return dt.datetime.combine(value, dt.time.min, tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _vehicle_days_to_breach(days_in_stock: Any) -> int | None:
    if days_in_stock in (None, ""):
        return None
    return _VEHICLE_BREACH_DAYS - _coerce_int(days_in_stock)


def _vehicle_predicted_breach_at(
    purchase_date: Any,
    days_in_stock: Any,
    *,
    today: dt.date | None = None,
) -> str | None:
    breach_base = _parse_date(purchase_date)
    if breach_base is None and days_in_stock not in (None, ""):
        breach_base = (today or dt.date.today()) - dt.timedelta(days=_coerce_int(days_in_stock))
    if breach_base is None:
        return None
    return _iso_midnight_utc(breach_base + dt.timedelta(days=_VEHICLE_BREACH_DAYS))


def _vehicle_horizon_severity(days_to_breach: int | None) -> str | None:
    if days_to_breach is None:
        return None
    # The approved AC2 says "attention", but this codebase only supports
    # medium/high/critical; keep floor-plan severity and only escalate short
    # horizons into the existing tiers until the owner confirms a new label.
    return "high" if days_to_breach <= 7 else "medium"


def _max_severity(current: str, projected: str | None) -> str:
    if not projected:
        return current
    return max((current, projected), key=lambda value: _SEVERITY_RANK.get(value, 0))


def _finding_fingerprint(tenant_id: str, vehicle_id: str, finding_type: str) -> str:
    """SHA-256 dedupe key per (tenant, vehicle, primary finding type).

    Keying on the finding type (not a fixed legacy string) lets a vehicle move
    between anticipatory problems over its life without colliding, while still
    deduping a stable problem run-over-run.
    """
    return hashlib.sha256(f"{tenant_id}:{vehicle_id}:{finding_type}".encode()).hexdigest()


@activity.defn
def ops_scope_vehicle_aging(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministically surface in-stock vehicles with an anticipatory problem.

    Reads ``v_dia_vehicle_current`` and runs the floor-plan-grounded signal
    engine (``vehicle_inventory_signals.assess_vehicle``) over every in-stock
    unit. A vehicle is scoped ONLY when at least one anticipatory signal fires
    (floor-plan band escalation, margin erosion or model-year carryover) — never
    merely because it has sat a long time. Finding type, severity, money
    exposure and the dedupe fingerprint are computed here so the run stays
    deterministic even if the downstream LLM assessment is unavailable.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001 — shared persistence client
    thresholds = run_context.get("thresholds") if isinstance(run_context.get("thresholds"), Mapping) else {}
    floor_plan_config = thresholds.get("floor_plan") if isinstance(thresholds.get("floor_plan"), Mapping) else None
    max_vehicles = _coerce_int(run_context.get("max_vehicles")) or _DEFAULT_MAX_VEHICLES
    max_vehicles = max(_MIN_SCOPED_VEHICLES, min(max_vehicles, _MAX_SCOPED_VEHICLES))

    rows = client.select(
        "v_dia_vehicle_current",
        columns=(
            "entity_id,source_record_id,name,condition,brand,model,model_year,"
            "cost,sale_price,store,status,purchase_date,days_in_stock,floor_plan_cost"
        ),
        filters={"status": "em_estoque"},
    )

    scoped: list[dict[str, Any]] = []
    for row in rows:
        vehicle_id = str(row.get("entity_id") or "")
        if not vehicle_id:
            continue
        assessment = assess_vehicle(
            row, floor_plan_config=floor_plan_config, thresholds=thresholds
        )
        if not assessment.triggered:
            continue
        days_to_breach = _vehicle_days_to_breach(row.get("days_in_stock"))
        predicted_breach_at = _vehicle_predicted_breach_at(row.get("purchase_date"), row.get("days_in_stock"))
        severity = _max_severity(assessment.severity, _vehicle_horizon_severity(days_to_breach))
        scoped.append(
            {
                "vehicle_id": vehicle_id,
                "tenant_id": tenant_id,
                "source_record_id": row.get("source_record_id"),
                "name": row.get("name"),
                "condition": row.get("condition"),
                "brand": row.get("brand"),
                "model": row.get("model"),
                "model_year": row.get("model_year"),
                "cost": _coerce_float(row.get("cost")),
                "sale_price": _coerce_float(row.get("sale_price")),
                "store": row.get("store"),
                "status": row.get("status"),
                "purchase_date": row.get("purchase_date"),
                "days_in_stock": _coerce_int(row.get("days_in_stock")),
                "predicted_breach_at": predicted_breach_at,
                "days_to_breach": days_to_breach,
                "floor_plan_cost": round(_coerce_float(row.get("floor_plan_cost")), 2),
                "monthly_carry": round(assessment.monthly_carry, 2),
                "accrued_floor_plan": round(assessment.accrued_floor_plan, 2),
                "gross_margin": round(assessment.gross_margin, 2),
                "finding_type": assessment.finding_type,
                "severity": severity,
                "signals": list(assessment.signals),
                "estimated_exposure": round(assessment.estimated_exposure, 2),
                "signal_evidence": list(assessment.evidence),
                "fingerprint": _finding_fingerprint(tenant_id, vehicle_id, assessment.finding_type),
            }
        )

    # Highest severity first, then largest money exposure, then stable by id.
    scoped.sort(
        key=lambda item: (
            -_SEVERITY_RANK.get(str(item.get("severity")), 0),
            -float(item.get("estimated_exposure") or 0.0),
            str(item.get("vehicle_id") or ""),
        )
    )
    return scoped[:max_vehicles]


@activity.defn
async def ops_vehicle_aging_assess(vehicle_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    locale = str(config.get("locale") or "pt-BR")
    max_tool_rounds = _coerce_int(bounds.get("max_tool_rounds")) or 0
    system_prompt = str(config.get("system_prompt") or "You are a vehicle stock-aging analyst.")
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Assess vehicle {vehicle_id} for tenant {tenant_id}. Evidence:\n{evidence_json}"
    )
    prompt_variables = {
        "tenant_id": str(vehicle_payload.get("tenant_id") or ""),
        "vehicle_id": str(vehicle_payload.get("vehicle_id") or ""),
        "brand": str(vehicle_payload.get("brand") or ""),
        "model": str(vehicle_payload.get("model") or ""),
        "model_year": str(vehicle_payload.get("model_year") or ""),
        "store": str(vehicle_payload.get("store") or ""),
        "condition": str(vehicle_payload.get("condition") or ""),
        "cost": str(vehicle_payload.get("cost") or ""),
        "sale_price": str(vehicle_payload.get("sale_price") or ""),
        "days_in_stock": str(vehicle_payload.get("days_in_stock") or ""),
        "finding_type": str(vehicle_payload.get("finding_type") or ""),
        "signals": ", ".join(vehicle_payload.get("signals") or []),
        "estimated_exposure": str(vehicle_payload.get("estimated_exposure") or ""),
        "monthly_carry": str(vehicle_payload.get("monthly_carry") or ""),
        "accrued_floor_plan": str(vehicle_payload.get("accrued_floor_plan") or ""),
        "gross_margin": str(vehicle_payload.get("gross_margin") or ""),
        "floor_plan_cost": str(vehicle_payload.get("floor_plan_cost") or ""),
        "evidence_json": json.dumps(vehicle_payload, sort_keys=True),
    }
    rendered_system_prompt = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user_prompt = ops_revrec.interpolate_prompt_template(user_prompt_template, prompt_variables)

    # Heartbeat every 15 s so a stalled LLM/HTTP call is detected before the
    # workflow's heartbeat_timeout elapses; cancelled once the analyst returns.
    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            except Exception:  # noqa: BLE001 — worker shutdown/other Temporal context errors
                logger.debug("ops_vehicle_aging_assess heartbeat failed; loop exiting")
                return
            await asyncio.sleep(15)

    heartbeat_task = asyncio.create_task(_heartbeat_loop())
    try:
        result = await run_vehicle_aging_analyst(
            vehicle_payload,
            system_prompt=rendered_system_prompt,
            user_prompt_template=rendered_user_prompt,
            locale=locale,
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()

    # Pin the deterministic, problem-defining fields to the scoped values so a
    # finding's type/severity/exposure never depend on free-form model output.
    result["vehicle_id"] = str(vehicle_payload.get("vehicle_id") or result.get("vehicle_id") or "")
    result["finding_type"] = str(vehicle_payload.get("finding_type") or FINDING_FLOOR_PLAN_ESCALATION)
    result["days_in_stock"] = _coerce_int(vehicle_payload.get("days_in_stock"))
    result["predicted_breach_at"] = vehicle_payload.get("predicted_breach_at")
    result["days_to_breach"] = vehicle_payload.get("days_to_breach")
    result["severity"] = str(vehicle_payload.get("severity") or result.get("severity") or "medium")
    result["signals"] = list(vehicle_payload.get("signals") or [])
    result["estimated_exposure"] = round(_coerce_float(vehicle_payload.get("estimated_exposure")), 2)

    # Surface the deterministic signal evidence first, then any model-provided
    # detail, de-duplicated and order-preserving.
    deterministic_evidence = list(vehicle_payload.get("signal_evidence") or [])
    model_evidence = list(result.get("evidence") or [])
    merged: list[str] = []
    for line in [*deterministic_evidence, *model_evidence]:
        if line and line not in merged:
            merged.append(line)
    result["evidence"] = merged

    result.setdefault("recommended_action", "monitor")
    result.setdefault("confidence", 0.0)
    result.setdefault("rationale", "No rationale provided")
    return result


@activity.defn(name="ops_vehicle_aging_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_vehicle_aging_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_vehicle_aging_expire_out_of_scope_findings")
def ops_vehicle_aging_expire_out_of_scope_findings(
    tenant_id: str,
    in_scope_fingerprints: list[str],
) -> int:
    """Supersede open vehicle findings no longer produced by the current run.

    After a reseed, vehicle UUIDs (and thus fingerprints) change, so stale
    findings never dedupe and linger as ``pending_approval``. This retires any
    open finding for this tenant whose fingerprint is not in this run's in-scope
    set, marking it ``superseded`` (preserves the audit trail). Returns the count.
    """
    return ops_revrec.ops_expire_out_of_scope_findings(
        tenant_id, _AGENT_KEY, in_scope_fingerprints
    )


@activity.defn(name="ops_vehicle_aging_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_vehicle_aging_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _vehicle_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    """Shape a surfaced vehicle finding into the canonical ``finding`` row.

    The vehicle entity_id is the audit anchor (``contract_id``), there are no
    line items, and the recoverable ``delta`` is the money exposure of the
    primary anticipatory signal.
    """
    vehicle_id = str(finding.get("vehicle_id") or "")
    return {
        **finding,
        "contract_id": vehicle_id,
        "line_item_id": None,
        "finding_type": str(finding.get("finding_type") or FINDING_FLOOR_PLAN_ESCALATION),
        "severity": str(finding.get("severity") or "medium"),
        "expected": {
            "brand": finding.get("brand"),
            "model": finding.get("model"),
            "model_year": finding.get("model_year"),
            "store": finding.get("store"),
            "purchase_date": finding.get("purchase_date"),
            "days_in_stock": finding.get("days_in_stock"),
            "predicted_breach_at": finding.get("predicted_breach_at"),
            "days_to_breach": finding.get("days_to_breach"),
            "signals": finding.get("signals"),
            "recommended_action": finding.get("recommended_action"),
            "monthly_carry": finding.get("monthly_carry"),
            "accrued_floor_plan": finding.get("accrued_floor_plan"),
            "gross_margin": finding.get("gross_margin"),
            "floor_plan_cost": finding.get("floor_plan_cost"),
            "sale_price": finding.get("sale_price"),
            "cost": finding.get("cost"),
        },
        "billed": {},
        "delta": finding.get("estimated_exposure"),
        "proposed_action": finding.get("recommended_action"),
    }


@activity.defn(name="ops_vehicle_aging_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_vehicle_finding_for_storage(finding), run_id)


@activity.defn(name="ops_vehicle_aging_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _vehicle_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_scope_vehicle_aging",
    "ops_vehicle_aging_assess",
    "ops_vehicle_aging_expire_out_of_scope_findings",
    "_vehicle_days_to_breach",
    "_vehicle_predicted_breach_at",
]
