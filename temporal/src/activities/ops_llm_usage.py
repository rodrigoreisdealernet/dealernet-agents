"""LLM usage metering: pricing + crash-safe persistence sink (issue #70).

A usage *sink* (built by :func:`build_usage_sink`) is injected into the agent's
``chat_with_tools`` loop via ``on_llm_call``. After every real provider call it
prices the call against a dated rate-card + per-tenant markup and upserts one row
into ``ops_llm_usage_event`` (idempotent on ``idempotency_key``, FR-008).

This module does the DB I/O; ``openai_client.py`` stays pure (NFR-001). It only
imports ``ops_revrec`` (for the PostgREST service-role client), never
``openai_client`` — the ``LlmCallUsage`` value is consumed duck-typed (``Any``)
to avoid an import cycle.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Any

from temporalio import activity

from . import ops_revrec

logger = logging.getLogger(__name__)

_USAGE_TABLE = "ops_llm_usage_event"
_RATE_CARD_TABLE = "ops_llm_rate_card"
_TENANT_PLAN_TABLE = "ops_tenant_llm_plan"
_DEFAULT_PROVIDER = "azure_openai"


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _within_window(row: Mapping[str, Any], at: datetime) -> bool:
    effective_from = _parse_ts(row.get("effective_from"))
    if effective_from is not None and effective_from > at:
        return False
    effective_to = _parse_ts(row.get("effective_to"))
    return not (effective_to is not None and effective_to <= at)


def price_usage(
    call: Any,
    *,
    rate_card_row: Mapping[str, Any] | None,
    markup_pct: float,
) -> tuple[float | None, float | None]:
    """Compute ``(provider_cost_usd, billable_cost_usd)`` for one call (FR-005).

    ``(prompt - cached) * in + cached * cached + completion * out`` scaled by the
    rate-card unit, then ``billable = provider_cost * (1 + markup_pct)`` for
    chargeable calls (no markup on retry/repair calls, A-001). Returns ``(None,
    None)`` when the call was not metered (``metering_status != 'ok'``) or no
    rate-card matched — tokens are never inferred (FR-003).
    """
    if getattr(call, "metering_status", None) != "ok" or rate_card_row is None:
        return None, None

    unit = rate_card_row.get("unit_of_measure") or "per_1k"
    if unit == "per_1m":
        divisor = 1_000_000.0
    elif unit == "per_1k":
        divisor = 1_000.0
    else:
        divisor = 1.0

    price_input = _to_float(rate_card_row.get("price_input")) or 0.0
    price_output = _to_float(rate_card_row.get("price_output")) or 0.0
    price_cached = _to_float(rate_card_row.get("price_cached_input")) or 0.0

    prompt_tokens = int(getattr(call, "prompt_tokens", None) or 0)
    completion_tokens = int(getattr(call, "completion_tokens", None) or 0)
    cached_tokens = int(getattr(call, "cached_input_tokens", None) or 0)
    uncached_prompt = max(prompt_tokens - cached_tokens, 0)

    provider_cost = (
        uncached_prompt * price_input
        + cached_tokens * price_cached
        + completion_tokens * price_output
    ) / divisor

    # Retry/repair/failover calls count provider cost but are not marked up (A-001).
    chargeable = bool(getattr(call, "chargeable", True))
    billable_cost = provider_cost * (1.0 + markup_pct) if chargeable else provider_cost
    return provider_cost, billable_cost


def _resolve_rate_card(
    client: Any, provider: str, model: str | None, at: datetime
) -> dict[str, Any] | None:
    if not model:
        return None
    rows = client.select(
        _RATE_CARD_TABLE,
        filters={"provider": provider, "provider_model": model},
        order_by="effective_from",
        descending=True,
    )
    for row in rows:
        if _within_window(row, at):
            return row
    return rows[0] if rows else None


def _resolve_markup(client: Any, tenant_id: str | None, at: datetime) -> tuple[float, str | None]:
    """Resolve markup_pct: tenant override first, then the null-tenant default plan."""
    if tenant_id:
        overrides = client.select(
            _TENANT_PLAN_TABLE,
            filters={"tenant_id": tenant_id},
            order_by="effective_from",
            descending=True,
        )
        for row in overrides:
            if _within_window(row, at):
                return _to_float(row.get("markup_pct")) or 0.0, row.get("plan_key")

    defaults = client.select(
        _TENANT_PLAN_TABLE,
        order_by="effective_from",
        descending=True,
    )
    for row in defaults:
        if row.get("tenant_id") is None and _within_window(row, at):
            return _to_float(row.get("markup_pct")) or 0.0, row.get("plan_key")
    return 0.0, None


def _build_idempotency_key(
    *,
    run_id: str,
    workflow_id: str,
    activity_id: str,
    activity_attempt: int,
    item_key: str,
    call_index: int,
    response_id: str | None,
) -> str:
    return ":".join(
        [
            run_id,
            workflow_id,
            activity_id,
            str(activity_attempt),
            item_key,
            str(call_index),
            response_id or "",
        ]
    )


def _build_event_row(
    client: Any,
    call: Any,
    *,
    tenant_id: str,
    run_id: str,
    workflow_id: str,
    activity_id: str,
    activity_attempt: int,
    agent_key: str,
    item_key: str,
) -> dict[str, Any]:
    at = datetime.now(UTC)
    provider = getattr(call, "provider", None) or _DEFAULT_PROVIDER
    model = getattr(call, "model", None)
    rate_card = _resolve_rate_card(client, provider, model, at)
    markup_pct, _plan_key = _resolve_markup(client, tenant_id, at)
    provider_cost, billable_cost = price_usage(call, rate_card_row=rate_card, markup_pct=markup_pct)
    priced = provider_cost is not None

    return {
        "tenant_id": tenant_id,
        "run_id": run_id or None,
        "workflow_id": workflow_id,
        "activity_id": activity_id,
        "activity_attempt": activity_attempt,
        "agent_key": agent_key,
        "item_key": item_key,
        "provider": provider,
        "provider_model": model,
        "deployment": None,
        "api_version": None,
        "meter_name": None,
        "unit_of_measure": rate_card.get("unit_of_measure") if rate_card else None,
        "round_index": getattr(call, "round_index", None),
        "schema_attempt": getattr(call, "schema_attempt", None),
        "prompt_tokens": getattr(call, "prompt_tokens", None),
        "completion_tokens": getattr(call, "completion_tokens", None),
        "total_tokens": getattr(call, "total_tokens", None),
        "cached_input_tokens": getattr(call, "cached_input_tokens", None),
        "reasoning_tokens": getattr(call, "reasoning_tokens", None),
        "raw_usage": getattr(call, "raw_usage", None),
        "metering_status": getattr(call, "metering_status", "ok"),
        "provider_cost_usd": provider_cost,
        "billable_cost_usd": billable_cost,
        "rate_card_id": rate_card.get("id") if (rate_card and priced) else None,
        "markup_pct": markup_pct if priced else None,
        "chargeable": bool(getattr(call, "chargeable", True)),
        "chargeability_reason": getattr(call, "chargeability_reason", None),
        "priced_at": at.isoformat() if priced else None,
        "idempotency_key": _build_idempotency_key(
            run_id=run_id,
            workflow_id=workflow_id,
            activity_id=activity_id,
            activity_attempt=activity_attempt,
            item_key=item_key,
            call_index=int(getattr(call, "round_index", 0) or 0),
            response_id=getattr(call, "response_id", None),
        ),
    }


@activity.defn
async def persist_llm_usage_event(event: dict[str, Any]) -> dict[str, Any]:
    """Upsert one usage event, idempotent on ``idempotency_key`` (FR-008/AC-006).

    Re-persisting the same event (e.g. an activity retry replaying the same call)
    merges onto the existing row instead of duplicating it.
    """
    client = ops_revrec._get_ops_persistence_client()
    return await asyncio.to_thread(
        client.upsert, _USAGE_TABLE, event, on_conflict="idempotency_key"
    )


def build_usage_sink(
    *,
    tenant_id: str,
    run_id: str,
    workflow_id: str,
    activity_id: str,
    activity_attempt: int,
    agent_key: str,
    item_key: str,
) -> Callable[[Any], Awaitable[None]]:
    """Build an ``on_llm_call`` sink that prices and persists each provider call.

    Persistence is per-call (crash-safe): a run that later overruns its tool/schema
    budget still leaves the usage rows of the calls already made (FR-004/AC-003).
    """

    async def on_llm_call(call: Any) -> None:
        # Metering is best-effort: a persistence failure must never change the
        # agent's business decision (issue #70 non-goal), so log and swallow.
        try:
            client = ops_revrec._get_ops_persistence_client()
            row = await asyncio.to_thread(
                _build_event_row,
                client,
                call,
                tenant_id=tenant_id,
                run_id=run_id,
                workflow_id=workflow_id,
                activity_id=activity_id,
                activity_attempt=activity_attempt,
                agent_key=agent_key,
                item_key=item_key,
            )
            await persist_llm_usage_event(row)
        except Exception:  # noqa: BLE001 - metering must not break the agent
            logger.warning("Failed to persist LLM usage event", exc_info=True)

    return on_llm_call


__all__ = [
    "build_usage_sink",
    "persist_llm_usage_event",
    "price_usage",
]
