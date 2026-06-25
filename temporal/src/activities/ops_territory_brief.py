"""Territory account brief and follow-up assistant activities.

Scope, assess, and persist brief items for the TerritoryAccountBriefWorkflow.

Signal coverage (operating-model tags):
  - pre_visit        : assemble account context before a call or site visit (t2)
  - territory_plan   : weekly territory account plan review (t1)
  - followup_update  : post-visit follow-up context update (t4)

Freshness:
  Any account whose signals are older than _STALE_THRESHOLD_DAYS is flagged
  as stale and the stale signal is added to the payload so the AI can surface
  it explicitly in the brief.

Design constraints:
  - No automatic customer outreach, account-stage mutation, pricing commitment,
    or branch promise. Assist only.
  - Duplicate account signals are collapsed into one brief item.
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

from ..agents.territory_brief_assistant import run_territory_brief_assistant
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

_MAX_SCOPED_ACCOUNTS = 100
_STALE_THRESHOLD_DAYS = 7
_PROMISED_FOLLOWUP_FACT_TYPES = {
    "promised_followup",
    "visit_promise",
    "customer_commitment",
    "rep_promise",
}
_REP_ASSIGNMENT_FACT_TYPES = {
    "rep_assignment",
    "account_owner",
}
_OPEN_ORDER_STATUSES = {"proposed", "quoted", "pending", "reserved"}
_CONTACT_FACT_TYPES = {
    "customer_call_logged",
    "customer_email_sent",
    "customer_sms_sent",
    "customer_visit_logged",
    "customer_intake_submitted",
}
_VISIT_FACT_TYPES = {
    "customer_visit_logged",
    "site_visit_logged",
}

_DEFAULT_TERRITORY_BRIEF_AGENT_KEY = "territory-account-brief"

_TERRITORY_BRIEF_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_telematics",
    )
}
_TERRITORY_BRIEF_TOOL_HANDLERS = {
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
            "description": "Read-only territory brief evidence tool",
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
        expanded = _TERRITORY_BRIEF_TOOL_GROUPS.get(tool, (tool,))
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


def _classify_brief_type(
    days_since_visit: int | None,
    open_opp_count: int,
    promised_followup_count: int,
) -> str:
    """Classify the most relevant brief type for an account.

    Priority order:
    - followup_update: promised follow-ups are outstanding (t4)
    - pre_visit: upcoming visit or very recent contact (t2)
    - territory_plan: default weekly planning context (t1)
    """
    if promised_followup_count > 0:
        return "followup_update"
    if days_since_visit is not None and days_since_visit <= 7:
        return "pre_visit"
    if open_opp_count > 0:
        return "pre_visit"
    return "territory_plan"


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
        handler = _TERRITORY_BRIEF_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


def _brief_finding_for_storage(item: dict[str, Any]) -> dict[str, Any]:
    """Map TerritoryBriefItemV1 fields onto the generic finding schema."""
    account_id = str(item.get("account_id") or "")
    brief_type = str(item.get("brief_type") or "territory_plan")
    priority = str(item.get("priority") or "medium")
    _priority_to_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    return {
        **item,
        "contract_id": account_id,
        "line_item_id": "",
        "finding_type": brief_type,
        "severity": _priority_to_severity.get(priority, "medium"),
        "expected": {
            "recommended_action": item.get("recommended_action"),
            "follow_up_draft": item.get("follow_up_draft"),
            "open_opportunities": item.get("open_opportunities"),
            "recent_rentals": item.get("recent_rentals", []),
            "visit_history": item.get("visit_history", []),
            "promised_follow_ups": item.get("promised_follow_ups", []),
            "branch_risks": item.get("branch_risks", []),
            "cross_branch_signals": item.get("cross_branch_signals", []),
            "freshness_warnings": item.get("freshness_warnings", []),
            "is_stale_data": item.get("is_stale_data", False),
            "stale_signals": item.get("stale_signals", []),
            "operating_model_tags": item.get("operating_model_tags", []),
        },
    }


# ---------------------------------------------------------------------------
# Scope activity
# ---------------------------------------------------------------------------

@activity.defn
def ops_territory_brief_scope(
    tenant_id: str,
    rep_id: str | None,
    account_id: str | None,
) -> list[dict[str, Any]]:
    """Scope territory brief candidates from account/customer entities, rental
    history, visit facts, promised follow-ups, open opportunities, and
    cross-branch signals.

    When ``account_id`` is provided, scopes only that single account (pre-visit
    mode).  When ``rep_id`` is also set, ``account_id`` must fall within that
    rep's authorized account set; if it does not, an empty list is returned
    (no-op).

    When ``account_id`` is omitted, scopes all active accounts for the tenant
    (territory plan mode), capped at _MAX_SCOPED_ACCOUNTS.  When ``rep_id``
    is set, only accounts assigned to that rep are included; when ``rep_id``
    is None (admin / branch_manager tenant-wide pass), all tenant accounts are
    accessible.

    Account assignment is determined by:
    - ``entity_facts`` with ``fact_type`` in ``_REP_ASSIGNMENT_FACT_TYPES``
      whose ``value`` or ``notes`` equals ``rep_id``.
    - Customer entity ``data.assigned_rep_id`` == ``rep_id``.

    Returns a list of account payloads ready for ``ops_territory_brief_assess``.
    Each payload carries ``brief_type``, ``account_id``, ``account_name``,
    ``tenant_id``, open opportunity counts, promised follow-ups, recent rentals,
    visit history, and a ``rental_data`` block for AI tool calls.

    Duplicate signals for the same customer are collapsed — each customer
    appears at most once in the result.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    # Fetch entity sets
    #
    # Three fetch scenarios, each with a different DB-level limit:
    #
    # 1. Single-account path (account_id set):
    #    Push entity_id to the DB layer so only the requested row is fetched,
    #    regardless of its position in the update-time ordering.  The limit is
    #    a safety guard only.
    #
    # 2. Rep-scoped fan-out (rep_id set, account_id omitted):
    #    Do NOT cap at the DB layer.  The _MAX_SCOPED_ACCOUNTS limit is applied
    #    at the end of this function after authorization, so it counts over the
    #    rep's authorised accounts, not the whole tenant.  Without this, a rep
    #    whose assigned accounts fall outside the newest-N tenant rows would
    #    receive an empty or incomplete scope even though authorised accounts
    #    exist.
    #
    # 3. Admin / branch_manager tenant-wide fan-out (rep_id=None, account_id=None):
    #    Keep the DB-level cap to avoid full-table scans on large tenants.
    customer_filter: dict[str, str] = {"entity_type": "customer"}
    if account_id:
        # Scenario 1: single-account — constrain to the exact row at DB level.
        customer_filter["entity_id"] = account_id
        customer_limit: int | None = _MAX_SCOPED_ACCOUNTS
    elif rep_id:
        # Scenario 2: rep fan-out — no DB cap; cap applied post-authorization.
        customer_limit = None
    else:
        # Scenario 3: admin/branch_manager — tenant-wide DB cap.
        customer_limit = _MAX_SCOPED_ACCOUNTS

    customers = client.select(
        "rental_current_entity_state",
        columns="entity_id, name, entity_type, data, updated_at",
        filters=customer_filter,
        order_by="updated_at",
        descending=True,
        limit=customer_limit,
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

    # Map billing_account → customer via customer_has_billing_account
    billing_to_customer: dict[str, str] = {}
    for rel in relationships:
        if str(rel.get("relationship_type") or "") == "customer_has_billing_account":
            billing_to_customer[str(rel.get("child_id") or "")] = str(rel.get("parent_id") or "")

    def _contract_customer(data: dict[str, Any]) -> str:
        cid = str(data.get("customer_id") or "")
        if cid:
            return cid
        ba_id = str(data.get("billing_account_id") or "")
        return billing_to_customer.get(ba_id, "")

    # Latest contract date per customer
    latest_contract_by_customer: dict[str, str] = {}
    recent_contracts_by_customer: dict[str, list[str]] = {}
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
        # Collect recent contract summaries (last 90 days)
        days = _days_since(ts)
        if days is not None and days <= 90:
            contract_id = str(row.get("entity_id") or "")
            # ts is an ISO 8601 timestamp; [:10] extracts the YYYY-MM-DD date portion.
            summary = f"Contract {contract_id}: {ts[:10]}"
            if "amount" in data:
                summary += f" — ${data['amount']}"
            recent_contracts_by_customer.setdefault(cid, []).append(summary)

    # Open opportunities per customer
    open_opp_by_customer: dict[str, int] = {}
    open_opp_ids_by_customer: dict[str, str] = {}
    for row in orders:
        data = ops_revrec._json_object(row.get("data"))  # noqa: SLF001
        order_status = str(data.get("status") or "").lower()
        if order_status not in _OPEN_ORDER_STATUSES:
            continue
        cid = str(data.get("customer_id") or "")
        if not cid:
            ba_id = str(data.get("billing_account_id") or "")
            cid = billing_to_customer.get(ba_id, "")
        if cid:
            open_opp_by_customer[cid] = open_opp_by_customer.get(cid, 0) + 1
            if cid not in open_opp_ids_by_customer:
                open_opp_ids_by_customer[cid] = str(row.get("entity_id") or "")

    # Group facts by entity and type
    latest_visit_by_entity: dict[str, str] = {}
    latest_contact_by_entity: dict[str, str] = {}
    promised_followups_by_entity: dict[str, list[str]] = {}
    visit_notes_by_entity: dict[str, list[str]] = {}

    for fact in facts:
        fact_type = str(fact.get("fact_type") or "")
        eid = str(fact.get("entity_id") or "")
        if not eid:
            continue
        ts = str(fact.get("measured_at") or fact.get("created_at") or "")

        if fact_type in _VISIT_FACT_TYPES:
            existing = latest_visit_by_entity.get(eid)
            if not existing or ts > existing:
                latest_visit_by_entity[eid] = ts
            note = str(fact.get("notes") or fact.get("value") or "")
            if note:
                # ts is ISO 8601; [:10] extracts the YYYY-MM-DD date portion.
                visit_notes_by_entity.setdefault(eid, []).append(f"{ts[:10]}: {note}")

        if fact_type in _CONTACT_FACT_TYPES:
            existing = latest_contact_by_entity.get(eid)
            if not existing or ts > existing:
                latest_contact_by_entity[eid] = ts

        if fact_type in _PROMISED_FOLLOWUP_FACT_TYPES:
            note = str(fact.get("notes") or fact.get("value") or "")
            # ts is ISO 8601; [:10] extracts the YYYY-MM-DD date portion.
            label = f"Promise [{ts[:10]}]: {note}" if note else f"Promise [{ts[:10]}]"
            promised_followups_by_entity.setdefault(eid, []).append(label)

    # Time-series grouped by entity_id
    ts_by_entity: dict[str, list[dict[str, Any]]] = {}
    for point in time_series:
        eid = str(point.get("entity_id") or "")
        if eid:
            ts_by_entity.setdefault(eid, []).append(dict(point))

    # ---------------------------------------------------------------------------
    # Rep-scope authorization
    # When rep_id is set, build the set of account entity IDs authorized for that
    # rep.  Authorization is determined by:
    #   1. entity_facts with fact_type in _REP_ASSIGNMENT_FACT_TYPES whose value
    #      or notes equals rep_id (the entity_id of that fact is the account).
    #   2. Customer entity data field assigned_rep_id == rep_id.
    # When rep_id is None (admin / branch_manager tenant-wide pass), all tenant
    # accounts are accessible and no filtering is applied.
    # ---------------------------------------------------------------------------
    rep_authorized_ids: set[str] | None = None
    if rep_id:
        rep_authorized_ids = set()
        for fact in facts:
            if str(fact.get("fact_type") or "") not in _REP_ASSIGNMENT_FACT_TYPES:
                continue
            val_from_fact = fact.get("value")
            val = str(val_from_fact if val_from_fact is not None else (fact.get("notes") or ""))
            if val == rep_id:
                eid = str(fact.get("entity_id") or "")
                if eid:
                    rep_authorized_ids.add(eid)
        for row in customers:
            cid = str(row.get("entity_id") or "")
            if not cid:
                continue
            d = ops_revrec._json_object(row.get("data"))  # noqa: SLF001
            if str(d.get("assigned_rep_id") or "") == rep_id:
                rep_authorized_ids.add(cid)

    # Enforce single-account authorization when rep_id is set.
    if account_id and rep_authorized_ids is not None and account_id not in rep_authorized_ids:
        logger.info(
            "ops_territory_brief_scope account_not_authorized",
            extra={"tenant_id": tenant_id, "rep_id": rep_id, "account_id": account_id},
        )
        return []

    # De-duplicate: one brief item per customer
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
        # Skip accounts not in the rep's authorized set when rep_id is set.
        if rep_authorized_ids is not None and customer_id not in rep_authorized_ids:
            continue
        seen_customers.add(customer_id)

        billing_ids = children_by_parent.get(customer_id, [])
        candidate_ids = [customer_id] + billing_ids

        # Recent rentals (last 90 days)
        recent_rentals = recent_contracts_by_customer.get(customer_id, [])

        # Open opportunities
        open_opps = open_opp_by_customer.get(customer_id, 0)
        source_opp_id = open_opp_ids_by_customer.get(customer_id)

        # Visit history
        visit_notes: list[str] = []
        for eid in candidate_ids:
            visit_notes.extend(visit_notes_by_entity.get(eid, []))
        visit_notes = visit_notes[-5:] if visit_notes else []

        # Most recent visit
        latest_visit_ts = max(
            (latest_visit_by_entity[eid] for eid in candidate_ids if eid in latest_visit_by_entity),
            default=None,
        )
        days_since_visit = _days_since(latest_visit_ts)

        # Promised follow-ups
        promised_followups: list[str] = []
        for eid in candidate_ids:
            promised_followups.extend(promised_followups_by_entity.get(eid, []))

        # Staleness
        last_updated = str(row.get("updated_at") or "")
        stale = _is_stale(last_updated)
        stale_signals: list[str] = []
        if stale:
            stale_signals.append(f"Customer entity last updated {last_updated or 'unknown'}")
        if not recent_rentals and not open_opps:
            stale_signals.append("No recent rental activity or open opportunities found")

        # Classify brief type
        brief_type = _classify_brief_type(days_since_visit, open_opps, len(promised_followups))

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
            "rep_id": rep_id,
            "account_id": customer_id,
            "account_name": str(data.get("name") or row.get("name") or ""),
            "brief_type": brief_type,
            "open_opportunities": open_opps,
            "source_opportunity_id": source_opp_id,
            "source_account_id": customer_id,
            "recent_rentals": recent_rentals,
            "visit_history": visit_notes,
            "promised_follow_ups": promised_followups,
            "days_since_visit": days_since_visit,
            "last_rental_date": latest_contract_by_customer.get(customer_id),
            "last_updated_at": last_updated,
            "is_stale_hint": stale,
            "stale_signals_hint": stale_signals,
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
        "ops_territory_brief_scope",
        extra={
            "tenant_id": tenant_id,
            "rep_id": rep_id,
            "account_id": account_id,
            "total_scoped": len(scoped),
        },
    )
    return scoped[:_MAX_SCOPED_ACCOUNTS]


# ---------------------------------------------------------------------------
# AI assessment activity
# ---------------------------------------------------------------------------

@activity.defn
async def ops_territory_brief_assess(
    account_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Run AI assessment for a single scoped territory account brief item.

    Returns a ``TerritoryBriefItemV1`` dict enriched with evidence, freshness
    warnings, stale-data callouts, operating-model tags, and a follow-up draft.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or (
            "You are the territory account brief assistant for an outside sales representative "
            "at an equipment-rental company. Your role is to assemble a disposition-ready "
            "pre-visit or territory-plan brief for a single customer account. Always: cite "
            "recent rentals, open opportunities, visit history, branch risks, and promised "
            "follow-ups from the provided data; flag stale signals with their freshness date; "
            "surface cross-branch signals when present; never commit pricing, send outreach, "
            "or mutate CRM stages or account records automatically."
        )
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or (
            "Prepare a territory account brief for customer {account_id} ({account_name}) "
            "in tenant {tenant_id}. Brief type: {brief_type}. "
            "Open opportunities: {open_opportunities}. "
            "Promised follow-ups outstanding: {promised_follow_up_count}. "
            "Days since last visit: {days_since_visit}. "
            "Recent rentals (last 90 days): {recent_rental_count}. "
            "Provide a disposition-ready brief with evidence and freshness indicators. "
            "Evidence:\n{evidence_json}"
        )
    )
    prompt_variables = {
        "tenant_id": str(account_payload.get("tenant_id") or ""),
        "account_id": str(account_payload.get("account_id") or ""),
        "account_name": str(account_payload.get("account_name") or ""),
        "brief_type": str(account_payload.get("brief_type") or "territory_plan"),
        "open_opportunities": str(account_payload.get("open_opportunities") or "0"),
        "promised_follow_up_count": str(len(account_payload.get("promised_follow_ups") or [])),
        "days_since_visit": str(account_payload.get("days_since_visit") or "unknown"),
        "recent_rental_count": str(len(account_payload.get("recent_rentals") or [])),
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
        result = await run_territory_brief_assistant(
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
        result.setdefault("brief_type", str(account_payload.get("brief_type") or "territory_plan"))
        result.setdefault("open_opportunities", account_payload.get("open_opportunities") or 0)
        result.setdefault("recent_rentals", account_payload.get("recent_rentals") or [])
        result.setdefault("visit_history", account_payload.get("visit_history") or [])
        result.setdefault("promised_follow_ups", account_payload.get("promised_follow_ups") or [])
        result.setdefault("source_account_id", account_payload.get("source_account_id"))
        result.setdefault("source_opportunity_id", account_payload.get("source_opportunity_id"))
        result["tenant_id"] = str(account_payload.get("tenant_id") or "")
        return result
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


# ---------------------------------------------------------------------------
# Named-activity wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------

@activity.defn(name="ops_territory_brief_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_territory_brief_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_territory_brief_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_territory_brief_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_territory_brief_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_brief_finding_for_storage(finding), run_id)


@activity.defn(name="ops_territory_brief_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _brief_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_territory_brief_scope",
    "ops_territory_brief_assess",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "_is_stale",
    "_days_since",
    "_classify_brief_type",
    "_brief_finding_for_storage",
    "_REP_ASSIGNMENT_FACT_TYPES",
]
