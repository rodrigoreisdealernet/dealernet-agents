from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.parts_inventory_advisor import run_parts_inventory_advisor
from . import ops_revrec

logger = logging.getLogger(__name__)

_AGENT_KEY = "parts-inventory-advisor"
_REPLENISH_FINDING_TYPE = "replenish_now"
_DEAD_STOCK_FINDING_TYPE = "dead_stock"
_DEFAULT_MAX_PARTS = 200
_MIN_SCOPED_PARTS = 1
_MAX_SCOPED_PARTS = 500
_DEFAULT_VELOCITY_WINDOW_DAYS = 90
_DEFAULT_DEAD_STOCK_MAX_VELOCITY = 0.0
_DEFAULT_DEAD_STOCK_MIN_VALUE = 0.0
_DEFAULT_DEAD_STOCK_HIGH_VALUE = 1000.0


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


def _parts_fingerprint(tenant_id: str, part_id: str, finding_type: str) -> str:
    return hashlib.sha256(f"{tenant_id}:{part_id}:{finding_type}".encode()).hexdigest()


def _windowed_velocity(
    sale_rows: Sequence[Mapping[str, Any]],
    part_id: str,
    window_days: int,
    now: dt.date,
) -> float:
    velocity = 0.0
    for row in sale_rows:
        if str(row.get("part_id") or "") != part_id:
            continue
        sale_date_raw = str(row.get("sale_date") or "")[:10]
        try:
            sale_date = dt.date.fromisoformat(sale_date_raw)
        except ValueError:
            continue
        age_days = (now - sale_date).days
        if 0 <= age_days <= window_days:
            velocity += _coerce_float(row.get("quantity"))
    return velocity


def _severity_for_stock_status(stock_status: str) -> str:
    match str(stock_status or "").strip().lower():
        case "zerado":
            return "critical"
        case "critico":
            return "high"
        case "baixo":
            return "medium"
        case _:
            return "medium"


def _thresholds_from_context(run_context: Mapping[str, Any]) -> Mapping[str, Any]:
    thresholds = run_context.get("thresholds") if isinstance(run_context.get("thresholds"), Mapping) else {}
    return thresholds


def _max_parts_from_context(run_context: Mapping[str, Any]) -> int:
    max_parts = _coerce_int(run_context.get("max_parts")) or _DEFAULT_MAX_PARTS
    return max(_MIN_SCOPED_PARTS, min(max_parts, _MAX_SCOPED_PARTS))


def _velocity_window_from_thresholds(thresholds: Mapping[str, Any]) -> int:
    return _coerce_int(thresholds.get("velocity_window_days", _DEFAULT_VELOCITY_WINDOW_DAYS)) or _DEFAULT_VELOCITY_WINDOW_DAYS


@activity.defn
def ops_scope_parts_replenish(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001 — shared persistence client
    thresholds = _thresholds_from_context(run_context)
    window_days = _velocity_window_from_thresholds(thresholds)
    max_parts = _max_parts_from_context(run_context)
    now = dt.date.today()

    rows = client.select(
        "v_dia_parts_critical",
        columns=(
            "entity_id,part_number,manufacturer,unit_cost,quantity_in_stock,min_stock,"
            "reorder_point,stock_value,stock_status,criticality_rank"
        ),
    )
    sale_rows = client.select(
        "v_dia_part_sale_current",
        columns="part_id,quantity,sale_date",
    )

    scoped: list[dict[str, Any]] = []
    for row in rows:
        part_id = str(row.get("entity_id") or "")
        if not part_id:
            continue
        velocity = _windowed_velocity(sale_rows, part_id, window_days, now)
        quantity_in_stock = _coerce_float(row.get("quantity_in_stock"))
        reorder_point = _coerce_float(row.get("reorder_point"))
        unit_cost = _coerce_float(row.get("unit_cost"))
        stock_value = round(_coerce_float(row.get("stock_value")), 2)
        criticality_rank = _coerce_int(row.get("criticality_rank"))
        quantity_suggested = max(0, int(reorder_point - quantity_in_stock))
        value_at_risk = round(quantity_suggested * unit_cost, 2)
        priority = (3 - criticality_rank) * 1000 + velocity * 10 + stock_value / 100
        scoped.append(
            {
                "part_id": part_id,
                "tenant_id": tenant_id,
                "part_number": row.get("part_number"),
                "manufacturer": row.get("manufacturer"),
                "unit_cost": unit_cost,
                "quantity_in_stock": quantity_in_stock,
                "min_stock": _coerce_float(row.get("min_stock")),
                "reorder_point": reorder_point,
                "stock_value": stock_value,
                "stock_status": row.get("stock_status"),
                "velocity": velocity,
                "quantity_suggested": quantity_suggested,
                "value_at_risk": value_at_risk,
                "severity": _severity_for_stock_status(str(row.get("stock_status") or "")),
                "priority": priority,
                "finding_type": _REPLENISH_FINDING_TYPE,
                "fingerprint": _parts_fingerprint(tenant_id, part_id, _REPLENISH_FINDING_TYPE),
            }
        )

    scoped.sort(key=lambda item: (-float(item.get("priority") or 0.0), str(item.get("part_id") or "")))
    return scoped[:max_parts]


@activity.defn
def ops_scope_parts_dead_stock(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001 — shared persistence client
    thresholds = _thresholds_from_context(run_context)
    window_days = _velocity_window_from_thresholds(thresholds)
    max_parts = _max_parts_from_context(run_context)
    dead_stock_max_velocity = _coerce_float(
        thresholds.get("dead_stock_max_velocity", _DEFAULT_DEAD_STOCK_MAX_VELOCITY)
    )
    dead_stock_min_value = _coerce_float(thresholds.get("dead_stock_min_value", _DEFAULT_DEAD_STOCK_MIN_VALUE))
    dead_stock_high_value = _coerce_float(thresholds.get("dead_stock_high_value", _DEFAULT_DEAD_STOCK_HIGH_VALUE))
    now = dt.date.today()

    rows = client.select(
        "v_dia_part_current",
        columns=(
            "entity_id,part_number,manufacturer,unit_cost,quantity_in_stock,min_stock,"
            "reorder_point,stock_value,stock_status"
        ),
    )
    sale_rows = client.select(
        "v_dia_part_sale_current",
        columns="part_id,quantity,sale_date",
    )

    scoped: list[dict[str, Any]] = []
    for row in rows:
        part_id = str(row.get("entity_id") or "")
        if not part_id:
            continue
        velocity = _windowed_velocity(sale_rows, part_id, window_days, now)
        quantity_in_stock = _coerce_float(row.get("quantity_in_stock"))
        stock_value = round(_coerce_float(row.get("stock_value")), 2)
        if velocity > dead_stock_max_velocity or stock_value < dead_stock_min_value or quantity_in_stock <= 0:
            continue
        scoped.append(
            {
                "part_id": part_id,
                "tenant_id": tenant_id,
                "part_number": row.get("part_number"),
                "manufacturer": row.get("manufacturer"),
                "unit_cost": _coerce_float(row.get("unit_cost")),
                "quantity_in_stock": quantity_in_stock,
                "min_stock": _coerce_float(row.get("min_stock")),
                "reorder_point": _coerce_float(row.get("reorder_point")),
                "stock_value": stock_value,
                "stock_status": row.get("stock_status"),
                "velocity": velocity,
                "quantity_suggested": 0,
                "value_at_risk": stock_value,
                "severity": "high" if stock_value >= dead_stock_high_value else "medium",
                "priority": stock_value,
                "finding_type": _DEAD_STOCK_FINDING_TYPE,
                "fingerprint": _parts_fingerprint(tenant_id, part_id, _DEAD_STOCK_FINDING_TYPE),
            }
        )

    scoped.sort(key=lambda item: (-float(item.get("stock_value") or 0.0), str(item.get("part_id") or "")))
    return scoped[:max_parts]


@activity.defn
async def ops_parts_inventory_assess(part_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    max_tool_rounds = _coerce_int(bounds.get("max_tool_rounds")) or 0
    system_prompt = str(config.get("system_prompt") or "You are a parts inventory advisor.")
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Assess part {part_id} ({part_number}) for tenant {tenant_id}. Evidence:\n{evidence_json}"
    )
    prompt_variables = {
        "tenant_id": str(part_payload.get("tenant_id") or ""),
        "part_id": str(part_payload.get("part_id") or ""),
        "part_number": str(part_payload.get("part_number") or ""),
        "manufacturer": str(part_payload.get("manufacturer") or ""),
        "stock_status": str(part_payload.get("stock_status") or ""),
        "quantity_in_stock": str(part_payload.get("quantity_in_stock") or ""),
        "reorder_point": str(part_payload.get("reorder_point") or ""),
        "stock_value": str(part_payload.get("stock_value") or ""),
        "velocity": str(part_payload.get("velocity") or ""),
        "quantity_suggested": str(part_payload.get("quantity_suggested") or ""),
        "value_at_risk": str(part_payload.get("value_at_risk") or ""),
        "finding_type": str(part_payload.get("finding_type") or ""),
        "evidence_json": json.dumps(part_payload, sort_keys=True),
    }
    rendered_system_prompt = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user_prompt = ops_revrec.interpolate_prompt_template(user_prompt_template, prompt_variables)

    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            except Exception:  # noqa: BLE001 — worker shutdown/other Temporal context errors
                logger.debug("ops_parts_inventory_assess heartbeat failed; loop exiting")
                return
            await asyncio.sleep(15)

    heartbeat_task = asyncio.create_task(_heartbeat_loop())
    try:
        result = await run_parts_inventory_advisor(
            part_payload,
            system_prompt=rendered_system_prompt,
            user_prompt_template=rendered_user_prompt,
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()

    result["part_id"] = str(part_payload.get("part_id") or result.get("part_id") or "")
    result["finding_type"] = str(part_payload.get("finding_type") or result.get("finding_type") or _REPLENISH_FINDING_TYPE)
    result["severity"] = str(part_payload.get("severity") or result.get("severity") or "medium")
    result["quantity_suggested"] = _coerce_int(part_payload.get("quantity_suggested"))
    result["value_at_risk"] = round(_coerce_float(part_payload.get("value_at_risk")), 2)
    result.setdefault("recommended_action", "monitor")
    result.setdefault("evidence", [])
    result.setdefault("confidence", 0.0)
    result.setdefault("rationale", "No rationale provided")
    return result


@activity.defn(name="ops_parts_inventory_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_parts_inventory_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_parts_inventory_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_parts_inventory_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _parts_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    part_id = str(finding.get("part_id") or "")
    return {
        **finding,
        "contract_id": part_id,
        "line_item_id": None,
        "finding_type": str(finding.get("finding_type") or _REPLENISH_FINDING_TYPE),
        "severity": str(finding.get("severity") or "medium"),
        "expected": {
            "part_number": finding.get("part_number"),
            "manufacturer": finding.get("manufacturer"),
            "stock_status": finding.get("stock_status"),
            "quantity_in_stock": finding.get("quantity_in_stock"),
            "reorder_point": finding.get("reorder_point"),
            "stock_value": finding.get("stock_value"),
            "velocity": finding.get("velocity"),
            "quantity_suggested": finding.get("quantity_suggested"),
            "recommended_action": finding.get("recommended_action"),
        },
        "billed": {},
        "delta": finding.get("value_at_risk"),
        "proposed_action": finding.get("recommended_action"),
    }


@activity.defn(name="ops_parts_inventory_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_parts_finding_for_storage(finding), run_id)


@activity.defn(name="ops_parts_inventory_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _parts_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_parts_inventory_assess",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_scope_parts_dead_stock",
    "ops_scope_parts_replenish",
]
