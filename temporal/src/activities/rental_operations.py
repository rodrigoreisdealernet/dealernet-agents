"""Rental domain activities for transfer, inspection, maintenance, and invoicing.

Transfer, inspection, and most maintenance activities are stubs that log
operations and return structured results. The four maintenance-costing
activities (add_maintenance_cost_line, compute_maintenance_work_order_totals,
check_maintenance_invoice_exists, create_maintenance_invoice) are wired to
the live Supabase entity/SCD2 store via PostgrestServiceRoleClient so that
cost lines and invoice relationships are durably persisted.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from temporalio import activity

from ..config import settings
from ..models.rental import (
    MAINTENANCE_OPENABLE_STATUSES,
    TRANSFERABLE_STATUSES,
    AssetStatus,
    InspectionResult,
    InspectionType,
    InvoiceStatus,
)

logger = logging.getLogger(__name__)

_MAINTENANCE_COMPLETION_EVENT_FACT_KEY = "maintenance_completion_event"
_MAINTENANCE_COMPLETION_EVENT_FACT = {
    "fact_key": _MAINTENANCE_COMPLETION_EVENT_FACT_KEY,
    "label": "Maintenance Completion Event",
    "description": "Append-only maintenance completion events for asset service history",
    "unit": "event",
}
_rental_ops_client: RentalOperationsPersistenceClient | None = None
_fact_type_id_cache: dict[str, str] = {}


class RentalOperationsPersistenceClient(Protocol):
    """Persistence interface used by rental operations activities and test fakes."""

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]: ...

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]: ...

    def upsert(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        on_conflict: str,
    ) -> dict[str, Any]: ...

    def update(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, Any] | None = None,
    ) -> list[dict[str, Any]]: ...

    def rpc(self, function_name: str, payload: Mapping[str, Any]) -> list[dict[str, Any]]: ...


class PostgrestServiceRoleClient:
    """Minimal service-role PostgREST client for direct Supabase reads and writes."""

    def __init__(self, *, base_url: str, service_role_key: str, timeout_seconds: int = 10) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_role_key = service_role_key
        self._timeout_seconds = timeout_seconds

    def _request(
        self,
        method: str,
        resource: str,
        *,
        params: Mapping[str, str] | None = None,
        payload: Mapping[str, Any] | None = None,
        prefer: str | None = None,
    ) -> list[dict[str, Any]]:
        query = f"?{urllib_parse.urlencode(params, safe='.*,()')}" if params else ""
        url = f"{self._base_url}/rest/v1/{resource}{query}"
        headers = {
            "apikey": self._service_role_key,
            "Authorization": "Bearer " + self._service_role_key,
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(url=url, data=body, method=method, headers=headers)
        try:
            with urllib_request.urlopen(req, timeout=self._timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Supabase request failed ({method} {resource}): {exc.code} {detail}") from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"Supabase request failed ({method} {resource}): {exc}") from exc

        if not raw.strip():
            return []
        decoded = json.loads(raw)
        if isinstance(decoded, list):
            return [dict(item) for item in decoded if isinstance(item, Mapping)]
        if isinstance(decoded, Mapping):
            return [dict(decoded)]
        return []

    def select(
        self,
        resource: str,
        *,
        columns: str = "*",
        filters: Mapping[str, Any] | None = None,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {"select": columns}
        for key, value in (filters or {}).items():
            if value is None:
                continue
            params[key] = f"eq.{value}"
        if order_by:
            params["order"] = f"{order_by}.{'desc' if descending else 'asc'}"
        if limit is not None:
            params["limit"] = str(limit)
        return self._request("GET", resource, params=params)

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        rows = self._request(
            "POST",
            resource,
            params={"select": "*"},
            payload=payload,
            prefer="return=representation",
        )
        return rows[0] if rows else {}

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        rows = self._request(
            "POST",
            resource,
            params={"select": "*", "on_conflict": on_conflict},
            payload=payload,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return rows[0] if rows else {}

    def update(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {}
        for key, value in (filters or {}).items():
            if value is not None:
                params[key] = f"eq.{value}"
        return self._request("PATCH", resource, params=params or None, payload=payload, prefer="return=representation")

    def rpc(self, function_name: str, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        return self._request(
            "POST",
            f"rpc/{function_name}",
            payload=payload,
            prefer="return=representation",
        )


def _get_ops_persistence_client():
    """Return a configured Supabase PostgREST client.

    Defers to ops_revrec to avoid circular imports and to share the
    single cached client instance across all activity modules.
    """
    from . import ops_revrec  # noqa: PLC0415 — lazy import avoids circular init
    return ops_revrec._get_ops_persistence_client()  # noqa: SLF001



def _idempotent_id(seed: str) -> str:
    """Return a deterministic UUID v5 from *seed*.

    Ensures that retrying a create activity with the same inputs produces the
    same entity ID, preventing duplicate rows in production.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def _get_rental_operations_persistence_client() -> RentalOperationsPersistenceClient:
    global _rental_ops_client
    if _rental_ops_client is None:
        _rental_ops_client = PostgrestServiceRoleClient(
            base_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
            timeout_seconds=int(os.getenv("SUPABASE_HTTP_TIMEOUT_SECONDS", "10")),
        )
    return _rental_ops_client


def _current_timestamp() -> str:
    return datetime.now(UTC).isoformat()


def _json_object(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _get_current_entity_state(
    client: RentalOperationsPersistenceClient,
    entity_id: str,
    entity_type: str,
) -> dict[str, Any]:
    rows = client.select(
        "rental_current_entity_state",
        columns="entity_id,entity_type,version_number,data,name",
        filters={"entity_id": entity_id, "entity_type": entity_type},
        limit=1,
    )
    if not rows:
        raise ValueError(f"{entity_type} {entity_id} was not found in current rental entity state")
    return dict(rows[0])


def _resolve_fact_type_id(
    client: RentalOperationsPersistenceClient,
    *,
    fact_key: str,
    label: str,
    description: str,
    unit: str,
) -> str:
    cached = _fact_type_id_cache.get(fact_key)
    if cached:
        return cached
    rows = client.select("fact_types", columns="id,key", filters={"key": fact_key}, limit=1)
    if not rows:
        rows = [client.upsert(
            "fact_types",
            {
                "key": fact_key,
                "label": label,
                "description": description,
                "unit": unit,
            },
            on_conflict="key",
        )]
    fact_type_id = str(rows[0]["id"])
    _fact_type_id_cache[fact_key] = fact_type_id
    return fact_type_id


def _maintenance_record_is_blocking(data: Mapping[str, Any]) -> bool:
    """Maintenance records block availability until they reach a terminal status."""

    status = str(data.get("status") or "").strip().lower()
    return status not in {"completed", "cancelled", "closed", "resolved"}


def _inspection_record_is_blocking(data: Mapping[str, Any]) -> bool:
    """Inspection rows block availability when failed or still in a non-terminal hold state."""

    outcome = str(data.get("outcome") or "").strip().lower()
    status = str(data.get("status") or "").strip().lower()
    return outcome == InspectionResult.FAIL.value or status in {
        InspectionResult.FAIL.value,
        AssetStatus.INSPECTION_HOLD.value,
        "open",
        "pending",
        "in_progress",
        "failed",
    }


# ---------------------------------------------------------------------------
# Asset state helpers
# ---------------------------------------------------------------------------

@activity.defn
def get_asset_status(asset_id: str) -> dict[str, Any]:
    """Return current status and data snapshot for an asset entity."""
    logger.info("[STUB] get_asset_status", extra={"asset_id": asset_id})
    return {
        "asset_id": asset_id,
        "status": AssetStatus.AVAILABLE.value,
        "version_id": "mock-version-id",
    }


@activity.defn
def check_asset_transferable(asset_id: str, current_status: str) -> dict[str, Any]:
    """Return whether the asset can be transferred.

    An asset is transferable only when its status is in TRANSFERABLE_STATUSES.
    """
    allowed = current_status in {s.value for s in TRANSFERABLE_STATUSES}
    if not allowed:
        reason = f"asset status '{current_status}' is not transferable"
        logger.info("[STUB] check_asset_transferable blocked", extra={"asset_id": asset_id, "reason": reason})
    else:
        reason = None
        logger.info("[STUB] check_asset_transferable allowed", extra={"asset_id": asset_id})
    return {"allowed": allowed, "reason": reason}


@activity.defn
def check_asset_maintenance_openable(asset_id: str, current_status: str) -> dict[str, Any]:
    """Return whether a maintenance record can be opened against the asset."""
    allowed = current_status in {s.value for s in MAINTENANCE_OPENABLE_STATUSES}
    reason = None if allowed else f"asset status '{current_status}' does not allow opening maintenance"
    logger.info("[STUB] check_asset_maintenance_openable", extra={"asset_id": asset_id, "allowed": allowed})
    return {"allowed": allowed, "reason": reason}


# ---------------------------------------------------------------------------
# Transfer activities
# ---------------------------------------------------------------------------

@activity.defn
def create_transfer_record(
    asset_id: str,
    origin_branch_id: str,
    destination_branch_id: str,
    requested_by: str,
    requested_ship_date: str | None = None,
    expected_receive_date: str | None = None,
    asset_scope: str | None = None,
    internal_cost: float | None = None,
    sourcing_decision_id: str | None = None,
    transfer_exception_reason: str | None = None,
    origin_project_id: str | None = None,
    destination_project_id: str | None = None,
) -> dict[str, Any]:
    """Create a transfer entity and link it to origin branch, destination branch, and asset."""
    natural_key = (
        f"sourcing-decision:{sourcing_decision_id}"
        if sourcing_decision_id
        else f"asset:{asset_id}:{origin_branch_id}:{destination_branch_id}:{requested_by}"
    )
    transfer_id = _idempotent_id(f"transfer:{natural_key}")
    logger.info(
        "[STUB] create_transfer_record",
        extra={
            "transfer_id": transfer_id,
            "asset_id": asset_id,
            "origin_branch_id": origin_branch_id,
            "destination_branch_id": destination_branch_id,
            "origin_project_id": origin_project_id,
            "destination_project_id": destination_project_id,
            "requested_ship_date": requested_ship_date,
            "expected_receive_date": expected_receive_date,
            "asset_scope": asset_scope,
            "internal_cost": internal_cost,
            "sourcing_decision_id": sourcing_decision_id,
        },
    )
    return {
        "transfer_id": transfer_id,
        "asset_id": asset_id,
        "status": "requested",
        "requested_ship_date": requested_ship_date,
        "expected_receive_date": expected_receive_date,
        "asset_scope": asset_scope,
        "internal_cost": internal_cost,
        "sourcing_decision_id": sourcing_decision_id,
        "transfer_exception_reason": transfer_exception_reason,
        "origin_project_id": origin_project_id,
        "destination_project_id": destination_project_id,
    }


@activity.defn
def record_transfer_milestone(
    transfer_id: str,
    asset_id: str,
    milestone: str,  # "approved" | "in_transit" | "received"
    actor_id: str,
    notes: str | None = None,
) -> bool:
    """Append a milestone event to the transfer entity."""
    logger.info(
        "[STUB] record_transfer_milestone",
        extra={"transfer_id": transfer_id, "milestone": milestone, "actor_id": actor_id},
    )
    return True


@activity.defn
def update_asset_branch(asset_id: str, destination_branch_id: str, actor_id: str) -> bool:
    """Update the branch:owns:asset relationship to the destination branch."""
    logger.info(
        "[STUB] update_asset_branch",
        extra={"asset_id": asset_id, "destination_branch_id": destination_branch_id},
    )
    return True


# ---------------------------------------------------------------------------
# Inspection activities
# ---------------------------------------------------------------------------

@activity.defn
def create_inspection_record(asset_id: str, inspection_type: str, inspector_id: str) -> dict[str, Any]:
    """Create an inspection entity and link it to the asset."""
    inspection_id = _idempotent_id(f"inspection:{asset_id}:{inspection_type}:{inspector_id}")
    logger.info(
        "[STUB] create_inspection_record",
        extra={"inspection_id": inspection_id, "asset_id": asset_id, "inspection_type": inspection_type},
    )
    return {"inspection_id": inspection_id, "asset_id": asset_id, "status": "in_progress"}


@activity.defn
def resolve_post_inspection_status(
    asset_id: str,
    inspection_type: str,
    outcome: str,
) -> str:
    """Determine and apply the correct asset status following an inspection result.

    Returns the new asset status string.
    """
    if outcome == InspectionResult.FAIL.value:
        new_status = AssetStatus.INSPECTION_HOLD.value
    elif inspection_type in (InspectionType.RETURN.value, InspectionType.SERVICE.value):
        new_status = AssetStatus.AVAILABLE.value
    else:
        # checkout pass — asset goes (or remains) on_rent
        new_status = AssetStatus.ON_RENT.value

    logger.info(
        "[STUB] resolve_post_inspection_status",
        extra={"asset_id": asset_id, "outcome": outcome, "new_status": new_status},
    )
    return new_status


# ---------------------------------------------------------------------------
# Maintenance activities
# ---------------------------------------------------------------------------

@activity.defn
def create_maintenance_record(
    asset_id: str,
    maintenance_type: str,
    technician_id: str,
    notes: str | None = None,
    availability_impact: str | None = None,
    blocking_reason: str | None = None,
    expected_return_at: str | None = None,
) -> dict[str, Any]:
    """Create a maintenance entity and link it to the asset.

    availability_impact ('soft_down' | 'hard_down') controls how the derived
    down state is projected into inventory availability.  blocking_reason is a
    human-readable explanation surfaced to ops users.  expected_return_at is
    an optional ISO-8601 timestamp for when the asset is expected back in service.
    """
    record_id = _idempotent_id(f"maintenance:{asset_id}:{maintenance_type}:{technician_id}")
    logger.info(
        "[STUB] create_maintenance_record",
        extra={
            "record_id": record_id,
            "asset_id": asset_id,
            "maintenance_type": maintenance_type,
            "availability_impact": availability_impact,
        },
    )
    return {
        "maintenance_record_id": record_id,
        "asset_id": asset_id,
        "status": "open",
        "availability_impact": availability_impact,
        "blocking_reason": blocking_reason,
        "expected_return_at": expected_return_at,
    }


@activity.defn
def complete_maintenance_record(
    maintenance_record_id: str,
    asset_id: str,
    technician_id: str,
    outcome: str,
    completed_at: str,
    resolution_notes: str | None = None,
    cost_summary: str | None = None,
) -> dict[str, Any]:
    """Mark a maintenance record as completed and preserve completion details."""
    client = _get_rental_operations_persistence_client()
    current_record = _get_current_entity_state(client, maintenance_record_id, "maintenance_record")
    relationship = client.select(
        "rental_current_relationships",
        columns="relationship_id,parent_id,child_id,relationship_type",
        filters={
            "relationship_type": "asset_has_maintenance_record",
            "parent_id": asset_id,
            "child_id": maintenance_record_id,
        },
        limit=1,
    )
    if not relationship:
        raise ValueError(
            f"maintenance_record {maintenance_record_id} is not linked to asset {asset_id}"
        )
    next_data = {
        **_json_object(current_record.get("data")),
        "status": "completed",
        "asset_id": asset_id,
        "technician_id": technician_id,
        "completed_by": technician_id,
        "outcome": outcome,
        "completed_at": completed_at,
    }
    if resolution_notes is not None:
        next_data["resolution_notes"] = resolution_notes
    if cost_summary is not None:
        next_data["cost_summary"] = cost_summary
    persisted = client.rpc(
        "rental_upsert_entity_current_state",
        {
            "p_entity_type": "maintenance_record",
            "p_entity_id": maintenance_record_id,
            "p_data": next_data,
        },
    )
    logger.info(
        "complete_maintenance_record",
        extra={
            "maintenance_record_id": maintenance_record_id,
            "asset_id": asset_id,
            "technician_id": technician_id,
            "outcome": outcome,
            "completed_at": completed_at,
        },
    )
    return {
        "maintenance_record_id": maintenance_record_id,
        "asset_id": asset_id,
        "status": "completed",
        "entity_version_id": str(persisted[0].get("entity_version_id", "")) if persisted else "",
        "outcome": outcome,
        "completed_at": completed_at,
        "resolution_notes": resolution_notes,
        "cost_summary": cost_summary,
    }


@activity.defn
def resolve_asset_maintenance_completion_status(asset_id: str) -> dict[str, Any]:
    """Return the explicit post-completion status after checking for blocking holds."""
    client = _get_rental_operations_persistence_client()
    asset_row = _get_current_entity_state(client, asset_id, "asset")
    current_asset_data = _json_object(asset_row.get("data"))
    relationships = client.select(
        "rental_current_relationships",
        columns="relationship_id,relationship_type,parent_id,child_id,child_entity_type",
        filters={"parent_id": asset_id},
    )

    for relationship in relationships:
        if relationship.get("relationship_type") != "asset_has_maintenance_record":
            continue
        child_id = str(relationship.get("child_id") or "")
        if not child_id:
            continue
        maintenance_row = _get_current_entity_state(client, child_id, "maintenance_record")
        if _maintenance_record_is_blocking(_json_object(maintenance_row.get("data"))):
            return {
                "asset_id": asset_id,
                "status": AssetStatus.MAINTENANCE.value,
                "restore_to_available": False,
                "blocking_reason": f"open maintenance record {child_id}",
            }

    for relationship in relationships:
        if relationship.get("relationship_type") != "asset_has_inspection":
            continue
        child_id = str(relationship.get("child_id") or "")
        if not child_id:
            continue
        inspection_row = _get_current_entity_state(client, child_id, "inspection")
        if _inspection_record_is_blocking(_json_object(inspection_row.get("data"))):
            return {
                "asset_id": asset_id,
                "status": AssetStatus.INSPECTION_HOLD.value,
                "restore_to_available": False,
                "blocking_reason": f"inspection hold {child_id}",
            }

    current_status = (
        str(current_asset_data.get("status") or "").strip()
        or str(current_asset_data.get("operational_status") or "").strip()
    )
    resolved_status = current_status if current_status in {AssetStatus.RETIRED.value, AssetStatus.UNAVAILABLE.value} else AssetStatus.AVAILABLE.value
    logger.info(
        "resolve_asset_maintenance_completion_status",
        extra={"asset_id": asset_id, "resolved_status": resolved_status},
    )
    return {
        "asset_id": asset_id,
        "status": resolved_status,
        "restore_to_available": resolved_status == AssetStatus.AVAILABLE.value,
        "blocking_reason": None,
    }


@activity.defn
def record_asset_downtime(
    asset_id: str,
    maintenance_record_id: str,
    downtime_minutes: float,
    downtime_started_at: str | None = None,
    downtime_completed_at: str | None = None,
    downtime_source: str = "maintenance",
    related_inspection_id: str | None = None,
) -> bool:
    """Write a time_series_points row for asset_downtime fact type.

    This is the maintenance-completion signal for the time-interval PM trigger
    family: after a maintenance event is recorded via this activity, the PM
    evaluator resets the elapsed-time baseline for the asset and a fresh
    interval window begins.

    The TSP row uses ``source_id = maintenance_record_id`` so that retried
    activity executions do not create duplicate rows (the fact-type-specific
    partial unique index ``uq_tsp_downtime_source`` on
    ``(entity_id, source_id)`` scoped to the ``asset_downtime`` fact type
    enforces this).

    Args:
        asset_id:              UUID of the asset that was under maintenance.
        maintenance_record_id: UUID of the maintenance record entity.
        downtime_minutes:      Total minutes the asset was unavailable.

    Returns:
        ``True`` on success, ``False`` if the ``asset_downtime`` fact type is
        not found in the database (schema mismatch warning).
    """
    client = _get_rental_operations_persistence_client()

    ft_rows = client.select(
        "fact_types",
        columns="id",
        filters={"key": "asset_downtime"},
        limit=1,
    )
    if not ft_rows:
        logger.warning(
            "record_asset_downtime: fact_type 'asset_downtime' not found",
            extra={"asset_id": asset_id, "maintenance_record_id": maintenance_record_id},
        )
        return False

    fact_type_id = str(ft_rows[0]["id"])
    observed_at = downtime_completed_at or downtime_started_at or datetime.now(tz=UTC).isoformat()
    client.upsert(
        "time_series_points",
        {
            "entity_id": asset_id,
            "fact_type_id": fact_type_id,
            "observed_at": observed_at,
            "data_payload": {
                "downtime_minutes": downtime_minutes,
                "maintenance_record_id": maintenance_record_id,
                "inspection_id": related_inspection_id,
            },
            "metadata": {
                "source": downtime_source,
                "downtime_started_at": downtime_started_at,
                "downtime_completed_at": downtime_completed_at,
            },
            "source_id": maintenance_record_id,
        },
        on_conflict="entity_id,source_id",
    )
    logger.info(
        "record_asset_downtime",
        extra={
            "asset_id": asset_id,
            "maintenance_record_id": maintenance_record_id,
            "downtime_minutes": downtime_minutes,
            "downtime_source": downtime_source,
        },
    )
    return True


@activity.defn
def record_maintenance_completion_event(
    asset_id: str,
    maintenance_record_id: str,
    completed_at: str,
    outcome: str,
    downtime_minutes: float,
    final_asset_status: str,
) -> bool:
    """Append a maintenance completion event to the service-history stream."""
    client = _get_rental_operations_persistence_client()
    fact_type_id = _resolve_fact_type_id(client, **_MAINTENANCE_COMPLETION_EVENT_FACT)
    client.insert(
        "time_series_points",
        {
            "entity_id": asset_id,
            "fact_type_id": fact_type_id,
            "observed_at": completed_at,
            "data_payload": {
                "event_type": "maintenance_completed",
                "maintenance_record_id": maintenance_record_id,
                "completed_at": completed_at,
                "outcome": outcome,
                "downtime_minutes": downtime_minutes,
                "final_asset_status": final_asset_status,
            },
            "metadata": {
                "source": "maintenance_workflow",
                "asset_status": final_asset_status,
            },
            "source_id": f"maintenance_completed:{maintenance_record_id}:{completed_at}",
        },
    )
    logger.info(
        "record_maintenance_completion_event",
        extra={
            "asset_id": asset_id,
            "maintenance_record_id": maintenance_record_id,
            "completed_at": completed_at,
            "outcome": outcome,
            "final_asset_status": final_asset_status,
        },
    )
    return True


# ---------------------------------------------------------------------------
# Maintenance costing activities
# ---------------------------------------------------------------------------

@activity.defn
def add_maintenance_cost_line(
    maintenance_record_id: str,
    line_type: str,
    description: str,
    quantity: float,
    unit_cost: float,
    sell_amount: float,
    is_taxable: bool = False,
    tax_rate: float = 0.0,
    notes: str | None = None,
    line_id: str | None = None,
) -> dict[str, Any]:
    """Create a maintenance_cost_line row linked to the maintenance record.

    ``line_id`` is a caller-supplied idempotency key that scopes retry-safety
    to a single logical line rather than to the full set of business fields.
    Two line items with the same business data (description, qty, cost) but
    different ``line_id`` values are always stored as separate rows, so
    identical charges can be entered more than once on the same work order.

    Retrying the *same* activity execution (same ``line_id``) is idempotent
    via upsert on ``(maintenance_record_id, line_id)``.

    The generated columns ``cost_total``, ``sell_line_total``, and
    ``tax_amount`` are computed by the database; their values are also
    computed locally and returned so callers do not need a second round-trip.
    """
    if not line_id:
        raise ValueError("line_id is required; callers must supply a stable per-line idempotency key")

    row_id = _idempotent_id(f"maintenance_cost_line:{maintenance_record_id}:{line_id}")
    cost_total = round(quantity * unit_cost, 4)
    sell_line_total = round(quantity * sell_amount, 4)
    tax_amount = round(sell_line_total * tax_rate, 4) if is_taxable else 0.0

    client = _get_rental_operations_persistence_client()
    row = client.upsert(
        "maintenance_cost_lines",
        {
            "id": row_id,
            "maintenance_record_id": maintenance_record_id,
            "line_id": line_id,
            "line_type": line_type,
            "description": description,
            "quantity": quantity,
            "unit_cost": unit_cost,
            "sell_amount": sell_amount,
            "is_taxable": is_taxable,
            "tax_rate": tax_rate,
            "notes": notes,
        },
        on_conflict="maintenance_record_id,line_id",
    )

    logger.info(
        "add_maintenance_cost_line",
        extra={
            "row_id": row_id,
            "line_id": line_id,
            "maintenance_record_id": maintenance_record_id,
            "line_type": line_type,
            "cost_total": cost_total,
            "sell_line_total": sell_line_total,
        },
    )
    return {
        "cost_line_id": row_id,
        "line_id": line_id,
        "maintenance_record_id": maintenance_record_id,
        "line_type": line_type,
        "description": description,
        "quantity": quantity,
        "unit_cost": unit_cost,
        "sell_amount": sell_amount,
        "cost_total": row.get("cost_total") if row.get("cost_total") is not None else cost_total,
        "sell_line_total": row.get("sell_line_total") if row.get("sell_line_total") is not None else sell_line_total,
        "is_taxable": is_taxable,
        "tax_rate": tax_rate,
        "tax_amount": row.get("tax_amount") if row.get("tax_amount") is not None else tax_amount,
        "notes": notes,
    }


@activity.defn
def compute_maintenance_work_order_totals(
    maintenance_record_id: str,
    cost_lines: list,
) -> dict[str, Any]:
    """Roll up itemized cost lines into work-order totals and persist via SCD2.

    Queries the durable ``maintenance_cost_lines`` rows from the database so
    that totals are always consistent with what was actually persisted.  The
    result is written back to the maintenance record entity as a new SCD2
    version so that the ``v_maintenance_work_order_billing`` view and fleet
    analytics always reflect the current rolled-up state.
    """
    client = _get_rental_operations_persistence_client()

    # 1. Query actual persisted cost lines from the DB
    rows = client.select(
        "maintenance_cost_lines",
        columns="cost_total,sell_line_total,tax_amount",
        filters={"maintenance_record_id": maintenance_record_id},
    )

    internal_subtotal = round(sum(float(r.get("cost_total") or 0) for r in rows), 2)
    sell_subtotal = round(sum(float(r.get("sell_line_total") or 0) for r in rows), 2)
    tax_total = round(sum(float(r.get("tax_amount") or 0) for r in rows), 2)
    sell_total = round(sell_subtotal + tax_total, 2)
    cost_line_count = len(rows)

    # 2. Fetch the current SCD2 entity version to carry existing data forward
    current_versions = client.select(
        "entity_versions",
        columns="entity_id,version_number,data",
        filters={"entity_id": maintenance_record_id, "is_current": True},
        limit=1,
    )
    current = current_versions[0] if current_versions else {}
    current_data = dict(current.get("data") or {})
    current_version_num = int(current.get("version_number") or 0)

    # 3. Insert a new SCD2 version with the updated cost totals.
    # The trg_entity_versions_scd2 BEFORE INSERT trigger automatically retires
    # the previous current row by setting is_current=false AND
    # valid_to=new.valid_from.  We must NOT manually clear is_current before
    # this insert; doing so would prevent the trigger from finding the old
    # current row and it would leave valid_to=NULL on the retired version.
    client.insert(
        "entity_versions",
        {
            "entity_id": maintenance_record_id,
            "version_number": current_version_num + 1,
            "is_current": True,
            "data": {
                **current_data,
                "internal_subtotal": internal_subtotal,
                "sell_subtotal": sell_subtotal,
                "tax_total": tax_total,
                "sell_total": sell_total,
                "cost_line_count": cost_line_count,
            },
        },
    )

    logger.info(
        "compute_maintenance_work_order_totals",
        extra={
            "maintenance_record_id": maintenance_record_id,
            "line_count": cost_line_count,
            "internal_subtotal": internal_subtotal,
            "sell_subtotal": sell_subtotal,
            "sell_total": sell_total,
        },
    )
    return {
        "maintenance_record_id": maintenance_record_id,
        "cost_line_count": cost_line_count,
        "internal_subtotal": internal_subtotal,
        "sell_subtotal": sell_subtotal,
        "tax_total": tax_total,
        "sell_total": sell_total,
    }


@activity.defn
def check_maintenance_invoice_exists(
    maintenance_record_id: str,
) -> dict[str, Any]:
    """Check whether a draft invoice already exists for this work order.

    Queries ``relationships_v2`` for a live
    ``invoice:generated_from:maintenance_work_order`` edge whose child is
    *maintenance_record_id*.  Returns the existing invoice_id and
    ``'exists': True`` when found so that invoice creation can be skipped
    (idempotency guard).
    """
    client = _get_rental_operations_persistence_client()
    rows = client.select(
        "relationships_v2",
        columns="parent_id",
        filters={
            "relationship_type": "invoice:generated_from:maintenance_work_order",
            "child_id": maintenance_record_id,
            "is_current": True,
        },
        limit=1,
    )
    if rows:
        invoice_id = str(rows[0].get("parent_id") or "")
        logger.info(
            "check_maintenance_invoice_exists: found",
            extra={"maintenance_record_id": maintenance_record_id, "invoice_id": invoice_id},
        )
        return {"exists": True, "invoice_id": invoice_id}

    logger.info(
        "check_maintenance_invoice_exists: not found",
        extra={"maintenance_record_id": maintenance_record_id},
    )
    return {"exists": False, "invoice_id": None}


@activity.defn
def create_maintenance_invoice(
    maintenance_record_id: str,
    billing_account_id: str,
    sell_subtotal: float,
    tax_total: float,
    sell_total: float,
    created_by: str = "system",
) -> dict[str, Any]:
    """Create a draft invoice entity linked to the maintenance work order.

    The invoice_id is deterministic so that a retry with the same inputs does
    not create a second invoice row (idempotent upsert on ``entities.id``).
    Steps performed in order:
      1. Upsert the invoice entity row.
      2. Upsert entity_version 1 with invoice data in the JSONB ``data`` blob.
      3. Upsert the ``invoice:generated_from:maintenance_work_order``
         relationship so that ``check_maintenance_invoice_exists`` can detect
         it on a subsequent call.
    """
    invoice_id = _idempotent_id(
        f"maintenance_invoice:{maintenance_record_id}:{billing_account_id}"
    )
    client = _get_rental_operations_persistence_client()

    # 1. Ensure invoice entity exists
    client.upsert(
        "entities",
        {
            "id": invoice_id,
            "entity_type": "invoice",
            "source_record_id": f"maintenance:{maintenance_record_id}",
        },
        on_conflict="id",
    )

    # 2. Upsert entity version 1 with invoice data
    client.upsert(
        "entity_versions",
        {
            "entity_id": invoice_id,
            "version_number": 1,
            "is_current": True,
            "data": {
                "status": InvoiceStatus.DRAFT.value,
                "billing_account_id": billing_account_id,
                "maintenance_record_id": maintenance_record_id,
                "sell_subtotal": sell_subtotal,
                "tax_total": tax_total,
                "sell_total": sell_total,
                "created_by": created_by,
            },
        },
        on_conflict="entity_id,version_number",
    )

    # 3. Upsert the relationship linking invoice to maintenance work order
    client.upsert(
        "relationships_v2",
        {
            "relationship_type": "invoice:generated_from:maintenance_work_order",
            "parent_id": invoice_id,
            "child_id": maintenance_record_id,
            "is_current": True,
            "metadata": {"billing_account_id": billing_account_id, "created_by": created_by},
        },
        on_conflict="relationship_type,parent_id,child_id",
    )

    logger.info(
        "create_maintenance_invoice",
        extra={
            "invoice_id": invoice_id,
            "maintenance_record_id": maintenance_record_id,
            "billing_account_id": billing_account_id,
            "sell_total": sell_total,
        },
    )
    return {
        "invoice_id": invoice_id,
        "maintenance_record_id": maintenance_record_id,
        "billing_account_id": billing_account_id,
        "status": InvoiceStatus.DRAFT.value,
        "sell_subtotal": sell_subtotal,
        "tax_total": tax_total,
        "sell_total": sell_total,
    }


# ---------------------------------------------------------------------------
# Invoice activities
# ---------------------------------------------------------------------------

@activity.defn
def create_invoice_record(
    contract_id: str,
    billing_period_start: str,
    billing_period_end: str,
    created_by: str,
) -> dict[str, Any]:
    """Create an invoice entity with draft status."""
    invoice_id = _idempotent_id(f"invoice:{contract_id}:{billing_period_start}:{billing_period_end}")
    logger.info("[STUB] create_invoice_record", extra={"invoice_id": invoice_id})
    return {
        "invoice_id": invoice_id,
        "contract_id": contract_id,
        "status": InvoiceStatus.DRAFT.value,
    }


@activity.defn
def derive_invoiceable_line_items(
    contract_id: str,
    line_items: list,
) -> dict[str, Any]:
    """Filter and de-duplicate invoiceable line items from rental lifecycle data."""
    ignored_statuses = {"draft", "void", "cancelled"}
    seen_sources: set[str] = set()
    invoiceable: list[dict] = []
    dropped_duplicates = 0

    for idx, item in enumerate(line_items):
        status = str(item.get("lifecycle_status", "approved")).lower()
        if status in ignored_statuses:
            continue

        source_key = str(
            item.get("source_key")
            or f"{item.get('source_type', 'contract_line')}:{item.get('source_id', idx)}"
        )
        if source_key in seen_sources:
            dropped_duplicates += 1
            continue
        seen_sources.add(source_key)

        invoiceable.append(
            {
                **item,
                "source_key": source_key,
                "contract_id": item.get("contract_id", contract_id),
            }
        )

    logger.info(
        "[STUB] derive_invoiceable_line_items",
        extra={
            "contract_id": contract_id,
            "line_item_count": len(line_items),
            "invoiceable_count": len(invoiceable),
            "dropped_duplicates": dropped_duplicates,
        },
    )
    return {
        "line_items": invoiceable,
        "invoiceable_count": len(invoiceable),
        "dropped_duplicates": dropped_duplicates,
    }


@activity.defn
def evaluate_invoice_readiness(
    contract_id: str,
    contract_status: str,
    line_items: list,
    billing_holds: list[str] | None = None,
) -> dict[str, Any]:
    """Evaluate billing holds and data completeness before invoice progression."""
    exceptions: list[dict] = []

    status = (contract_status or "").lower()
    if status in {InvoiceStatus.DRAFT.value, InvoiceStatus.VOID.value}:
        exceptions.append(
            {
                "code": "contract_not_billable",
                "reason": f"Contract {contract_id} is {status or 'unknown'} and cannot be invoiced.",
                "blocking": True,
            }
        )

    for hold in billing_holds or []:
        exceptions.append(
            {
                "code": "billing_hold",
                "reason": f"Billing hold present: {hold}",
                "blocking": True,
            }
        )

    for item in line_items:
        source_key = str(item.get("source_key", "unknown_source"))
        charge_type = str(item.get("charge_type", "rental")).lower()
        if charge_type == "rental":
            requires_return = bool(item.get("requires_return_data", False))
            requires_usage = bool(item.get("requires_usage_data", False))
            has_return = bool(item.get("actual_return_at"))
            has_usage = item.get("usage_quantity") is not None
            if requires_return and not has_return:
                exceptions.append(
                    {
                        "code": "missing_return_data",
                        "reason": f"Return timestamp is missing for {source_key}.",
                        "blocking": True,
                        "source_key": source_key,
                    }
                )
            if requires_usage and not has_usage:
                exceptions.append(
                    {
                        "code": "missing_usage_data",
                        "reason": f"Usage quantity is missing for {source_key}.",
                        "blocking": True,
                        "source_key": source_key,
                    }
                )

    if not line_items:
        exceptions.append(
            {
                "code": "no_invoiceable_lines",
                "reason": "No invoiceable line items are available for this billing period.",
                "blocking": True,
            }
        )

    blocked = any(bool(exc.get("blocking")) for exc in exceptions)
    logger.info(
        "[STUB] evaluate_invoice_readiness",
        extra={
            "contract_id": contract_id,
            "blocked": blocked,
            "exception_count": len(exceptions),
        },
    )
    return {"blocked": blocked, "exceptions": exceptions}


@activity.defn
def compute_invoice_totals(
    invoice_id: str,
    line_items: list,
) -> dict[str, Any]:
    """Compute subtotal, tax, and total from line items.

    Each line_item dict is expected to have: {'rate': float, 'quantity': float, 'tax_rate': float}.
    """
    subtotal: float = 0.0
    tax: float = 0.0
    for item in line_items:
        rate = float(item.get("rate", 0))
        quantity = float(item.get("quantity", 1))
        item_tax_rate = float(item.get("tax_rate", 0.0))
        line_total = rate * quantity
        subtotal += line_total
        tax += line_total * item_tax_rate

    subtotal = round(subtotal, 2)
    tax = round(tax, 2)
    total = round(subtotal + tax, 2)

    logger.info(
        "[STUB] compute_invoice_totals",
        extra={"invoice_id": invoice_id, "line_item_count": len(line_items)},
    )
    return {"subtotal": subtotal, "tax": tax, "total": total}


@activity.defn
def finalise_invoice(
    invoice_id: str,
    subtotal: float,
    tax: float,
    total: float,
    blocked: bool = False,
    billing_exceptions: list[dict] | None = None,
    billing_context: dict | None = None,
) -> dict[str, Any]:
    """Persist computed totals and advance invoice status to 'pending'."""
    logger.info("[STUB] finalise_invoice", extra={"invoice_id": invoice_id})
    final_status = InvoiceStatus.DRAFT.value if blocked else InvoiceStatus.PENDING.value
    context = billing_context or {}
    return {
        "invoice_id": invoice_id,
        "status": final_status,
        "subtotal": subtotal,
        "tax": tax,
        "total": total,
        "blocked": blocked,
        "billing_exceptions": billing_exceptions or [],
        "customer_id": context.get("customer_id"),
        "billing_account_id": context.get("billing_account_id"),
        "job_site_id": context.get("job_site_id"),
        "transaction_currency_code": context.get("transaction_currency_code", "USD"),
        "reporting_currency_code": context.get("reporting_currency_code", "USD"),
        "fx_rate_applied": context.get("fx_rate_applied", 1.0),
        "fx_rate_effective_at": context.get("fx_rate_effective_at"),
    }
