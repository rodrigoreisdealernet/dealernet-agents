"""Integration and master-data exception queue activities.

Scope, assess, and persist ranked exception threads for the
IntegrationExceptionQueueWorkflow.

Signal coverage:
  - portal_exception   : customer-portal sync failures from integration delivery
                         logs (connector_key contains 'portal') (t5)
  - logistics_exception: logistics/mobile integration failures from descartes
                         sync delivery and mulesoft logistics connectors (t6)
  - master_data_drift  : stale or re-keyed master-data records from entity
                         state (assets, contracts, customers) with no recent
                         update (t7)

Freshness:
  Any exception whose last_updated_at is older than _STALE_THRESHOLD_HOURS is
  flagged as stale and the stale signal is added to the payload so the AI can
  surface it explicitly in the recommendation.

Design constraints:
  - No status mutations, retry approval bypasses, or data corrections.
    Assist only.
  - Duplicate / sibling failures that share the same underlying outage or
    data-quality problem collapse into one canonical thread per source_key.
  - If a scoped record contains no useful signal (no exception_id, no context),
    it is silently skipped.
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

from ..agents.integration_exception_assistant import run_integration_exception_assistant
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

_MAX_SCOPED_EXCEPTIONS = 200
_STALE_THRESHOLD_HOURS = 8
_MASTER_DATA_STALE_DAYS = 30

_DEFAULT_INTEGRATION_EXCEPTION_AGENT_KEY = "integration-exception-queue"

_INTEGRATION_EXCEPTION_TOOL_GROUPS: dict[str, tuple[str, ...]] = {
    "rental_data": (
        "query_entity",
        "query_time_series",
        "query_relationships",
        "query_facts",
        "get_telematics",
    )
}
_INTEGRATION_EXCEPTION_TOOL_HANDLERS = {
    "query_entity": query_entity,
    "query_time_series": query_time_series,
    "query_relationships": query_relationships,
    "query_facts": query_facts,
    "get_telematics": get_telematics,
}

# Integration delivery failure statuses to scope
_FAILURE_STATUSES = {
    "retryable_failure",
    "non_retryable_failure",
    "quarantined",
    "replay_queued",
    "failed",
    "error",
}

# Connector key fragments that indicate portal integrations (t5)
_PORTAL_CONNECTOR_FRAGMENTS = {"portal", "customer_portal", "selfservice", "self_service"}

# Connector key fragments that indicate logistics/mobile integrations (t6)
_LOGISTICS_CONNECTOR_FRAGMENTS = {
    "descartes",
    "logistics",
    "mobile",
    "dispatch",
    "samsara",
    "telematics",
    "transport",
    "field",
}

# Entity types that are considered master data for drift detection (t7)
_MASTER_DATA_ENTITY_TYPES = {"asset", "customer", "billing_account", "branch", "category"}


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
            "description": "Read-only integration exception evidence tool",
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
        expanded = _INTEGRATION_EXCEPTION_TOOL_GROUPS.get(tool, (tool,))
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


def _is_stale(ts_str: str | None, threshold_hours: int = _STALE_THRESHOLD_HOURS) -> bool:
    """Return True when the timestamp is older than threshold_hours or absent."""
    if not ts_str:
        return True
    try:
        dt = datetime.fromisoformat(ts_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt < datetime.now(UTC) - timedelta(hours=threshold_hours)
    except ValueError:
        return True


def _is_stale_days(ts_str: str | None, threshold_days: int = _MASTER_DATA_STALE_DAYS) -> bool:
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


def _classify_exception_type(connector_key: str) -> str:
    """Classify an exception thread as portal, logistics, or master_data_drift.

    Priority order: portal_exception > logistics_exception > master_data_drift
    """
    key_lower = connector_key.lower()
    for fragment in _PORTAL_CONNECTOR_FRAGMENTS:
        if fragment in key_lower:
            return "portal_exception"
    for fragment in _LOGISTICS_CONNECTOR_FRAGMENTS:
        if fragment in key_lower:
            return "logistics_exception"
    return "master_data_drift"


def _exception_finding_for_storage(thread: dict[str, Any]) -> dict[str, Any]:
    """Map IntegrationExceptionThreadV1 fields onto the generic finding schema."""
    exception_id = str(thread.get("exception_id") or "")
    exception_type = str(thread.get("exception_type") or "master_data_drift")
    priority = str(thread.get("priority") or "medium")
    _priority_to_severity = {"critical": "critical", "high": "high", "medium": "medium", "low": "low"}
    return {
        **thread,
        "contract_id": exception_id,
        "line_item_id": str(thread.get("source_connector") or ""),
        "finding_type": exception_type,
        "severity": _priority_to_severity.get(priority, "medium"),
        "expected": {
            "title": thread.get("title"),
            "summary": thread.get("summary"),
            "affected_workflows": thread.get("affected_workflows", []),
            "likely_root_cause": thread.get("likely_root_cause"),
            "recommended_action": thread.get("recommended_action"),
            "source_connector": thread.get("source_connector"),
            "duplicate_signal_count": thread.get("duplicate_signal_count", 0),
            "freshness_note": thread.get("freshness_note"),
            "is_stale_data": thread.get("is_stale_data", False),
            "stale_signals": thread.get("stale_signals", []),
            "operating_model_tags": thread.get("operating_model_tags", []),
        },
    }


def _exception_store_from_payload(exception_payload: Mapping[str, Any]) -> RentalDataStore:
    payload = (
        exception_payload.get("rental_data")
        if isinstance(exception_payload.get("rental_data"), Mapping)
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


def _exception_tool_executor(
    exception_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
):
    enabled_tools = {name for name in (_extract_tool_name(t) for t in configured_tools) if name}
    store = _exception_store_from_payload(exception_payload)
    scope = AppScope(tenant_id=str(exception_payload.get("tenant_id") or ""))

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = _INTEGRATION_EXCEPTION_TOOL_HANDLERS.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        try:
            return handler(store, scope, **dict(arguments))
        except ToolValidationError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}
        except TypeError as exc:
            return {"status": "invalid_request", "tool_name": tool_name, "reason": str(exc)}

    return _tool_executor


# ---------------------------------------------------------------------------
# Scope activity
# ---------------------------------------------------------------------------

@activity.defn
def ops_integration_exception_scope(
    tenant_id: str,
    run_date: str | None,
) -> list[dict[str, Any]]:
    """Scope integration and master-data exception candidates.

    Unions three candidate sets:
      1. portal_exception     — integration delivery failures for connectors
                                identified as customer-portal integrations (t5)
      2. logistics_exception  — delivery failures for logistics/mobile/telematics
                                connectors, plus Descartes sync failures (t6)
      3. master_data_drift    — entities in master-data types (asset, customer,
                                billing_account, branch, category) that have not
                                been updated in _MASTER_DATA_STALE_DAYS days (t7)

    Returns a list of exception payloads ready for
    ``ops_integration_exception_assess``.  Duplicate signals from the same
    connector and failure type are collapsed into a single canonical exception
    thread — each (connector_key, status) pair appears at most once.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001

    # 1. Integration delivery failures (mulesoft connector log)
    delivery_failures = client.select(
        "integration_delivery_log",
        columns=(
            "id, integration_id, tenant_id, connector_key, exchange_key, direction, "
            "scope_key, entity_type, entity_id, workflow_id, status, attempt_count, "
            "http_status, error_message, last_error, received_at, delivered_at, created_at, updated_at"
        ),
        filters={"tenant_id": tenant_id},
        order_by="updated_at",
        descending=True,
        limit=1000,
    )

    # 2. Descartes sync delivery failures
    descartes_failures = client.select(
        "descartes_sync_delivery",
        columns=(
            "id, tenant_id, provider_key, scope, contract_line_id, route_id, "
            "source_event_id, sync_status, retry_count, is_retryable, error_code, "
            "error_message, quarantine_reason, occurred_at, updated_at"
        ),
        filters={"tenant_id": tenant_id},
        order_by="updated_at",
        descending=True,
        limit=500,
    )

    # 3. Master-data entities for staleness audit
    master_data_entities = client.select(
        "rental_current_entity_state",
        columns="entity_id, entity_type, name, data, updated_at",
        order_by="updated_at",
        descending=False,
        limit=2000,
    )

    # --- Build canonical exception threads ---
    # Dedup key: (exception_type, source_connector, scope_key/entity_type)
    # The first failure seen for each dedup key becomes the canonical thread;
    # siblings increment the duplicate_signal_count.
    canonical: dict[str, dict[str, Any]] = {}

    # Process integration delivery failures
    for row in delivery_failures:
        status = str(row.get("status") or "").lower()
        if status not in _FAILURE_STATUSES:
            continue
        row_tenant = str(row.get("tenant_id") or "")
        if row_tenant and row_tenant != tenant_id:
            continue
        connector_key = str(row.get("connector_key") or "")
        scope_key = str(row.get("scope_key") or "")
        entity_type = str(row.get("entity_type") or "")
        exception_type = _classify_exception_type(connector_key)

        dedup_key = f"{exception_type}:{connector_key}:{scope_key or entity_type}"
        last_updated = str(row.get("updated_at") or row.get("created_at") or "")
        stale = _is_stale(last_updated)

        if dedup_key in canonical:
            canonical[dedup_key]["duplicate_signal_count"] = (
                canonical[dedup_key].get("duplicate_signal_count", 0) + 1
            )
            # Update to most recent failure
            existing_ts = str(canonical[dedup_key].get("last_updated_at") or "")
            if last_updated > existing_ts:
                canonical[dedup_key]["last_updated_at"] = last_updated
                canonical[dedup_key]["is_stale_hint"] = stale
            # Collect error messages for evidence
            err = str(row.get("error_message") or row.get("last_error") or "")
            if err:
                canonical[dedup_key].setdefault("error_samples", [])
                if err not in canonical[dedup_key]["error_samples"]:
                    canonical[dedup_key]["error_samples"].append(err)
        else:
            err = str(row.get("error_message") or row.get("last_error") or "")
            canonical[dedup_key] = {
                "tenant_id": tenant_id,
                "exception_id": str(row.get("id") or dedup_key),
                "exception_type": exception_type,
                "source_connector": connector_key,
                "scope_key": scope_key,
                "entity_type": entity_type,
                "affected_entity_id": str(row.get("entity_id") or ""),
                "affected_workflow_id": str(row.get("workflow_id") or ""),
                "failure_status": status,
                "attempt_count": int(_coerce_float(row.get("attempt_count") or 0)),
                "http_status": row.get("http_status"),
                "error_message": err,
                "error_samples": [err] if err else [],
                "duplicate_signal_count": 0,
                "last_updated_at": last_updated,
                "is_stale_hint": stale,
                "rental_data": {
                    "entities": [],
                    "relationships": [],
                    "facts": [],
                    "time_series": [],
                    "telematics": [],
                },
            }

    # Process Descartes sync failures
    for row in descartes_failures:
        status = str(row.get("sync_status") or "").lower()
        if status not in _FAILURE_STATUSES:
            continue
        row_tenant = str(row.get("tenant_id") or "")
        if row_tenant and row_tenant != tenant_id:
            continue
        connector_key = str(row.get("provider_key") or "descartes")
        scope = str(row.get("scope") or "")
        exception_type = _classify_exception_type(connector_key)

        dedup_key = f"{exception_type}:{connector_key}:{scope}"
        last_updated = str(row.get("updated_at") or row.get("occurred_at") or "")
        stale = _is_stale(last_updated)
        err = str(row.get("error_message") or row.get("error_code") or row.get("quarantine_reason") or "")

        if dedup_key in canonical:
            canonical[dedup_key]["duplicate_signal_count"] = (
                canonical[dedup_key].get("duplicate_signal_count", 0) + 1
            )
            existing_ts = str(canonical[dedup_key].get("last_updated_at") or "")
            if last_updated > existing_ts:
                canonical[dedup_key]["last_updated_at"] = last_updated
                canonical[dedup_key]["is_stale_hint"] = stale
            if err and err not in canonical[dedup_key].get("error_samples", []):
                canonical[dedup_key].setdefault("error_samples", []).append(err)
        else:
            canonical[dedup_key] = {
                "tenant_id": tenant_id,
                "exception_id": str(row.get("id") or dedup_key),
                "exception_type": exception_type,
                "source_connector": connector_key,
                "scope_key": scope,
                "entity_type": "route_sync",
                "affected_entity_id": str(row.get("contract_line_id") or ""),
                "affected_workflow_id": str(row.get("route_id") or ""),
                "failure_status": status,
                "attempt_count": int(_coerce_float(row.get("retry_count") or 0)),
                "http_status": None,
                "error_message": err,
                "error_samples": [err] if err else [],
                "duplicate_signal_count": 0,
                "last_updated_at": last_updated,
                "is_stale_hint": stale,
                "rental_data": {
                    "entities": [],
                    "relationships": [],
                    "facts": [],
                    "time_series": [],
                    "telematics": [],
                },
            }

    # Process master-data drift
    for row in master_data_entities:
        entity_type = str(row.get("entity_type") or "")
        if entity_type not in _MASTER_DATA_ENTITY_TYPES:
            continue
        data = ops_revrec._json_object(row.get("data"))  # noqa: SLF001
        row_tenant = str(data.get("tenant_id") or "")
        if row_tenant and row_tenant != tenant_id:
            continue
        last_updated = str(row.get("updated_at") or "")
        if not _is_stale_days(last_updated):
            continue

        entity_id = str(row.get("entity_id") or "")
        entity_name = str(row.get("name") or data.get("name") or "")
        dedup_key = f"master_data_drift:master_data:{entity_type}"

        if dedup_key in canonical:
            canonical[dedup_key]["duplicate_signal_count"] = (
                canonical[dedup_key].get("duplicate_signal_count", 0) + 1
            )
            # Track oldest record for most impactful drift evidence
            existing_ts = str(canonical[dedup_key].get("last_updated_at") or "")
            if not existing_ts or last_updated < existing_ts:
                canonical[dedup_key]["last_updated_at"] = last_updated
                canonical[dedup_key]["is_stale_hint"] = True
        else:
            canonical[dedup_key] = {
                "tenant_id": tenant_id,
                "exception_id": f"master_data:{entity_type}:{entity_id}",
                "exception_type": "master_data_drift",
                "source_connector": "master_data",
                "scope_key": entity_type,
                "entity_type": entity_type,
                "affected_entity_id": entity_id,
                "affected_workflow_id": "",
                "failure_status": "stale",
                "attempt_count": 0,
                "http_status": None,
                "error_message": f"Entity type '{entity_type}' (e.g. '{entity_name}') not updated in over {_MASTER_DATA_STALE_DAYS} days",
                "error_samples": [],
                "duplicate_signal_count": 0,
                "last_updated_at": last_updated,
                "is_stale_hint": True,
                "rental_data": {
                    "entities": [
                        {
                            "entity_id": entity_id,
                            "entity_type": entity_type,
                            "name": entity_name,
                            "data": data,
                            "updated_at": last_updated,
                        }
                    ],
                    "relationships": [],
                    "facts": [],
                    "time_series": [],
                    "telematics": [],
                },
            }

    scoped = list(canonical.values())

    logger.info(
        "ops_integration_exception_scope",
        extra={
            "tenant_id": tenant_id,
            "run_date": run_date,
            "total_scoped": len(scoped),
        },
    )
    return scoped[:_MAX_SCOPED_EXCEPTIONS]


# ---------------------------------------------------------------------------
# AI assessment activity
# ---------------------------------------------------------------------------

@activity.defn
async def ops_integration_exception_assess(
    exception_payload: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Run AI assessment for a single scoped integration exception thread.

    Returns an ``IntegrationExceptionThreadV1`` dict enriched with evidence,
    stale-data callouts, affected workflows, and operating-model tags.
    """
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(_coerce_float(bounds.get("max_tool_rounds")) or 5)
    tools = _normalize_tools(list(config.get("tools") or []))
    system_prompt = str(
        config.get("system_prompt")
        or (
            "You are the integration and master-data exception assistant for a rental software "
            "and systems administrator at an equipment-rental company. Your role is to evaluate "
            "a single integration or master-data exception and produce a ranked, evidence-backed "
            "exception thread with a clear recommended next investigation or fix path for the "
            "administrator to review. Always: cite delivery log evidence, error messages, and "
            "freshness signals; flag stale telemetry; collapse duplicate signals; never mutate "
            "data, approve retries automatically, or send customer communications."
        )
    )
    user_prompt_template = str(
        config.get("user_prompt_template")
        or (
            "Evaluate integration exception for connector '{source_connector}' "
            "in tenant {tenant_id}. Exception type: {exception_type}. "
            "Failure status: {failure_status}. "
            "Attempt count: {attempt_count}. "
            "Duplicate signals collapsed: {duplicate_signal_count}. "
            "Error: {error_message}. "
            "Provide a ranked exception thread with a clear recommended investigation path. "
            "Evidence: {evidence_json}"
        )
    )
    prompt_variables = {
        "tenant_id": str(exception_payload.get("tenant_id") or ""),
        "exception_id": str(exception_payload.get("exception_id") or ""),
        "exception_type": str(exception_payload.get("exception_type") or ""),
        "source_connector": str(exception_payload.get("source_connector") or ""),
        "failure_status": str(exception_payload.get("failure_status") or ""),
        "attempt_count": str(exception_payload.get("attempt_count") or "0"),
        "duplicate_signal_count": str(exception_payload.get("duplicate_signal_count") or "0"),
        "error_message": str(exception_payload.get("error_message") or ""),
        "evidence_json": json.dumps(exception_payload, sort_keys=True, default=str),
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
        tool_executor = _exception_tool_executor(exception_payload, tools)
        result = await run_integration_exception_assistant(
            exception_payload,
            system_prompt=rendered_system,
            user_prompt_template=rendered_user,
            tools=tools,
            tool_executor=tool_executor,
            max_tool_rounds=max_tool_rounds,
        )
        # Carry through fields the AI may not reproduce.
        result.setdefault("exception_id", str(exception_payload.get("exception_id") or ""))
        result.setdefault("exception_type", str(exception_payload.get("exception_type") or "master_data_drift"))
        result.setdefault("source_connector", str(exception_payload.get("source_connector") or ""))
        result.setdefault("duplicate_signal_count", int(exception_payload.get("duplicate_signal_count") or 0))
        result.setdefault("tenant_id", str(exception_payload.get("tenant_id") or ""))
        result["tenant_id"] = str(exception_payload.get("tenant_id") or "")
        return result
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, temporalio.exceptions.CancelledError):
            await heartbeat_task


# ---------------------------------------------------------------------------
# Named-activity wrappers (avoid Temporal activity name collisions)
# ---------------------------------------------------------------------------

@activity.defn(name="ops_integration_exception_load_agent_config")
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    return ops_revrec.ops_load_agent_config(tenant_id, agent_key)


@activity.defn(name="ops_integration_exception_list_open_finding_fingerprints")
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    return ops_revrec.ops_list_open_finding_fingerprints(tenant_id)


@activity.defn(name="ops_integration_exception_create_workflow_run")
def ops_create_workflow_run(
    workflow_key: str, tenant_id: str, metadata: dict[str, Any]
) -> dict[str, Any]:
    return ops_revrec.ops_create_workflow_run(workflow_key, tenant_id, metadata)


@activity.defn(name="ops_integration_exception_finalize_workflow_run")
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    return ops_revrec.ops_finalize_workflow_run(run_id, summary)


@activity.defn(name="ops_integration_exception_record_finding")
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    return ops_revrec.ops_record_finding(_exception_finding_for_storage(finding), run_id)


@activity.defn(name="ops_integration_exception_record_finding_disposition")
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    return ops_revrec.ops_record_finding_disposition(
        _exception_finding_for_storage(finding), disposition, run_id, approver
    )


__all__ = [
    "ops_integration_exception_scope",
    "ops_integration_exception_assess",
    "ops_create_workflow_run",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "ops_record_finding",
    "ops_record_finding_disposition",
]
