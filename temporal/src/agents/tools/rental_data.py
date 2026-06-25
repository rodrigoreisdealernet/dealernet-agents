from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from uuid import UUID

from ...config import settings
from ..url_safety import is_safe_external_url

ENTITY_TYPE_ALLOWLIST = frozenset(
    {
        "branch",
        "customer",
        "billing_account",
        "contact",
        "job_site",
        "asset_category",
        "asset",
        "maintenance_record",
        "inspection",
        "rental_order",
        "rental_order_line",
        "rental_contract",
        "rental_contract_line",
        "invoice",
        "rate_card",
    }
)

RELATIONSHIP_TYPE_ALLOWLIST = frozenset(
    {
        "customer_has_billing_account",
        "customer_has_contact",
        "customer_has_job_site",
        "branch_has_asset",
        "asset_category_has_asset",
        "asset_has_maintenance_record",
        "asset_has_inspection",
        "order_has_line",
        "order_converted_to",
        "contract_has_line",
        "line_assigned_asset",
    }
)

FACT_KEY_ALLOWLIST = frozenset(
    {
        "asset_meter_reading",
        "asset_downtime",
        "branch_on_rent_count",
        "branch_utilization_rate",
        "invoice_total",
        "rental_revenue",
        "rental_order_count",
        "rental_contract_count",
        "rental_line_duration_days",
        "rental_line_rate_amount",
    }
)

RATE_TYPE_ALLOWLIST = frozenset({"daily", "weekly", "monthly", "fixed"})

ENTITY_SORT_ALLOWLIST = frozenset({"entity_id", "created_at", "updated_at"})
TIME_SERIES_SORT_ALLOWLIST = frozenset({"observed_at", "created_at"})
FACT_SORT_ALLOWLIST = frozenset({"updated_at", "created_at", "value"})


class ToolValidationError(ValueError):
    """Raised when agent tool inputs fail validation."""


@dataclass(frozen=True)
class AppScope:
    tenant_id: str
    branch_id: str | None = None

    def __post_init__(self) -> None:
        if not self.tenant_id:
            raise ToolValidationError("tenant_id is required")


class RentalReadModel(Protocol):
    def entities(self) -> Iterable[Mapping[str, Any]]: ...
    def relationships(self) -> Iterable[Mapping[str, Any]]: ...
    def facts(self) -> Iterable[Mapping[str, Any]]: ...
    def time_series_points(self) -> Iterable[Mapping[str, Any]]: ...
    def invoices(self) -> Iterable[Mapping[str, Any]]: ...
    def rate_cards(self) -> Iterable[Mapping[str, Any]]: ...
    def synthetic_telematics(self) -> Iterable[Mapping[str, Any]]: ...


ReadModelQuery = Callable[[str], list[dict[str, Any]]]


class RentalReadClient(Protocol):
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


class PostgrestReadClient:
    def __init__(self, *, base_url: str, service_role_key: str, timeout_seconds: int = 10) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_role_key = service_role_key
        self._timeout_seconds = timeout_seconds

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
        query = urllib_parse.urlencode(params, safe=".*,()")
        url = f"{self._base_url}/rest/v1/{resource}?{query}"
        req = urllib_request.Request(
            url=url,
            method="GET",
            headers={
                "apikey": self._service_role_key,
                "Authorization": "Bearer " + self._service_role_key,
            },
        )
        try:
            with urllib_request.urlopen(req, timeout=self._timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except urllib_error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Supabase read failed ({resource}): {exc.code} {detail}") from exc
        except urllib_error.URLError as exc:
            raise RuntimeError(f"Supabase read failed ({resource}): {exc}") from exc

        decoded = json.loads(raw) if raw.strip() else []
        if isinstance(decoded, list):
            return [dict(item) for item in decoded if isinstance(item, Mapping)]
        if isinstance(decoded, Mapping):
            return [dict(decoded)]
        return []


@dataclass(slots=True)
class SupabaseRentalReadModel:
    client: RentalReadClient

    def _entity_scope_index(self) -> dict[str, dict[str, Any]]:
        rows = self.client.select(
            "rental_current_entity_state",
            columns="entity_id,entity_type,data,created_at,updated_at",
        )
        return {str(row.get("entity_id")): dict(row) for row in rows}

    def _asset_branch_index(self) -> dict[str, Any]:
        rows = self.client.select("rental_current_assets", columns="entity_id,current_branch_id")
        return {str(row.get("entity_id")): row.get("current_branch_id") for row in rows}

    def entities(self) -> Iterable[Mapping[str, Any]]:
        rows = self.client.select(
            "rental_current_entity_state",
            columns="entity_id,entity_type,entity_version_id,version_number,data,created_at,updated_at",
        )
        return [
            {
                "entity_id": row.get("entity_id"),
                "entity_type": row.get("entity_type"),
                "version_id": row.get("entity_version_id"),
                "version_number": row.get("version_number"),
                "data": row.get("data", {}),
                "created_at": row.get("created_at"),
                "updated_at": row.get("updated_at"),
            }
            for row in rows
        ]

    def relationships(self) -> Iterable[Mapping[str, Any]]:
        rows = self.client.select(
            "rental_current_relationships",
            columns="relationship_id,relationship_type,parent_id,child_id,metadata,valid_from,valid_to",
        )
        scope_index = self._entity_scope_index()
        scoped_rows: list[dict[str, Any]] = []
        for row in rows:
            parent = scope_index.get(str(row.get("parent_id")), {})
            child = scope_index.get(str(row.get("child_id")), {})
            metadata = dict(row.get("metadata") or {})
            scoped_rows.append(
                {
                    **dict(row),
                    "tenant_id": (parent.get("data") or {}).get("tenant_id")
                    or (child.get("data") or {}).get("tenant_id")
                    or metadata.get("tenant_id"),
                    "branch_id": (parent.get("data") or {}).get("branch_id")
                    or (child.get("data") or {}).get("branch_id")
                    or metadata.get("branch_id"),
                }
            )
        return scoped_rows

    def facts(self) -> Iterable[Mapping[str, Any]]:
        fact_types = self.client.select("fact_types", columns="id,key")
        fact_type_by_id = {str(row.get("id")): row.get("key") for row in fact_types}
        entity_scope = self._entity_scope_index()
        asset_branch_by_id = self._asset_branch_index()
        rows = self.client.select(
            "entity_facts",
            columns="id,entity_id,fact_type_id,value,unit,metadata,created_at,updated_at",
        )
        payload: list[dict[str, Any]] = []
        for row in rows:
            entity_id = str(row.get("entity_id"))
            entity = entity_scope.get(entity_id, {})
            data = entity.get("data") or {}
            metadata = dict(row.get("metadata") or {})
            payload.append(
                {
                    "fact_id": row.get("id"),
                    "entity_id": entity_id,
                    "fact_key": fact_type_by_id.get(str(row.get("fact_type_id"))),
                    "value": row.get("value"),
                    "unit": row.get("unit"),
                    "metadata": metadata,
                    "tenant_id": data.get("tenant_id") or metadata.get("tenant_id"),
                    "branch_id": data.get("branch_id") or asset_branch_by_id.get(entity_id) or metadata.get("branch_id"),
                    "created_at": row.get("created_at"),
                    "updated_at": row.get("updated_at"),
                }
            )
        return payload

    def time_series_points(self) -> Iterable[Mapping[str, Any]]:
        fact_types = self.client.select("fact_types", columns="id,key")
        fact_type_by_id = {str(row.get("id")): row.get("key") for row in fact_types}
        entity_scope = self._entity_scope_index()
        asset_branch_by_id = self._asset_branch_index()
        rows = self.client.select(
            "time_series_points",
            columns="id,entity_id,fact_type_id,observed_at,data_payload,metadata,created_at",
        )
        payload: list[dict[str, Any]] = []
        for row in rows:
            entity_id = str(row.get("entity_id"))
            entity = entity_scope.get(entity_id, {})
            data = entity.get("data") or {}
            metadata = dict(row.get("metadata") or {})
            payload.append(
                {
                    "point_id": row.get("id"),
                    "entity_id": entity_id,
                    "fact_key": fact_type_by_id.get(str(row.get("fact_type_id"))),
                    "observed_at": row.get("observed_at"),
                    "data_payload": row.get("data_payload", {}),
                    "metadata": metadata,
                    "tenant_id": data.get("tenant_id") or metadata.get("tenant_id"),
                    "branch_id": data.get("branch_id") or asset_branch_by_id.get(entity_id) or metadata.get("branch_id"),
                    "created_at": row.get("created_at"),
                }
            )
        return payload

    def invoices(self) -> Iterable[Mapping[str, Any]]:
        rows = self.client.select(
            "rental_current_entity_state",
            columns="entity_id,data",
            filters={"entity_type": "invoice"},
        )
        return [
            {
                "invoice_id": row.get("entity_id"),
                "status": (row.get("data") or {}).get("status"),
                "contract_id": (row.get("data") or {}).get("contract_id"),
                "customer_id": (row.get("data") or {}).get("customer_id"),
                "billing_account_id": (row.get("data") or {}).get("billing_account_id"),
                "currency": (row.get("data") or {}).get("currency"),
                "subtotal": (row.get("data") or {}).get("subtotal"),
                "tax": (row.get("data") or {}).get("tax"),
                "total": (row.get("data") or {}).get("total"),
                "line_items": (row.get("data") or {}).get("line_items", []),
                "issued_at": (row.get("data") or {}).get("issued_at"),
                "due_at": (row.get("data") or {}).get("due_at"),
                "tenant_id": (row.get("data") or {}).get("tenant_id"),
                "branch_id": (row.get("data") or {}).get("branch_id"),
            }
            for row in rows
        ]

    def rate_cards(self) -> Iterable[Mapping[str, Any]]:
        rows = self.client.select(
            "rental_current_entity_state",
            columns="entity_id,data",
            filters={"entity_type": "rate_card"},
        )
        return [
            {
                "rate_card_id": row.get("entity_id"),
                "tenant_id": (row.get("data") or {}).get("tenant_id"),
                "branch_id": (row.get("data") or {}).get("branch_id"),
                "asset_category_id": (row.get("data") or {}).get("asset_category_id"),
                "rate_type": (row.get("data") or {}).get("rate_type"),
                "rate_amount": (row.get("data") or {}).get("rate_amount"),
                "currency": (row.get("data") or {}).get("currency"),
                "effective_from": (row.get("data") or {}).get("effective_from"),
                "effective_to": (row.get("data") or {}).get("effective_to"),
            }
            for row in rows
        ]

    def synthetic_telematics(self) -> Iterable[Mapping[str, Any]]:
        rows = self.client.select(
            "rental_current_entity_state",
            columns="entity_id,data",
            filters={"entity_type": "telematics"},
        )
        return [
            {
                "point_id": row.get("entity_id"),
                "asset_id": (row.get("data") or {}).get("asset_id"),
                "captured_at": (row.get("data") or {}).get("captured_at"),
                "meter_hours": (row.get("data") or {}).get("meter_hours"),
                "engine_on": (row.get("data") or {}).get("engine_on"),
                "lat": (row.get("data") or {}).get("lat"),
                "lon": (row.get("data") or {}).get("lon"),
                "tenant_id": (row.get("data") or {}).get("tenant_id"),
                "branch_id": (row.get("data") or {}).get("branch_id"),
            }
            for row in rows
            if (row.get("data") or {}).get("source") == "synthetic_v1"
        ]


def build_service_role_rental_store(client: RentalReadClient | None = None) -> RentalDataStore:
    read_client = client or PostgrestReadClient(
        base_url=settings.supabase_url,
        service_role_key=settings.supabase_service_role_key,
        timeout_seconds=int(os.getenv("SUPABASE_HTTP_TIMEOUT_SECONDS", "10")),
    )
    return RentalDataStore(read_model=SupabaseRentalReadModel(client=read_client))


@dataclass(slots=True)
class SqlRentalReadModel:
    query: ReadModelQuery

    def entities(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              entity_id,
              entity_type,
              entity_version_id as version_id,
              version_number,
              data,
              created_at,
              updated_at
            from rental_current_entity_state
            """
        )

    def relationships(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              relationship_id,
              relationship_type,
              parent_id,
              child_id,
              metadata,
              coalesce(
                nullif(parent_entities.data ->> 'tenant_id', ''),
                nullif(child_entities.data ->> 'tenant_id', ''),
                nullif(metadata ->> 'tenant_id', '')
              ) as tenant_id,
              coalesce(
                case when parent_entities.entity_type = 'branch' then parent_entities.entity_id::text end,
                case when child_entities.entity_type = 'branch' then child_entities.entity_id::text end,
                nullif(parent_entities.data ->> 'branch_id', ''),
                nullif(child_entities.data ->> 'branch_id', ''),
                nullif(metadata ->> 'branch_id', '')
              ) as branch_id,
              valid_from,
              valid_to
            from rental_current_relationships
            join rental_current_entity_state as parent_entities
              on parent_entities.entity_id = rental_current_relationships.parent_id
            join rental_current_entity_state as child_entities
              on child_entities.entity_id = rental_current_relationships.child_id
            """
        )

    def facts(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              entity_facts.id as fact_id,
              entity_facts.entity_id,
              fact_types.key as fact_key,
              entity_facts.value,
              entity_facts.unit,
              entity_facts.metadata,
              coalesce(
                nullif(scoped_entities.data ->> 'tenant_id', ''),
                nullif(entity_facts.metadata ->> 'tenant_id', '')
              ) as tenant_id,
              coalesce(
                nullif(scoped_entities.data ->> 'branch_id', ''),
                scoped_assets.current_branch_id::text,
                nullif(entity_facts.metadata ->> 'branch_id', '')
              ) as branch_id,
              entity_facts.created_at,
              entity_facts.updated_at
            from entity_facts
            join fact_types
              on fact_types.id = entity_facts.fact_type_id
            join rental_current_entity_state as scoped_entities
              on scoped_entities.entity_id = entity_facts.entity_id
            left join rental_current_assets as scoped_assets
              on scoped_assets.entity_id = entity_facts.entity_id
            """
        )

    def time_series_points(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              time_series_points.id as point_id,
              time_series_points.entity_id,
              fact_types.key as fact_key,
              time_series_points.observed_at,
              time_series_points.data_payload,
              time_series_points.metadata,
              coalesce(
                nullif(scoped_entities.data ->> 'tenant_id', ''),
                nullif(time_series_points.metadata ->> 'tenant_id', '')
              ) as tenant_id,
              coalesce(
                nullif(scoped_entities.data ->> 'branch_id', ''),
                scoped_assets.current_branch_id::text,
                nullif(time_series_points.metadata ->> 'branch_id', '')
              ) as branch_id,
              time_series_points.created_at
            from time_series_points
            join fact_types
              on fact_types.id = time_series_points.fact_type_id
            join rental_current_entity_state as scoped_entities
              on scoped_entities.entity_id = time_series_points.entity_id
            left join rental_current_assets as scoped_assets
              on scoped_assets.entity_id = time_series_points.entity_id
            """
        )

    def invoices(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              entity_id as invoice_id,
              data ->> 'status' as status,
              data ->> 'contract_id' as contract_id,
              data ->> 'customer_id' as customer_id,
              data ->> 'billing_account_id' as billing_account_id,
              data ->> 'currency' as currency,
              (data ->> 'subtotal')::numeric as subtotal,
              (data ->> 'tax')::numeric as tax,
              (data ->> 'total')::numeric as total,
              coalesce(data -> 'line_items', '[]'::jsonb) as line_items,
              data ->> 'issued_at' as issued_at,
              data ->> 'due_at' as due_at,
              data
            from rental_current_entity_state
            where entity_type = 'invoice'
            """
        )

    def rate_cards(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              entity_id as rate_card_id,
              data ->> 'branch_id' as branch_id,
              data ->> 'asset_category_id' as asset_category_id,
              data ->> 'rate_type' as rate_type,
              (data ->> 'rate_amount')::numeric as rate_amount,
              data ->> 'currency' as currency,
              data ->> 'effective_from' as effective_from,
              data ->> 'effective_to' as effective_to,
              data
            from rental_current_entity_state
            where entity_type = 'rate_card'
            """
        )

    def synthetic_telematics(self) -> Iterable[Mapping[str, Any]]:
        return self.query(
            """
            select
              entity_id as point_id,
              data ->> 'asset_id' as asset_id,
              data ->> 'captured_at' as captured_at,
              (data ->> 'meter_hours')::numeric as meter_hours,
              (data ->> 'engine_on')::boolean as engine_on,
              (data ->> 'lat')::numeric as lat,
              (data ->> 'lon')::numeric as lon,
              data
            from rental_current_entity_state
            where entity_type = 'telematics'
              and data ->> 'source' = 'synthetic_v1'
            """
        )


@dataclass(slots=True)
class InMemoryRentalReadModel:
    entity_rows: list[dict[str, Any]]
    relationship_rows: list[dict[str, Any]]
    fact_rows: list[dict[str, Any]]
    time_series_rows: list[dict[str, Any]]
    invoice_rows: list[dict[str, Any]]
    rate_card_rows: list[dict[str, Any]]
    telematics_rows: list[dict[str, Any]]

    def entities(self) -> Iterable[Mapping[str, Any]]:
        return self.entity_rows

    def relationships(self) -> Iterable[Mapping[str, Any]]:
        return self.relationship_rows

    def facts(self) -> Iterable[Mapping[str, Any]]:
        return self.fact_rows

    def time_series_points(self) -> Iterable[Mapping[str, Any]]:
        return self.time_series_rows

    def invoices(self) -> Iterable[Mapping[str, Any]]:
        return self.invoice_rows

    def rate_cards(self) -> Iterable[Mapping[str, Any]]:
        return self.rate_card_rows

    def synthetic_telematics(self) -> Iterable[Mapping[str, Any]]:
        return self.telematics_rows


@dataclass(slots=True)
class RentalDataStore:
    read_model: RentalReadModel


def _validate_uuid(name: str, value: str | None) -> str | None:
    if value is None:
        return None
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise ToolValidationError(f"{name} must be a valid UUID") from exc


def _validate_allowlist(name: str, value: str, allowed: Iterable[str]) -> str:
    if value not in allowed:
        raise ToolValidationError(f"Unsupported {name}: {value}")
    return value


def _validate_limit(limit: int | None, *, default: int, min_value: int = 1, max_value: int = 250) -> int:
    bounded = default if limit is None else int(limit)
    if bounded < min_value or bounded > max_value:
        raise ToolValidationError(f"limit must be between {min_value} and {max_value}")
    return bounded


def _validate_sort(sort_by: str, allowlist: Iterable[str], sort_order: str) -> tuple[str, bool]:
    _validate_allowlist("sort_by", sort_by, allowlist)
    if sort_order not in {"asc", "desc"}:
        raise ToolValidationError("sort_order must be 'asc' or 'desc'")
    return sort_by, sort_order == "desc"


def _parse_datetime(value: str | None, *, name: str) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ToolValidationError(f"{name} must be ISO-8601") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _extract_tenant_id(record: Mapping[str, Any]) -> str | None:
    return (
        record.get("tenant_id")
        or (record.get("metadata") or {}).get("tenant_id")
        or (record.get("data") or {}).get("tenant_id")
    )


def _extract_branch_id(record: Mapping[str, Any]) -> str | None:
    data = record.get("data") or {}
    metadata = record.get("metadata") or {}
    return (
        record.get("branch_id")
        or record.get("current_branch_id")
        or data.get("branch_id")
        or metadata.get("branch_id")
    )


def _matches_scope(record: Mapping[str, Any], scope: AppScope) -> bool:
    if _extract_tenant_id(record) != scope.tenant_id:
        return False
    if scope.branch_id is None:
        return True
    branch_id = _extract_branch_id(record)
    return branch_id == scope.branch_id


def _scoped_rows(rows: Iterable[Mapping[str, Any]], scope: AppScope) -> list[dict[str, Any]]:
    return [dict(row) for row in rows if _matches_scope(row, scope)]


def query_entity(
    store: RentalDataStore,
    scope: AppScope,
    *,
    entity_type: str,
    entity_id: str | None = None,
    limit: int = 50,
    sort_by: str = "updated_at",
    sort_order: str = "desc",
) -> dict[str, Any]:
    _validate_allowlist("entity_type", entity_type, ENTITY_TYPE_ALLOWLIST)
    entity_id = _validate_uuid("entity_id", entity_id)
    limit = _validate_limit(limit, default=50)
    sort_key, reverse = _validate_sort(sort_by, ENTITY_SORT_ALLOWLIST, sort_order)

    candidates = _scoped_rows(store.read_model.entities(), scope)
    candidates = [row for row in candidates if row.get("entity_type") == entity_type]
    if entity_id:
        candidates = [row for row in candidates if row.get("entity_id") == entity_id]

    candidates.sort(key=lambda row: str(row.get(sort_key, "")), reverse=reverse)
    evidence = [
        {
            "entity_id": row.get("entity_id"),
            "entity_type": row.get("entity_type"),
            "version_id": row.get("version_id"),
            "version_number": row.get("version_number"),
            "tenant_id": _extract_tenant_id(row),
            "branch_id": _extract_branch_id(row),
            "data": row.get("data", {}),
            "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at"),
        }
        for row in candidates[:limit]
    ]
    return {"entity_type": entity_type, "count": len(evidence), "evidence": evidence}


def query_time_series(
    store: RentalDataStore,
    scope: AppScope,
    *,
    fact_key: str,
    entity_id: str | None = None,
    start_at: str | None = None,
    end_at: str | None = None,
    limit: int = 100,
    sort_by: str = "observed_at",
    sort_order: str = "desc",
) -> dict[str, Any]:
    _validate_allowlist("fact_key", fact_key, FACT_KEY_ALLOWLIST)
    entity_id = _validate_uuid("entity_id", entity_id)
    start_at_dt = _parse_datetime(start_at, name="start_at")
    end_at_dt = _parse_datetime(end_at, name="end_at")
    if start_at_dt and end_at_dt and start_at_dt > end_at_dt:
        raise ToolValidationError("start_at must be <= end_at")
    limit = _validate_limit(limit, default=100)
    sort_key, reverse = _validate_sort(sort_by, TIME_SERIES_SORT_ALLOWLIST, sort_order)

    points = _scoped_rows(store.read_model.time_series_points(), scope)
    points = [row for row in points if row.get("fact_key") == fact_key]
    if entity_id:
        points = [row for row in points if row.get("entity_id") == entity_id]

    def _in_range(row: Mapping[str, Any]) -> bool:
        observed_at = _parse_datetime(str(row.get("observed_at")), name="observed_at")
        if observed_at is None:
            return False
        if start_at_dt and observed_at < start_at_dt:
            return False
        return not (end_at_dt and observed_at > end_at_dt)

    points = [row for row in points if _in_range(row)]
    points.sort(key=lambda row: str(row.get(sort_key, "")), reverse=reverse)

    evidence = [
        {
            "point_id": row.get("point_id"),
            "entity_id": row.get("entity_id"),
            "fact_key": row.get("fact_key"),
            "observed_at": row.get("observed_at"),
            "data_payload": row.get("data_payload", {}),
            "metadata": row.get("metadata", {}),
        }
        for row in points[:limit]
    ]
    return {"fact_key": fact_key, "count": len(evidence), "evidence": evidence}


def query_relationships(
    store: RentalDataStore,
    scope: AppScope,
    *,
    relationship_type: str,
    entity_id: str | None = None,
    direction: str = "both",
    limit: int = 100,
) -> dict[str, Any]:
    _validate_allowlist("relationship_type", relationship_type, RELATIONSHIP_TYPE_ALLOWLIST)
    entity_id = _validate_uuid("entity_id", entity_id)
    if direction not in {"outbound", "inbound", "both"}:
        raise ToolValidationError("direction must be one of outbound, inbound, both")
    limit = _validate_limit(limit, default=100)

    rows = _scoped_rows(store.read_model.relationships(), scope)
    rows = [row for row in rows if row.get("relationship_type") == relationship_type]

    if entity_id and direction in {"outbound", "both"}:
        outbound = [row for row in rows if row.get("parent_id") == entity_id]
    else:
        outbound = []
    if entity_id and direction in {"inbound", "both"}:
        inbound = [row for row in rows if row.get("child_id") == entity_id]
    else:
        inbound = []

    filtered = (outbound + inbound if direction == "both" else outbound or inbound) if entity_id else rows

    evidence = [
        {
            "relationship_id": row.get("relationship_id"),
            "relationship_type": row.get("relationship_type"),
            "parent_id": row.get("parent_id"),
            "child_id": row.get("child_id"),
            "metadata": row.get("metadata", {}),
            "valid_from": row.get("valid_from"),
            "valid_to": row.get("valid_to"),
        }
        for row in filtered[:limit]
    ]
    return {"relationship_type": relationship_type, "count": len(evidence), "evidence": evidence}


def query_facts(
    store: RentalDataStore,
    scope: AppScope,
    *,
    fact_keys: list[str],
    entity_id: str | None = None,
    limit: int = 100,
    sort_by: str = "updated_at",
    sort_order: str = "desc",
) -> dict[str, Any]:
    if not fact_keys:
        raise ToolValidationError("fact_keys must include at least one item")
    invalid_keys = [key for key in fact_keys if key not in FACT_KEY_ALLOWLIST]
    if invalid_keys:
        raise ToolValidationError(f"Unsupported fact keys: {', '.join(invalid_keys)}")

    entity_id = _validate_uuid("entity_id", entity_id)
    limit = _validate_limit(limit, default=100)
    sort_key, reverse = _validate_sort(sort_by, FACT_SORT_ALLOWLIST, sort_order)

    rows = _scoped_rows(store.read_model.facts(), scope)
    rows = [row for row in rows if row.get("fact_key") in set(fact_keys)]
    if entity_id:
        rows = [row for row in rows if row.get("entity_id") == entity_id]

    rows.sort(key=lambda row: str(row.get(sort_key, "")), reverse=reverse)
    evidence = [
        {
            "fact_id": row.get("fact_id"),
            "entity_id": row.get("entity_id"),
            "fact_key": row.get("fact_key"),
            "value": row.get("value"),
            "unit": row.get("unit"),
            "metadata": row.get("metadata", {}),
            "updated_at": row.get("updated_at"),
        }
        for row in rows[:limit]
    ]
    return {"fact_keys": sorted(set(fact_keys)), "count": len(evidence), "evidence": evidence}


def get_invoice_detail(store: RentalDataStore, scope: AppScope, *, invoice_id: str) -> dict[str, Any]:
    invoice_id = _validate_uuid("invoice_id", invoice_id)
    matches = _scoped_rows(store.read_model.invoices(), scope)
    matches = [row for row in matches if row.get("invoice_id") == invoice_id]

    if not matches:
        return {"invoice_id": invoice_id, "found": False, "evidence": None}

    invoice = matches[0]
    return {
        "invoice_id": invoice_id,
        "found": True,
        "evidence": {
            "tenant_id": _extract_tenant_id(invoice),
            "branch_id": _extract_branch_id(invoice),
            "status": invoice.get("status"),
            "contract_id": invoice.get("contract_id"),
            "customer_id": invoice.get("customer_id"),
            "billing_account_id": invoice.get("billing_account_id"),
            "currency": invoice.get("currency"),
            "subtotal": invoice.get("subtotal"),
            "tax": invoice.get("tax"),
            "total": invoice.get("total"),
            "line_items": invoice.get("line_items", []),
            "issued_at": invoice.get("issued_at"),
            "due_at": invoice.get("due_at"),
        },
    }


def get_rate_card(
    store: RentalDataStore,
    scope: AppScope,
    *,
    branch_id: str,
    asset_category_id: str,
    rate_type: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    branch_id = _validate_uuid("branch_id", branch_id)
    asset_category_id = _validate_uuid("asset_category_id", asset_category_id)
    if rate_type is not None:
        _validate_allowlist("rate_type", rate_type, RATE_TYPE_ALLOWLIST)
    limit = _validate_limit(limit, default=50)

    rows = _scoped_rows(store.read_model.rate_cards(), scope)
    rows = [
        row
        for row in rows
        if row.get("branch_id") == branch_id and row.get("asset_category_id") == asset_category_id
    ]
    if rate_type is not None:
        rows = [row for row in rows if row.get("rate_type") == rate_type]

    evidence = [
        {
            "rate_card_id": row.get("rate_card_id"),
            "branch_id": row.get("branch_id"),
            "asset_category_id": row.get("asset_category_id"),
            "rate_type": row.get("rate_type"),
            "rate_amount": row.get("rate_amount"),
            "currency": row.get("currency"),
            "effective_from": row.get("effective_from"),
            "effective_to": row.get("effective_to"),
        }
        for row in rows[:limit]
    ]
    return {
        "branch_id": branch_id,
        "asset_category_id": asset_category_id,
        "rate_type": rate_type,
        "count": len(evidence),
        "evidence": evidence,
    }


def get_telematics(
    store: RentalDataStore,
    scope: AppScope,
    *,
    asset_id: str,
    limit: int = 25,
    external_urls: list[str] | None = None,
) -> dict[str, Any]:
    asset_id = _validate_uuid("asset_id", asset_id)
    limit = _validate_limit(limit, default=25, max_value=100)

    rows = _scoped_rows(store.read_model.synthetic_telematics(), scope)
    rows = [row for row in rows if row.get("asset_id") == asset_id]
    rows = rows[:limit]

    evidence = [
        {
            "asset_id": row.get("asset_id"),
            "captured_at": row.get("captured_at"),
            "meter_hours": row.get("meter_hours"),
            "engine_on": bool(row.get("engine_on", False)),
            "lat": row.get("lat"),
            "lon": row.get("lon"),
            "source": "synthetic_v1",
        }
        for row in rows
    ]

    vetted_urls = [url for url in (external_urls or []) if is_safe_external_url(url)]
    rejected_urls = [url for url in (external_urls or []) if url not in vetted_urls]

    return {
        "asset_id": asset_id,
        "count": len(evidence),
        "evidence": evidence,
        "external_lookups": {"allowed": vetted_urls, "rejected": rejected_urls},
    }
