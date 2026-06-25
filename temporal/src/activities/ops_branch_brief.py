"""Branch morning-brief activities.

Scope, assess, and persist ranked brief items for the
BranchMorningBriefWorkflow.

Signal coverage (operating-model tags):
  - contract_exception  : open contracts with billing/AP exceptions (t1)
  - ap_hold             : contracts / billing accounts with an AP hold flag (t1)
  - utilization_outlier : branches or asset categories below utilization threshold (t1)
  - dispatch_exception  : delivery/pickup records that are at risk or late (t4)
  - maintenance_blocker : maintenance records blocking a promised delivery (t5)
  - unavailable_unit    : assets in non-rent-ready status that threaten active contracts (t5)
  - customer_followup   : high-value customers with open service or sales signals (t6)

Freshness:
  Any item whose last_updated_at is older than _STALE_THRESHOLD_HOURS is
  flagged as stale and the stale signal is added to the item payload so the
  AI can surface it explicitly in the recommendation.

Design constraints:
  - No status mutations.  Assist only.
  - Customer-facing, money-moving, or status-changing follow-ups remain
    human-approved actions; this module never initiates them.
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

from ..agents.branch_brief_assistant import run_branch_brief_assistant
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
_DEFAULT_BRANCH_BRIEF_AGENT_KEY = "branch-morning-brief"

_BRIEF_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_telematics",
    )
}
_BRIEF_TOOL_HANDLERS = {
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
            "description": "Read-only branch evidence tool",
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
        expanded = _BRIEF_TOOL_GROUPS.get(tool, (tool,))
        for tool_name in expanded:
            if tool_name in seen:
                continue
            seen.add(tool_name)
            normalized.append(_tool_definition(tool_name))
    return normalized


def _dict_list(value: Any) -> list[dict[str, Any]]:
    from collections.abc import Mapping as ABCMapping
    from collections.abc import Sequence as ABCSequence
    return (
        [dict(item) for item in value if isinstance(item, ABCMapping)]
        if isinstance(value, ABCSequence) and not isinstance(value, str | bytes | bytearray)
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


def _brief_store_from_item_payload(item_payload: Mapping[str, Any]) -> RentalDataStore:
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


def _brief_tool_executor(
    item_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
):
    enabled_tools = {name for name in (_extract_tool_name(t) for t in configured_tools) if name}
    store = _brief_store_from_item_payload(item_payload)
    scope = AppScope(tenant_id=str(item_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _BRIEF_TOOL_HANDLERS.get(tool_name)
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
    """Map BranchBriefItemV1 fields onto the generic finding schema."""
    source_record_id = str(item.get("source_record_id") or item.get("item_id") or "")
    secondary_record_id = str(item.get("secondary_record_id") or "")
    priority = str(item.get("priority") or "medium")
    _priority_to_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    return {
        **item,
        "contract_id": source_record_id or None,
        "line_item_id": secondary_record_id or None,
        "finding_type": str(item.get("item_type") or "contract_exception"),
        "severity": _priority_to_severity.get(priority, priority),
        "proposed_action": str(item.get("recommendation") or ""),
        "expected": {
            "item_type": item.get("item_type"),
            "owner_team": item.get("owner_team"),
            "blockers": item.get("blockers", []),
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
def ops_branch_brief_scope(
    tenant_id: str,
    branch_id: str | None,
) -> list[dict[str, Any]]:
    """Scope branch morning-brief candidates from contracts, utilization,
    dispatch, maintenance, and customer-history signals.

    Returns a list of item payloads ready for ``ops_branch_brief_assess``.
    Each payload carries ``item_type``, ``item_id``, ``tenant_id``,
    ``last_updated_at``, and a ``rental_data`` block for AI tool calls.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    scoped: list[dict[str, Any]] = []
    existing_ids: set[str] = set()

    # 1. Contract exceptions and AP holds (t1)
    contract_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "rental_contract"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in contract_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        status = str(data.get("status") or "")
        contract_id = str(row.get("entity_id") or "")
        if not contract_id:
            continue

        # Only surface contracts in exception-relevant states.
        if status not in ("active", "pending", "on_hold", "overdue", "disputed"):
            continue

        if branch_id:
            branch_rels = client.select(
                "rental_current_relationships",
                columns="parent_id,child_id",
                filters={"relationship_type": "branch_has_contract", "child_id": contract_id, "parent_id": branch_id},
                limit=1,
            )
            if not branch_rels:
                # Fallback: check via customer/job-site relationship
                branch_rels = client.select(
                    "rental_current_relationships",
                    columns="parent_id,child_id",
                    filters={"relationship_type": "branch_manages_contract", "child_id": contract_id, "parent_id": branch_id},
                    limit=1,
                )
                if not branch_rels:
                    continue

        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)

        ap_hold = bool(data.get("ap_hold") or data.get("on_hold") or status == "on_hold")
        item_type = "ap_hold" if ap_hold else "contract_exception"
        key = f"{item_type}:{contract_id}"
        if key in existing_ids:
            continue
        existing_ids.add(key)

        billing_account_id = str(data.get("billing_account_id") or "")

        # Gather billing account state for evidence.
        ba_rows: list[dict[str, Any]] = []
        if billing_account_id:
            ba_rows = client.select(
                "rental_current_entity_state",
                columns="entity_id, name, entity_type, data, updated_at",
                filters={"entity_id": billing_account_id, "entity_type": "billing_account"},
                limit=1,
            )

        scoped.append({
            "tenant_id": tenant_id,
            "item_id": contract_id,
            "item_type": item_type,
            "source_record_id": contract_id,
            "secondary_record_id": billing_account_id or None,
            "contract_status": status,
            "ap_hold": ap_hold,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [dict(row), *(ba_rows[:1])],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    # 2. Utilization outliers (t1) — branches or categories below threshold
    util_rows = client.select(
        "rental_asset_availability_current",
        columns="*",
        filters={"branch_id": branch_id} if branch_id else {},
        order_by="utilization_rate_pct",
        descending=False,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in util_rows:
        util_pct = _coerce_float(row.get("utilization_rate_pct") or row.get("utilization_rate") or 0)
        # Surface only meaningfully low-utilization signals (below 40%).
        if util_pct >= 40.0:
            continue
        category = str(row.get("asset_category_name") or row.get("category_id") or "")
        b_id = str(row.get("branch_id") or "")
        item_id = f"util:{b_id}:{category}"
        if item_id in existing_ids:
            continue
        existing_ids.add(item_id)

        last_updated = str(row.get("last_updated") or row.get("updated_at") or "")
        stale = _is_stale(last_updated)

        scoped.append({
            "tenant_id": tenant_id,
            "item_id": item_id,
            "item_type": "utilization_outlier",
            "source_record_id": b_id or None,
            "secondary_record_id": category or None,
            "utilization_pct": util_pct,
            "branch_name": str(row.get("branch_name") or b_id),
            "asset_category": category,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [dict(row)],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    # 3. Dispatch exceptions (t4) — delivery/pickup records at risk or late
    dispatch_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "dispatch_record"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in dispatch_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        dispatch_status = str(data.get("status") or "")
        if dispatch_status not in ("at_risk", "late", "failed", "exception"):
            continue
        dispatch_id = str(row.get("entity_id") or "")
        if not dispatch_id:
            continue
        key = f"dispatch:{dispatch_id}"
        if key in existing_ids:
            continue

        if branch_id:
            branch_rels = client.select(
                "rental_current_relationships",
                columns="parent_id,child_id",
                filters={"relationship_type": "branch_has_dispatch", "child_id": dispatch_id, "parent_id": branch_id},
                limit=1,
            )
            if not branch_rels:
                continue

        existing_ids.add(key)
        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)
        contract_id = str(data.get("contract_id") or "")

        scoped.append({
            "tenant_id": tenant_id,
            "item_id": dispatch_id,
            "item_type": "dispatch_exception",
            "source_record_id": dispatch_id,
            "secondary_record_id": contract_id or None,
            "dispatch_status": dispatch_status,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [dict(row)],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    # 4. Maintenance blockers threatening active contracts (t5)
    maint_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "maintenance_record"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in maint_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        maint_status = str(data.get("status") or "")
        if maint_status not in ("open", "in_progress", "pending"):
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

        # Only surface if the asset has an active contract relationship.
        active_contract_rels = client.select(
            "rental_current_relationships",
            columns="parent_id,child_id",
            filters={"relationship_type": "contract_has_asset", "child_id": asset_id},
            limit=1,
        )
        if not active_contract_rels:
            continue

        key = f"maint:{maint_id}"
        if key in existing_ids:
            continue
        existing_ids.add(key)

        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)
        parts_blocked = bool(data.get("parts_blocked") or data.get("parts_hold"))

        asset_rows = client.select(
            "rental_current_entity_state",
            columns="entity_id, name, entity_type, data, updated_at",
            filters={"entity_id": asset_id, "entity_type": "asset"},
            limit=1,
        )
        asset_data = dict(asset_rows[0]) if asset_rows else {}

        scoped.append({
            "tenant_id": tenant_id,
            "item_id": maint_id,
            "item_type": "maintenance_blocker",
            "source_record_id": asset_id,
            "secondary_record_id": maint_id,
            "maintenance_status": maint_status,
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

    # 5. Unavailable units that may threaten scheduled deliveries (t5)
    na_asset_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "asset"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    _na_statuses = {"in_maintenance", "on_inspection_hold"}
    for row in na_asset_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        op_status = str(data.get("operational_status") or "")
        if op_status not in _na_statuses:
            continue
        asset_id = str(row.get("entity_id") or "")
        if not asset_id:
            continue
        key = f"na:{asset_id}"
        if key in existing_ids:
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

        existing_ids.add(key)
        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)

        scoped.append({
            "tenant_id": tenant_id,
            "item_id": asset_id,
            "item_type": "unavailable_unit",
            "source_record_id": asset_id,
            "secondary_record_id": None,
            "operational_status": op_status,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [dict(row)],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    # 6. High-value customer follow-up prompts (t6)
    customer_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "customer"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in customer_rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        # Only surface customers flagged for follow-up or with open service issues.
        needs_followup = bool(
            data.get("needs_followup")
            or data.get("service_issue_open")
            or data.get("ar_overdue")
            or data.get("at_risk")
        )
        if not needs_followup:
            continue
        customer_id = str(row.get("entity_id") or "")
        if not customer_id:
            continue
        key = f"customer:{customer_id}"
        if key in existing_ids:
            continue

        if branch_id:
            branch_rels = client.select(
                "rental_current_relationships",
                columns="parent_id,child_id",
                filters={"relationship_type": "branch_has_customer", "child_id": customer_id, "parent_id": branch_id},
                limit=1,
            )
            if not branch_rels:
                continue

        existing_ids.add(key)

        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)

        scoped.append({
            "tenant_id": tenant_id,
            "item_id": customer_id,
            "item_type": "customer_followup",
            "source_record_id": customer_id,
            "secondary_record_id": None,
            "customer_name": str(row.get("name") or customer_id),
            "followup_reason": (
                "ar_overdue" if data.get("ar_overdue")
                else "service_issue" if data.get("service_issue_open")
                else "at_risk" if data.get("at_risk")
                else "flagged"
            ),
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [dict(row)],
                "relationships": [],
                "facts": [],
                "time_series": [],
                "telematics": [],
            },
        })

    logger.info(
        "ops_branch_brief_scope",
        extra={
            "tenant_id": tenant_id,
            "branch_id": branch_id,
            "total_scoped": len(scoped),
        },
    )
    return scoped[:_MAX_SCOPED_ITEMS]


# ---------------------------------------------------------------------------
# AI assessment activity
# ---------------------------------------------------------------------------

@activity.defn
async def ops_branch_brief_assess(
    item_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Run AI assessment for a single scoped branch brief item.

    Returns a ``BranchBriefItemV1`` dict enriched with evidence, blockers,
    stale-data callouts, and operating-model tags.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or (
            "You are the branch morning-brief assistant for a branch operations manager at an "
            "equipment-rental company. Your role is to evaluate a single branch exception or "
            "opportunity item and produce a disposition-ready recommendation. Always: cite "
            "evidence from the provided data; flag stale signals; identify the owner team; "
            "never initiate customer-facing, money-moving, or status-changing actions — "
            "those require manager approval."
        )
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or (
            "Evaluate branch brief item {item_id} (type: {item_type}) "
            "in tenant {tenant_id}. Context: {evidence_json}"
        )
    )
    prompt_variables = {
        "tenant_id": str(item_payload.get("tenant_id") or ""),
        "item_id": str(item_payload.get("item_id") or ""),
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
        tool_executor = _brief_tool_executor(item_payload, tools)
        result = await run_branch_brief_assistant(
            item_payload,
            system_prompt=rendered_system,
            user_prompt_template=rendered_user,
            tools=tools,
            tool_executor=tool_executor,
            max_tool_rounds=max_tool_rounds,
        )
        # Carry through fields that the AI may not reproduce.
        result.setdefault("item_id", str(item_payload.get("item_id") or ""))
        result.setdefault("item_type", str(item_payload.get("item_type") or "contract_exception"))
        result.setdefault("source_record_id", item_payload.get("source_record_id"))
        result.setdefault("secondary_record_id", item_payload.get("secondary_record_id"))
        result["tenant_id"] = str(item_payload.get("tenant_id") or "")
        return result
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


# ---------------------------------------------------------------------------
# Named-activity wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------

@activity.defn(name="ops_branch_brief_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_branch_brief_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_branch_brief_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_branch_brief_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_branch_brief_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_item_finding_for_storage(finding), run_id)


@activity.defn(name="ops_branch_brief_record_finding_disposition")
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
    "_is_stale",
    "_item_finding_for_storage",
    "ops_branch_brief_assess",
    "ops_branch_brief_scope",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
]
