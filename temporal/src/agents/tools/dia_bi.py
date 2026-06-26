"""Read-only BI tools for the live Portal assistant (DIA, automotive DMS).

Mirrors the shape of ``rental_data.py`` (pure read functions, OpenAI-format tool
definitions, a handler map) but targets the **automotive** analytics views the
Portal frontend already reads via ``agentsApi`` (``v_dia_*`` + ``ops_findings_view``).

Scope note: the ``v_dia_*`` views are dealership-wide aggregate snapshots and do
not expose a per-row ``tenant_id`` to filter on. We read them with the service
role (same as ``rental_data``'s PostgrestReadClient). ``tenant_id`` is plumbed
through for future multi-tenant scoping and for prompt context, but does not
filter these aggregate views today.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from ...config import settings
from .rental_data import PostgrestReadClient, RentalReadClient, ToolValidationError

# view -> (default order column or None, descending)
_VIEW_ORDER: dict[str, tuple[str | None, bool]] = {
    "v_dia_sales_trend": ("sale_date", True),
    "ops_findings_view": ("created_at", True),
}

_MAX_LIMIT = 200


def build_service_role_dia_client(client: RentalReadClient | None = None) -> RentalReadClient:
    """PostgREST read client over Supabase using the service role key."""
    return client or PostgrestReadClient(
        base_url=settings.supabase_url,
        service_role_key=settings.supabase_service_role_key,
        timeout_seconds=int(os.getenv("SUPABASE_HTTP_TIMEOUT_SECONDS", "10")),
    )


def _bounded_limit(limit: int | None, *, default: int) -> int:
    bounded = default if limit is None else int(limit)
    if bounded < 1 or bounded > _MAX_LIMIT:
        raise ToolValidationError(f"limit must be between 1 and {_MAX_LIMIT}")
    return bounded


def _read(
    client: RentalReadClient,
    view: str,
    *,
    filters: Mapping[str, Any] | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    order_by, descending = _VIEW_ORDER.get(view, (None, False))
    return client.select(
        view,
        columns="*",
        filters=filters,
        order_by=order_by,
        descending=descending,
        limit=limit,
    )


def get_owner_kpis(client: RentalReadClient) -> dict[str, Any]:
    """Single-row owner snapshot: vendas, oficina, estoque e peças do mês corrente."""
    rows = _read(client, "v_dia_owner_kpis", limit=1)
    return {"view": "v_dia_owner_kpis", "count": len(rows), "evidence": rows[:1]}


def get_sales_summary(
    client: RentalReadClient,
    *,
    condition: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Vendas de veículos agrupadas por mês/condição/marca/loja. ``condition`` opcional (novo/usado)."""
    limit = _bounded_limit(limit, default=50)
    filters = {"condition": condition} if condition else None
    rows = _read(client, "v_dia_sales_summary", filters=filters, limit=limit)
    return {"view": "v_dia_sales_summary", "count": len(rows), "evidence": rows}


def get_sales_trend(client: RentalReadClient, *, limit: int = 30) -> dict[str, Any]:
    """Tendência diária de vendas (unidades e receita), mais recentes primeiro."""
    limit = _bounded_limit(limit, default=30)
    rows = _read(client, "v_dia_sales_trend", limit=limit)
    return {"view": "v_dia_sales_trend", "count": len(rows), "evidence": rows}


def get_inventory_summary(client: RentalReadClient, *, limit: int = 50) -> dict[str, Any]:
    """Estoque de veículos por faixa de idade/marca/loja (valor e floor plan)."""
    limit = _bounded_limit(limit, default=50)
    rows = _read(client, "v_dia_inventory_summary", limit=limit)
    return {"view": "v_dia_inventory_summary", "count": len(rows), "evidence": rows}


def get_parts_summary(client: RentalReadClient, *, limit: int = 50) -> dict[str, Any]:
    """Peças: valor em estoque por status + vendas por mês (UNION)."""
    limit = _bounded_limit(limit, default=50)
    rows = _read(client, "v_dia_parts_summary", limit=limit)
    return {"view": "v_dia_parts_summary", "count": len(rows), "evidence": rows}


def get_service_summary(client: RentalReadClient, *, limit: int = 50) -> dict[str, Any]:
    """Oficina: ordens de serviço por mês/status."""
    limit = _bounded_limit(limit, default=50)
    rows = _read(client, "v_dia_service_summary", limit=limit)
    return {"view": "v_dia_service_summary", "count": len(rows), "evidence": rows}


def get_owner_brief_by_brand(client: RentalReadClient, *, limit: int = 50) -> dict[str, Any]:
    """Resumo do dia anterior por marca (novos/usados/peças/AT/floor plan)."""
    limit = _bounded_limit(limit, default=50)
    rows = _read(client, "v_dia_owner_brief_by_brand", limit=limit)
    return {"view": "v_dia_owner_brief_by_brand", "count": len(rows), "evidence": rows}


def get_pending_findings(client: RentalReadClient, *, limit: int = 20) -> dict[str, Any]:
    """Findings pendentes de aprovação (IA proativa) — situações que pedem decisão."""
    limit = _bounded_limit(limit, default=20)
    rows = _read(client, "ops_findings_view", filters={"status": "pending_approval"}, limit=limit)
    return {"view": "ops_findings_view", "count": len(rows), "evidence": rows}


# ── OpenAI-format tool definitions ─────────────────────────────────────────────
def _fn(name: str, description: str, properties: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties or {},
                "additionalProperties": False,
            },
        },
    }


_LIMIT_PROP = {"limit": {"type": "integer", "description": "Máximo de linhas (1-200).", "minimum": 1, "maximum": _MAX_LIMIT}}

DIA_BI_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    _fn("get_owner_kpis", "KPIs do dono no mês corrente (vendas, oficina, estoque, peças)."),
    _fn(
        "get_sales_summary",
        "Vendas de veículos por mês/condição/marca/loja. Param opcional 'condition' (novo|usado).",
        {
            "condition": {"type": "string", "enum": ["novo", "usado"], "description": "Filtra por condição."},
            **_LIMIT_PROP,
        },
    ),
    _fn("get_sales_trend", "Tendência diária de vendas (unidades e receita).", _LIMIT_PROP),
    _fn("get_inventory_summary", "Estoque de veículos por faixa de idade/marca/loja.", _LIMIT_PROP),
    _fn("get_parts_summary", "Peças: estoque por status e vendas por mês.", _LIMIT_PROP),
    _fn("get_service_summary", "Oficina: ordens de serviço por mês/status.", _LIMIT_PROP),
    _fn("get_owner_brief_by_brand", "Resumo do dia anterior por marca.", _LIMIT_PROP),
    _fn("get_pending_findings", "Findings pendentes de aprovação (situações que pedem decisão).", _LIMIT_PROP),
]

DIA_BI_TOOL_HANDLERS = {
    "get_owner_kpis": get_owner_kpis,
    "get_sales_summary": get_sales_summary,
    "get_sales_trend": get_sales_trend,
    "get_inventory_summary": get_inventory_summary,
    "get_parts_summary": get_parts_summary,
    "get_service_summary": get_service_summary,
    "get_owner_brief_by_brand": get_owner_brief_by_brand,
    "get_pending_findings": get_pending_findings,
}


__all__ = [
    "DIA_BI_TOOL_DEFINITIONS",
    "DIA_BI_TOOL_HANDLERS",
    "build_service_role_dia_client",
    "get_owner_kpis",
    "get_sales_summary",
    "get_sales_trend",
    "get_inventory_summary",
    "get_parts_summary",
    "get_service_summary",
    "get_owner_brief_by_brand",
    "get_pending_findings",
]
