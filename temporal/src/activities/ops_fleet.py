from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.fleet_auditor import run_fleet_auditor
from ..agents.tools.rental_data import (
    AppScope,
    InMemoryRentalReadModel,
    RentalDataStore,
    ToolValidationError,
    get_invoice_detail,
    get_rate_card,
    get_telematics,
    query_entity,
    query_facts,
    query_relationships,
    query_time_series,
)
from . import ops_revrec

_MAX_SCOPED_ASSETS = 1000
_MIN_SCOPED_ASSETS = 1
_DEFAULT_FLEET_REQUESTER = "ops-fleet-auditor"
_FLEET_HANDOFF_STATUS_DRAFT = "draft"
_STALE_THRESHOLD_HOURS = 8
_BENCHMARK_KEY_HINTS = (
    "benchmark_utilization_pct",
    "utilization_benchmark_pct",
    "target_utilization_pct",
    "fleet_utilization_benchmark_pct",
)
_TELEMATICS_KEY_HINTS = ("telematics", "gps", "engine_hours", "hours_meter", "odometer")
_KPI_KEY_HINTS = ("kpi", "demand_gap", "open_demand", "utilization")
_REVENUE_KEY_HINTS = ("revenue", "rental_revenue", "earned_revenue", "invoice_amount")
_MAINTENANCE_COST_KEY_HINTS = ("maintenance_cost", "repair_cost", "service_cost")
_DOWNTIME_KEY_HINTS = ("downtime", "down_hours", "downtime_hours", "out_of_service")
_RESALE_KEY_HINTS = ("resale", "residual_value", "market_value")
_REPLACEMENT_KEY_HINTS = ("replacement_cost", "replacement_value", "replacement_price")
_AGE_KEY_HINTS = ("age_years", "asset_age_years")
_SERVICE_HOURS_KEY_HINTS = ("service_hours", "hours_meter", "engine_hours")
_DEFAULT_SOURCE_STALE_THRESHOLD_HOURS = _STALE_THRESHOLD_HOURS
_SOURCE_GAP_MISSING_DEMAND_CATEGORY = "missing_demand_category"
_SOURCE_GAP_MISSING_HOME_BRANCH = "missing_home_branch"
_SOURCE_GAP_MISSING_BRANCH_CATEGORY_DEMAND = "missing_branch_category_demand"
_FLEET_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_invoice_detail",
        "get_rate_card",
        "get_telematics",
    )
}
_FLEET_TOOL_HANDLERS = {
    "query_entity": query_entity,
    "query_time_series": query_time_series,
    "query_relationships": query_relationships,
    "query_facts": query_facts,
    "get_invoice_detail": get_invoice_detail,
    "get_rate_card": get_rate_card,
    "get_telematics": get_telematics,
}
_CANONICAL_DISPOSITIONS = {"keep", "sell", "replace"}


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
            "description": "Read-only fleet evidence tool",
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
        expanded = _FLEET_TOOL_GROUPS.get(tool, (tool,))
        for tool_name in expanded:
            if tool_name in seen:
                continue
            seen.add(tool_name)
            normalized.append(_tool_definition(tool_name))
    return normalized


def _dict_list(value: Any) -> list[dict[str, Any]]:
    return [dict(item) for item in value if isinstance(item, Mapping)] if isinstance(value, Sequence) else []


def _fleet_store_from_asset_payload(asset_payload: Mapping[str, Any]) -> RentalDataStore:
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
        invoice_rows=_dict_list(payload.get("invoices")),
        rate_card_rows=_dict_list(payload.get("rate_cards")),
        telematics_rows=_dict_list(payload.get("telematics")),
    )
    return RentalDataStore(read_model=model)


def _point_observed_at(point: Mapping[str, Any]) -> datetime | None:
    return _parse_iso_datetime(str(point.get("observed_at") or ""))


def _parse_iso_datetime(value: str) -> datetime | None:
    if not value:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if candidate.endswith("Z"):
        candidate = f"{candidate[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _point_in_window(point: Mapping[str, Any], start_at: datetime | None, end_at: datetime | None) -> bool:
    if start_at is None and end_at is None:
        return True
    observed_at = _point_observed_at(point)
    if observed_at is None:
        return False
    if start_at is not None and observed_at < start_at:
        return False
    return not (end_at is not None and observed_at > end_at)


def _point_utilization_pct(point: Mapping[str, Any]) -> float | None:
    data_payload = point.get("data_payload")
    metadata = point.get("metadata")
    candidates = []
    if isinstance(data_payload, Mapping):
        candidates.extend(
            [
                data_payload.get("utilization_pct"),
                data_payload.get("fleet_utilization_pct"),
                data_payload.get("value"),
            ]
        )
    if isinstance(metadata, Mapping):
        candidates.extend([metadata.get("utilization_pct"), metadata.get("fleet_utilization_pct")])
    for value in candidates:
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _extract_numeric_value(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _point_numeric(point: Mapping[str, Any]) -> float | None:
    data_payload = point.get("data_payload")
    if isinstance(data_payload, Mapping):
        for key in (
            "value",
            "amount",
            "total",
            "revenue_amount",
            "cost",
            "hours",
            "downtime_hours",
            "reading_value",
        ):
            value = _extract_numeric_value(data_payload.get(key))
            if value is not None:
                return value
        for value in data_payload.values():
            numeric = _extract_numeric_value(value)
            if numeric is not None:
                return numeric
    metadata = point.get("metadata")
    if isinstance(metadata, Mapping):
        for value in metadata.values():
            numeric = _extract_numeric_value(value)
            if numeric is not None:
                return numeric
    return None


def _point_series(points: Sequence[Mapping[str, Any]], hints: Sequence[str]) -> list[dict[str, Any]]:
    series: list[dict[str, Any]] = []
    for point in points:
        if not _point_matches_hints(point, hints):
            continue
        value = _point_numeric(point)
        if value is None:
            continue
        series.append(
            {
                "value": value,
                "observed_at": point.get("observed_at"),
                "fact_key": point.get("fact_key"),
            }
        )
    series.sort(key=lambda row: str(row.get("observed_at") or ""))
    return series


def _fact_series(
    facts: Sequence[Mapping[str, Any]],
    fact_key_by_id: Mapping[str, str],
    hints: Sequence[str],
) -> list[dict[str, Any]]:
    series: list[dict[str, Any]] = []
    for fact in facts:
        fact_key = str(fact_key_by_id.get(str(fact.get("fact_type_id") or ""), "")).lower()
        if not any(hint in fact_key for hint in hints):
            continue
        value = _extract_numeric_value(fact.get("value"))
        if value is None:
            continue
        series.append(
            {
                "value": value,
                "observed_at": fact.get("updated_at") or fact.get("created_at"),
                "fact_key": fact_key,
            }
        )
    series.sort(key=lambda row: str(row.get("observed_at") or ""))
    return series


def _average(series: Sequence[Mapping[str, Any]]) -> float | None:
    values = [value for item in series for value in [_extract_numeric_value(item.get("value"))] if value is not None]
    if not values:
        return None
    return sum(values) / len(values)


def _latest_timestamp(rows: Sequence[Mapping[str, Any]], *, key: str) -> str | None:
    latest: datetime | None = None
    for row in rows:
        observed = _parse_iso_datetime(str(row.get(key) or ""))
        if observed is None:
            continue
        if latest is None or observed > latest:
            latest = observed
    return latest.isoformat() if latest is not None else None


def _is_stale(timestamp_value: str | None, threshold_hours: int = _STALE_THRESHOLD_HOURS) -> bool:
    if not timestamp_value:
        return True
    observed = _parse_iso_datetime(str(timestamp_value))
    if observed is None:
        return True
    return observed < datetime.now(UTC) - timedelta(hours=threshold_hours)


def _point_benchmark_pct(point: Mapping[str, Any]) -> float | None:
    data_payload = point.get("data_payload")
    metadata = point.get("metadata")
    candidates: list[Any] = []
    if isinstance(data_payload, Mapping):
        for key in _BENCHMARK_KEY_HINTS:
            candidates.append(data_payload.get(key))
        if any(hint in str(point.get("fact_key") or "").lower() for hint in _BENCHMARK_KEY_HINTS):
            candidates.append(data_payload.get("value"))
    if isinstance(metadata, Mapping):
        for key in _BENCHMARK_KEY_HINTS:
            candidates.append(metadata.get(key))
    for candidate in candidates:
        value = _extract_numeric_value(candidate)
        if value is not None:
            return value
    return None


def _point_matches_hints(point: Mapping[str, Any], hints: Sequence[str]) -> bool:
    fact_key = str(point.get("fact_key") or "").lower()
    if any(hint in fact_key for hint in hints):
        return True
    data_payload = point.get("data_payload")
    metadata = point.get("metadata")
    if isinstance(data_payload, Mapping) and any(
        any(hint in str(key).lower() for hint in hints) for key in data_payload
    ):
        return True
    if isinstance(metadata, Mapping):
        if any(any(hint in str(key).lower() for hint in hints) for key in metadata):
            return True
        if any(any(hint in str(value).lower() for hint in hints) for value in metadata.values()):
            return True
    return False


def _fleet_tool_executor(asset_payload: Mapping[str, Any], configured_tools: Sequence[Mapping[str, Any]]):
    enabled_tools = {name for name in (_extract_tool_name(tool) for tool in configured_tools) if name}
    store = _fleet_store_from_asset_payload(asset_payload)
    scope = AppScope(tenant_id=str(asset_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _FLEET_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


def _build_demand_gap_snapshot(
    *,
    category_id: str,
    home_branch_id: str,
    demand_counts_by_branch: Mapping[str, int],
    supply_counts_by_branch: Mapping[str, int],
) -> tuple[dict[str, Any], list[str]]:
    """Assemble branch/category demand-gap evidence for one scoped asset category.

    Returns a tuple of (snapshot, source_gaps). Source gaps are emitted whenever
    required scope/evidence is missing, which signals manual evidence is needed
    before automated sourcing actions are applied.
    """
    source_gaps: list[str] = []
    manual_evidence: list[str] = []
    if not category_id:
        source_gaps.append(_SOURCE_GAP_MISSING_DEMAND_CATEGORY)
        manual_evidence.append("Missing asset category scope for demand-gap sourcing.")
    if not home_branch_id:
        source_gaps.append(_SOURCE_GAP_MISSING_HOME_BRANCH)
        manual_evidence.append("Missing home branch scope for demand-gap sourcing.")
    if not demand_counts_by_branch:
        source_gaps.append(_SOURCE_GAP_MISSING_BRANCH_CATEGORY_DEMAND)
        manual_evidence.append("No branch/category demand evidence was found in the audit window.")
    branch_ids = sorted(set(demand_counts_by_branch).union(supply_counts_by_branch))
    branch_category_gaps = [
        {
            "branch_id": scoped_branch_id,
            "demand_count": int(demand_counts_by_branch.get(scoped_branch_id, 0)),
            "supply_count": int(supply_counts_by_branch.get(scoped_branch_id, 0)),
            "demand_gap": int(demand_counts_by_branch.get(scoped_branch_id, 0))
            - int(supply_counts_by_branch.get(scoped_branch_id, 0)),
            "is_home_branch": scoped_branch_id == home_branch_id,
        }
        for scoped_branch_id in branch_ids
    ]
    positive_candidates = sorted(
        (
            item
            for item in branch_category_gaps
            if not bool(item.get("is_home_branch")) and int(item.get("demand_gap", 0)) > 0
        ),
        key=lambda item: (-int(item.get("demand_gap", 0)), str(item.get("branch_id") or "")),
    )
    best_destination = positive_candidates[0] if positive_candidates else None
    home_demand = demand_counts_by_branch.get(home_branch_id)
    home_supply = supply_counts_by_branch.get(home_branch_id)
    home_gap = (
        int(home_demand or 0) - int(home_supply or 0)
        if home_branch_id
        else None
    )
    return (
        {
            "category_id": category_id or None,
            "home_branch_id": home_branch_id or None,
            "home_branch_demand_count": int(home_demand or 0) if home_branch_id else None,
            "home_branch_supply_count": int(home_supply or 0) if home_branch_id else None,
            "home_branch_gap": home_gap,
            "branch_category_gaps": branch_category_gaps,
            "best_destination_branch_id": best_destination.get("branch_id") if best_destination else None,
            "best_destination_gap": int(best_destination.get("demand_gap", 0)) if best_destination else None,
            "manual_evidence": manual_evidence,
        },
        source_gaps,
    )


@activity.defn
async def ops_fleet_assess(asset_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(config.get("system_prompt") or "Assess fleet utilization and recommend disposition.")
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Assess asset {asset_id} for tenant {tenant_id}. Evidence:\n{evidence_json}"
    )
    prompt_variables = {
        "tenant_id": str(asset_payload.get("tenant_id") or ""),
        "asset_id": str(asset_payload.get("asset_id") or ""),
        "evidence_json": json.dumps(asset_payload, sort_keys=True),
    }
    rendered_system_prompt = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user_prompt = ops_revrec.interpolate_prompt_template(user_prompt_template, prompt_variables)

    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            except Exception:
                return
            await asyncio.sleep(15)

    heartbeat_task = asyncio.create_task(_heartbeat_loop())
    try:
        result = await run_fleet_auditor(
            asset_payload,
            system_prompt=rendered_system_prompt,
            user_prompt_template=rendered_user_prompt,
            tools=tools,
            tool_executor=_fleet_tool_executor(asset_payload, tools),
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()

    result.setdefault("asset_id", str(asset_payload.get("asset_id") or ""))
    result.setdefault("utilization_pct", float(asset_payload.get("utilization_pct") or 0.0))
    result.setdefault("estimated_monthly_revenue_uplift", 0.0)
    result.setdefault("target_branch_id", None)
    result.setdefault("evidence", [])
    result.setdefault("confidence", 0.0)
    result.setdefault("disposition", "keep")
    result.setdefault("rationale", "No rationale provided")
    result["home_branch_id"] = str(asset_payload.get("home_branch_id") or "")
    return result


@activity.defn
def ops_scope_fleet_assets(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    client = ops_revrec._get_ops_persistence_client()
    max_assets = int(_coerce_float(run_context.get("max_assets")) or 200)
    max_assets = max(_MIN_SCOPED_ASSETS, min(max_assets, _MAX_SCOPED_ASSETS))
    thresholds = run_context.get("thresholds") if isinstance(run_context.get("thresholds"), Mapping) else {}
    utilization_threshold = float(
        run_context.get("utilization_threshold")
        if run_context.get("utilization_threshold") is not None
        else thresholds.get("utilization_pct_threshold", 0.0)
    )
    maintenance_cost_threshold = _extract_numeric_value(thresholds.get("maintenance_cost_threshold"))
    downtime_hours_threshold = _extract_numeric_value(thresholds.get("downtime_hours_threshold"))
    asset_age_years_threshold = _extract_numeric_value(thresholds.get("asset_age_years_threshold"))
    service_hours_threshold = _extract_numeric_value(thresholds.get("service_hours_threshold"))
    resale_replacement_ratio_threshold = _extract_numeric_value(thresholds.get("resale_replacement_ratio_threshold"))
    revenue_floor_threshold = _extract_numeric_value(thresholds.get("revenue_floor_threshold"))
    source_stale_threshold_hours = int(
        _extract_numeric_value(thresholds.get("source_stale_threshold_hours")) or _DEFAULT_SOURCE_STALE_THRESHOLD_HOURS
    )
    branch_id = str(run_context.get("branch_id") or "") or None
    start_at, end_at = ops_revrec._run_context_bounds(run_context)  # noqa: SLF001
    statuses = {"available", "returned"}

    rows = client.select(
        "rental_current_entity_state",
        columns="entity_id,entity_type,entity_version_id,version_number,data,created_at,updated_at",
        filters={"entity_type": "asset"},
    )
    all_entities = client.select(
        "rental_current_entity_state",
        columns="entity_id,entity_type,entity_version_id,version_number,data,created_at,updated_at",
    )
    relationships = client.select(
        "rental_current_relationships",
        columns="relationship_id,relationship_type,parent_id,child_id,metadata,valid_from,valid_to",
    )
    fact_types = client.select("fact_types", columns="id,key")
    facts = client.select(
        "entity_facts",
        columns="id,entity_id,fact_type_id,value,unit,metadata,created_at,updated_at",
    )
    points = client.select(
        "time_series_points",
        columns="id,entity_id,fact_type_id,observed_at,data_payload,metadata,created_at",
    )
    points = [point for point in points if _point_in_window(point, start_at, end_at)]
    fact_key_by_id = {str(row.get("id")): str(row.get("key") or "") for row in fact_types}
    tenant_entities = [
        dict(row)
        for row in all_entities
        if isinstance(row.get("data"), Mapping) and str((row.get("data") or {}).get("tenant_id") or "") == tenant_id
    ]
    tenant_entities_by_id = {str(row.get("entity_id") or ""): row for row in tenant_entities}

    def _entity_data(row: Mapping[str, Any]) -> dict[str, Any]:
        data = row.get("data")
        return dict(data) if isinstance(data, Mapping) else {}

    def _entity_tenant_branch(entity_id: str) -> tuple[str, str]:
        entity_data = _entity_data(tenant_entities_by_id.get(entity_id, {}))
        return (str(entity_data.get("tenant_id") or ""), str(entity_data.get("branch_id") or ""))

    supply_counts_by_branch_and_category: dict[tuple[str, str], int] = {}
    for entity in tenant_entities:
        if str(entity.get("entity_type") or "") != "asset":
            continue
        entity_data = _entity_data(entity)
        if str(entity_data.get("status") or "").lower() not in statuses:
            continue
        scoped_branch_id = str(entity_data.get("branch_id") or "")
        scoped_category_id = str(entity_data.get("category_id") or "")
        if not scoped_branch_id or not scoped_category_id:
            continue
        key = (scoped_branch_id, scoped_category_id)
        supply_counts_by_branch_and_category[key] = supply_counts_by_branch_and_category.get(key, 0) + 1

    scoped: list[dict[str, Any]] = []
    for row in rows:
        data = _entity_data(row)
        if str(data.get("tenant_id") or "") != tenant_id:
            continue
        if str(data.get("status") or "").lower() not in statuses:
            continue
        if branch_id and str(data.get("branch_id") or "") != branch_id:
            continue
        asset_id = str(row.get("entity_id") or "")
        category_id = str(data.get("category_id") or "")

        demand_lines = [
            entity
            for entity in tenant_entities
            if str(entity.get("entity_type") or "") == "rental_order_line"
            and str(_entity_data(entity).get("category_id") or "") == category_id
        ]
        demand_order_ids = {
            str(_entity_data(line).get("rental_order_id") or _entity_data(line).get("order_id") or "")
            for line in demand_lines
        }
        demand_order_ids.discard("")
        demand_orders = [
            entity
            for entity in tenant_entities
            if str(entity.get("entity_id") or "") in demand_order_ids and str(entity.get("entity_type") or "") == "rental_order"
        ]
        demand_counts_by_branch: dict[str, int] = {}
        for demand_line in demand_lines:
            demand_line_data = _entity_data(demand_line)
            scoped_branch_id = str(demand_line_data.get("branch_id") or "")
            if not scoped_branch_id:
                order_id = str(demand_line_data.get("rental_order_id") or demand_line_data.get("order_id") or "")
                order_data = _entity_data(tenant_entities_by_id.get(order_id, {}))
                scoped_branch_id = str(order_data.get("branch_id") or "")
            if not scoped_branch_id:
                continue
            demand_counts_by_branch[scoped_branch_id] = demand_counts_by_branch.get(scoped_branch_id, 0) + 1
        supply_counts_by_branch = {
            scoped_branch_id: scoped_count
            for (scoped_branch_id, scoped_category_id), scoped_count in supply_counts_by_branch_and_category.items()
            if scoped_category_id == category_id
        }
        demand_gap_snapshot, demand_source_gaps = _build_demand_gap_snapshot(
            category_id=category_id,
            home_branch_id=str(data.get("branch_id") or ""),
            demand_counts_by_branch=demand_counts_by_branch,
            supply_counts_by_branch=supply_counts_by_branch,
        )
        demand_gap_state = "ok" if not demand_source_gaps else "manual_evidence_required"
        demand_gap_evidence = (
            [
                "Demand-gap sourcing snapshot assembled for branch/category scope.",
                (
                    f"Primary demand branch candidate: {demand_gap_snapshot.get('best_destination_branch_id')} "
                    f"(gap {demand_gap_snapshot.get('best_destination_gap')})"
                    if demand_gap_snapshot.get("best_destination_branch_id")
                    else "No positive demand-gap destination branch detected in current scope."
                ),
            ]
            if demand_gap_state == "ok"
            else list(demand_gap_snapshot.get("manual_evidence") or [])
        )
        relevant_entity_ids = {asset_id}
        home_branch_id = str(data.get("branch_id") or "")
        if home_branch_id:
            relevant_entity_ids.add(home_branch_id)
        if category_id:
            relevant_entity_ids.add(category_id)
        relevant_entity_ids.update(str(entity.get("entity_id") or "") for entity in demand_lines)
        relevant_entity_ids.update(str(entity.get("entity_id") or "") for entity in demand_orders)
        relevant_entity_ids.update(str(_entity_data(entity).get("branch_id") or "") for entity in demand_lines)
        relevant_entity_ids.update(str(_entity_data(entity).get("branch_id") or "") for entity in demand_orders)
        relevant_entity_ids.discard("")
        for relationship in relationships:
            parent_id = str(relationship.get("parent_id") or "")
            child_id = str(relationship.get("child_id") or "")
            if parent_id in relevant_entity_ids or child_id in relevant_entity_ids:
                if parent_id:
                    relevant_entity_ids.add(parent_id)
                if child_id:
                    relevant_entity_ids.add(child_id)
        asset_points = [
            {
                "point_id": point.get("id"),
                "entity_id": point.get("entity_id"),
                "fact_key": fact_key_by_id.get(str(point.get("fact_type_id") or ""), ""),
                "observed_at": point.get("observed_at"),
                "data_payload": dict(point.get("data_payload") or {})
                if isinstance(point.get("data_payload"), Mapping)
                else {},
                "metadata": dict(point.get("metadata") or {}) if isinstance(point.get("metadata"), Mapping) else {},
                "tenant_id": _entity_tenant_branch(str(point.get("entity_id") or ""))[0],
                "branch_id": _entity_tenant_branch(str(point.get("entity_id") or ""))[1],
                "created_at": point.get("created_at"),
            }
            for point in points
            if str(point.get("entity_id") or "") in relevant_entity_ids
        ]
        point_utilization_values = [
            value
            for point in asset_points
            if str(point.get("entity_id") or "") == asset_id
            for value in [_point_utilization_pct(point)]
            if value is not None
        ]
        asset_utilization_points = [
            point
            for point in asset_points
            if str(point.get("entity_id") or "") == asset_id and _point_utilization_pct(point) is not None
        ]
        utilization_trend_series = [
            {"value": value, "observed_at": point.get("observed_at")}
            for point in asset_utilization_points
            for value in [_point_utilization_pct(point)]
            if value is not None
        ]
        utilization_trend_series.sort(key=lambda item: str(item.get("observed_at") or ""))
        benchmark_points = [
            point
            for point in asset_points
            if str(point.get("entity_id") or "") == asset_id and _point_benchmark_pct(point) is not None
        ]
        benchmark_values = [
            benchmark
            for point in benchmark_points
            for benchmark in [_point_benchmark_pct(point)]
            if benchmark is not None
        ]
        telematics_points = [point for point in asset_points if _point_matches_hints(point, _TELEMATICS_KEY_HINTS)]
        kpi_points = [point for point in asset_points if _point_matches_hints(point, _KPI_KEY_HINTS)]
        revenue_series = _point_series(asset_points, _REVENUE_KEY_HINTS) + _fact_series(facts, fact_key_by_id, _REVENUE_KEY_HINTS)
        maintenance_cost_series = _point_series(asset_points, _MAINTENANCE_COST_KEY_HINTS) + _fact_series(
            facts,
            fact_key_by_id,
            _MAINTENANCE_COST_KEY_HINTS,
        )
        downtime_series = _point_series(asset_points, _DOWNTIME_KEY_HINTS) + _fact_series(facts, fact_key_by_id, _DOWNTIME_KEY_HINTS)
        resale_series = _point_series(asset_points, _RESALE_KEY_HINTS) + _fact_series(facts, fact_key_by_id, _RESALE_KEY_HINTS)
        replacement_series = _point_series(asset_points, _REPLACEMENT_KEY_HINTS) + _fact_series(
            facts,
            fact_key_by_id,
            _REPLACEMENT_KEY_HINTS,
        )
        age_years = next(
            (
                value
                for key in _AGE_KEY_HINTS
                for value in [_extract_numeric_value(data.get(key))]
                if value is not None
            ),
            None,
        )
        if age_years is None:
            in_service_at = _parse_iso_datetime(str(data.get("in_service_at") or data.get("service_start_at") or ""))
            if in_service_at is not None:
                age_years = max((datetime.now(UTC) - in_service_at).days / 365.25, 0.0)
        service_hours = next(
            (
                value
                for key in _SERVICE_HOURS_KEY_HINTS
                for value in [_extract_numeric_value(data.get(key))]
                if value is not None
            ),
            None,
        )
        if service_hours is None:
            service_hours = _average(_point_series(asset_points, _SERVICE_HOURS_KEY_HINTS))
        average_revenue = _average(revenue_series)
        maintenance_cost = _average(maintenance_cost_series)
        downtime_hours = _average(downtime_series)
        resale_value = _average(resale_series)
        replacement_cost = _average(replacement_series)
        resale_replacement_ratio = (
            resale_value / replacement_cost
            if resale_value is not None and replacement_cost not in (None, 0.0)
            else None
        )
        utilization_trend_delta_pct = (
            float(utilization_trend_series[-1]["value"]) - float(utilization_trend_series[0]["value"])
            if len(utilization_trend_series) >= 2
            else None
        )
        utilization_pct = (
            sum(point_utilization_values) / len(point_utilization_values)
            if point_utilization_values
            else float(data.get("utilization_pct") or data.get("fleet_utilization_pct") or 0.0)
        )
        benchmark_utilization_pct = (
            sum(benchmark_values) / len(benchmark_values)
            if benchmark_values
            else None
        )
        asset_facts = [
            {
                "fact_id": fact.get("id"),
                "entity_id": fact.get("entity_id"),
                "fact_key": fact_key_by_id.get(str(fact.get("fact_type_id") or ""), ""),
                "value": fact.get("value"),
                "unit": fact.get("unit"),
                "metadata": dict(fact.get("metadata") or {}) if isinstance(fact.get("metadata"), Mapping) else {},
                "tenant_id": _entity_tenant_branch(str(fact.get("entity_id") or ""))[0],
                "branch_id": _entity_tenant_branch(str(fact.get("entity_id") or ""))[1],
                "updated_at": fact.get("updated_at"),
                "created_at": fact.get("created_at"),
            }
            for fact in facts
            if str(fact.get("entity_id") or "") in relevant_entity_ids
        ]
        relevant_relationships: list[dict[str, Any]] = []
        for relationship in relationships:
            parent_id = str(relationship.get("parent_id") or "")
            child_id = str(relationship.get("child_id") or "")
            if parent_id not in relevant_entity_ids and child_id not in relevant_entity_ids:
                continue
            parent_tenant_id, parent_branch_id = _entity_tenant_branch(parent_id)
            child_tenant_id, child_branch_id = _entity_tenant_branch(child_id)
            relationship_tenant_id = parent_tenant_id or child_tenant_id
            if relationship_tenant_id != tenant_id:
                continue
            relevant_relationships.append(
                {
                    **dict(relationship),
                    "tenant_id": relationship_tenant_id,
                    "branch_id": parent_branch_id or child_branch_id,
                }
            )

        scoped_entities = [
            dict(entity)
            for entity_id, entity in tenant_entities_by_id.items()
            if entity_id in relevant_entity_ids
        ]
        recent_history = [
            point
            for point in asset_points
            if str(point.get("entity_id") or "") == asset_id
        ]
        recent_history.sort(key=lambda point: str(point.get("observed_at") or ""), reverse=True)
        utilization_last_observed_at = _latest_timestamp(asset_utilization_points, key="observed_at")
        benchmark_last_observed_at = _latest_timestamp(benchmark_points, key="observed_at")
        telematics_last_observed_at = _latest_timestamp(telematics_points, key="observed_at")
        revenue_last_observed_at = _latest_timestamp(revenue_series, key="observed_at")
        maintenance_cost_last_observed_at = _latest_timestamp(maintenance_cost_series, key="observed_at")
        downtime_last_observed_at = _latest_timestamp(downtime_series, key="observed_at")
        resale_last_observed_at = _latest_timestamp(resale_series, key="observed_at")
        replacement_last_observed_at = _latest_timestamp(replacement_series, key="observed_at")
        stale_signals: list[str] = []
        if _is_stale(utilization_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Utilization signal is stale or missing.")
        if _is_stale(benchmark_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Benchmark signal is stale or missing.")
        if _is_stale(telematics_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Telematics signal is stale or missing.")
        if _is_stale(revenue_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Revenue signal is stale or missing.")
        if _is_stale(maintenance_cost_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Maintenance cost signal is stale or missing.")
        if _is_stale(downtime_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Downtime signal is stale or missing.")
        if _is_stale(resale_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Resale signal is stale or missing.")
        if _is_stale(replacement_last_observed_at, source_stale_threshold_hours):
            stale_signals.append("Replacement-cost signal is stale or missing.")
        source_gaps: list[str] = []
        if utilization_last_observed_at is None:
            source_gaps.append("missing_utilization")
        if average_revenue is None:
            source_gaps.append("missing_revenue")
        if maintenance_cost is None:
            source_gaps.append("missing_maintenance_cost")
        if downtime_hours is None:
            source_gaps.append("missing_downtime")
        if resale_value is None or replacement_cost is None:
            source_gaps.append("missing_market_context")
        if "Utilization signal is stale or missing." in stale_signals:
            source_gaps.append("stale_utilization")
        if "Revenue signal is stale or missing." in stale_signals:
            source_gaps.append("stale_revenue")
        if "Maintenance cost signal is stale or missing." in stale_signals:
            source_gaps.append("stale_maintenance_cost")
        if "Downtime signal is stale or missing." in stale_signals:
            source_gaps.append("stale_downtime")
        if (
            "Resale signal is stale or missing." in stale_signals
            or "Replacement-cost signal is stale or missing." in stale_signals
        ):
            source_gaps.append("stale_market_context")
        source_gaps.extend(demand_source_gaps)
        source_gaps = sorted(set(source_gaps))
        # Block recommendations only when market context or utilization reliability is too weak for automation.
        source_gap_state = (
            "blocked"
            if any(gap in source_gaps for gap in ("missing_utilization", "stale_utilization", "missing_market_context"))
            else "degraded"
            if source_gaps
            else "ok"
        )
        threshold_flags: list[str] = []
        if utilization_pct < utilization_threshold:
            threshold_flags.append("utilization_pct_threshold")
        if maintenance_cost_threshold is not None and maintenance_cost is not None and maintenance_cost >= maintenance_cost_threshold:
            threshold_flags.append("maintenance_cost_threshold")
        if downtime_hours_threshold is not None and downtime_hours is not None and downtime_hours >= downtime_hours_threshold:
            threshold_flags.append("downtime_hours_threshold")
        if asset_age_years_threshold is not None and age_years is not None and age_years >= asset_age_years_threshold:
            threshold_flags.append("asset_age_years_threshold")
        if service_hours_threshold is not None and service_hours is not None and service_hours >= service_hours_threshold:
            threshold_flags.append("service_hours_threshold")
        if (
            resale_replacement_ratio_threshold is not None
            and resale_replacement_ratio is not None
            and resale_replacement_ratio <= resale_replacement_ratio_threshold
        ):
            threshold_flags.append("resale_replacement_ratio_threshold")
        if revenue_floor_threshold is not None and average_revenue is not None and average_revenue <= revenue_floor_threshold:
            threshold_flags.append("revenue_floor_threshold")
        if not threshold_flags:
            continue
        threshold_flags = sorted(set(threshold_flags))
        scoped.append(
            {
                "tenant_id": tenant_id,
                "asset_id": asset_id,
                "home_branch_id": str(data.get("branch_id") or ""),
                "category_id": category_id,
                "status": str(data.get("status") or ""),
                "utilization_pct": utilization_pct,
                "benchmark_utilization_pct": benchmark_utilization_pct,
                "benchmark_gap_pct": (
                    utilization_pct - benchmark_utilization_pct
                    if benchmark_utilization_pct is not None
                    else None
                ),
                "utilization_last_observed_at": utilization_last_observed_at,
                "benchmark_last_observed_at": benchmark_last_observed_at,
                "telematics_last_observed_at": telematics_last_observed_at,
                "revenue_last_observed_at": revenue_last_observed_at,
                "maintenance_cost_last_observed_at": maintenance_cost_last_observed_at,
                "downtime_last_observed_at": downtime_last_observed_at,
                "market_last_observed_at": max(
                    str(resale_last_observed_at or ""),
                    str(replacement_last_observed_at or ""),
                )
                or None,
                "stale_signals": stale_signals,
                "source_gaps": source_gaps,
                "source_gap_state": source_gap_state,
                "demand_gap_state": demand_gap_state,
                "demand_gap_snapshot": demand_gap_snapshot,
                "threshold_flags": threshold_flags,
                "lifecycle_snapshot": {
                    "revenue_history": {"average_value": average_revenue, "series": revenue_series[-12:]},
                    "utilization_trend": {
                        "current_utilization_pct": utilization_pct,
                        "trend_delta_pct": utilization_trend_delta_pct,
                        "series": utilization_trend_series[-12:],
                    },
                    "maintenance_and_downtime": {
                        "average_maintenance_cost": maintenance_cost,
                        "average_downtime_hours": downtime_hours,
                        "maintenance_series": maintenance_cost_series[-12:],
                        "downtime_series": downtime_series[-12:],
                    },
                    "age_and_hours": {"age_years": age_years, "service_hours": service_hours},
                    "market_context": {
                        "resale_value": resale_value,
                        "replacement_cost": replacement_cost,
                        "resale_replacement_ratio": resale_replacement_ratio,
                        "resale_series": resale_series[-12:],
                        "replacement_series": replacement_series[-12:],
                    },
                },
                "benchmark_evidence": [
                    (
                        f"Utilization {utilization_pct:.1f}% vs benchmark {benchmark_utilization_pct:.1f}%."
                        if benchmark_utilization_pct is not None
                        else "Benchmark unavailable for this branch/asset class."
                    )
                ],
                "kpi_evidence": [f"{len(kpi_points)} KPI signals in audit window."],
                "telematics_evidence": [f"{len(telematics_points)} telematics signals in audit window."],
                "revenue_evidence": [f"{len(revenue_series)} revenue signals in audit window."],
                "maintenance_evidence": [f"{len(maintenance_cost_series)} maintenance-cost signals in audit window."],
                "downtime_evidence": [f"{len(downtime_series)} downtime signals in audit window."],
                "market_evidence": [
                    f"{len(resale_series)} resale signals and {len(replacement_series)} replacement-cost signals in audit window."
                ],
                "demand_gap_evidence": demand_gap_evidence,
                "recent_history": recent_history[:25],
                "demand_entities": [dict(entity) for entity in demand_lines],
                "time_series_points": asset_points,
                "run_window_start": run_context.get("run_window_start"),
                "run_window_end": run_context.get("run_window_end"),
                "rental_data": {
                    "entities": scoped_entities,
                    "relationships": relevant_relationships,
                    "facts": asset_facts,
                    "time_series": asset_points,
                    "invoices": [],
                    "rate_cards": [],
                    "telematics": telematics_points,
                },
            }
        )
    scoped.sort(key=lambda item: (float(item.get("utilization_pct", 0.0)), str(item.get("asset_id", ""))))
    return scoped[:max_assets]


@activity.defn(name="ops_fleet_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_fleet_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_fleet_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_fleet_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _fleet_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    asset_id = str(finding.get("asset_id") or "")
    return {
        **finding,
        "contract_id": asset_id,
        "line_item_id": None,
        "expected": {
            "utilization_pct": finding.get("utilization_pct"),
            "benchmark_utilization_pct": finding.get("benchmark_utilization_pct"),
            "benchmark_gap_pct": finding.get("benchmark_gap_pct"),
            "urgency_score": finding.get("urgency_score"),
            "recommendation_path": finding.get("recommendation_path"),
            "assumptions": finding.get("assumptions"),
            "stale_signals": finding.get("stale_signals"),
            "source_gaps": finding.get("source_gaps"),
            "source_gap_state": finding.get("source_gap_state"),
            "demand_gap_state": finding.get("demand_gap_state"),
            "demand_gap_snapshot": finding.get("demand_gap_snapshot"),
            "recommendation_blocked": finding.get("recommendation_blocked"),
            "threshold_flags": finding.get("threshold_flags"),
            "lifecycle_snapshot": finding.get("lifecycle_snapshot"),
            "operating_model_tags": finding.get("operating_model_tags", []),
        },
        "billed": {},
        "delta": finding.get("estimated_monthly_revenue_uplift"),
        "proposed_action": finding.get("recommendation_path") or finding.get("disposition"),
        "finding_type": str(finding.get("finding_type") or "cross_branch_utilization_outlier"),
        "severity": str(finding.get("severity") or "medium"),
    }


@activity.defn(name="ops_fleet_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_fleet_finding_for_storage(finding), run_id)


@activity.defn(name="ops_fleet_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(_fleet_finding_for_storage(finding), disposition, run_id, approver)


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


@activity.defn
def ops_requires_transfer_approval(finding: dict[str, Any], config: dict[str, Any]) -> bool:
    disposition = str(finding.get("disposition") or "").lower()
    if disposition in _CANONICAL_DISPOSITIONS:
        return True
    if disposition != "transfer":
        return False
    thresholds = config.get("thresholds") or {}
    threshold = _coerce_float(thresholds.get("transfer_value_threshold"))
    uplift = _coerce_float(finding.get("estimated_monthly_revenue_uplift"))
    return uplift >= threshold


@activity.defn
def ops_transfer_request_payload(
    finding: dict[str, Any],
    approver: dict[str, Any] | None = None,
) -> dict[str, Any]:
    requested_by = str((approver or {}).get("approver_id") or _DEFAULT_FLEET_REQUESTER)
    return {
        "asset_id": str(finding.get("asset_id") or ""),
        "origin_branch_id": str(finding.get("home_branch_id") or ""),
        "destination_branch_id": str(finding.get("target_branch_id") or ""),
        "requested_by": requested_by,
        "sourcing_decision_id": str(finding.get("fingerprint") or finding.get("finding_id") or ""),
        "requested_ship_date": finding.get("requested_ship_date") or finding.get("recommended_ship_date"),
        "expected_receive_date": finding.get("expected_receive_date"),
        "asset_scope": str(
            finding.get("asset_scope")
            or finding.get("asset_name")
            or finding.get("asset_id")
            or ""
        ),
        "internal_cost": finding.get("estimated_transfer_cost") or finding.get("estimated_internal_cost"),
        "transfer_exception_reason": finding.get("transfer_exception_reason"),
        "requested_at": datetime.now(UTC).isoformat(),
    }


def _canonical_disposition(disposition: Any) -> str:
    normalized = str(disposition or "").strip().lower()
    if normalized in _CANONICAL_DISPOSITIONS:
        return normalized
    if normalized == "buy":
        return "replace"
    return "keep"


@activity.defn
def ops_draft_disposition_handoff(
    finding: dict[str, Any],
    approver: dict[str, Any] | None = None,
) -> dict[str, Any]:
    client = ops_revrec.get_ops_persistence_client()
    tenant_id = str(finding.get("tenant_id") or "")
    if not tenant_id:
        raise ValueError("tenant_id is required to draft disposition handoff")
    fingerprint = str(finding.get("fingerprint") or "")
    finding_rows = client.select("finding", filters={"tenant_id": tenant_id, "fingerprint": fingerprint}, limit=1)
    if not finding_rows:
        raise ValueError(f"finding not found for disposition handoff fingerprint={fingerprint}")
    finding_id = str(finding_rows[0].get("id") or "")
    if not finding_id:
        raise ValueError("finding id is required to draft disposition handoff")
    canonical_disposition = _canonical_disposition(finding.get("disposition"))
    handoff_path = "procurement" if canonical_disposition == "replace" else "lifecycle"
    row = client.upsert(
        "fleet_disposition_handoff_draft",
        {
            "tenant_id": tenant_id,
            "finding_id": finding_id,
            "disposition": canonical_disposition,
            "handoff_path": handoff_path,
            "status": _FLEET_HANDOFF_STATUS_DRAFT,
            "approver": dict(approver) if approver else None,
            "payload": {
                "rationale": finding.get("rationale"),
                "evidence": finding.get("evidence"),
                "workflow_id": finding.get("workflow_id"),
                "fingerprint": fingerprint,
                "asset_id": finding.get("asset_id"),
                "home_branch_id": finding.get("home_branch_id"),
                "target_branch_id": finding.get("target_branch_id"),
                "proposed_action": finding.get("proposed_action"),
                "recommendation_path": finding.get("recommendation_path"),
                "lifecycle_snapshot": finding.get("lifecycle_snapshot"),
                "approver_note": (approver or {}).get("note"),
                "approved_at": str(finding.get("decided_at") or datetime.now(UTC).isoformat()),
            },
        },
        on_conflict="finding_id",
    )
    return {
        "handoff_id": str(row.get("id") or ""),
        "status": _FLEET_HANDOFF_STATUS_DRAFT,
        "handoff_path": handoff_path,
        "disposition": canonical_disposition,
    }


__all__ = [
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_fleet_assess",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_draft_disposition_handoff",
    "ops_requires_transfer_approval",
    "ops_scope_fleet_assets",
    "ops_transfer_request_payload",
]
