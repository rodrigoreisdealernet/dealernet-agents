"""Account health and dormant-account growth queue activities.

Scope, assess, and persist ranked account threads for the
AccountHealthQueueWorkflow.

Signal coverage:
  - dormant          : customers with no rental activity in 60–180 days (t6)
  - lost             : customers with no rental activity for 180+ days (t6)
  - at_risk          : declining utilization trend or long contact gap (t7)
  - growth_opportunity: open opportunities or improving utilization trend (t7)

Freshness:
  Any account whose signals are older than _STALE_THRESHOLD_DAYS is flagged
  as stale and the stale signal is added to the payload so the AI can surface
  it explicitly in the recommendation.

Design constraints:
  - No account-stage mutations.  Assist only.
  - Duplicate signals for the same account are collapsed into one thread.
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

from ..agents.account_health_assistant import run_account_health_assistant
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

_MAX_SCOPED_ACCOUNTS = 200
_STALE_THRESHOLD_DAYS = 7
_DORMANT_DAYS = 60
_LOST_DAYS = 180
_CONTACT_GAP_AT_RISK_DAYS = 45

_DEFAULT_ACCOUNT_HEALTH_AGENT_KEY = "account-health-queue"

_ACCOUNT_HEALTH_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_telematics",
    )
}
_ACCOUNT_HEALTH_TOOL_HANDLERS = {
    "query_entity": query_entity,
    "query_time_series": query_time_series,
    "query_relationships": query_relationships,
    "query_facts": query_facts,
    "get_telematics": get_telematics,
}

_CONTACT_FACT_TYPES = {
    "customer_call_logged",
    "customer_email_sent",
    "customer_sms_sent",
    "customer_intake_submitted",
}

_OPEN_ORDER_STATUSES = {"proposed", "quoted", "pending", "reserved"}


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
            "description": "Read-only account health evidence tool",
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
        expanded = _ACCOUNT_HEALTH_TOOL_GROUPS.get(tool, (tool,))
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
    """Return True when the timestamp is older than threshold_days or absent."""
    if not ts_str:
        return True
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt < datetime.now(UTC) - timedelta(days=threshold_days)
    except ValueError:
        return True


def _days_since(ts_str: str | None) -> int | None:
    """Return number of whole days since ts_str, or None if absent/invalid."""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        delta = datetime.now(UTC) - dt
        return max(0, delta.days)
    except ValueError:
        return None


def _classify_health_signal(
    days_since_rental: int | None,
    contact_gap_days: int | None,
    utilization_trend: str,
    open_opp_count: int,
) -> str:
    """Classify a single health signal from account evidence.

    Priority order: lost > dormant > growth_opportunity > at_risk
    A growth_opportunity is surfaced when there are open opportunities or an
    improving trend, even if the account hasn't been dormant.
    """
    if days_since_rental is not None and days_since_rental >= _LOST_DAYS:
        return "lost"
    if days_since_rental is not None and days_since_rental >= _DORMANT_DAYS:
        return "dormant"
    if open_opp_count > 0 or utilization_trend == "improving":
        return "growth_opportunity"
    if utilization_trend == "declining" or (
        contact_gap_days is not None and contact_gap_days >= _CONTACT_GAP_AT_RISK_DAYS
    ):
        return "at_risk"
    # Fall back: if we have no rental date at all, treat as dormant so
    # the rep can explicitly review and classify the account.
    if days_since_rental is None:
        return "dormant"
    return "at_risk"


def _account_store_from_payload(account_payload: Mapping[str, Any]) -> RentalDataStore:
    payload = (
        account_payload.get("rental_data")
        if isinstance(account_payload.get("rental_data"), Mapping)
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


def _account_tool_executor(
    account_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
):
    enabled_tools = {name for name in (_extract_tool_name(t) for t in configured_tools) if name}
    store = _account_store_from_payload(account_payload)
    scope = AppScope(tenant_id=str(account_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _ACCOUNT_HEALTH_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


def _thread_finding_for_storage(thread: dict[str, Any]) -> dict[str, Any]:
    """Map AccountHealthThreadV1 fields onto the generic finding schema."""
    account_id = str(thread.get("account_id") or "")
    health_signal = str(thread.get("health_signal") or "dormant")
    priority = str(thread.get("priority") or "medium")
    _priority_to_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    return {
        **thread,
        "contract_id": account_id,
        "line_item_id": "",
        "finding_type": health_signal,
        "severity": _priority_to_severity.get(priority, "medium"),
        "expected": {
            "recommended_angle": thread.get("recommended_angle"),
            "outreach_draft": thread.get("outreach_draft"),
            "contact_gap_days": thread.get("contact_gap_days"),
            "last_rental_date": thread.get("last_rental_date"),
            "utilization_trend": thread.get("utilization_trend"),
            "open_opportunities": thread.get("open_opportunities"),
            "is_stale_data": thread.get("is_stale_data", False),
            "stale_signals": thread.get("stale_signals", []),
            "operating_model_tags": thread.get("operating_model_tags", []),
        },
    }


# ---------------------------------------------------------------------------
# Scope activity
# ---------------------------------------------------------------------------

@activity.defn
def ops_account_health_scope(
    tenant_id: str,
    rep_id: str | None,
    run_date: str | None,
) -> list[dict[str, Any]]:
    """Scope account health candidates from customer entities, rental history,
    contact facts, and utilization time series.

    Returns a list of account payloads ready for ``ops_account_health_assess``.
    Each payload carries ``health_signal``, ``account_id``, ``customer_id``,
    ``tenant_id``, ``last_rental_date``, ``contact_gap_days``, and a
    ``rental_data`` block for AI tool calls.

    Duplicate signals for the same customer are collapsed — each customer
    appears at most once in the result.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    # Fetch base entity sets
    customers = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters={"entity_type": "customer"},
        order_by="updated_at",
        descending=True,
        limit=_MAX_SCOPED_ACCOUNTS,
    )
    contracts = client.select(
        "rental_current_entity_state",
        columns="entity_id, entity_type, data, updated_at",
        filters={"entity_type": "rental_contract"},
        order_by="updated_at",
        descending=True,
        limit=2000,
    )
    orders = client.select(
        "rental_current_entity_state",
        columns="entity_id, entity_type, data, updated_at",
        filters={"entity_type": "rental_order"},
        order_by="updated_at",
        descending=True,
        limit=2000,
    )
    relationships = client.select("rental_current_relationships")
    facts = client.select(
        "entity_facts",
        filters={"tenant_id": tenant_id},
        limit=5000,
    )
    time_series = client.select(
        "time_series_points",
        filters={"tenant_id": tenant_id},
        limit=5000,
    )

    # Build relationship index: parent → [child_ids]
    children_by_parent: dict[str, list[str]] = {}
    for rel in relationships:
        parent_id = str(rel.get("parent_id") or "")
        child_id = str(rel.get("child_id") or "")
        if parent_id and child_id:
            children_by_parent.setdefault(parent_id, []).append(child_id)

    # Contracts grouped by customer (via billing_account or direct link)
    # Map billing_account → customer via customer_has_billing_account
    billing_to_customer: dict[str, str] = {}
    for rel in relationships:
        if str(rel.get("relationship_type") or "") == "customer_has_billing_account":
            billing_to_customer[str(rel.get("child_id") or "")] = str(rel.get("parent_id") or "")

    # Resolve customer_id from contract data
    def _contract_customer(data: dict[str, Any]) -> str:
        cid = str(data.get("customer_id") or "")
        if cid:
            return cid
        ba_id = str(data.get("billing_account_id") or "")
        return billing_to_customer.get(ba_id, "")

    # Latest contract date per customer
    latest_contract_by_customer: dict[str, str] = {}
    for row in contracts:
        data = ops_revrec._json_object(row.get("data"))  # noqa: SLF001
        cid = _contract_customer(data)
        if not cid:
            continue
        ts = str(row.get("updated_at") or data.get("created_at") or "")
        if not ts:
            continue
        existing = latest_contract_by_customer.get(cid)
        if not existing or ts > existing:
            latest_contract_by_customer[cid] = ts

    # Open opportunities (open orders) per customer
    open_opp_by_customer: dict[str, int] = {}
    for row in orders:
        data = ops_revrec._json_object(row.get("data"))  # noqa: SLF001
        status = str(data.get("status") or "").lower()
        if status not in _OPEN_ORDER_STATUSES:
            continue
        cid = str(data.get("customer_id") or "")
        if not cid:
            ba_id = str(data.get("billing_account_id") or "")
            cid = billing_to_customer.get(ba_id, "")
        if cid:
            open_opp_by_customer[cid] = open_opp_by_customer.get(cid, 0) + 1

    # Latest contact fact date per entity (customer or billing account)
    latest_contact_by_entity: dict[str, str] = {}
    for fact in facts:
        fact_type = str(fact.get("fact_type") or "")
        if fact_type not in _CONTACT_FACT_TYPES:
            continue
        eid = str(fact.get("entity_id") or "")
        if not eid:
            continue
        ts = str(fact.get("measured_at") or fact.get("created_at") or "")
        if not ts:
            continue
        existing = latest_contact_by_entity.get(eid)
        if not existing or ts > existing:
            latest_contact_by_entity[eid] = ts

    # Time-series grouped by entity_id
    ts_by_entity: dict[str, list[dict[str, Any]]] = {}
    for point in time_series:
        eid = str(point.get("entity_id") or "")
        if eid:
            ts_by_entity.setdefault(eid, []).append(dict(point))

    def _utilization_trend(entity_ids: list[str]) -> str:
        """Derive a simple trend from the most recent utilization time-series."""
        pts: list[dict[str, Any]] = []
        for eid in entity_ids:
            pts.extend(ts_by_entity.get(eid, []))
        util_pts = [
            p for p in pts if str(p.get("metric_key") or "") in ("utilization_pct", "utilization")
        ]
        if len(util_pts) < 2:
            return "unknown"
        util_pts.sort(key=lambda p: str(p.get("measured_at") or p.get("timestamp") or ""))
        recent_half = util_pts[len(util_pts) // 2:]
        early_half = util_pts[: len(util_pts) // 2]
        avg_recent = sum(_coerce_float(p.get("value")) for p in recent_half) / len(recent_half)
        avg_early = sum(_coerce_float(p.get("value")) for p in early_half) / len(early_half)
        diff = avg_recent - avg_early
        if diff > 5:
            return "improving"
        if diff < -5:
            return "declining"
        return "stable"

    # De-duplicate: one thread per customer
    seen_customers: set[str] = set()
    scoped: list[dict[str, Any]] = []

    for row in customers:
        data = ops_revrec._json_object(row.get("data"))  # noqa: SLF001
        customer_id = str(row.get("entity_id") or "")
        if not customer_id:
            continue
        if str(data.get("tenant_id") or "") != tenant_id:
            continue
        if customer_id in seen_customers:
            continue
        seen_customers.add(customer_id)

        # Rental history
        last_rental_ts = latest_contract_by_customer.get(customer_id)
        days_since_rental = _days_since(last_rental_ts)

        # Contact gap
        # Check direct customer facts and billing-account facts
        billing_ids = children_by_parent.get(customer_id, [])
        candidate_contact_ids = [customer_id] + billing_ids
        latest_contact_ts = max(
            (latest_contact_by_entity[eid] for eid in candidate_contact_ids if eid in latest_contact_by_entity),
            default=None,
        )
        contact_gap_days = _days_since(latest_contact_ts)

        # Utilization trend from customer + billing account time series
        trend = _utilization_trend([customer_id] + billing_ids)

        # Open opportunities
        open_opps = open_opp_by_customer.get(customer_id, 0)

        # Skip customers with no prior rental history at all — not yet in the
        # health queue (they would be in the prospecting queue instead).
        if days_since_rental is None and not billing_ids:
            continue

        health_signal = _classify_health_signal(
            days_since_rental, contact_gap_days, trend, open_opps
        )

        # Staleness of the customer entity itself
        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)

        # Gather relevant relationships for the rental_data payload
        relevant_entity_ids: set[str] = {customer_id}
        relevant_entity_ids.update(billing_ids)

        relevant_relationships = [
            dict(rel)
            for rel in relationships
            if str(rel.get("parent_id") or "") in relevant_entity_ids
            or str(rel.get("child_id") or "") in relevant_entity_ids
        ]
        relevant_ts = [
            point
            for eid in relevant_entity_ids
            for point in ts_by_entity.get(eid, [])
        ]
        relevant_facts = [
            dict(f)
            for f in facts
            if str(f.get("entity_id") or "") in relevant_entity_ids
        ]

        scoped.append({
            "tenant_id": tenant_id,
            "account_id": customer_id,
            "customer_id": customer_id,
            "account_name": str(data.get("name") or row.get("name") or ""),
            "health_signal": health_signal,
            "last_rental_date": last_rental_ts,
            "days_since_rental": days_since_rental,
            "contact_gap_days": contact_gap_days,
            "utilization_trend": trend,
            "open_opportunities": open_opps,
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "rental_data": {
                "entities": [
                    {
                        "entity_id": customer_id,
                        "entity_type": "customer",
                        "name": str(data.get("name") or ""),
                        "data": data,
                        "updated_at": last_updated,
                    }
                ],
                "relationships": relevant_relationships,
                "facts": relevant_facts,
                "time_series": relevant_ts,
                "telematics": [],
            },
        })

    logger.info(
        "ops_account_health_scope",
        extra={
            "tenant_id": tenant_id,
            "rep_id": rep_id,
            "run_date": run_date,
            "total_scoped": len(scoped),
        },
    )
    return scoped[:_MAX_SCOPED_ACCOUNTS]


# ---------------------------------------------------------------------------
# AI assessment activity
# ---------------------------------------------------------------------------

@activity.defn
async def ops_account_health_assess(
    account_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Run AI assessment for a single scoped account health thread.

    Returns an ``AccountHealthThreadV1`` dict enriched with evidence,
    stale-data callouts, operating-model tags, and an outreach draft.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or (
            "You are the account health and dormant-account growth assistant for an outside "
            "sales representative at an equipment-rental company. Your role is to evaluate "
            "a single customer account and produce a ranked, evidence-backed health thread "
            "with a win-back, retention, or growth angle for the rep to review. Always: cite "
            "rental history, utilization, and contact-gap evidence; flag stale signals; "
            "never mutate account stages, send outreach, or commit commercial terms automatically."
        )
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or (
            "Evaluate account health for customer {account_id} ({account_name}) "
            "in tenant {tenant_id}. Health signal: {health_signal}. "
            "Days since last rental: {days_since_rental}. "
            "Contact gap days: {contact_gap_days}. "
            "Utilization trend: {utilization_trend}. "
            "Open opportunities: {open_opportunities}. "
            "Provide a ranked health thread with a reviewable outreach draft. "
            "Evidence: {evidence_json}"
        )
    )
    prompt_variables = {
        "tenant_id": str(account_payload.get("tenant_id") or ""),
        "account_id": str(account_payload.get("account_id") or ""),
        "account_name": str(account_payload.get("account_name") or ""),
        "health_signal": str(account_payload.get("health_signal") or ""),
        "days_since_rental": str(account_payload.get("days_since_rental") or "unknown"),
        "contact_gap_days": str(account_payload.get("contact_gap_days") or "unknown"),
        "utilization_trend": str(account_payload.get("utilization_trend") or "unknown"),
        "open_opportunities": str(account_payload.get("open_opportunities") or "0"),
        "evidence_json": json.dumps(account_payload, sort_keys=True, default=str),
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
        tool_executor = _account_tool_executor(account_payload, tools)
        result = await run_account_health_assistant(
            account_payload,
            system_prompt=rendered_system,
            user_prompt_template=rendered_user,
            tools=tools,
            tool_executor=tool_executor,
            max_tool_rounds=max_tool_rounds,
        )
        # Carry through fields the AI may not reproduce.
        result.setdefault("account_id", str(account_payload.get("account_id") or ""))
        result.setdefault("account_name", str(account_payload.get("account_name") or ""))
        result.setdefault("health_signal", str(account_payload.get("health_signal") or "dormant"))
        result.setdefault("last_rental_date", account_payload.get("last_rental_date"))
        result.setdefault("contact_gap_days", account_payload.get("contact_gap_days") or 0)
        result.setdefault("utilization_trend", account_payload.get("utilization_trend") or "unknown")
        result.setdefault("open_opportunities", account_payload.get("open_opportunities") or 0)
        result["tenant_id"] = str(account_payload.get("tenant_id") or "")
        return result
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


# ---------------------------------------------------------------------------
# Named-activity wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------

@activity.defn(name="ops_account_health_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_account_health_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_account_health_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_account_health_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_account_health_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_thread_finding_for_storage(finding), run_id)


@activity.defn(name="ops_account_health_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _thread_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_account_health_scope",
    "ops_account_health_assess",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
]
