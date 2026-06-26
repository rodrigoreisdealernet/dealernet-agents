"""Disposition recommendation queue activities.

Scope, assess, and persist ranked disposition findings for the
DispositionQueueWorkflow.

Trigger coverage:
  - monthly_review  : scheduled monthly run for all tenant assets
  - threshold_breach: on-demand run when an asset crosses a configured
                      age, utilization, or maintenance-cost threshold

Design constraints:
  - No sale, retirement, or replacement purchase is ever executed automatically.
  - Assist only — the executive reviews and approves from the queue.
  - At most one active finding per asset; re-running upserts the existing finding.
  - Stale findings (assets no longer crossing thresholds) are retired explicitly.
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

from ..agents.disposition_recommender import run_disposition_recommender
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

_MAX_SCOPED_ASSETS = 500
_STALE_THRESHOLD_DAYS = 14
_DEFAULT_AGE_MONTHS_THRESHOLD = 84  # 7 years
_DEFAULT_UTILIZATION_THRESHOLD_PCT = 20.0
_DEFAULT_MAINTENANCE_COST_RATIO = 0.15  # 15% of asset value per year
_AGENT_KEY = "disposition-queue"

_DISPOSITION_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_telematics",
    )
}
_DISPOSITION_TOOL_HANDLERS = {
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


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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
            "description": "Read-only disposition evidence tool",
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
        expanded = _DISPOSITION_TOOL_GROUPS.get(tool, (tool,))
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


def _is_stale(ts_str: str | None, threshold_days: int = _STALE_THRESHOLD_DAYS) -> bool:
    if not ts_str:
        return True
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt < datetime.now(UTC) - timedelta(days=threshold_days)
    except ValueError:
        return True


def _months_since(ts_str: str | None) -> int | None:
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        delta = datetime.now(UTC) - dt
        # approx 30.44 days/month — sufficient for threshold comparisons (±1 month at boundaries)
        return max(0, int(delta.days / 30.44))
    except ValueError:
        return None


def _asset_store_from_payload(asset_payload: Mapping[str, Any]) -> RentalDataStore:
    payload = (
        asset_payload.get("rental_data")
        if isinstance(asset_payload.get("rental_data"), Mapping)
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


def _asset_tool_executor(
    asset_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
):
    enabled_tools = {name for name in (_extract_tool_name(t) for t in configured_tools) if name}
    store = _asset_store_from_payload(asset_payload)
    scope = AppScope(tenant_id=str(asset_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _DISPOSITION_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


def _finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    """Map DispositionRecommendationV1 fields onto the generic finding schema."""
    asset_id = str(finding.get("asset_id") or "")
    action = str(finding.get("recommended_action") or "keep")
    _action_severity = {"keep": "low", "sell_now": "high", "replace": "critical"}
    priority = str(finding.get("priority") or "medium")
    _priority_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    severity = _priority_severity.get(priority, _action_severity.get(action, "medium"))
    return {
        **finding,
        "contract_id": asset_id,
        "line_item_id": None,
        "finding_type": f"disposition_{action}",
        "severity": severity,
        "expected": {
            "recommended_action": action,
            "timing_rationale": finding.get("timing_rationale"),
            "age_months": finding.get("age_months"),
            "estimated_residual_value": finding.get("estimated_residual_value"),
            "total_cost_of_ownership": finding.get("total_cost_of_ownership"),
            "is_stale_data": finding.get("is_stale_data", False),
            "stale_signals": list(finding.get("stale_signals") or []),
            "operating_model_tags": list(finding.get("operating_model_tags") or []),
        },
    }


# ---------------------------------------------------------------------------
# Scope activity
# ---------------------------------------------------------------------------

@activity.defn
def ops_disposition_scope(
    tenant_id: str,
    run_context: dict[str, Any],
) -> list[dict[str, Any]]:
    """Scope candidate assets whose lifecycle metrics cross configured thresholds.

    Candidates are selected when any of the following conditions is true:
    - age_months >= age_months_threshold (default 84 months / 7 years)
    - utilization_pct <= utilization_pct_threshold (default 20%)
    - maintenance_cost_ratio >= maintenance_cost_ratio_threshold (default 0.15)

    Returns enriched asset payloads ready for ``ops_disposition_assess``.
    Each payload carries lifecycle facts, maintenance history, utilization
    time-series, and a ``rental_data`` block for AI tool calls.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    age_threshold = _coerce_float(run_context.get("age_months_threshold")) or _DEFAULT_AGE_MONTHS_THRESHOLD
    util_threshold = _coerce_float(run_context.get("utilization_pct_threshold")) or _DEFAULT_UTILIZATION_THRESHOLD_PCT
    maint_ratio_threshold = _coerce_float(run_context.get("maintenance_cost_ratio_threshold")) or _DEFAULT_MAINTENANCE_COST_RATIO
    trigger_type = str(run_context.get("trigger_type") or "monthly_review")

    assets = client.select(
        "rental_current_entity_state",
        columns="entity_id,entity_type,data,updated_at",
        filters={"entity_type": "asset"},
        limit=_MAX_SCOPED_ASSETS,
    )
    all_entities = client.select(
        "rental_current_entity_state",
        columns="entity_id,entity_type,data,updated_at",
    )
    relationships = client.select("rental_current_relationships")
    fact_types = client.select("fact_types", columns="id,key")
    facts = client.select("entity_facts")
    time_series = client.select("time_series_points")

    fact_key_by_id = {str(row.get("id")): str(row.get("key") or "") for row in fact_types}
    entities_by_id: dict[str, dict[str, Any]] = {
        str(row.get("entity_id") or ""): dict(row) for row in all_entities
    }

    def _entity_data(entity_id: str) -> dict[str, Any]:
        row = entities_by_id.get(entity_id, {})
        data = row.get("data")
        return dict(data) if isinstance(data, Mapping) else {}

    scoped: list[dict[str, Any]] = []
    for row in assets:
        data = row.get("data")
        if not isinstance(data, Mapping):
            continue
        data = dict(data)
        if str(data.get("tenant_id") or "") != tenant_id:
            continue

        asset_id = str(row.get("entity_id") or "")
        if not asset_id:
            continue

        commissioned_at = str(data.get("commissioned_at") or data.get("purchase_date") or "")
        age_months = _months_since(commissioned_at)

        utilization_pct = _coerce_float(data.get("utilization_pct") or data.get("fleet_utilization_pct") or 100.0)
        asset_points = [
            dict(pt)
            for pt in time_series
            if str(pt.get("entity_id") or "") == asset_id
        ]
        utilization_values = []
        for pt in asset_points:
            dp = pt.get("data_payload")
            if not isinstance(dp, Mapping):
                continue
            fk = str(pt.get("fact_key") or fact_key_by_id.get(str(pt.get("fact_type_id") or ""), "")).lower()
            if "utilization_pct" in dp or "utilization" in fk:
                utilization_values.append(_coerce_float(dp.get("utilization_pct") or dp.get("value")))
        if utilization_values:
            utilization_pct = sum(utilization_values) / len(utilization_values)

        asset_facts = [
            {
                "fact_id": fact.get("id"),
                "entity_id": fact.get("entity_id"),
                "fact_key": fact_key_by_id.get(str(fact.get("fact_type_id") or ""), ""),
                "value": fact.get("value"),
                "unit": fact.get("unit"),
                "metadata": dict(fact.get("metadata") or {}) if isinstance(fact.get("metadata"), Mapping) else {},
            }
            for fact in facts
            if str(fact.get("entity_id") or "") == asset_id
        ]

        maintenance_cost = sum(
            _coerce_float(f.get("value"))
            for f in asset_facts
            if any(kw in str(f.get("fact_key") or "").lower() for kw in ("maintenance_cost", "repair_cost", "service_cost"))
        )
        asset_value = _coerce_float(data.get("purchase_price") or data.get("asset_value") or 0.0)
        maintenance_cost_ratio = (maintenance_cost / asset_value) if asset_value > 0 else 0.0

        candidate = False
        trigger_reasons: list[str] = []

        if age_months is not None and age_months >= age_threshold:
            candidate = True
            trigger_reasons.append(f"age_months={age_months} >= threshold={int(age_threshold)}")
        if utilization_pct <= util_threshold:
            candidate = True
            trigger_reasons.append(f"utilization_pct={utilization_pct:.1f}% <= threshold={util_threshold:.1f}%")
        if maintenance_cost_ratio >= maint_ratio_threshold:
            candidate = True
            trigger_reasons.append(
                f"maintenance_cost_ratio={maintenance_cost_ratio:.3f} >= threshold={maint_ratio_threshold:.3f}"
            )

        if not candidate:
            continue

        relevant_entity_ids = {asset_id}
        branch_id = str(data.get("branch_id") or "")
        category_id = str(data.get("category_id") or "")
        if branch_id:
            relevant_entity_ids.add(branch_id)
        if category_id:
            relevant_entity_ids.add(category_id)
        for rel in relationships:
            parent_id = str(rel.get("parent_id") or "")
            child_id = str(rel.get("child_id") or "")
            if parent_id in relevant_entity_ids or child_id in relevant_entity_ids:
                if parent_id:
                    relevant_entity_ids.add(parent_id)
                if child_id:
                    relevant_entity_ids.add(child_id)

        scoped_entities = [
            dict(entities_by_id[eid])
            for eid in relevant_entity_ids
            if eid in entities_by_id
        ]
        relevant_facts = [
            {
                "fact_id": fact.get("id"),
                "entity_id": fact.get("entity_id"),
                "fact_key": fact_key_by_id.get(str(fact.get("fact_type_id") or ""), ""),
                "value": fact.get("value"),
                "unit": fact.get("unit"),
                "metadata": dict(fact.get("metadata") or {}) if isinstance(fact.get("metadata"), Mapping) else {},
            }
            for fact in facts
            if str(fact.get("entity_id") or "") in relevant_entity_ids
        ]
        relevant_ts = [
            {
                "point_id": pt.get("id"),
                "entity_id": pt.get("entity_id"),
                "fact_key": fact_key_by_id.get(str(pt.get("fact_type_id") or ""), ""),
                "observed_at": pt.get("observed_at"),
                "data_payload": dict(pt.get("data_payload") or {}) if isinstance(pt.get("data_payload"), Mapping) else {},
                "metadata": dict(pt.get("metadata") or {}) if isinstance(pt.get("metadata"), Mapping) else {},
            }
            for pt in time_series
            if str(pt.get("entity_id") or "") in relevant_entity_ids
        ]
        relevant_relationships = [
            dict(rel)
            for rel in relationships
            if str(rel.get("parent_id") or "") in relevant_entity_ids
            or str(rel.get("child_id") or "") in relevant_entity_ids
        ]
        telematics_ts = [
            pt for pt in relevant_ts
            if any(kw in str(pt.get("fact_key") or "").lower() for kw in ("telematics", "gps", "engine_hours", "odometer"))
        ]

        last_updated = str(row.get("updated_at") or "")
        stale_signals: list[str] = []
        if _is_stale(last_updated):
            stale_signals.append("Asset entity record is stale or not recently updated.")
        if not utilization_values:
            stale_signals.append("Utilization signal is missing from time series.")

        scoped.append(
            {
                "tenant_id": tenant_id,
                "asset_id": asset_id,
                "branch_id": branch_id,
                "category_id": category_id,
                "status": str(data.get("status") or ""),
                "age_months": age_months,
                "commissioned_at": commissioned_at,
                "utilization_pct": utilization_pct,
                "maintenance_cost": maintenance_cost,
                "asset_value": asset_value,
                "maintenance_cost_ratio": maintenance_cost_ratio,
                "trigger_type": trigger_type,
                "trigger_reasons": trigger_reasons,
                "stale_signals": stale_signals,
                "is_stale_hint": bool(stale_signals),
                "last_updated_at": last_updated,
                "rental_data": {
                    "entities": scoped_entities,
                    "relationships": relevant_relationships,
                    "facts": relevant_facts,
                    "time_series": relevant_ts,
                    "telematics": telematics_ts,
                },
            }
        )

    logger.info(
        "ops_disposition_scope",
        extra={
            "tenant_id": tenant_id,
            "trigger_type": trigger_type,
            "total_scoped": len(scoped),
        },
    )
    return scoped


# ---------------------------------------------------------------------------
# List existing findings (for supersede / retire logic)
# ---------------------------------------------------------------------------

@activity.defn
def ops_disposition_list_existing_findings(tenant_id: str) -> list[dict[str, Any]]:
    """Return all open disposition findings for supersede / retire comparison.

    Returns the minimal set of fields needed for deduplication: finding id,
    fingerprint, asset_id, and the previously recommended_action.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    rows = client.select(
        "finding",
        filters={"tenant_id": tenant_id, "status": "pending_approval"},
        limit=5000,
    )
    result = []
    for row in rows:
        agent_key = str(row.get("agent_key") or "")
        if agent_key != _AGENT_KEY:
            continue
        expected = row.get("expected")
        result.append({
            "id": row.get("id"),
            "fingerprint": str(row.get("fingerprint") or ""),
            "asset_id": str((dict(expected).get("asset_id") if isinstance(expected, Mapping) else None) or row.get("contract_id") or ""),
            "recommended_action": str((dict(expected).get("recommended_action") if isinstance(expected, Mapping) else None) or "keep"),
        })
    return result


# ---------------------------------------------------------------------------
# Retire-stale activity
# ---------------------------------------------------------------------------

@activity.defn
def ops_disposition_retire_stale_findings(
    tenant_id: str,
    active_asset_ids: list[str],
    run_id: str,
) -> int:
    """Retire disposition findings for assets no longer in the candidate scope.

    When an asset has improved beyond all thresholds (no longer a candidate),
    any pending disposition finding for that asset is marked as superseded so
    the executive queue stays clean.

    Returns the number of findings retired.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    active_set = set(active_asset_ids)
    rows = client.select(
        "finding",
        filters={"tenant_id": tenant_id, "status": "pending_approval"},
        limit=5000,
    )
    retired = 0
    for row in rows:
        agent_key = str(row.get("agent_key") or "")
        if agent_key != _AGENT_KEY:
            continue
        fingerprint = str(row.get("fingerprint") or "")
        expected = row.get("expected")
        asset_id = str(
            (dict(expected).get("asset_id") if isinstance(expected, Mapping) else None)
            or row.get("contract_id")
            or ""
        )
        if asset_id and asset_id not in active_set:
            client.update(
                "finding",
                {"status": "superseded", "run_id": run_id},
                filters={"fingerprint": fingerprint, "tenant_id": tenant_id},
            )
            retired += 1
    logger.info(
        "ops_disposition_retire_stale_findings",
        extra={"tenant_id": tenant_id, "retired": retired},
    )
    return retired


# ---------------------------------------------------------------------------
# AI assessment activity
# ---------------------------------------------------------------------------

@activity.defn
async def ops_disposition_assess(
    asset_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Run AI assessment for a single scoped asset disposition finding.

    Returns a ``DispositionRecommendationV1`` dict enriched with evidence,
    stale-data callouts, and operating-model tags.
    """
    bounds = config.get("bounds") or {}
    locale = str(config.get("locale") or "pt-BR")
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or (
            "You are the asset lifecycle disposition advisor for a Regional/Enterprise Operations "
            "Executive at an equipment-rental company. Your role is to evaluate a single asset and "
            "produce a canonical disposition recommendation — keep, sell_now, or replace — with a "
            "timing rationale and evidence bundle for the executive to review. Always: cite "
            "utilization history, age, maintenance costs, and residual value evidence; flag stale "
            "signals explicitly; never execute a sale, retirement, purchase, or depreciation journal "
            "automatically."
        )
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or (
            "Evaluate lifecycle disposition for asset {asset_id} in tenant {tenant_id}. "
            "Age: {age_months} months. Utilization: {utilization_pct}%. "
            "Maintenance cost: {maintenance_cost} ({maintenance_cost_ratio} ratio). "
            "Trigger reasons: {trigger_reasons}. "
            "Stale signals: {stale_signals}. "
            "Provide a ranked disposition recommendation with timing rationale and evidence. "
            "Evidence: {evidence_json}"
        )
    )
    prompt_variables = {
        "tenant_id": str(asset_payload.get("tenant_id") or ""),
        "asset_id": str(asset_payload.get("asset_id") or ""),
        "age_months": str(asset_payload.get("age_months") or "unknown"),
        "utilization_pct": str(asset_payload.get("utilization_pct") or "unknown"),
        "maintenance_cost": str(asset_payload.get("maintenance_cost") or "0"),
        "maintenance_cost_ratio": str(asset_payload.get("maintenance_cost_ratio") or "0"),
        "trigger_reasons": ", ".join(list(asset_payload.get("trigger_reasons") or [])),
        "stale_signals": ", ".join(list(asset_payload.get("stale_signals") or [])),
        "evidence_json": json.dumps(asset_payload, sort_keys=True, default=str),
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
        tool_executor = _asset_tool_executor(asset_payload, tools)
        result = await run_disposition_recommender(
            asset_payload,
            system_prompt=rendered_system,
            user_prompt_template=rendered_user,
            tools=tools,
            tool_executor=tool_executor,
            locale=locale,
            max_tool_rounds=max_tool_rounds,
        )
        result.setdefault("asset_id", str(asset_payload.get("asset_id") or ""))
        result.setdefault("recommended_action", "keep")
        result.setdefault("timing_rationale", "")
        result.setdefault("confidence", 0.0)
        result.setdefault("evidence", [])
        result.setdefault("priority", "low")
        result.setdefault("rationale", "No rationale provided")
        result.setdefault("age_months", asset_payload.get("age_months"))
        result.setdefault("estimated_residual_value", None)
        result.setdefault("total_cost_of_ownership", asset_payload.get("maintenance_cost"))
        result.setdefault("is_stale_data", bool(asset_payload.get("stale_signals")))
        result.setdefault("stale_signals", list(asset_payload.get("stale_signals") or []))
        result["tenant_id"] = str(asset_payload.get("tenant_id") or "")
        result["branch_id"] = str(asset_payload.get("branch_id") or "")
        result["category_id"] = str(asset_payload.get("category_id") or "")
        result["trigger_type"] = str(asset_payload.get("trigger_type") or "monthly_review")
        result["trigger_reasons"] = list(asset_payload.get("trigger_reasons") or [])
        return result
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


# ---------------------------------------------------------------------------
# Named-activity wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------

@activity.defn(name="ops_disposition_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_disposition_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_disposition_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_disposition_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_disposition_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_finding_for_storage(finding), run_id)


@activity.defn(name="ops_disposition_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _finding_for_storage(finding), disposition, run_id, approver
    )


@activity.defn(name="ops_disposition_record_finding_review")
def ops_record_finding_review(
    tenant_id: str,
    fingerprint: str,
    reviewer_id: str,
    reviewer_name: str | None,
    decision: str,
    note: str | None,
    run_id: str,
) -> bool:
    """Persist an executive review decision for a queued disposition finding.

    Updates the finding row by fingerprint to record the reviewer's decision
    (accepted, deferred, rejected, or needs_more_info).  Informational only —
    no sale, retirement, replacement purchase, or depreciation journal is changed.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    approver: dict[str, Any] = {
        "reviewer_id": reviewer_id,
        "reviewer_name": reviewer_name or "",
        "decision": decision,
        "note": note or "",
        "reviewed_at": datetime.now(UTC).isoformat(),
    }
    client.update(
        "finding",
        {
            "status": "informational",
            "decided_at": datetime.now(UTC).isoformat(),
            "approver": approver,
        },
        filters={"fingerprint": fingerprint, "tenant_id": tenant_id},
    )
    logger.info(
        "ops_record_finding_review",
        extra={"tenant_id": tenant_id, "fingerprint": fingerprint, "decision": decision},
    )
    return True


__all__ = [
    "ops_disposition_scope",
    "ops_disposition_assess",
    "ops_disposition_list_existing_findings",
    "ops_disposition_retire_stale_findings",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_record_finding_review",
]
