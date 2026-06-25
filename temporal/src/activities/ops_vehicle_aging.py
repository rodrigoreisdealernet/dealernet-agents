from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Mapping
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.vehicle_aging_analyst import run_vehicle_aging_analyst
from . import ops_revrec

logger = logging.getLogger(__name__)

_AGENT_KEY = "vehicle-aging-analyst"
_FINDING_TYPE = "stock_aging_90d"

# Deterministic scope/severity thresholds (overridable via config.thresholds).
_DEFAULT_WARNING_DAYS = 75
_DEFAULT_BREACH_DAYS = 90
_DEFAULT_MAX_VEHICLES = 200
_MIN_SCOPED_VEHICLES = 1
_MAX_SCOPED_VEHICLES = 500
# Floor-plan exposure window in days below which the high/"imminent" band starts.
_IMMINENT_WINDOW_DAYS = 5


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


def _severity_for_days(
    days: int,
    *,
    warning_days: int = _DEFAULT_WARNING_DAYS,
    breach_days: int = _DEFAULT_BREACH_DAYS,
) -> tuple[str, str]:
    """Deterministic severity + aging bucket from days in stock.

    warning..(breach-6)  -> medium / approaching   (e.g. 75-84)
    (breach-5)..breach    -> high   / imminent      (e.g. 85-90)
    > breach              -> critical / breached     (e.g. 91+)
    """
    imminent_floor = max(warning_days, breach_days - _IMMINENT_WINDOW_DAYS)
    if days > breach_days:
        return "critical", "breached"
    if days >= imminent_floor:
        return "high", "imminent"
    return "medium", "approaching"


def _stock_aging_fingerprint(tenant_id: str, vehicle_id: str) -> str:
    return hashlib.sha256(f"{tenant_id}:{vehicle_id}:{_FINDING_TYPE}".encode()).hexdigest()


@activity.defn
def ops_scope_vehicle_aging(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministically scope in-stock vehicles approaching the 90-day floor-plan line.

    Reads ``v_dia_vehicle_current`` (NOT any rental_* helper): in-stock vehicles
    whose derived ``days_in_stock`` is at or beyond the aging-warning threshold,
    ordered by ``days_in_stock`` descending.  Severity, aging bucket and the
    SHA-256 dedupe fingerprint are computed here so the run stays deterministic
    even if the downstream LLM assessment is unavailable.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001 — shared persistence client
    thresholds = run_context.get("thresholds") if isinstance(run_context.get("thresholds"), Mapping) else {}
    warning_days = _coerce_int(thresholds.get("aging_warning_days", _DEFAULT_WARNING_DAYS)) or _DEFAULT_WARNING_DAYS
    breach_days = _coerce_int(thresholds.get("aging_breach_days", _DEFAULT_BREACH_DAYS)) or _DEFAULT_BREACH_DAYS
    max_vehicles = _coerce_int(run_context.get("max_vehicles")) or _DEFAULT_MAX_VEHICLES
    max_vehicles = max(_MIN_SCOPED_VEHICLES, min(max_vehicles, _MAX_SCOPED_VEHICLES))

    rows = client.select(
        "v_dia_vehicle_current",
        columns=(
            "entity_id,source_record_id,name,condition,brand,model,model_year,"
            "cost,sale_price,store,status,days_in_stock,floor_plan_cost"
        ),
        filters={"status": "em_estoque"},
    )

    scoped: list[dict[str, Any]] = []
    for row in rows:
        vehicle_id = str(row.get("entity_id") or "")
        if not vehicle_id:
            continue
        days_in_stock = _coerce_int(row.get("days_in_stock"))
        if days_in_stock < warning_days:
            continue
        severity, aging_bucket = _severity_for_days(
            days_in_stock,
            warning_days=warning_days,
            breach_days=breach_days,
        )
        floor_plan_cost = round(_coerce_float(row.get("floor_plan_cost")), 2)
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
                "days_in_stock": days_in_stock,
                "floor_plan_cost": floor_plan_cost,
                "estimated_exposure": floor_plan_cost,
                "severity": severity,
                "aging_bucket": aging_bucket,
                "finding_type": _FINDING_TYPE,
                "fingerprint": _stock_aging_fingerprint(tenant_id, vehicle_id),
            }
        )

    scoped.sort(key=lambda item: (-int(item.get("days_in_stock") or 0), str(item.get("vehicle_id") or "")))
    return scoped[:max_vehicles]


@activity.defn
async def ops_vehicle_aging_assess(vehicle_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
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
        "aging_bucket": str(vehicle_payload.get("aging_bucket") or ""),
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
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()

    # Pin the deterministic, money-relevant fields to the scoped view values so a
    # finding's severity/exposure never depend on free-form model output.
    result["vehicle_id"] = str(vehicle_payload.get("vehicle_id") or result.get("vehicle_id") or "")
    result["finding_type"] = _FINDING_TYPE
    result["days_in_stock"] = _coerce_int(vehicle_payload.get("days_in_stock"))
    result["severity"] = str(vehicle_payload.get("severity") or result.get("severity") or "medium")
    result["aging_bucket"] = str(vehicle_payload.get("aging_bucket") or result.get("aging_bucket") or "approaching")
    result["estimated_exposure"] = round(_coerce_float(vehicle_payload.get("floor_plan_cost")), 2)
    result.setdefault("recommended_action", "monitor")
    result.setdefault("evidence", [])
    result.setdefault("confidence", 0.0)
    result.setdefault("rationale", "No rationale provided")
    return result


@activity.defn(name="ops_vehicle_aging_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_vehicle_aging_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_vehicle_aging_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_vehicle_aging_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _vehicle_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    """Shape a surfaced vehicle-aging finding into the canonical ``finding`` row.

    The vehicle entity_id is the audit anchor (``contract_id``), there are no
    line items, and the recoverable ``delta`` is the floor-plan exposure derived
    from ``v_dia_vehicle_current``.
    """
    vehicle_id = str(finding.get("vehicle_id") or "")
    return {
        **finding,
        "contract_id": vehicle_id,
        "line_item_id": None,
        "finding_type": str(finding.get("finding_type") or _FINDING_TYPE),
        "severity": str(finding.get("severity") or "medium"),
        "expected": {
            "brand": finding.get("brand"),
            "model": finding.get("model"),
            "model_year": finding.get("model_year"),
            "store": finding.get("store"),
            "days_in_stock": finding.get("days_in_stock"),
            "aging_bucket": finding.get("aging_bucket"),
            "recommended_action": finding.get("recommended_action"),
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
]
