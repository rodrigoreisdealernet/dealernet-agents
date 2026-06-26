from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.collections_prioritizer import run_collections_prioritizer
from . import ops_revrec

logger = logging.getLogger(__name__)

_AGENT_KEY = "collections-prioritizer"
_FINDING_TYPE = "collections_priority"
_DEFAULT_NEAR_DUE_DAYS = -5
_DEFAULT_MAX_CUSTOMERS = 200
_MIN_SCOPED_CUSTOMERS = 1
_MAX_SCOPED_CUSTOMERS = 500
_MAX_CONTACT_NOTES_PER_CUSTOMER = 5
_MAX_NOTE_CHARS = 240
_MAX_EVIDENCE_ITEMS = 5
_MAX_EVIDENCE_CHARS = 240


def _coerce_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _parse_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _bounded_text(value: Any, *, limit: int = _MAX_NOTE_CHARS) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _bounded_evidence(items: Sequence[Any] | None) -> list[str]:
    bounded: list[str] = []
    for item in list(items or [])[:_MAX_EVIDENCE_ITEMS]:
        text = _bounded_text(item, limit=_MAX_EVIDENCE_CHARS)
        if text:
            bounded.append(text)
    return bounded


def _severity_for_days(days_overdue: int) -> str:
    if days_overdue > 90:
        return "critical"
    if days_overdue >= 31:
        return "high"
    if days_overdue >= 1:
        return "medium"
    return "low"


def _collections_fingerprint(tenant_id: str, customer_id: str) -> str:
    return hashlib.sha256(f"{tenant_id}:{customer_id}:{_FINDING_TYPE}".encode()).hexdigest()


@activity.defn
def ops_scope_collections(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001 — shared persistence client
    thresholds = run_context.get("thresholds") if isinstance(run_context.get("thresholds"), Mapping) else {}
    near_due_days = _coerce_int(thresholds.get("near_due_days", _DEFAULT_NEAR_DUE_DAYS))
    if near_due_days == 0 and thresholds.get("near_due_days") in (None, ""):
        near_due_days = _DEFAULT_NEAR_DUE_DAYS
    max_customers = _coerce_int(run_context.get("max_customers")) or _DEFAULT_MAX_CUSTOMERS
    max_customers = max(_MIN_SCOPED_CUSTOMERS, min(max_customers, _MAX_SCOPED_CUSTOMERS))

    receivable_rows = client.select(
        "v_dia_receivable_current",
        columns=(
            "entity_id,source_record_id,name,customer_id,customer_name,document_number,"
            "receivable_type,balance,due_date,collector_code,collector_name,status,days_overdue"
        ),
        filters={"status": "aberto"},
    )
    contact_rows = client.select(
        "v_dia_collection_contact_current",
        columns=(
            "entity_id,source_record_id,customer_id,receivable_id,action,note,"
            "contact_date,next_contact_date,result"
        ),
    )

    contacts_by_customer: dict[str, list[dict[str, Any]]] = {}
    for row in contact_rows:
        customer_id = str(row.get("customer_id") or "")
        if not customer_id:
            continue
        note = _bounded_text(row.get("note"))
        contact = {
            "contact_id": row.get("entity_id"),
            "receivable_id": row.get("receivable_id"),
            "action": row.get("action"),
            "note": note,
            "contact_date": row.get("contact_date"),
            "next_contact_date": row.get("next_contact_date"),
            "result": row.get("result"),
        }
        contacts_by_customer.setdefault(customer_id, []).append(contact)

    customers: dict[str, dict[str, Any]] = {}
    today = date.today()
    for row in receivable_rows:
        customer_id = str(row.get("customer_id") or "")
        if not customer_id:
            continue
        balance = round(_coerce_float(row.get("balance")), 2)
        days_overdue = max(_coerce_int(row.get("days_overdue")), 0)
        due_date = _parse_date(row.get("due_date"))
        raw_days_from_due = (today - due_date).days if due_date else days_overdue
        receivable = {
            "receivable_id": row.get("entity_id"),
            "source_record_id": row.get("source_record_id"),
            "document_number": row.get("document_number"),
            "receivable_type": row.get("receivable_type"),
            "balance": balance,
            "due_date": row.get("due_date"),
            "days_overdue": days_overdue,
            "collector_code": row.get("collector_code"),
            "collector_name": row.get("collector_name"),
        }
        customer = customers.setdefault(
            customer_id,
            {
                "customer_id": customer_id,
                "tenant_id": tenant_id,
                "customer_name": row.get("customer_name") or row.get("name"),
                "open_receivables": [],
                "total_exposure": 0.0,
                "max_days_overdue": 0,
                "qualifies": False,
            },
        )
        customer["open_receivables"].append(receivable)
        customer["total_exposure"] = round(_coerce_float(customer.get("total_exposure")) + balance, 2)
        customer["max_days_overdue"] = max(_coerce_int(customer.get("max_days_overdue")), days_overdue)
        customer["qualifies"] = bool(customer.get("qualifies")) or raw_days_from_due >= near_due_days

    scoped: list[dict[str, Any]] = []
    for customer_id, customer in customers.items():
        if not customer.get("qualifies"):
            continue
        recent_contacts = sorted(
            contacts_by_customer.get(customer_id, []),
            key=lambda item: str(item.get("contact_date") or ""),
            reverse=True,
        )[:_MAX_CONTACT_NOTES_PER_CUSTOMER]
        max_days_overdue = _coerce_int(customer.get("max_days_overdue"))
        total_exposure = round(_coerce_float(customer.get("total_exposure")), 2)
        scoped.append(
            {
                "customer_id": customer_id,
                "tenant_id": tenant_id,
                "customer_name": customer.get("customer_name"),
                "open_receivables": customer.get("open_receivables") or [],
                "recent_collection_contacts": recent_contacts,
                "total_exposure": total_exposure,
                "max_days_overdue": max_days_overdue,
                "days_overdue": max_days_overdue,
                "severity": _severity_for_days(max_days_overdue),
                "finding_type": _FINDING_TYPE,
                "fingerprint": _collections_fingerprint(tenant_id, customer_id),
            }
        )

    scoped.sort(key=lambda item: (-_coerce_float(item.get("total_exposure")), str(item.get("customer_id") or "")))
    return scoped[:max_customers]


@activity.defn
async def ops_collections_assess(customer_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    max_tool_rounds = _coerce_int(bounds.get("max_tool_rounds")) or 0
    system_prompt = str(config.get("system_prompt") or "You are a collections prioritizer.")
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Assess customer {customer_id} for tenant {tenant_id}. Evidence:\n{evidence_json}"
    )
    prompt_variables = {
        "tenant_id": str(customer_payload.get("tenant_id") or ""),
        "customer_id": str(customer_payload.get("customer_id") or ""),
        "customer_name": str(customer_payload.get("customer_name") or ""),
        "total_exposure": str(customer_payload.get("total_exposure") or ""),
        "days_overdue": str(customer_payload.get("max_days_overdue") or customer_payload.get("days_overdue") or ""),
        "severity": str(customer_payload.get("severity") or ""),
        "evidence_json": json.dumps(customer_payload, sort_keys=True),
    }
    rendered_system_prompt = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user_prompt = ops_revrec.interpolate_prompt_template(user_prompt_template, prompt_variables)

    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            except Exception:  # noqa: BLE001 — worker shutdown/other Temporal context errors
                logger.debug("ops_collections_assess heartbeat failed; loop exiting")
                return
            await asyncio.sleep(15)

    heartbeat_task = asyncio.create_task(_heartbeat_loop())
    try:
        result = await run_collections_prioritizer(
            customer_payload,
            system_prompt=rendered_system_prompt,
            user_prompt_template=rendered_user_prompt,
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()

    result["customer_id"] = str(customer_payload.get("customer_id") or result.get("customer_id") or "")
    result["finding_type"] = _FINDING_TYPE
    result["total_exposure"] = round(_coerce_float(customer_payload.get("total_exposure")), 2)
    result["days_overdue"] = _coerce_int(customer_payload.get("max_days_overdue") or customer_payload.get("days_overdue"))
    result["severity"] = str(customer_payload.get("severity") or result.get("severity") or "medium")
    result.setdefault("recommended_action", "monitor")
    result.setdefault("evidence", [])
    result["evidence"] = _bounded_evidence(result.get("evidence"))
    result.setdefault("confidence", 0.0)
    result.setdefault("rationale", "No rationale provided")
    result.setdefault("next_step_note", "")
    return result


@activity.defn(name="ops_collections_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_collections_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_collections_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_collections_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _collections_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    customer_id = str(finding.get("customer_id") or "")
    evidence = _bounded_evidence(finding.get("evidence"))
    return {
        **finding,
        "contract_id": customer_id,
        "line_item_id": None,
        "finding_type": str(finding.get("finding_type") or _FINDING_TYPE),
        "severity": str(finding.get("severity") or "medium"),
        "expected": {
            "customer_id": customer_id,
            "total_exposure": finding.get("total_exposure"),
            "days_overdue": finding.get("days_overdue"),
            "recommended_action": finding.get("recommended_action"),
            "next_step_note": _bounded_text(finding.get("next_step_note"), limit=_MAX_EVIDENCE_CHARS),
            "evidence_summary": evidence,
        },
        "billed": {},
        "delta": finding.get("total_exposure"),
        "evidence": evidence,
        "proposed_action": finding.get("recommended_action"),
    }


@activity.defn(name="ops_collections_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_collections_finding_for_storage(finding), run_id)


@activity.defn(name="ops_collections_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _collections_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_collections_assess",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_scope_collections",
]
