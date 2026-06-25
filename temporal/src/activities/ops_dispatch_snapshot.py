"""Dispatch scope snapshot and constraint inputs."""
from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from temporalio import activity

from . import ops_revrec

logger = logging.getLogger(__name__)

_MAX_SCOPED_ITEMS = 200
_STALE_THRESHOLD_HOURS = 8
_TELEMATICS_STALE_THRESHOLD_HOURS = 2
_DRIVER_HOS_STALE_THRESHOLD_HOURS = 4

_OPEN_DISPATCH_STATUSES = {"open", "scheduled", "in_progress", "pending_dispatch"}
_HOS_FACT_TYPES = {
    "driver_hos",
    "driver_hours_remaining",
    "hos_cycle_hours",
    "driver_availability",
}
_CAPACITY_FACT_TYPES = {
    "truck_capacity_lbs",
    "truck_payload_lbs",
    "vehicle_max_load",
    "trailer_capacity",
}
_ROUTE_FACT_TYPES = {
    "planned_route",
    "route_waypoints",
    "routing_provider",
    "estimated_drive_time",
}

SOURCE_GAP_MISSING_TELEMATICS = "missing_telematics"
SOURCE_GAP_STALE_TELEMATICS = "stale_telematics"
SOURCE_GAP_MISSING_DRIVER_HOS = "missing_driver_hos"
SOURCE_GAP_STALE_DRIVER_HOS = "stale_driver_hos"
SOURCE_GAP_MISSING_ROUTE = "missing_route"
SOURCE_GAP_MISSING_ASSET_READINESS = "missing_asset_readiness"
SOURCE_GAP_CONFLICTED_TIME_WINDOW = "conflicted_time_window"


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _is_stale(ts_str: str | None, threshold_hours: int = _STALE_THRESHOLD_HOURS) -> bool:
    parsed = _parse_datetime(ts_str)
    if parsed is None:
        return True
    return datetime.now(UTC) - parsed > timedelta(hours=threshold_hours)


def _dict_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [dict(item) for item in value if isinstance(item, Mapping)]
    return []


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _latest_row_timestamp(rows: Sequence[Mapping[str, Any]]) -> str | None:
    latest: datetime | None = None
    latest_raw: str | None = None
    for row in rows:
        for key in ("recorded_at", "updated_at"):
            raw = row.get(key)
            parsed = _parse_datetime(str(raw) if raw else None)
            if parsed is None:
                continue
            if latest is None or parsed > latest:
                latest = parsed
                latest_raw = parsed.isoformat()
    return latest_raw


def _filter_facts(rows: Sequence[Mapping[str, Any]], allowed_types: set[str]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows if str(row.get("fact_type") or "") in allowed_types]


def _relation_exists(client: ops_revrec.OpsPersistenceClient, *, relationship_type: str, parent_id: str, child_id: str) -> bool:
    if not parent_id or not child_id:
        return False
    return bool(
        client.select(
            "rental_current_relationships",
            columns="parent_id,child_id",
            filters={
                "relationship_type": relationship_type,
                "parent_id": parent_id,
                "child_id": child_id,
            },
            limit=1,
        )
    )


def _detect_source_gaps(
    *,
    has_telematics: bool,
    telematics_updated_at: str | None,
    has_driver_hos: bool,
    driver_hos_updated_at: str | None,
    has_route: bool,
    has_asset_readiness: bool,
    time_window_start: str | None,
    time_window_end: str | None,
) -> list[str]:
    gaps: list[str] = []

    if not has_telematics:
        gaps.append(SOURCE_GAP_MISSING_TELEMATICS)
    elif _is_stale(telematics_updated_at, threshold_hours=_TELEMATICS_STALE_THRESHOLD_HOURS):
        gaps.append(SOURCE_GAP_STALE_TELEMATICS)

    if not has_driver_hos:
        gaps.append(SOURCE_GAP_MISSING_DRIVER_HOS)
    elif _is_stale(driver_hos_updated_at, threshold_hours=_DRIVER_HOS_STALE_THRESHOLD_HOURS):
        gaps.append(SOURCE_GAP_STALE_DRIVER_HOS)

    if not has_route:
        gaps.append(SOURCE_GAP_MISSING_ROUTE)

    if not has_asset_readiness:
        gaps.append(SOURCE_GAP_MISSING_ASSET_READINESS)

    start_dt = _parse_datetime(time_window_start)
    end_dt = _parse_datetime(time_window_end)
    if time_window_start and time_window_end and (start_dt is None or end_dt is None or start_dt >= end_dt):
        gaps.append(SOURCE_GAP_CONFLICTED_TIME_WINDOW)

    return gaps


def build_dispatch_scope_fingerprint(
    *,
    tenant_id: str,
    branch_id: str | None,
    run_date: str | None,
    order_ids: list[str],
    asset_ids: list[str],
    driver_ids: list[str],
) -> str:
    payload = {
        "tenant_id": tenant_id,
        "branch_id": branch_id or "",
        "run_date": run_date or "",
        "order_ids": sorted(set(order_ids)),
        "asset_ids": sorted(set(asset_ids)),
        "driver_ids": sorted(set(driver_ids)),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _item_finding_for_storage(item: dict[str, Any]) -> dict[str, Any]:
    order_id = str(item.get("order_id") or item.get("item_id") or "")
    asset_id = str(item.get("asset_id") or "")
    priority = str(item.get("priority") or "medium")
    priority_to_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    return {
        **item,
        "contract_id": order_id or None,
        "line_item_id": asset_id or None,
        "finding_type": str(item.get("item_type") or "open_delivery"),
        "severity": priority_to_severity.get(priority, priority),
        "proposed_action": str(item.get("recommendation") or ""),
        "expected": {
            "item_type": item.get("item_type"),
            "source_gaps": item.get("source_gaps", []),
            "is_stale_data": item.get("is_stale_hint", False),
            "operating_model_tags": item.get("operating_model_tags", []),
        },
        "billed": {},
        "delta": None,
    }


@activity.defn
def ops_dispatch_snapshot_scope(
    tenant_id: str,
    branch_id: str | None,
    run_date: str | None,
) -> dict[str, Any]:
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    items: list[dict[str, Any]] = []
    snapshot_source_gaps: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    order_ids: list[str] = []
    asset_ids: list[str] = []
    driver_ids: list[str] = []

    dispatch_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "dispatch_record"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in dispatch_rows:
        data = _mapping(row.get("data"))
        dispatch_status = str(data.get("status") or "")
        if dispatch_status not in _OPEN_DISPATCH_STATUSES:
            continue

        dispatch_id = str(row.get("entity_id") or "")
        if not dispatch_id or dispatch_id in seen_ids:
            continue
        if branch_id and not _relation_exists(
            client,
            relationship_type="branch_has_dispatch",
            parent_id=branch_id,
            child_id=dispatch_id,
        ):
            continue
        seen_ids.add(dispatch_id)

        dispatch_type = str(data.get("dispatch_type") or data.get("type") or "delivery")
        item_type = "open_pickup" if "pickup" in dispatch_type.lower() else "open_delivery"
        order_id = str(data.get("order_id") or data.get("rental_order_id") or "")
        contract_id = str(data.get("contract_id") or "")
        asset_id = str(data.get("asset_id") or "")
        driver_id = str(data.get("driver_id") or data.get("assigned_driver_id") or "")
        route_id = str(data.get("route_id") or data.get("route_plan_id") or "")
        time_window_start = str(data.get("time_window_start") or data.get("scheduled_start_at") or "")
        time_window_end = str(data.get("time_window_end") or data.get("scheduled_end_at") or "")

        telematics_rows = (
            client.select("asset_telemetry_current", columns="*", filters={"asset_id": asset_id}, limit=1)
            if asset_id
            else []
        )
        telematics_updated_at = _latest_row_timestamp(telematics_rows)

        driver_fact_rows = (
            client.select(
                "rental_current_facts",
                columns="entity_id, fact_type, value, recorded_at, updated_at",
                filters={"entity_id": driver_id},
                limit=50,
            )
            if driver_id
            else []
        )
        driver_hos_rows = _filter_facts(driver_fact_rows, _HOS_FACT_TYPES)
        driver_hos_updated_at = _latest_row_timestamp(driver_hos_rows)

        route_target_id = route_id or order_id
        route_fact_rows = (
            client.select(
                "rental_current_facts",
                columns="entity_id, fact_type, value, recorded_at, updated_at",
                filters={"entity_id": route_target_id},
                limit=50,
            )
            if route_target_id
            else []
        )
        route_rows = _filter_facts(route_fact_rows, _ROUTE_FACT_TYPES)

        asset_rows = (
            client.select(
                "rental_current_entity_state",
                columns="entity_id, name, entity_type, data, updated_at",
                filters={"entity_id": asset_id, "entity_type": "asset"},
                limit=1,
            )
            if asset_id
            else []
        )
        asset_row = asset_rows[0] if asset_rows else {}
        asset_data = _mapping(asset_row.get("data"))
        has_asset_readiness = bool(asset_row) and bool(asset_data.get("operational_status") or asset_data.get("status"))

        source_gaps = _detect_source_gaps(
            has_telematics=bool(telematics_rows),
            telematics_updated_at=telematics_updated_at,
            has_driver_hos=bool(driver_hos_rows),
            driver_hos_updated_at=driver_hos_updated_at,
            has_route=bool(route_rows),
            has_asset_readiness=has_asset_readiness,
            time_window_start=time_window_start or None,
            time_window_end=time_window_end or None,
        )
        if source_gaps:
            snapshot_source_gaps.append({"dispatch_id": dispatch_id, "item_type": item_type, "gaps": source_gaps})

        if order_id:
            order_ids.append(order_id)
        if asset_id:
            asset_ids.append(asset_id)
        if driver_id:
            driver_ids.append(driver_id)

        location_row = telematics_rows[0] if telematics_rows else {}
        items.append(
            {
                "tenant_id": tenant_id,
                "item_id": dispatch_id,
                "item_type": item_type,
                "order_id": order_id or None,
                "contract_id": contract_id or None,
                "asset_id": asset_id or None,
                "driver_id": driver_id or None,
                "route_id": route_id or None,
                "dispatch_status": dispatch_status,
                "dispatch_type": dispatch_type,
                "time_window_start": time_window_start or None,
                "time_window_end": time_window_end or None,
                "location_latitude": location_row.get("lat"),
                "location_longitude": location_row.get("lon"),
                "location_recorded_at": location_row.get("recorded_at") or location_row.get("updated_at"),
                "asset_operational_status": asset_data.get("operational_status") or asset_data.get("status"),
                "source_gaps": source_gaps,
                "last_updated_at": str(row.get("updated_at") or ""),
                "is_stale_hint": _is_stale(str(row.get("updated_at") or "")),
                "rental_data": {
                    "entities": [dict(row), *[dict(asset) for asset in asset_rows]],
                    "relationships": [],
                    "facts": [*route_rows, *driver_hos_rows],
                    "time_series": [],
                    "telematics": _dict_list(telematics_rows),
                },
            }
        )

    dispatch_asset_ids = [
        str(item.get("asset_id") or "")
        for item in items
        if item.get("item_type") in {"open_delivery", "open_pickup"} and item.get("asset_id")
    ]
    for asset_id in dispatch_asset_ids:
        key = f"asset:{asset_id}"
        if key in seen_ids:
            continue
        seen_ids.add(key)

        asset_rows = client.select(
            "rental_current_entity_state",
            columns="entity_id, name, entity_type, data, updated_at",
            filters={"entity_id": asset_id, "entity_type": "asset"},
            limit=1,
        )
        if not asset_rows:
            snapshot_source_gaps.append(
                {"asset_id": asset_id, "item_type": "asset_readiness", "gaps": [SOURCE_GAP_MISSING_ASSET_READINESS]}
            )
            continue

        asset_row = asset_rows[0]
        asset_data = _mapping(asset_row.get("data"))
        telematics_rows = client.select("asset_telemetry_current", columns="*", filters={"asset_id": asset_id}, limit=1)
        telematics_updated_at = _latest_row_timestamp(telematics_rows)
        asset_gaps: list[str] = []
        if not telematics_rows:
            asset_gaps.append(SOURCE_GAP_MISSING_TELEMATICS)
        elif _is_stale(telematics_updated_at, threshold_hours=_TELEMATICS_STALE_THRESHOLD_HOURS):
            asset_gaps.append(SOURCE_GAP_STALE_TELEMATICS)
        if not (asset_data.get("operational_status") or asset_data.get("status")):
            asset_gaps.append(SOURCE_GAP_MISSING_ASSET_READINESS)
        if asset_gaps:
            snapshot_source_gaps.append({"asset_id": asset_id, "item_type": "asset_readiness", "gaps": asset_gaps})

        location_row = telematics_rows[0] if telematics_rows else {}
        items.append(
            {
                "tenant_id": tenant_id,
                "item_id": asset_id,
                "item_type": "asset_readiness",
                "asset_id": asset_id,
                "asset_name": str(asset_row.get("name") or asset_id),
                "operational_status": asset_data.get("operational_status") or asset_data.get("status"),
                "location_latitude": location_row.get("lat"),
                "location_longitude": location_row.get("lon"),
                "location_recorded_at": location_row.get("recorded_at") or location_row.get("updated_at"),
                "source_gaps": asset_gaps,
                "last_updated_at": str(asset_row.get("updated_at") or ""),
                "is_stale_hint": _is_stale(str(asset_row.get("updated_at") or "")),
                "rental_data": {
                    "entities": [dict(asset_row)],
                    "relationships": [],
                    "facts": [],
                    "time_series": [],
                    "telematics": _dict_list(telematics_rows),
                },
            }
        )

    vehicle_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "vehicle"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in vehicle_rows:
        vehicle_id = str(row.get("entity_id") or "")
        if not vehicle_id:
            continue
        key = f"truck:{vehicle_id}"
        if key in seen_ids:
            continue
        if branch_id and not _relation_exists(
            client,
            relationship_type="branch_has_vehicle",
            parent_id=branch_id,
            child_id=vehicle_id,
        ):
            continue
        seen_ids.add(key)

        capacity_fact_rows = _filter_facts(
            client.select(
                "rental_current_facts",
                columns="entity_id, fact_type, value, recorded_at, updated_at",
                filters={"entity_id": vehicle_id},
                limit=50,
            ),
            _CAPACITY_FACT_TYPES,
        )
        items.append(
            {
                "tenant_id": tenant_id,
                "item_id": vehicle_id,
                "item_type": "truck_capacity",
                "asset_id": vehicle_id,
                "vehicle_name": str(row.get("name") or vehicle_id),
                "operational_status": _mapping(row.get("data")).get("operational_status") or _mapping(row.get("data")).get("status"),
                "capacity_fact_type": capacity_fact_rows[0].get("fact_type") if capacity_fact_rows else None,
                "capacity_value": _mapping(capacity_fact_rows[0].get("value")) if capacity_fact_rows else {},
                "source_gaps": [],
                "last_updated_at": str(row.get("updated_at") or ""),
                "is_stale_hint": _is_stale(str(row.get("updated_at") or "")),
                "rental_data": {
                    "entities": [dict(row)],
                    "relationships": [],
                    "facts": capacity_fact_rows,
                    "time_series": [],
                    "telematics": [],
                },
            }
        )
        asset_ids.append(vehicle_id)

    driver_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "driver"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    for row in driver_rows:
        driver_id = str(row.get("entity_id") or "")
        if not driver_id:
            continue
        key = f"driver:{driver_id}"
        if key in seen_ids:
            continue
        if branch_id and not _relation_exists(
            client,
            relationship_type="branch_has_driver",
            parent_id=branch_id,
            child_id=driver_id,
        ):
            continue
        seen_ids.add(key)

        hos_rows = _filter_facts(
            client.select(
                "rental_current_facts",
                columns="entity_id, fact_type, value, recorded_at, updated_at",
                filters={"entity_id": driver_id},
                limit=50,
            ),
            _HOS_FACT_TYPES,
        )
        hos_updated_at = _latest_row_timestamp(hos_rows)
        driver_gaps: list[str] = []
        if not hos_rows:
            driver_gaps.append(SOURCE_GAP_MISSING_DRIVER_HOS)
        elif _is_stale(hos_updated_at, threshold_hours=_DRIVER_HOS_STALE_THRESHOLD_HOURS):
            driver_gaps.append(SOURCE_GAP_STALE_DRIVER_HOS)
        if driver_gaps:
            snapshot_source_gaps.append({"driver_id": driver_id, "item_type": "driver_hos", "gaps": driver_gaps})

        items.append(
            {
                "tenant_id": tenant_id,
                "item_id": driver_id,
                "item_type": "driver_hos",
                "driver_id": driver_id,
                "driver_name": str(row.get("name") or driver_id),
                "availability_status": _mapping(row.get("data")).get("availability_status") or _mapping(row.get("data")).get("status"),
                "source_gaps": driver_gaps,
                "last_updated_at": str(row.get("updated_at") or ""),
                "is_stale_hint": _is_stale(str(row.get("updated_at") or "")),
                "rental_data": {
                    "entities": [dict(row)],
                    "relationships": [],
                    "facts": hos_rows,
                    "time_series": [],
                    "telematics": [],
                },
            }
        )
        driver_ids.append(driver_id)

    staging_filters: dict[str, Any] = {"entity_type": "branch_staging"}
    if branch_id:
        staging_filters["entity_id"] = branch_id
    staging_rows = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters=staging_filters,
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ITEMS,
    )
    if not staging_rows and branch_id:
        staging_rows = client.select(
            "rental_current_entity_state",
            columns="entity_id, name, entity_type, data, updated_at",
            filters={"entity_id": branch_id, "entity_type": "branch"},
            limit=1,
        )
    for row in staging_rows:
        staging_id = str(row.get("entity_id") or "")
        if not staging_id:
            continue
        key = f"staging:{staging_id}"
        if key in seen_ids:
            continue
        seen_ids.add(key)
        staging_data = _mapping(row.get("data"))
        items.append(
            {
                "tenant_id": tenant_id,
                "item_id": staging_id,
                "item_type": "branch_staging",
                "branch_id": branch_id or staging_id,
                "staging_status": staging_data.get("staging_status") or staging_data.get("status"),
                "source_gaps": [],
                "last_updated_at": str(row.get("updated_at") or ""),
                "is_stale_hint": _is_stale(str(row.get("updated_at") or "")),
                "rental_data": {
                    "entities": [dict(row)],
                    "relationships": [],
                    "facts": [],
                    "time_series": [],
                    "telematics": [],
                },
            }
        )

    fingerprint = build_dispatch_scope_fingerprint(
        tenant_id=tenant_id,
        branch_id=branch_id,
        run_date=run_date,
        order_ids=order_ids,
        asset_ids=asset_ids,
        driver_ids=driver_ids,
    )
    logger.info(
        "ops_dispatch_snapshot_scope",
        extra={
            "tenant_id": tenant_id,
            "branch_id": branch_id,
            "run_date": run_date,
            "total_items": len(items),
            "total_source_gaps": len(snapshot_source_gaps),
            "fingerprint": fingerprint,
        },
    )
    return {
        "items": items[:_MAX_SCOPED_ITEMS],
        "source_gaps": snapshot_source_gaps,
        "fingerprint": fingerprint,
        "order_ids": sorted(set(order_ids)),
        "asset_ids": sorted(set(asset_ids)),
        "driver_ids": sorted(set(driver_ids)),
    }


@activity.defn(name="ops_dispatch_snapshot_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_dispatch_snapshot_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_dispatch_snapshot_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_dispatch_snapshot_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_dispatch_snapshot_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_item_finding_for_storage(finding), run_id)


@activity.defn(name="ops_dispatch_snapshot_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(_item_finding_for_storage(finding), disposition, run_id, approver)


__all__ = [
    "SOURCE_GAP_CONFLICTED_TIME_WINDOW",
    "SOURCE_GAP_MISSING_ASSET_READINESS",
    "SOURCE_GAP_MISSING_DRIVER_HOS",
    "SOURCE_GAP_MISSING_ROUTE",
    "SOURCE_GAP_MISSING_TELEMATICS",
    "SOURCE_GAP_STALE_DRIVER_HOS",
    "SOURCE_GAP_STALE_TELEMATICS",
    "_detect_source_gaps",
    "_is_stale",
    "_item_finding_for_storage",
    "build_dispatch_scope_fingerprint",
    "ops_create_workflow_run",
    "ops_dispatch_snapshot_scope",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
]
