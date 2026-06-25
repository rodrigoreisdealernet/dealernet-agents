from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime
from hashlib import sha1
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.credit_analyst import run_credit_analyst, run_credit_application_reviewer
from ..agents.lien_deadline_assistant import (
    calculate_prelim_notice_deadline,
    run_lien_deadline_assistant,
    run_lien_waiver_assistant,
)
from ..agents.tools.rental_data import (
    AppScope,
    InMemoryRentalReadModel,
    RentalDataStore,
    ToolValidationError,
    get_invoice_detail,
    get_rate_card,
    query_entity,
    query_facts,
    query_relationships,
    query_time_series,
)
from . import ops_revrec

# Upper bound guards against runaway LLM cost and activity duration when the
# tenant has a large number of billing accounts.  Lower bound ensures at least
# one account is always evaluated so config errors surface quickly.
_MAX_SCOPED_ACCOUNTS = 500
_MIN_SCOPED_ACCOUNTS = 1
_DEFAULT_CREDIT_REQUESTER = "ops-credit-analyst"
_COLLECTIONS_OPERATING_MODEL_TAGS = [
    "credit-billing-analyst:t1",
    "credit-billing-analyst:t8",
]
_CREDIT_APPLICATION_OPERATING_MODEL_TAGS = [
    "credit-billing-analyst:t2",
]
_LIEN_DEADLINE_OPERATING_MODEL_TAGS = [
    "credit-billing-analyst:t4",
]
_LIEN_WAIVER_OPERATING_MODEL_TAGS = [
    "credit-billing-analyst:t5",
]
_MAX_SCOPED_OBLIGATIONS = 200
_CREDIT_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_invoice_detail",
        "get_rate_card",
    )
}
_CREDIT_TOOL_HANDLERS = {
    "query_entity": query_entity,
    "query_time_series": query_time_series,
    "query_relationships": query_relationships,
    "query_facts": query_facts,
    "get_invoice_detail": get_invoice_detail,
    "get_rate_card": get_rate_card,
}


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
            "description": "Read-only credit evidence tool",
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
        expanded = _CREDIT_TOOL_GROUPS.get(tool, (tool,))
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


def _credit_store_from_account_payload(account_payload: Mapping[str, Any]) -> RentalDataStore:
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
        invoice_rows=_dict_list(payload.get("invoices")),
        rate_card_rows=_dict_list(payload.get("rate_cards")),
        telematics_rows=[],
    )
    return RentalDataStore(read_model=model)


def _credit_tool_executor(
    account_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
):
    enabled_tools = {name for name in (_extract_tool_name(t) for t in configured_tools) if name}
    store = _credit_store_from_account_payload(account_payload)
    scope = AppScope(tenant_id=str(account_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _CREDIT_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _coerce_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _invoice_date(invoice: Mapping[str, Any]) -> datetime | None:
    return _parse_datetime(
        invoice.get("due_date")
        or invoice.get("invoice_date")
        or invoice.get("created_at")
    )


def _normalize_evidence_items(items: Sequence[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, Mapping):
            normalized.append(dict(item))
            continue
        text = str(item or "").strip()
        if text:
            normalized.append({"summary": text})
    return normalized


def _collections_proposed_action(
    *,
    overdue_amount: float,
    oldest_overdue_days: int,
    stale_inputs: Sequence[str],
    notice_threshold_days: int,
    lien_threshold_days: int,
) -> tuple[str, str]:
    if overdue_amount <= 0:
        return "no_op", "no_op"
    if stale_inputs:
        return "manual_portfolio_review", "manual_review"
    if oldest_overdue_days >= lien_threshold_days:
        return "review_lien_preparation", "formal_escalation_review"
    if oldest_overdue_days >= notice_threshold_days:
        return "review_notice_of_intent", "approaching_formal_escalation"
    return "routine_follow_up", "routine_follow_up"


def _collections_risk_level(
    *,
    proposed_action: str,
    oldest_overdue_days: int,
    stale_inputs: Sequence[str],
) -> str:
    if proposed_action == "review_lien_preparation":
        return "critical"
    if proposed_action == "review_notice_of_intent":
        return "high"
    if stale_inputs or oldest_overdue_days >= 45:
        return "medium"
    if proposed_action == "no_op":
        return "low"
    return "medium"


def _build_collections_assessment(
    account_payload: Mapping[str, Any],
    raw_assessment: Mapping[str, Any],
    config: Mapping[str, Any],
) -> dict[str, Any]:
    thresholds = dict(config.get("thresholds") or {})
    notice_threshold_days = max(_coerce_int(thresholds.get("notice_of_intent_days")) or 60, 1)
    lien_threshold_days = max(_coerce_int(thresholds.get("lien_preparation_days")) or 90, 1)
    payment_stale_after_days = max(
        _coerce_int(thresholds.get("payment_history_stale_after_days")) or 21,
        1,
    )
    current_exposure = _coerce_float(account_payload.get("current_exposure"))
    invoices = _dict_list((account_payload.get("rental_data") or {}).get("invoices"))
    overdue_invoices = [
        invoice
        for invoice in invoices
        if str(invoice.get("status") or "").lower() in {"overdue", "past_due"}
    ]
    overdue_amount = _coerce_float(account_payload.get("overdue_amount")) or sum(
        _coerce_float(invoice.get("amount") or invoice.get("total")) for invoice in overdue_invoices
    )
    invoice_dates = [parsed for invoice in overdue_invoices if (parsed := _invoice_date(invoice))]
    now = datetime.now(UTC)
    oldest_overdue_days = (
        max((now - parsed).days for parsed in invoice_dates)
        if invoice_dates
        else max(_coerce_int(raw_assessment.get("oldest_overdue_days")), 0)
    )
    latest_payment_at: datetime | None = None
    for point in _dict_list((account_payload.get("rental_data") or {}).get("time_series")):
        if str(point.get("fact_key") or "").lower() != "payment_received":
            continue
        observed_at = _parse_datetime(point.get("observed_at"))
        if observed_at is None:
            continue
        if latest_payment_at is None or observed_at > latest_payment_at:
            latest_payment_at = observed_at
    stale_inputs: list[str] = []
    if latest_payment_at is None:
        stale_inputs.append("payment_history_missing")
    elif (now - latest_payment_at).days > payment_stale_after_days:
        stale_inputs.append("payment_history_stale")
    if not overdue_invoices:
        stale_inputs.append("overdue_invoice_detail_missing")
    branch_context = str(account_payload.get("branch_context") or "").strip()
    if not branch_context:
        stale_inputs.append("branch_context_missing")
    proposed_action, escalation_stage = _collections_proposed_action(
        overdue_amount=overdue_amount,
        oldest_overdue_days=oldest_overdue_days,
        stale_inputs=stale_inputs,
        notice_threshold_days=notice_threshold_days,
        lien_threshold_days=lien_threshold_days,
    )
    risk_level = str(raw_assessment.get("risk_level") or "") or _collections_risk_level(
        proposed_action=proposed_action,
        oldest_overdue_days=oldest_overdue_days,
        stale_inputs=stale_inputs,
    )
    evidence_items = _normalize_evidence_items(list(raw_assessment.get("evidence") or []))
    evidence_items[:0] = [
        {"label": "Overdue AR", "summary": f"${overdue_amount:,.2f} overdue across {len(overdue_invoices)} invoice(s)"},
        {
            "label": "Escalation window",
            "summary": f"Oldest overdue invoice is {oldest_overdue_days} day(s) old; notice-of-intent at {notice_threshold_days}+ days, lien prep at {lien_threshold_days}+ days",
        },
        {
            "label": "Branch context",
            "summary": branch_context or "Branch follow-up context is missing and requires manual review.",
        },
    ]
    if latest_payment_at is not None:
        evidence_items.append(
            {
                "label": "Last payment signal",
                "summary": f"Latest payment activity captured at {latest_payment_at.isoformat()}",
            }
        )
    if stale_inputs:
        evidence_items.append(
            {
                "label": "Uncertainty",
                "summary": ", ".join(stale_inputs),
            }
        )
    signal_components = {
        "overdue_amount": round(overdue_amount, 2),
        "oldest_overdue_days": oldest_overdue_days,
        "proposed_action": proposed_action,
        "stale_inputs": sorted(stale_inputs),
        "latest_payment_at": latest_payment_at.isoformat() if latest_payment_at else None,
    }
    material_signal_key = sha1(
        json.dumps(signal_components, sort_keys=True).encode("utf-8")
    ).hexdigest()
    rationale = str(raw_assessment.get("rationale") or "").strip()
    if not rationale:
        rationale = (
            "No materially new AR signal detected; keep the queue unchanged."
            if proposed_action == "no_op"
            else "Collections recommendation derived from overdue aging, recent payment history, and available branch follow-up context."
        )
    return {
        "account_id": str(raw_assessment.get("account_id") or account_payload.get("account_id") or ""),
        "customer_id": str(account_payload.get("customer_id") or raw_assessment.get("customer_id") or ""),
        "customer_name": str(account_payload.get("customer_name") or raw_assessment.get("customer_name") or ""),
        "account_label": str(account_payload.get("account_label") or ""),
        "branch_context": branch_context,
        "risk_level": risk_level,
        "proposed_action": proposed_action,
        "current_exposure": current_exposure,
        "aging_trend": str(raw_assessment.get("aging_trend") or "deteriorating"),
        "payment_behavior_score": _coerce_float(raw_assessment.get("payment_behavior_score")),
        "overdue_amount": overdue_amount,
        "oldest_overdue_days": oldest_overdue_days,
        "escalation_stage": escalation_stage,
        "stale_inputs": stale_inputs,
        "latest_payment_at": latest_payment_at.isoformat() if latest_payment_at else None,
        "material_signal_key": material_signal_key,
        "operating_model_tags": list(_COLLECTIONS_OPERATING_MODEL_TAGS),
        "evidence": evidence_items,
        "confidence": _coerce_float(raw_assessment.get("confidence") or 0.0),
        "rationale": rationale,
    }


@activity.defn
async def ops_credit_assess(
    account_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or "Assess overdue receivables and recommend the next human-approved collections escalation step for billing account {account_id}."
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Assess billing account {account_id} for tenant {tenant_id}. Rank the overdue receivable, surface uncertainty when payment or note history is stale, and propose the next collections step without sending outreach automatically. Evidence:\n{evidence_json}"
    )
    prompt_variables = {
        "tenant_id": str(account_payload.get("tenant_id") or ""),
        "account_id": str(account_payload.get("account_id") or ""),
        "evidence_json": json.dumps(account_payload, sort_keys=True),
    }
    rendered_system_prompt = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user_prompt = ops_revrec.interpolate_prompt_template(
        user_prompt_template, prompt_variables
    )

    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            await asyncio.sleep(10)

    heartbeat_task = asyncio.ensure_future(_heartbeat_loop())
    try:
        tool_executor = _credit_tool_executor(account_payload, tools)
        raw_assessment = await run_credit_analyst(
            account_payload,
            system_prompt=rendered_system_prompt,
            user_prompt_template=rendered_user_prompt,
            tools=tools,
            tool_executor=tool_executor,
            max_tool_rounds=max_tool_rounds,
        )
        return _build_collections_assessment(account_payload, raw_assessment, config)
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


@activity.defn
def ops_scope_credit_accounts(
    tenant_id: str, run_context: dict[str, Any]
) -> list[dict[str, Any]]:
    """Scope billing accounts that need credit review.

    Returns accounts that are:
    - new (recently created, no credit limit set), or
    - have overdue invoices at or above the configured overdue_threshold, or
    - have utilization at or above the configured exposure_utilization_pct.

    When neither threshold is configured no filtering is applied and all
    tenant accounts are returned (safe fallback for unconfigured agents).
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    max_accounts = min(
        max(int(run_context.get("max_accounts", 100)), _MIN_SCOPED_ACCOUNTS),
        _MAX_SCOPED_ACCOUNTS,
    )

    raw_thresholds = run_context.get("thresholds") or {}
    overdue_threshold: float | None = (
        _coerce_float(raw_thresholds["overdue_threshold"])
        if raw_thresholds.get("overdue_threshold") is not None
        else None
    )
    exposure_utilization_pct: float | None = (
        _coerce_float(raw_thresholds["exposure_utilization_pct"])
        if raw_thresholds.get("exposure_utilization_pct") is not None
        else None
    )
    apply_filter = overdue_threshold is not None or exposure_utilization_pct is not None

    billing_accounts = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "billing_account"},
    )
    invoices = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "invoice"},
    )
    customers = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "customer"},
    )
    notes = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "note"},
    )
    branches = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "branch"},
    )
    relationships = client.select("rental_current_relationships")
    time_series = client.select(
        "time_series_points",
        filters={"tenant_id": tenant_id},
        limit=5000,
    )

    # Build quick look-ups
    customer_by_id: dict[str, dict[str, Any]] = {}
    for cust in customers:
        data = ops_revrec._json_object(cust.get("data"))  # noqa: SLF001
        if str(data.get("tenant_id")) != tenant_id:
            continue
        customer_by_id[str(cust.get("entity_id"))] = {"entity_id": str(cust.get("entity_id")), **data}

    note_by_id: dict[str, dict[str, Any]] = {}
    for note in notes:
        data = ops_revrec._json_object(note.get("data"))  # noqa: SLF001
        note_by_id[str(note.get("entity_id"))] = {"entity_id": str(note.get("entity_id")), **data}

    branch_by_id: dict[str, dict[str, Any]] = {}
    for branch in branches:
        data = ops_revrec._json_object(branch.get("data"))  # noqa: SLF001
        branch_by_id[str(branch.get("entity_id"))] = {"entity_id": str(branch.get("entity_id")), **data}

    # Invoices grouped by billing_account_id
    invoices_by_account: dict[str, list[dict[str, Any]]] = {}
    for inv in invoices:
        data = ops_revrec._json_object(inv.get("data"))  # noqa: SLF001
        if str(data.get("tenant_id")) != tenant_id:
            continue
        acct_id = str(data.get("billing_account_id") or "")
        if not acct_id:
            continue
        invoices_by_account.setdefault(acct_id, []).append(
            {"entity_id": str(inv.get("entity_id")), **data}
        )

    # Time-series grouped by entity_id
    ts_by_entity: dict[str, list[dict[str, Any]]] = {}
    for point in time_series:
        eid = str(point.get("entity_id") or "")
        if eid:
            ts_by_entity.setdefault(eid, []).append(dict(point))

    # Parent→child relationships
    children_by_parent: dict[str, list[str]] = {}
    for rel in relationships:
        parent_id = str(rel.get("parent_id") or "")
        child_id = str(rel.get("child_id") or "")
        if parent_id and child_id:
            children_by_parent.setdefault(parent_id, []).append(child_id)

    scoped: list[dict[str, Any]] = []
    for acct in billing_accounts:
        data = ops_revrec._json_object(acct.get("data"))  # noqa: SLF001
        if str(data.get("tenant_id")) != tenant_id:
            continue
        account_id = str(acct.get("entity_id"))
        credit_limit = _coerce_float(data.get("credit_limit"))
        current_exposure = _coerce_float(data.get("current_exposure") or data.get("outstanding_balance"))
        acct_invoices = invoices_by_account.get(account_id, [])

        # Compute overdue exposure from invoices
        overdue_amount = sum(
            _coerce_float(inv.get("amount") or inv.get("total"))
            for inv in acct_invoices
            if str(inv.get("status") or "").lower() in {"overdue", "past_due"}
        )

        # Customer data
        customer_id = str(data.get("customer_id") or "")
        customer_data = customer_by_id.get(customer_id, {})
        if not customer_id:
            parent_ids = [
                str(rel.get("parent_id") or "")
                for rel in relationships
                if str(rel.get("relationship_type") or "") == "customer_has_billing_account"
                and str(rel.get("child_id") or "") == account_id
            ]
            customer_id = next((parent_id for parent_id in parent_ids if parent_id), "")
            customer_data = customer_by_id.get(customer_id, {})

        note_entities = [
            note_by_id[child_id]
            for child_id in children_by_parent.get(customer_id, [])
            if child_id in note_by_id
        ]
        branch_names = sorted(
            {
                str(
                    branch_by_id.get(str(inv.get("branch_id") or ""), {}).get("name")
                    or inv.get("branch_id")
                    or ""
                ).strip()
                for inv in acct_invoices
                if str(inv.get("branch_id") or "").strip()
            }
        )
        branch_names = [name for name in branch_names if name]
        branch_context = "; ".join(branch_names)
        if note_entities:
            latest_note = str(note_entities[0].get("body") or "").strip()
            if latest_note:
                branch_context = (
                    f"{branch_context} · Note: {latest_note}" if branch_context else f"Note: {latest_note}"
                )

        # Build rental_data payload for agent tools
        relevant_entity_ids = {account_id}
        if customer_id:
            relevant_entity_ids.add(customer_id)
        for note in note_entities:
            relevant_entity_ids.add(str(note.get("entity_id") or ""))
        for inv in acct_invoices:
            relevant_entity_ids.add(str(inv.get("entity_id") or ""))
            branch_id = str(inv.get("branch_id") or "")
            if branch_id:
                relevant_entity_ids.add(branch_id)

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

        scoped.append(
            {
                "tenant_id": tenant_id,
                "account_id": account_id,
                "customer_id": customer_id,
                "customer_name": str(customer_data.get("name") or ""),
                "credit_limit": credit_limit,
                "current_exposure": current_exposure,
                "overdue_amount": overdue_amount,
                "invoice_count": len(acct_invoices),
                "rental_data": {
                    "entities": [
                        {"entity_id": account_id, "entity_type": "billing_account", "data": data},
                        *(
                            [{"entity_id": customer_id, "entity_type": "customer", "data": customer_data}]
                            if customer_id
                            else []
                        ),
                        *[
                            {
                                "entity_id": str(inv.get("entity_id")),
                                "entity_type": "invoice",
                                "data": inv,
                            }
                            for inv in acct_invoices
                        ],
                        *[
                            {
                                "entity_id": str(note.get("entity_id")),
                                "entity_type": "note",
                                "data": note,
                            }
                            for note in note_entities
                        ],
                        *[
                            {
                                "entity_id": branch_id,
                                "entity_type": "branch",
                                "data": branch_by_id.get(branch_id, {}),
                            }
                            for branch_id in {
                                str(inv.get("branch_id") or "")
                                for inv in acct_invoices
                                if str(inv.get("branch_id") or "")
                            }
                        ],
                    ],
                    "relationships": relevant_relationships,
                    "facts": [],
                    "time_series": relevant_ts,
                    "invoices": acct_invoices,
                    "rate_cards": [],
                },
                "account_label": str(data.get("account_number") or data.get("name") or account_id),
                "branch_context": branch_context,
            }
        )

    # Collections queue scope is overdue-first. When thresholds are not configured
    # we still only return accounts with overdue AR so the queue stays focused on
    # actionable collections work rather than generic credit setup.
    if apply_filter:

        def _meets_criteria(acct: dict[str, Any]) -> bool:
            limit = _coerce_float(acct.get("credit_limit"))
            overdue = _coerce_float(acct.get("overdue_amount"))
            if overdue_threshold is not None and overdue > 0 and overdue >= overdue_threshold:
                return True
            if exposure_utilization_pct is not None:
                if limit <= 0:
                    return overdue > 0
                utilization = (_coerce_float(acct.get("current_exposure")) / limit) * 100.0
                if overdue > 0 and utilization >= exposure_utilization_pct:
                    return True
            return False

        scoped = [acct for acct in scoped if _meets_criteria(acct)]
    else:
        scoped = [acct for acct in scoped if _coerce_float(acct.get("overdue_amount")) > 0]

    # Prioritize: overdue first, then highest exposure
    scoped.sort(
        key=lambda item: (
            -_coerce_float(item.get("overdue_amount")),
            -_coerce_float(item.get("current_exposure")),
        )
    )
    return scoped[:max_accounts]


@activity.defn(name="ops_credit_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_credit_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_credit_list_existing_findings")
def ops_list_existing_findings(tenant_id: str) -> list[dict[str, Any]]:
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    rows = client.select("finding", filters={"tenant_id": tenant_id}, limit=5000)
    return [dict(row) for row in rows]


@activity.defn(name="ops_credit_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_credit_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _credit_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    account_id = str(finding.get("account_id") or "")
    overdue_amount = _coerce_float(finding.get("overdue_amount"))
    current_exposure = _coerce_float(finding.get("current_exposure"))
    return {
        **finding,
        "contract_id": account_id,
        "line_item_id": None,
        "expected": {
            "amount": overdue_amount,
            "account_id": account_id,
            "account_label": finding.get("account_label"),
            "customer_name": finding.get("customer_name"),
            "branch_context": finding.get("branch_context"),
            "oldest_overdue_days": finding.get("oldest_overdue_days"),
            "escalation_stage": finding.get("escalation_stage"),
            "material_signal_key": finding.get("material_signal_key"),
            "stale_inputs": list(finding.get("stale_inputs") or []),
            "operating_model_tags": list(finding.get("operating_model_tags") or []),
        },
        "billed": {
            "amount": current_exposure,
            "latest_payment_at": finding.get("latest_payment_at"),
        },
        "delta": overdue_amount or current_exposure,
        "proposed_action": finding.get("proposed_action"),
        "finding_type": str(finding.get("finding_type") or "collections_priority"),
        "severity": str(finding.get("severity") or _risk_level_to_severity(finding.get("risk_level"))),
    }


def _risk_level_to_severity(risk_level: Any) -> str:
    mapping = {"low": "low", "medium": "medium", "high": "high", "critical": "high"}
    return mapping.get(str(risk_level or "medium"), "medium")


@activity.defn(name="ops_credit_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_credit_finding_for_storage(finding), run_id)


@activity.defn(name="ops_credit_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _credit_finding_for_storage(finding), disposition, run_id, approver
    )


@activity.defn
def ops_apply_credit_change(
    finding: dict[str, Any],
    approver: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Gated write: insert a credit_change_proposal row after human approval.

    Nothing is auto-applied to customer terms — a downstream billing process
    or manual action consumes the proposal table.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    tenant_id = str(finding.get("tenant_id") or "")
    if not tenant_id:
        raise ValueError("tenant_id is required to apply credit change")

    # Resolve the finding_id (must already be recorded)
    fingerprint = str(finding.get("fingerprint") or "")
    finding_rows = client.select("finding", filters={"fingerprint": fingerprint}, limit=1)
    finding_id = str(finding_rows[0]["id"]) if finding_rows else None

    account_id = str(finding.get("account_id") or "")
    payload = client.insert(
        "credit_change_proposal",
        {
            "tenant_id": tenant_id,
            "finding_id": finding_id,
            "account_id": account_id or None,
            "proposed_action": str(finding.get("proposed_action") or "no_change"),
            "proposed_credit_limit": finding.get("proposed_credit_limit"),
            "proposed_terms": finding.get("proposed_terms"),
            "proposed_hold": bool(finding.get("proposed_hold")),
            "status": "draft",
            "approver": dict(approver) if approver else None,
            "payload": {
                "risk_level": finding.get("risk_level"),
                "rationale": finding.get("rationale"),
                "evidence": finding.get("evidence"),
                "confidence": finding.get("confidence"),
                "current_exposure": finding.get("current_exposure"),
                "aging_trend": finding.get("aging_trend"),
                "payment_behavior_score": finding.get("payment_behavior_score"),
                "fingerprint": fingerprint,
                "run_id": finding.get("run_id"),
                "workflow_id": finding.get("workflow_id"),
                "applied_at": datetime.now(UTC).isoformat(),
                "applied_by": (approver or {}).get("approver_id") or _DEFAULT_CREDIT_REQUESTER,
            },
        },
    )
    return {"proposal_id": str(payload.get("id") or ""), "account_id": account_id}


# ---------------------------------------------------------------------------
# Credit Application Review activities (t2)
# ---------------------------------------------------------------------------


@activity.defn(name="ops_credit_scope_credit_applications")
def ops_scope_credit_applications(
    tenant_id: str,
    run_context: dict[str, Any],
) -> list[dict[str, Any]]:
    """Scope pending credit applications awaiting analyst review.

    Returns at most _MAX_SCOPED_OBLIGATIONS applications ordered by
    requested credit limit descending so the highest-exposure requests
    are reviewed first.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    thresholds = run_context.get("thresholds") or {}
    max_applications = min(
        int(thresholds.get("max_applications", _MAX_SCOPED_OBLIGATIONS)),
        _MAX_SCOPED_OBLIGATIONS,
    )

    rows = client.select(
        "credit_application",
        filters={"tenant_id": tenant_id, "status": "pending_review"},
        limit=max_applications,
    )
    applications: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row) if isinstance(row, Mapping) else {}
        application_id = str(data.get("id") or data.get("application_id") or "")
        if not application_id:
            continue
        applications.append({
            "tenant_id": tenant_id,
            "application_id": application_id,
            "customer_id": str(data.get("customer_id") or ""),
            "account_id": str(data.get("account_id") or ""),
            "customer_name": str(data.get("customer_name") or ""),
            "requested_credit_limit": _coerce_float(data.get("requested_credit_limit")),
            "current_credit_limit": _coerce_float(data.get("current_credit_limit")),
            "requested_terms": str(data.get("requested_terms") or ""),
            "submitted_at": str(data.get("submitted_at") or ""),
            "notes": str(data.get("notes") or ""),
            "rental_data": data.get("rental_data") or {},
        })

    applications.sort(
        key=lambda a: -_coerce_float(a.get("requested_credit_limit")),
    )
    return applications


@activity.defn(name="ops_credit_application_assess")
async def ops_application_assess(
    application_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """AI-assisted creditworthiness assessment for a single credit application (t2).

    Never applies credit limit or terms changes — surfaces a proposal for
    human analyst approval.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("credit_application_system_prompt")
        or "Assess the creditworthiness of the applicant for account {account_id} and propose appropriate credit limits and payment terms for analyst approval. Do not approve or apply any change automatically."
    )
    user_prompt_template = str(
        config.get("credit_application_user_prompt_template")
        or "Review credit application {application_id} for customer {customer_id} (account {account_id}), tenant {tenant_id}. Requested limit: {requested_credit_limit}. Current limit: {current_credit_limit}. Evaluate trade references, payment history, and current exposure. Propose a recommended action and rationale without applying any changes. Evidence:\n{evidence_json}"
    )

    prompt_variables: dict[str, str] = {
        "tenant_id": str(application_payload.get("tenant_id") or ""),
        "application_id": str(application_payload.get("application_id") or ""),
        "customer_id": str(application_payload.get("customer_id") or ""),
        "account_id": str(application_payload.get("account_id") or ""),
        "requested_credit_limit": str(application_payload.get("requested_credit_limit") or 0),
        "current_credit_limit": str(application_payload.get("current_credit_limit") or 0),
        "evidence_json": json.dumps(
            {
                k: v
                for k, v in application_payload.items()
                if k not in {"rental_data"}
            },
            default=str,
        ),
    }
    for key, value in prompt_variables.items():
        user_prompt_template = user_prompt_template.replace(f"{{{key}}}", value)

    tool_executor = _credit_tool_executor(application_payload, tools)
    result = await run_credit_application_reviewer(
        application_payload,
        system_prompt=system_prompt,
        user_prompt_template=user_prompt_template,
        tools=tools,
        tool_executor=tool_executor,
        max_tool_rounds=max_tool_rounds,
    )
    result.setdefault("operating_model_tags", list(_CREDIT_APPLICATION_OPERATING_MODEL_TAGS))
    return result


# ---------------------------------------------------------------------------
# Lien Deadline activities (t4)
# ---------------------------------------------------------------------------


@activity.defn(name="ops_credit_scope_lien_deadlines")
def ops_scope_lien_deadlines(
    tenant_id: str,
    run_context: dict[str, Any],
) -> list[dict[str, Any]]:
    """Scope project-based contract obligations that have or need lien-deadline tracking.

    Returns obligations ordered by urgency (overdue first, critical next).
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    thresholds = run_context.get("thresholds") or {}
    max_obligations = min(
        int(thresholds.get("max_obligations", _MAX_SCOPED_OBLIGATIONS)),
        _MAX_SCOPED_OBLIGATIONS,
    )

    rows = client.select(
        "lien_deadline_obligation",
        filters={"tenant_id": tenant_id},
        limit=max_obligations,
    )
    obligations: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row) if isinstance(row, Mapping) else {}
        obligation_id = str(data.get("id") or data.get("obligation_id") or "")
        if not obligation_id:
            continue

        state = str(data.get("state") or "").strip().upper()
        first_furnishing_str = str(data.get("first_furnishing_date") or "")
        first_furnishing_date: date | None = None
        if first_furnishing_str:
            parsed_dt = _parse_datetime(first_furnishing_str)
            if parsed_dt:
                first_furnishing_date = parsed_dt.date()

        deadline_info: dict[str, Any] = {}
        if state and first_furnishing_date:
            deadline_info = calculate_prelim_notice_deadline(
                state=state,
                first_furnishing_date=first_furnishing_date,
            )
        else:
            missing: list[str] = []
            if not state:
                missing.append("state not set on obligation")
            if not first_furnishing_date:
                missing.append("first_furnishing_date not set on obligation")
            deadline_info = {
                "state": state or "UNKNOWN",
                "deadline_date": None,
                "days_window": None,
                "days_remaining": None,
                "urgency": "unknown_jurisdiction",
                "notice_required": None,
                "stale_inputs": missing,
            }

        obligations.append({
            "tenant_id": tenant_id,
            "obligation_id": obligation_id,
            "project_id": str(data.get("project_id") or ""),
            "account_id": str(data.get("account_id") or ""),
            "customer_name": str(data.get("customer_name") or ""),
            "project_name": str(data.get("project_name") or ""),
            "state": state,
            "first_furnishing_date": first_furnishing_str,
            "notice_sent": bool(data.get("notice_sent")),
            "notice_sent_at": str(data.get("notice_sent_at") or ""),
            "deadline_date": deadline_info.get("deadline_date"),
            "days_remaining": deadline_info.get("days_remaining"),
            "urgency": deadline_info.get("urgency", "unknown_jurisdiction"),
            "notice_required": deadline_info.get("notice_required"),
            "stale_inputs": deadline_info.get("stale_inputs") or [],
            "rental_data": data.get("rental_data") or {},
        })

    _URGENCY_ORDER = {
        "overdue": 0,
        "critical": 1,
        "warning": 2,
        "ok": 3,
        "unknown_jurisdiction": 4,
        "not_required": 5,
    }
    obligations.sort(key=lambda o: _URGENCY_ORDER.get(str(o.get("urgency") or ""), 99))
    return obligations


@activity.defn(name="ops_credit_lien_deadline_assess")
async def ops_lien_deadline_assess(
    obligation_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """AI-assisted preliminary-notice evidence assembly for a single obligation (t4).

    Deadline dates are pre-computed deterministically.  The AI layer assembles
    project evidence, surfaces stale inputs, and proposes the recommended
    action for analyst review.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("lien_deadline_system_prompt")
        or "You are a lien-right deadline assistant for an equipment-rental company. Deadlines are provided to you deterministically — do not recalculate them. Your role is to assemble project, contract, and payment evidence and propose the next analyst-approved action for each obligation. Never send notices automatically."
    )
    user_prompt_template = str(
        config.get("lien_deadline_user_prompt_template")
        or "Review lien-deadline obligation {obligation_id} for project {project_id} in state {state}, tenant {tenant_id}. Deadline: {deadline_date} ({days_remaining} days remaining, urgency: {urgency}). Notice sent: {notice_sent}. Propose the next action without sending any notice automatically. Evidence:\n{evidence_json}"
    )

    days_remaining = obligation_payload.get("days_remaining")
    prompt_variables: dict[str, str] = {
        "tenant_id": str(obligation_payload.get("tenant_id") or ""),
        "obligation_id": str(obligation_payload.get("obligation_id") or ""),
        "project_id": str(obligation_payload.get("project_id") or ""),
        "account_id": str(obligation_payload.get("account_id") or ""),
        "state": str(obligation_payload.get("state") or ""),
        "deadline_date": str(obligation_payload.get("deadline_date") or "unknown"),
        "days_remaining": str(days_remaining) if days_remaining is not None else "unknown",
        "urgency": str(obligation_payload.get("urgency") or "unknown"),
        "notice_sent": str(obligation_payload.get("notice_sent") or False),
        "evidence_json": json.dumps(
            {
                k: v
                for k, v in obligation_payload.items()
                if k not in {"rental_data"}
            },
            default=str,
        ),
    }
    for key, value in prompt_variables.items():
        user_prompt_template = user_prompt_template.replace(f"{{{key}}}", value)

    tool_executor = _credit_tool_executor(obligation_payload, tools)
    result = await run_lien_deadline_assistant(
        obligation_payload,
        system_prompt=system_prompt,
        user_prompt_template=user_prompt_template,
        tools=tools,
        tool_executor=tool_executor,
        max_tool_rounds=max_tool_rounds,
    )
    # Merge deterministic deadline fields — AI must not override dates
    result["deadline_date"] = obligation_payload.get("deadline_date")
    result["days_remaining"] = obligation_payload.get("days_remaining")
    result["urgency"] = obligation_payload.get("urgency")
    result["notice_required"] = obligation_payload.get("notice_required")
    result.setdefault("operating_model_tags", list(_LIEN_DEADLINE_OPERATING_MODEL_TAGS))
    return result


# ---------------------------------------------------------------------------
# Lien Waiver activities (t5)
# ---------------------------------------------------------------------------


@activity.defn(name="ops_credit_scope_lien_waivers")
def ops_scope_lien_waivers(
    tenant_id: str,
    run_context: dict[str, Any],
) -> list[dict[str, Any]]:
    """Scope waiver obligations that need analyst review.

    Returns pending and missing waivers ordered by payment amount descending.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    thresholds = run_context.get("thresholds") or {}
    max_obligations = min(
        int(thresholds.get("max_obligations", _MAX_SCOPED_OBLIGATIONS)),
        _MAX_SCOPED_OBLIGATIONS,
    )

    rows = client.select(
        "lien_waiver_obligation",
        filters={"tenant_id": tenant_id},
        limit=max_obligations,
    )
    obligations: list[dict[str, Any]] = []
    for row in rows:
        data = dict(row) if isinstance(row, Mapping) else {}
        obligation_id = str(data.get("id") or data.get("obligation_id") or "")
        if not obligation_id:
            continue
        waiver_status = str(data.get("waiver_status") or "pending_receipt")
        obligations.append({
            "tenant_id": tenant_id,
            "obligation_id": obligation_id,
            "project_id": str(data.get("project_id") or ""),
            "account_id": str(data.get("account_id") or ""),
            "payment_id": str(data.get("payment_id") or ""),
            "customer_name": str(data.get("customer_name") or ""),
            "waiver_type": str(data.get("waiver_type") or "unknown"),
            "payment_amount": _coerce_float(data.get("payment_amount")),
            "waiver_status": waiver_status,
            "payment_date": str(data.get("payment_date") or ""),
            "rental_data": data.get("rental_data") or {},
        })

    _STATUS_ORDER = {
        "missing": 0,
        "pending_receipt": 1,
        "sent_awaiting_return": 2,
        "expired": 3,
        "received": 4,
        "not_required": 5,
    }
    obligations.sort(
        key=lambda o: (
            _STATUS_ORDER.get(str(o.get("waiver_status") or ""), 99),
            -_coerce_float(o.get("payment_amount")),
        )
    )
    return obligations


@activity.defn(name="ops_credit_lien_waiver_assess")
async def ops_lien_waiver_assess(
    obligation_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """AI-assisted waiver evidence assembly for a single obligation (t5).

    Confirms which waivers are still outstanding on a payment and proposes
    the next analyst-approved action.  Never closes obligations automatically.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("lien_waiver_system_prompt")
        or "You are a lien-waiver tracking assistant for an equipment-rental company. Review waiver obligations alongside incoming payments. Surface missing or outstanding waivers and propose analyst-approved actions. Never close obligations or apply waiver status changes automatically."
    )
    user_prompt_template = str(
        config.get("lien_waiver_user_prompt_template")
        or "Review lien-waiver obligation {obligation_id} for project {project_id} in account {account_id}, tenant {tenant_id}. Payment: {payment_amount}. Waiver type: {waiver_type}. Current status: {waiver_status}. Propose the next action for analyst approval. Evidence:\n{evidence_json}"
    )

    prompt_variables: dict[str, str] = {
        "tenant_id": str(obligation_payload.get("tenant_id") or ""),
        "obligation_id": str(obligation_payload.get("obligation_id") or ""),
        "project_id": str(obligation_payload.get("project_id") or ""),
        "account_id": str(obligation_payload.get("account_id") or ""),
        "payment_id": str(obligation_payload.get("payment_id") or ""),
        "waiver_type": str(obligation_payload.get("waiver_type") or "unknown"),
        "payment_amount": str(obligation_payload.get("payment_amount") or 0),
        "waiver_status": str(obligation_payload.get("waiver_status") or "pending_receipt"),
        "evidence_json": json.dumps(
            {
                k: v
                for k, v in obligation_payload.items()
                if k not in {"rental_data"}
            },
            default=str,
        ),
    }
    for key, value in prompt_variables.items():
        user_prompt_template = user_prompt_template.replace(f"{{{key}}}", value)

    tool_executor = _credit_tool_executor(obligation_payload, tools)
    result = await run_lien_waiver_assistant(
        obligation_payload,
        system_prompt=system_prompt,
        user_prompt_template=user_prompt_template,
        tools=tools,
        tool_executor=tool_executor,
        max_tool_rounds=max_tool_rounds,
    )
    result.setdefault("operating_model_tags", list(_LIEN_WAIVER_OPERATING_MODEL_TAGS))
    return result


__all__ = [
    "ops_apply_credit_change",
    "ops_application_assess",
    "ops_create_workflow_run",
    "ops_credit_assess",
    "ops_finalize_workflow_run",
    "ops_lien_deadline_assess",
    "ops_lien_waiver_assess",
    "ops_list_existing_findings",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_scope_credit_accounts",
    "ops_scope_credit_applications",
    "ops_scope_lien_deadlines",
    "ops_scope_lien_waivers",
]
