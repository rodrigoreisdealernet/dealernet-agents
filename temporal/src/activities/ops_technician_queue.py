"""Technician morning-queue activities.

Scope, assess, and persist ranked technician queue items for the
TechnicianMorningQueueWorkflow.

Signal coverage (service-technician operating-model tags):
  - returned_unit   : assets that returned from rental and need
                      inspection / repair follow-up (t1)
  - pm_work         : open PM work orders ready for execution (t2)
  - active_repair   : open/in-progress maintenance records (t2)
  - rent_ready_check: maintenance records nearly complete — final
                      prep before returning to available fleet (t5)

Priority factors surfaced per item:
  - contract_risk                : asset tied to live contract or imminent rental
  - overdue_maintenance          : PM or repair past target completion window
  - parts_blocker                : work order waiting on parts
  - has_return_condition_evidence: inspection/condition record already exists

Freshness:
  Any item whose last_updated_at is older than _STALE_THRESHOLD_HOURS is
  flagged as stale and the stale signal is added to the item payload.

Fail-closed:
  If a scoped record contains no useful data (no asset_id, no context), it
  is silently skipped. When the AI cannot determine priority due to missing
  data, it sets confidence=0 and populates priority_reasons with
  'insufficient_data:' entries rather than guessing.

Design constraints:
  - No status mutations.  Assist only.
  - The activities delegate generic ops persistence (config, run lifecycle,
    finding storage) to ops_revrec via named-activity wrappers so Temporal
    activity name collisions are avoided.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.technician_queue_assistant import run_technician_queue_assistant
from ..agents.tools.rental_data import (
    AppScope,
    InMemoryRentalReadModel,
    RentalDataStore,
    ToolValidationError,
    get_telematics,
    query_entity,
    query_facts,
    query_relationships,
    query_time_series,
)
from . import ops_revrec

logger = logging.getLogger(__name__)

_MAX_SCOPED_ITEMS = 200
_STALE_THRESHOLD_HOURS = 8
_DEFAULT_TECHNICIAN_QUEUE_AGENT_KEY = "technician-morning-queue"

_TECH_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_telematics",
    )
}
_TECH_TOOL_HANDLERS = {
    "query_entity": query_entity,
    "query_time_series": query_time_series,
    "query_relationships": query_relationships,
    "query_facts": query_facts,
    "get_telematics": get_telematics,
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _extract_tool_name(tool: Mapping[str, Any]) -> str | None:
    function = tool.get("function")
    if not isinstance(function, Mapping):
        return None
    name = function.get("name")
    return str(name) if isinstance(name, str) and name else None


def _tool_definition(tool_name: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool_name,
            "description": "Read-only technician evidence tool",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": True},
        },
    }


def _normalize_tools(configured_tools: Sequence[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tool in configured_tools:
        if isinstance(tool, Mapping):
            normalized_tool = dict(tool)
            name = _extract_tool_name(normalized_tool)
            if name and name in seen:
                continue
            if name:
                seen.add(name)
            normalized.append(normalized_tool)
            continue
        if not isinstance(tool, str):
            continue
        expanded = _TECH_TOOL_GROUPS.get(tool, (tool,))
        for tool_name in expanded:
            if tool_name in seen:
                continue
            seen.add(tool_name)
            normalized.append(_tool_definition(tool_name))
    return normalized


def _dict_list(value: Any) -> list[dict[str, Any]]:
    return (
        [dict(item) for item in value if isinstance(item, Mapping)]
        if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray)
        else []
    )


def _is_stale(ts_str: str | None, threshold_hours: int = _STALE_THRESHOLD_HOURS) -> bool:
    """Return True when the timestamp is older than threshold_hours or absent."""
    if not ts_str:
        return True
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt < datetime.now(UTC) - timedelta(hours=threshold_hours)
    except ValueError:
        return True


def _tech_store_from_item_payload(item_payload: Mapping[str, Any]) -> RentalDataStore:
    payload = (
        item_payload.get("rental_data")
        if isinstance(item_payload.get("rental_data"), Mapping)
        else {}
    )
    model = InMemoryRentalReadModel(
        entity_rows=_dict_list(payload.get("entities")),
        relationship_rows=_dict_list(payload.get("relationships")),
        fact_rows=_dict_list(payload.get("facts")),
        time_series_rows=_dict_list(payload.get("time_series")),
        invoice_rows=[],
        rate_card_rows=[],
        telematics_rows=_dict_list(payload.get("telematics")),
    )
    return RentalDataStore(read_model=model)


def _tech_tool_executor(
    item_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
):
    enabled_tools = {name for name in (_extract_tool_name(t) for t in configured_tools) if name}
    store = _tech_store_from_item_payload(item_payload)
    scope = AppScope(tenant_id=str(item_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _TECH_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


def _item_finding_for_storage(item: dict[str, Any]) -> dict[str, Any]:
    """Map TechnicianQueueItemV1 fields onto the generic finding schema."""
    asset_id = str(item.get("asset_id") or "")
    work_order_id = str(item.get("work_order_id") or "")
    priority = str(item.get("priority") or "medium")
    _priority_to_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    return {
        **item,
        "contract_id": asset_id or None,
        "line_item_id": work_order_id or None,
        "finding_type": str(item.get("item_type") or "active_repair"),
        "severity": _priority_to_severity.get(priority, priority),
        "proposed_action": str(item.get("recommendation") or ""),
        "expected": {
            "item_type": item.get("item_type"),
            "priority_reasons": item.get("priority_reasons", []),
            "blockers": item.get("blockers", []),
            "contract_risk": item.get("contract_risk", False),
            "overdue_maintenance": item.get("overdue_maintenance", False),
            "parts_blocker": item.get("parts_blocker", False),
            "has_return_condition_evidence": item.get("has_return_condition_evidence", False),
            "rent_ready_eta": item.get("rent_ready_eta"),
            "is_stale_data": item.get("is_stale_data", False),
            "stale_signals": item.get("stale_signals", []),
            "operating_model_tags": item.get("operating_model_tags", []),
        },
        "billed": {},
        "delta": None,
    }


# ---------------------------------------------------------------------------
# Scoping activity
# ---------------------------------------------------------------------------

@activity.defn
def ops_technician_queue_scope(
    tenant_id: str,
    branch_id: str | None,
    run_date: str | None,
) -> list[dict[str, Any]]:
    """Scope technician queue candidates from returned units, PM work orders,
    and active maintenance records.

    Returns a list of item payloads ready for ``ops_technician_queue_assess``.
    Each payload carries ``item_type``, ``asset_id``, ``tenant_id``,
    ``last_updated_at``, and a ``rental_data`` block for AI tool calls.

    Item types returned:
      returned_unit   — assets with operational_status = 'returned' needing
                        inspection/repair follow-up (t1)
      pm_work         — open PM work orders ready for execution (t2)
      active_repair   — open/in-progress maintenance records (t2)
      rent_ready_check— maintenance records in 'completed' or 'pending_approval'
                        state — confirm and return to fleet (t5)
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    scoped: list[dict[str, Any]] = []

    # 1. Returned units needing inspection / repair follow-up (t1)
    returned_asset_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "asset"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    _returned_statuses = {"returned", "on_inspection_hold"}
    seen_asset_ids: set[str] = set()
    for row in returned_asset_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        if str(data.get("tenant_id") or "") != tenant_id:
            continue
        op_status = str(data.get("operational_status") or "")
        if op_status not in _returned_statuses:
            continue
        asset_id = str(row.get("entity_id") or "")
        if not asset_id:
            continue

        if branch_id:
            branch_rels = client.select(
                "rental_current_relationships",
                columns="parent_id,child_id",
                filters={"relationship_type": "branch_has_asset", "child_id": asset_id, "parent_id": branch_id},
                limit=1,
            )
            if not branch_rels:
                continue

        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)

        # Check for existing return condition evidence (inspection records).
        inspection_rels = client.select(
            "rental_current_relationships",
            columns="parent_id,child_id,relationship_type",
            filters={"relationship_type": "asset_has_inspection", "parent_id": asset_id},
            limit=1,
        )
        has_return_condition_evidence = len(inspection_rels) > 0

        seen_asset_ids.add(asset_id)
        scoped.append({
            "tenant_id": tenant_id,
            "asset_id": asset_id,
            "item_type": "returned_unit",
            "work_order_id": None,
            "operational_status": op_status,
            "has_return_condition_evidence": has_return_condition_evidence,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [dict(row)],
                "relationships": [dict(r) for r in inspection_rels],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    # 2. Open PM work orders ready for execution (t2 — pm_work)
    pm_wo_rows = client.select(
        "pm_work_orders",
        columns="id, tenant_id, asset_id, policy_id, trigger_type, status, reason, run_id, created_at, updated_at",
        filters={"tenant_id": tenant_id, "status": "open"},
        order_by="created_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in pm_wo_rows:
        asset_id = str(row.get("asset_id") or "")
        if not asset_id:
            continue
        if branch_id:
            branch_rels = client.select(
                "rental_current_relationships",
                columns="parent_id,child_id",
                filters={"relationship_type": "branch_has_asset", "child_id": asset_id, "parent_id": branch_id},
                limit=1,
            )
            if not branch_rels:
                continue

        last_updated = str(row.get("updated_at") or row.get("created_at") or "")
        stale = _is_stale(last_updated)

        # Gather asset entity state for evidence.
        asset_rows = client.select(
            "rental_current_entity_state",
            columns="entity_id, name, entity_type, data, updated_at",
            filters={"entity_id": asset_id, "entity_type": "asset"},
            limit=1,
        )
        asset_data = dict(asset_rows[0]) if asset_rows else {}

        seen_asset_ids.add(asset_id)
        scoped.append({
            "tenant_id": tenant_id,
            "asset_id": asset_id,
            "item_type": "pm_work",
            "work_order_id": str(row.get("id") or ""),
            "trigger_type": str(row.get("trigger_type") or ""),
            "policy_id": str(row.get("policy_id") or ""),
            "reason": str(row.get("reason") or ""),
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [asset_data] if asset_data else [],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    # 3. Active repairs and rent-ready checks from maintenance records (t2 / t5)
    maint_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "maintenance_record"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    _active_statuses = {"open", "in_progress", "pending"}
    _near_complete_statuses = {"completed", "pending_approval"}
    for row in maint_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        if str(data.get("tenant_id") or "") != tenant_id:
            continue
        status = str(data.get("status") or "")
        if status not in _active_statuses | _near_complete_statuses:
            continue

        maint_id = str(row.get("entity_id") or "")
        if not maint_id:
            continue

        # Resolve asset via relationship.
        asset_rels = client.select(
            "rental_current_relationships",
            columns="parent_id,child_id,relationship_type",
            filters={"relationship_type": "asset_has_maintenance_record", "child_id": maint_id},
            limit=1,
        )
        asset_id = str(asset_rels[0].get("parent_id") or "") if asset_rels else str(data.get("asset_id") or "")
        if not asset_id:
            continue

        if branch_id:
            branch_rels = client.select(
                "rental_current_relationships",
                columns="parent_id,child_id",
                filters={"relationship_type": "branch_has_asset", "child_id": asset_id, "parent_id": branch_id},
                limit=1,
            )
            if not branch_rels:
                continue

        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)
        parts_blocked = bool(data.get("parts_blocked") or data.get("parts_hold"))

        item_type = "rent_ready_check" if status in _near_complete_statuses else "active_repair"

        asset_rows = client.select(
            "rental_current_entity_state",
            columns="entity_id, name, entity_type, data, updated_at",
            filters={"entity_id": asset_id, "entity_type": "asset"},
            limit=1,
        )
        asset_data = dict(asset_rows[0]) if asset_rows else {}

        # Avoid double-scoping an asset that already appears as returned_unit or pm_work.
        # Maintenance records provide the work-execution view; we still add them even
        # if the asset appeared earlier so the technician sees all open work items.
        scoped.append({
            "tenant_id": tenant_id,
            "asset_id": asset_id,
            "item_type": item_type,
            "work_order_id": maint_id,
            "maintenance_status": status,
            "parts_blocked": parts_blocked,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [
                    dict(row),
                    *(([asset_data]) if asset_data else []),
                ],
                "relationships": [dict(r) for r in asset_rels] if asset_rels else [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    logger.info(
        "ops_technician_queue_scope",
        extra={
            "tenant_id": tenant_id,
            "branch_id": branch_id,
            "run_date": run_date,
            "total_scoped": len(scoped),
        },
    )
    return scoped[:_MAX_SCOPED_ITEMS]


# ---------------------------------------------------------------------------
# AI assessment activity
# ---------------------------------------------------------------------------

@activity.defn
async def ops_technician_queue_assess(
    item_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Run AI assessment for a single scoped technician queue item.

    Returns a ``TechnicianQueueItemV1`` dict enriched with priority_reasons,
    evidence, blockers, stale-data callouts, and operating-model tags.

    Fails closed: if prerequisite data is missing, the result has
    confidence=0 and priority_reasons contains 'insufficient_data:' entries.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or (
            "You are the technician morning-queue assistant for a rental equipment service technician "
            "or shop foreman. Your role is to evaluate a single queue item (returned unit, PM work "
            "order, active repair, or rent-ready check) and produce a disposition-ready, ranked "
            "recommendation. "
            "Always: cite explicit evidence; flag stale meter/tech/parts signals; "
            "surface contract_risk, overdue_maintenance, parts_blocker, and "
            "has_return_condition_evidence as boolean fields AND as human-readable priority_reasons. "
            "FAIL CLOSED: if you cannot determine priority because data is missing, set confidence=0 "
            "and add 'insufficient_data: <field>' entries to priority_reasons. "
            "Never guess a high-priority ranking when evidence is absent. "
            "Never mutate equipment status or promise rent-ready dates without technician/foreman approval."
        )
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or (
            "Evaluate technician queue item for asset {asset_id} (type: {item_type}) "
            "in tenant {tenant_id}. Context: {evidence_json}"
        )
    )
    prompt_variables = {
        "tenant_id": str(item_payload.get("tenant_id") or ""),
        "asset_id": str(item_payload.get("asset_id") or ""),
        "item_type": str(item_payload.get("item_type") or ""),
        "evidence_json": json.dumps(item_payload, sort_keys=True, default=str),
    }
    rendered_system = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user = ops_revrec.interpolate_prompt_template(user_prompt_template, prompt_variables)

    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            await asyncio.sleep(10)

    heartbeat_task = asyncio.ensure_future(_heartbeat_loop())
    try:
        tool_executor = _tech_tool_executor(item_payload, tools)
        result = await run_technician_queue_assistant(
            item_payload,
            system_prompt=rendered_system,
            user_prompt_template=rendered_user,
            tools=tools,
            tool_executor=tool_executor,
            max_tool_rounds=max_tool_rounds,
        )
        # Carry through fields that the AI may not reproduce.
        result.setdefault("asset_id", str(item_payload.get("asset_id") or ""))
        result.setdefault("item_type", str(item_payload.get("item_type") or "active_repair"))
        result.setdefault("work_order_id", item_payload.get("work_order_id"))
        result["tenant_id"] = str(item_payload.get("tenant_id") or "")
        return result
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


# ---------------------------------------------------------------------------
# Named-activity wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------

@activity.defn(name="ops_technician_queue_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_technician_queue_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_technician_queue_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_technician_queue_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_technician_queue_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_item_finding_for_storage(finding), run_id)


@activity.defn(name="ops_technician_queue_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _item_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_technician_queue_assess",
    "ops_technician_queue_scope",
]
