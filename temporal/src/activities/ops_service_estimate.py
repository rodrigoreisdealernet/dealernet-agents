from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
from collections.abc import Mapping
from typing import Any

import temporalio.exceptions
from temporalio import activity

from ..agents.service_estimate_rescue import run_service_estimate_rescue
from . import ops_revrec

logger = logging.getLogger(__name__)

_AGENT_KEY = "service-estimate-rescue"
_FINDING_TYPE = "estimate_rescue"

# Deterministic scope/severity thresholds (overridable via config.thresholds).
_DEFAULT_MAX_ESTIMATES = 200
_MIN_SCOPED_ESTIMATES = 1
_MAX_SCOPED_ESTIMATES = 500
# Pending estimates at or above this recoverable value are escalated to "high".
_DEFAULT_HIGH_VALUE_THRESHOLD = 5000.0
# Default authorization window: valid_from + 7 days unless tenant config overrides it.
_ESTIMATE_AUTH_WINDOW_DAYS = 7
_BREACH_FIELD_CANDIDATES = (
    "valid_until",
    "authorization_valid_until",
    "authorization_expires_at",
    "expires_at",
)


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


def _parse_datetime(value: Any) -> dt.datetime | None:
    if isinstance(value, dt.datetime):
        parsed = value
    elif isinstance(value, dt.date):
        parsed = dt.datetime.combine(value, dt.time.min)
    elif value:
        raw = str(value).strip()
        try:
            parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed = dt.datetime.combine(dt.date.fromisoformat(raw[:10]), dt.time.min)
            except ValueError:
                return None
    else:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _service_estimate_predicted_breach_at(
    estimate_payload: Mapping[str, Any],
    *,
    auth_window_days: int = _ESTIMATE_AUTH_WINDOW_DAYS,
) -> str | None:
    for field in _BREACH_FIELD_CANDIDATES:
        parsed = _parse_datetime(estimate_payload.get(field))
        if parsed is not None:
            return parsed.isoformat().replace("+00:00", "Z")
    valid_from = _parse_datetime(estimate_payload.get("valid_from"))
    if valid_from is None:
        return None
    return (valid_from + dt.timedelta(days=auth_window_days)).isoformat().replace("+00:00", "Z")


def _service_estimate_days_to_breach(
    predicted_breach_at: Any,
    *,
    today: dt.date | None = None,
) -> int | None:
    parsed = _parse_datetime(predicted_breach_at)
    if parsed is None:
        return None
    return (parsed.date() - (today or dt.date.today())).days


def _severity_for(
    status: str,
    line_value: float,
    *,
    high_value_threshold: float = _DEFAULT_HIGH_VALUE_THRESHOLD,
) -> str:
    """Deterministic severity from estimate status + recoverable value.

    declined                         -> high   (a confirmed lost sale to recover)
    pending with line_value >= thr   -> high   (the manager's priority)
    pending below the threshold      -> medium
    """
    if str(status) == "declined" or _coerce_float(line_value) >= high_value_threshold:
        return "high"
    return "medium"


def _estimate_fingerprint(tenant_id: str, estimate_id: str) -> str:
    return hashlib.sha256(f"{tenant_id}:{estimate_id}:{_FINDING_TYPE}".encode()).hexdigest()


@activity.defn
def ops_scope_service_estimates(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministically scope pending/declined service estimates to rescue.

    Reads ``v_dia_service_estimate_current`` (NOT any rental_* helper): one row
    per pending/declined estimate on a non-cancelled OS, already ranked
    declined-before-pending then ``line_value`` desc by the view. Severity, the
    recoverable value and the SHA-256 dedupe fingerprint are computed here so the
    run stays deterministic even if the downstream LLM assessment is unavailable.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001 — shared persistence client
    thresholds = run_context.get("thresholds") if isinstance(run_context.get("thresholds"), Mapping) else {}
    high_value_threshold = (
        _coerce_float(thresholds.get("high_value_threshold", _DEFAULT_HIGH_VALUE_THRESHOLD))
        or _DEFAULT_HIGH_VALUE_THRESHOLD
    )
    auth_window_days = (
        _coerce_int(thresholds.get("estimate_auth_window_days", _ESTIMATE_AUTH_WINDOW_DAYS))
        or _ESTIMATE_AUTH_WINDOW_DAYS
    )
    max_estimates = _coerce_int(run_context.get("max_estimates")) or _DEFAULT_MAX_ESTIMATES
    max_estimates = max(_MIN_SCOPED_ESTIMATES, min(max_estimates, _MAX_SCOPED_ESTIMATES))

    rows = client.select(
        "v_dia_service_estimate_current",
        columns=(
            "os_id,source_record_id,order_number,customer,vehicle,technician,"
            "estimate_id,estimate_status,line_value,lost_sale_reason,"
            "estimate_description,recovery_rank,valid_from"
        ),
    )

    scoped: list[dict[str, Any]] = []
    for row in rows:
        estimate_id = str(row.get("estimate_id") or "")
        if not estimate_id:
            continue
        estimate_status = str(row.get("estimate_status") or "pending")
        line_value = round(_coerce_float(row.get("line_value")), 2)
        recovery_rank = _coerce_int(row.get("recovery_rank"))
        severity = _severity_for(estimate_status, line_value, high_value_threshold=high_value_threshold)
        predicted_breach_at = _service_estimate_predicted_breach_at(row, auth_window_days=auth_window_days)
        scoped.append(
            {
                "estimate_id": estimate_id,
                "os_id": str(row.get("os_id") or ""),
                "tenant_id": tenant_id,
                "source_record_id": row.get("source_record_id"),
                "order_number": row.get("order_number"),
                "customer": row.get("customer"),
                "vehicle": row.get("vehicle"),
                "technician": row.get("technician"),
                "estimate_status": estimate_status,
                "valid_from": row.get("valid_from"),
                "line_value": line_value,
                "recoverable_value": line_value,
                "predicted_breach_at": predicted_breach_at,
                "days_to_breach": _service_estimate_days_to_breach(predicted_breach_at),
                "lost_sale_reason": row.get("lost_sale_reason"),
                "estimate_description": row.get("estimate_description"),
                "severity": severity,
                "recovery_rank": recovery_rank,
                "finding_type": _FINDING_TYPE,
                "fingerprint": _estimate_fingerprint(tenant_id, estimate_id),
            }
        )

    scoped.sort(
        key=lambda item: (
            int(item.get("recovery_rank") or 0),
            -float(item.get("line_value") or 0.0),
            str(item.get("estimate_id") or ""),
        )
    )
    return scoped[:max_estimates]


@activity.defn
async def ops_service_estimate_assess(estimate_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    max_tool_rounds = _coerce_int(bounds.get("max_tool_rounds")) or 0
    system_prompt = str(config.get("system_prompt") or "You are a service-estimate authorization rescue analyst.")
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Assess estimate {estimate_id} on order {order_number} for tenant {tenant_id}. Evidence:\n{evidence_json}"
    )
    prompt_variables = {
        "tenant_id": str(estimate_payload.get("tenant_id") or ""),
        "estimate_id": str(estimate_payload.get("estimate_id") or ""),
        "os_id": str(estimate_payload.get("os_id") or ""),
        "order_number": str(estimate_payload.get("order_number") or ""),
        "customer": str(estimate_payload.get("customer") or ""),
        "vehicle": str(estimate_payload.get("vehicle") or ""),
        "technician": str(estimate_payload.get("technician") or ""),
        "estimate_status": str(estimate_payload.get("estimate_status") or ""),
        "line_value": str(estimate_payload.get("line_value") or ""),
        "recoverable_value": str(estimate_payload.get("recoverable_value") or ""),
        "lost_sale_reason": str(estimate_payload.get("lost_sale_reason") or ""),
        "estimate_description": str(estimate_payload.get("estimate_description") or ""),
        "severity": str(estimate_payload.get("severity") or ""),
        "valid_from": str(estimate_payload.get("valid_from") or ""),
        "evidence_json": json.dumps(estimate_payload, sort_keys=True),
    }
    rendered_system_prompt = ops_revrec.interpolate_prompt_template(system_prompt, prompt_variables)
    rendered_user_prompt = ops_revrec.interpolate_prompt_template(user_prompt_template, prompt_variables)

    # Heartbeat every 15 s so a stalled LLM/HTTP call is detected before the
    # workflow's heartbeat_timeout elapses; cancelled once the analyst returns.
    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                return
            except Exception:  # noqa: BLE001 — worker shutdown/other Temporal context errors
                logger.debug("ops_service_estimate_assess heartbeat failed; loop exiting")
                return
            await asyncio.sleep(15)

    heartbeat_task = asyncio.create_task(_heartbeat_loop())
    try:
        result = await run_service_estimate_rescue(
            estimate_payload,
            system_prompt=rendered_system_prompt,
            user_prompt_template=rendered_user_prompt,
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()

    # Pin the deterministic, money-relevant fields to the scoped view values so a
    # finding's severity/recoverable value never depend on free-form model output.
    result["estimate_id"] = str(estimate_payload.get("estimate_id") or result.get("estimate_id") or "")
    result["os_id"] = str(estimate_payload.get("os_id") or result.get("os_id") or "")
    result["finding_type"] = _FINDING_TYPE
    result["severity"] = str(estimate_payload.get("severity") or result.get("severity") or "medium")
    result["recoverable_value"] = round(_coerce_float(estimate_payload.get("recoverable_value")), 2)
    result["valid_from"] = estimate_payload.get("valid_from")
    result["predicted_breach_at"] = estimate_payload.get("predicted_breach_at")
    result["days_to_breach"] = estimate_payload.get("days_to_breach")
    result.setdefault("recommended_action", "monitor")
    result.setdefault("evidence", [])
    result.setdefault("confidence", 0.0)
    result.setdefault("rationale", "No rationale provided")
    return result


@activity.defn(name="ops_service_estimate_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_service_estimate_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_service_estimate_create_workflow_run")
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_service_estimate_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


def _service_estimate_finding_for_storage(finding: dict[str, Any]) -> dict[str, Any]:
    """Shape a surfaced service-estimate finding into the canonical ``finding`` row.

    The parent OS entity_id is the audit anchor (``contract_id``), there are no
    line items (``estimate_id`` is not necessarily a uuid, so it is carried in
    ``expected`` instead), and the recoverable ``delta`` is the estimate's
    ``line_value`` derived from ``v_dia_service_estimate_current``.
    """
    os_id = str(finding.get("os_id") or "")
    return {
        **finding,
        "contract_id": os_id,
        "line_item_id": None,
        "finding_type": str(finding.get("finding_type") or _FINDING_TYPE),
        "severity": str(finding.get("severity") or "medium"),
        "expected": {
            "estimate_id": finding.get("estimate_id"),
            "estimate_status": finding.get("estimate_status"),
            "valid_from": finding.get("valid_from"),
            "line_value": finding.get("line_value"),
            "predicted_breach_at": finding.get("predicted_breach_at"),
            "days_to_breach": finding.get("days_to_breach"),
            "lost_sale_reason": finding.get("lost_sale_reason"),
            "customer": finding.get("customer"),
            "vehicle": finding.get("vehicle"),
            "order_number": finding.get("order_number"),
            "recommended_action": finding.get("recommended_action"),
        },
        "billed": {},
        "delta": finding.get("recoverable_value"),
        "proposed_action": finding.get("recommended_action"),
    }


@activity.defn(name="ops_service_estimate_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_service_estimate_finding_for_storage(finding), run_id)


@activity.defn(name="ops_service_estimate_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _service_estimate_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "_ESTIMATE_AUTH_WINDOW_DAYS",
    "_service_estimate_days_to_breach",
    "_service_estimate_predicted_breach_at",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_scope_service_estimates",
    "ops_service_estimate_assess",
]
