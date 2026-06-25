from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

import temporalio.exceptions
from temporalio import activity

from ..agents.revrec_analyst import revrec_finding_v1_schema, run_revrec_analyst
from ..config import settings

logger = logging.getLogger(__name__)
_PROMPT_TEMPLATE_VARIABLE_PATTERN = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
_PROMPT_TEMPLATE_MUSTACHE_PATTERN = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


class AgentConfigError(ValueError):
    """Base error for tenant-scoped agent config failures."""


class AgentConfigNotFoundError(AgentConfigError):
    """Raised when a tenant/agent pair has no current configuration."""


class UnknownOutputSchemaKeyError(AgentConfigError):
    """Raised when the configured output schema key cannot be resolved."""


class PromptTemplateInterpolationError(AgentConfigError):
    """Raised when required prompt variables are missing."""


def _extract_tool_name(tool: Mapping[str, Any]) -> str | None:
    function = tool.get("function")
    if not isinstance(function, Mapping):
        return None
    name = function.get("name")
    if not isinstance(name, str) or not name:
        return None
    return name


def _query_time_series(contract_payload: Mapping[str, Any], arguments: Mapping[str, Any]) -> dict[str, Any]:
    raw_points = contract_payload.get("time_series_points")
    points = [point for point in raw_points if isinstance(point, Mapping)] if isinstance(raw_points, Sequence) else []
    entity_id = arguments.get("entity_id")
    kinds = arguments.get("kinds")
    allowed_kinds = {str(kind) for kind in kinds} if isinstance(kinds, Sequence) and not isinstance(kinds, str) else None

    filtered = [
        dict(point)
        for point in points
        if (entity_id is None or point.get("entity_id") == entity_id)
        and (allowed_kinds is None or str(point.get("kind")) in allowed_kinds)
    ]
    return {"status": "ok", "count": len(filtered), "points": filtered}


def _get_invoice_detail(contract_payload: Mapping[str, Any], arguments: Mapping[str, Any]) -> dict[str, Any]:
    invoice_id = arguments.get("invoice_id")
    if not isinstance(invoice_id, str) or not invoice_id:
        return {"status": "invalid_request", "reason": "invoice_id is required"}

    invoices = contract_payload.get("invoices")
    if isinstance(invoices, Mapping):
        invoice = invoices.get(invoice_id)
        if isinstance(invoice, Mapping):
            return {"status": "ok", "invoice": dict(invoice)}
    elif isinstance(invoices, Sequence) and not isinstance(invoices, str):
        for invoice in invoices:
            if isinstance(invoice, Mapping) and invoice.get("invoice_id") == invoice_id:
                return {"status": "ok", "invoice": dict(invoice)}

    return {"status": "not_found", "invoice_id": invoice_id}


def _get_rate_card(contract_payload: Mapping[str, Any], arguments: Mapping[str, Any]) -> dict[str, Any]:
    raw_rate_cards = contract_payload.get("rate_cards")
    rate_cards = (
        [rate_card for rate_card in raw_rate_cards if isinstance(rate_card, Mapping)]
        if isinstance(raw_rate_cards, Sequence) and not isinstance(raw_rate_cards, str)
        else []
    )
    match_fields = ("asset_category", "branch", "customer", "job", "rate_type")
    for rate_card in rate_cards:
        if all(arguments.get(field) in (None, rate_card.get(field)) for field in match_fields):
            return {"status": "ok", "rate_card": dict(rate_card)}
    return {"status": "not_found"}


def _build_revrec_tool_executor(
    contract_payload: Mapping[str, Any],
    configured_tools: Sequence[Mapping[str, Any]],
) -> Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]:
    handlers = {
        "query_time_series": _query_time_series,
        "get_invoice_detail": _get_invoice_detail,
        "get_rate_card": _get_rate_card,
    }
    enabled_tools = {name for name in (_extract_tool_name(tool) for tool in configured_tools) if name}

    async def _tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool_name not in enabled_tools:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        handler = handlers.get(tool_name)
        if handler is None:
            return {"status": "unsupported_tool", "tool_name": tool_name}
        return handler(contract_payload, arguments)

    return _tool_executor


def _normalize_tools(configured_tools: Sequence[Any]) -> list[dict[str, Any]]:
    """Normalize configured tool entries into OpenAI tool definitions.

    Supports pre-shaped mapping entries or plain string names (wrapped as
    function tools with permissive object parameters).
    """
    normalized: list[dict[str, Any]] = []
    for tool in configured_tools:
        if isinstance(tool, Mapping):
            normalized.append(dict(tool))
            continue
        if isinstance(tool, str):
            normalized.append(
                {
                    "type": "function",
                    "function": {
                        "name": tool,
                        "description": "Read-only revrec evidence tool",
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": True,
                        },
                    },
                }
            )
    return normalized


class OpsPersistenceClient(Protocol):
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
        filters: Mapping[str, Any],
    ) -> list[dict[str, Any]]: ...


class PostgrestServiceRoleClient:
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
        filters: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        params = {"select": "*"}
        for key, value in filters.items():
            params[key] = f"eq.{value}"
        return self._request(
            "PATCH",
            resource,
            params=params,
            payload=payload,
            prefer="return=representation",
        )


_ops_client: OpsPersistenceClient | None = None
_fact_type_id_cache: dict[str, str] = {}


def _get_ops_persistence_client() -> OpsPersistenceClient:
    global _ops_client
    if _ops_client is None:
        _ops_client = PostgrestServiceRoleClient(
            base_url=settings.supabase_url,
            service_role_key=settings.supabase_service_role_key,
            timeout_seconds=int(os.getenv("SUPABASE_HTTP_TIMEOUT_SECONDS", "10")),
        )
    return _ops_client


def get_ops_persistence_client() -> OpsPersistenceClient:
    return _get_ops_persistence_client()


def _json_object(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _json_array(value: Any) -> list[Any]:
    return list(value) if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray) else []


def interpolate_prompt_template(template: str, variables: Mapping[str, Any]) -> str:
    rendered = str(template or "")
    missing: set[str] = set()

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in variables:
            missing.add(key)
            return match.group(0)
        return str(variables[key])

    rendered = _PROMPT_TEMPLATE_MUSTACHE_PATTERN.sub(_replace, rendered)
    rendered = _PROMPT_TEMPLATE_VARIABLE_PATTERN.sub(_replace, rendered)
    if missing:
        missing_keys = ", ".join(sorted(missing))
        raise PromptTemplateInterpolationError(f"Missing required prompt variables: {missing_keys}")
    return rendered


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _valid_uuid(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def _resolve_fact_type_id(client: OpsPersistenceClient, fact_key: str = "rental_revenue") -> str:
    cached = _fact_type_id_cache.get(fact_key)
    if cached:
        return cached
    rows = client.select("fact_types", columns="id,key", filters={"key": fact_key}, limit=1)
    if not rows and fact_key != "example_fact":
        # Keep audit writes resilient in lower environments where the
        # analytics bootstrap may only contain the seeded placeholder key.
        # This preserves append-only audit behavior while still recording the
        # event payload (consumer views can key off metadata/event_type).
        rows = client.select("fact_types", columns="id,key", filters={"key": "example_fact"}, limit=1)
    if not rows:
        raise ValueError("Unable to resolve fact type for audit events")
    fact_type_id = str(rows[0]["id"])
    _fact_type_id_cache[fact_key] = fact_type_id
    return fact_type_id


def _build_finding_row(
    *,
    finding: Mapping[str, Any],
    tenant_id: str,
    agent_key: str,
    run_id: str,
    status: str = "pending_approval",
    approver: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    contract_id = _valid_uuid(finding.get("contract_id"))
    line_item_id = _valid_uuid(finding.get("line_item_id"))
    return {
        "tenant_id": tenant_id,
        "agent_key": agent_key,
        "run_id": run_id,
        "workflow_id": str(finding.get("workflow_id") or ""),
        "contract_id": contract_id,
        "line_item_id": line_item_id,
        "finding_type": str(finding.get("finding_type") or "unknown"),
        "severity": str(finding.get("severity") or "medium"),
        "status": status,
        "expected": _json_object(finding.get("expected")),
        "billed": _json_object(finding.get("billed")),
        "delta": finding.get("delta"),
        "evidence": {"items": _json_array(finding.get("evidence"))},
        "proposed_action": finding.get("proposed_action"),
        "confidence": finding.get("confidence"),
        "rationale": finding.get("rationale"),
        "fingerprint": str(finding.get("fingerprint") or ""),
        "decided_at": datetime.now(UTC).isoformat() if status in {"approved", "rejected", "informational"} else None,
        "approver": dict(approver) if approver else None,
    }


def _append_audit_event(
    client: OpsPersistenceClient,
    *,
    finding_row: Mapping[str, Any],
    event_type: str,
    run_id: str,
    approver: Mapping[str, Any] | None,
) -> dict[str, Any]:
    entity_id = _valid_uuid(finding_row.get("line_item_id")) or _valid_uuid(finding_row.get("contract_id"))
    if not entity_id:
        raise ValueError("finding must include a valid contract_id or line_item_id for audit event")
    payload = {
        "entity_id": entity_id,
        "fact_type_id": _resolve_fact_type_id(client),
        "observed_at": datetime.now(UTC).isoformat(),
        "data_payload": {
            "event_type": event_type,
            "finding_id": finding_row.get("id"),
            "fingerprint": finding_row.get("fingerprint"),
            "run_id": run_id,
            "agent": finding_row.get("agent_key"),
            "rationale": finding_row.get("rationale"),
            "evidence": finding_row.get("evidence"),
            "approver": dict(approver) if approver else None,
        },
        "metadata": {
            "tenant_id": finding_row.get("tenant_id"),
            "branch_id": finding_row.get("branch_id"),
            "source": "ops_revrec_activity",
        },
    }
    return client.insert("time_series_points", payload)


def _coerce_decimal_number(value: Any) -> float:
    """Best-effort numeric coercion used for adjustment draft amount fields."""
    if isinstance(value, int | float | Decimal):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


def _run_context_bounds(run_context: Mapping[str, Any]) -> tuple[datetime | None, datetime | None]:
    start = _parse_iso_datetime(str(run_context.get("run_window_start") or "")) if run_context.get("run_window_start") else None
    end = _parse_iso_datetime(str(run_context.get("run_window_end") or "")) if run_context.get("run_window_end") else None
    if start and end and start > end:
        raise ValueError("run_window_start must be <= run_window_end")
    return start, end


@activity.defn
async def ops_revrec_analyze(contract_payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    bounds = config.get("bounds") or {}
    max_tool_rounds = int(bounds.get("max_tool_rounds", 5))
    system_prompt = str(config.get("system_prompt") or "You are a revenue recognition analyst.")
    user_prompt_template = str(
        config.get("user_prompt_template")
        or "Contract {contract_id} evidence:\n{evidence_json}"
    )
    tools = _normalize_tools(config.get("tools") or [])
    tool_executor = _build_revrec_tool_executor(contract_payload, tools)

    # Heartbeat every 15 s so Temporal can detect a stalled LLM/HTTP call
    # before the heartbeat_timeout (configured on the execute_activity call)
    # elapses.  The loop is cancelled once the analyst returns.
    async def _heartbeat_loop() -> None:
        while True:
            try:
                activity.heartbeat()
            except temporalio.exceptions.CancelledError:
                # Activity has been cancelled by Temporal; stop heartbeating.
                return
            except Exception:  # noqa: BLE001 — other Temporal context errors (e.g., worker shutdown)
                logger.debug("ops_revrec_analyze heartbeat failed; loop exiting")
                return
            await asyncio.sleep(15)

    heartbeat_task = asyncio.create_task(_heartbeat_loop())
    try:
        return await run_revrec_analyst(
            contract_payload,
            system_prompt=system_prompt,
            user_prompt_template=user_prompt_template,
            tools=tools,
            tool_executor=tool_executor,
            max_tool_rounds=max_tool_rounds,
        )
    finally:
        heartbeat_task.cancel()


@activity.defn
def ops_load_agent_config(tenant_id: str, agent_key: str) -> dict[str, Any]:
    client = _get_ops_persistence_client()
    rows = client.select(
        "ops_agent_config_current",
        filters={"tenant_id": tenant_id, "agent_key": agent_key},
        limit=1,
    )
    if not rows:
        raise AgentConfigNotFoundError(f"No agent_config row found for tenant_id={tenant_id} agent_key={agent_key}")
    row = dict(rows[0])
    if row.get("enabled") is False:
        raise AgentConfigError(f"Agent config disabled for tenant_id={tenant_id} agent_key={agent_key}")
    output_schema_key = str(row.get("output_schema_key") or "").strip()
    if not output_schema_key:
        raise UnknownOutputSchemaKeyError(
            f"Missing output_schema_key for tenant_id={tenant_id} agent_key={agent_key}"
        )
    output_schemas = client.select(
        "ops_output_schema_registry",
        filters={"schema_key": output_schema_key},
        limit=1,
    )
    if not output_schemas:
        raise UnknownOutputSchemaKeyError(f"Unknown output_schema_key={output_schema_key}")
    row["tools"] = _json_array(row.get("tools"))
    # Normalize `model` to an object (never null/scalar) so workflow consumers
    # can always read provider/deployment keys without defensive type checks.
    row["model"] = _json_object(row.get("model"))
    row["bounds"] = _json_object(row.get("bounds"))
    row["thresholds"] = _json_object(row.get("thresholds"))
    row["schedule"] = _json_object(row.get("schedule"))
    row["output_schema_key"] = output_schema_key
    row["output_schema"] = _json_object(output_schemas[0].get("schema_json"))
    # v1 safety invariant: runtime never enables auto-apply for money-moving actions.
    # Stored value remains in DB for future versions but is intentionally overridden here.
    row["auto_apply"] = False
    return row


@activity.defn
def ops_scope_revrec_contracts(tenant_id: str, run_context: dict[str, Any]) -> list[dict[str, Any]]:
    client = _get_ops_persistence_client()
    max_contracts = int(run_context.get("max_contracts", 100))
    max_contracts = max(1, min(max_contracts, 250))
    branch_id = str(run_context.get("branch_id") or "") or None
    start_at, end_at = _run_context_bounds(run_context)

    contracts = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "rental_contract"},
    )
    lines = client.select(
        "rental_current_entity_state",
        columns="entity_id,data",
        filters={"entity_type": "rental_contract_line"},
    )

    eligible_contracts: dict[str, dict[str, Any]] = {}
    contract_lookup: dict[str, dict[str, Any]] = {}
    for contract in contracts:
        data = _json_object(contract.get("data"))
        if str(data.get("tenant_id")) != tenant_id:
            continue
        status = str(data.get("status") or "").lower()
        if status not in {"active", "pending"}:
            continue
        contract_id = str(contract.get("entity_id"))
        contract_lookup[contract_id] = {"contract_id": contract_id, **data}

    for line in lines:
        data = _json_object(line.get("data"))
        if str(data.get("tenant_id")) != tenant_id:
            continue
        if branch_id and str(data.get("branch_id") or "") != branch_id:
            continue
        contract_id = str(data.get("contract_id") or "")
        if contract_id not in contract_lookup:
            continue

        line_status = str(data.get("status") or "").lower()
        actual_end = _parse_iso_datetime(str(data.get("actual_end") or "")) if data.get("actual_end") else None
        returned_in_window = line_status == "returned" and (
            (start_at is None or (actual_end is not None and actual_end >= start_at))
            and (end_at is None or (actual_end is not None and actual_end <= end_at))
        )
        include_line = line_status == "on_rent" or returned_in_window
        if not include_line:
            continue

        scoped = eligible_contracts.setdefault(contract_id, {**contract_lookup[contract_id], "line_items": []})
        scoped["line_items"].append(
            {
                "line_item_id": line.get("entity_id"),
                "status": data.get("status"),
                "asset_id": data.get("asset_id"),
                "rate_type": data.get("rate_type"),
                "rate_amount": data.get("rate_amount"),
                "actual_start": data.get("actual_start"),
                "actual_end": data.get("actual_end"),
            }
        )

    scoped_contracts = list(eligible_contracts.values())
    scoped_contracts.sort(key=lambda row: str(row.get("contract_id")))
    return scoped_contracts[:max_contracts]


@activity.defn
def ops_list_open_finding_fingerprints(tenant_id: str) -> list[str]:
    client = _get_ops_persistence_client()
    rows = client.select(
        "finding",
        columns="fingerprint",
        filters={"tenant_id": tenant_id, "status": "pending_approval"},
    )
    return sorted({str(row.get("fingerprint")) for row in rows if row.get("fingerprint")})


@activity.defn
def ops_create_workflow_run(workflow_key: str, tenant_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
    run_id = f"{workflow_key}:{uuid.uuid4()}"
    client = _get_ops_persistence_client()
    client.insert(
        "ops_workflow_run",
        {
            "run_id": run_id,
            "tenant_id": tenant_id,
            "workflow_key": workflow_key,
            "status": "running",
            "counts": {"metadata": metadata},
        },
    )
    return {"run_id": run_id}


@activity.defn
def ops_finalize_workflow_run(run_id: str, summary: dict[str, Any]) -> bool:
    client = _get_ops_persistence_client()
    rows = client.update(
        "ops_workflow_run",
        {
            "status": str(summary.get("status") or "succeeded"),
            "finished_at": datetime.now(UTC).isoformat(),
            "counts": dict(summary),
        },
        filters={"run_id": run_id},
    )
    return bool(rows)


@activity.defn
def ops_record_finding(finding: dict[str, Any], run_id: str) -> dict[str, Any]:
    client = _get_ops_persistence_client()
    run_rows = client.select("ops_workflow_run", filters={"run_id": run_id}, limit=1)
    if not run_rows:
        raise ValueError(f"ops_workflow_run not found for run_id={run_id}")
    run_row = run_rows[0]
    tenant_id = str(finding.get("tenant_id") or run_row.get("tenant_id") or "")
    if not tenant_id:
        raise ValueError("tenant_id is required to record finding")
    agent_key = str(finding.get("agent_key") or run_row.get("workflow_key") or "")
    finding_row = client.upsert(
        "finding",
        _build_finding_row(
            finding=finding,
            tenant_id=tenant_id,
            agent_key=agent_key,
            run_id=run_id,
            status="pending_approval",
            approver=None,
        ),
        on_conflict="tenant_id,fingerprint",
    )
    event_row = _append_audit_event(
        client,
        finding_row=finding_row,
        event_type="finding_recorded",
        run_id=run_id,
        approver=None,
    )
    return {"finding_id": str(finding_row.get("id")), "event": event_row}


@activity.defn
def ops_record_finding_disposition(
    finding: dict[str, Any],
    disposition: str,
    run_id: str,
    approver: dict[str, Any] | None = None,
) -> bool:
    client = _get_ops_persistence_client()
    run_rows = client.select("ops_workflow_run", filters={"run_id": run_id}, limit=1)
    if not run_rows:
        raise ValueError(f"ops_workflow_run not found for run_id={run_id}")
    run_row = run_rows[0]
    tenant_id = str(finding.get("tenant_id") or run_row.get("tenant_id") or "")
    if not tenant_id:
        raise ValueError("tenant_id is required to record finding disposition")
    mapped_status = {"approved": "approved", "rejected": "rejected"}.get(disposition, "informational")
    finding_row = client.upsert(
        "finding",
        _build_finding_row(
            finding=finding,
            tenant_id=tenant_id,
            agent_key=str(finding.get("agent_key") or run_row.get("workflow_key") or ""),
            run_id=run_id,
            status=mapped_status,
            approver=approver,
        ),
        on_conflict="tenant_id,fingerprint",
    )
    _append_audit_event(
        client,
        finding_row=finding_row,
        event_type=f"finding_disposition_{mapped_status}",
        run_id=run_id,
        approver=approver,
    )
    return True


@activity.defn
def ops_draft_invoice_adjustment(
    finding: dict[str, Any],
    run_id: str,
    approver: dict[str, Any],
) -> dict[str, Any]:
    client = _get_ops_persistence_client()
    run_rows = client.select("ops_workflow_run", filters={"run_id": run_id}, limit=1)
    if not run_rows:
        raise ValueError(f"ops_workflow_run not found for run_id={run_id}")
    run_row = run_rows[0]
    tenant_id = str(finding.get("tenant_id") or run_row.get("tenant_id") or "")
    if not tenant_id:
        raise ValueError("tenant_id is required to draft invoice adjustment")
    finding_row = client.upsert(
        "finding",
        _build_finding_row(
            finding=finding,
            tenant_id=tenant_id,
            agent_key=str(finding.get("agent_key") or run_row.get("workflow_key") or ""),
            run_id=run_id,
            status="approved",
            approver=approver,
        ),
        on_conflict="tenant_id,fingerprint",
    )
    amount = _coerce_decimal_number(finding.get("delta"))
    draft = client.insert(
        "invoice_adjustment_draft",
        {
            "tenant_id": tenant_id,
            "finding_id": finding_row.get("id"),
            "amount": amount,
            "status": "draft",
            "approver": dict(approver),
            "payload": {
                "run_id": run_id,
                "proposed_action": finding.get("proposed_action"),
                "finding": dict(finding),
            },
        },
    )
    _append_audit_event(
        client,
        finding_row=finding_row,
        event_type="invoice_adjustment_drafted",
        run_id=run_id,
        approver=approver,
    )
    return {"adjustment_id": str(draft.get("id")), "status": "draft"}


__all__ = [
    "get_ops_persistence_client",
    "ops_create_workflow_run",
    "ops_draft_invoice_adjustment",
    "ops_finalize_workflow_run",
    "ops_list_open_finding_fingerprints",
    "ops_load_agent_config",
    "interpolate_prompt_template",
    "ops_record_finding",
    "ops_record_finding_disposition",
    "ops_revrec_analyze",
    "ops_scope_revrec_contracts",
    "revrec_finding_v1_schema",
]
