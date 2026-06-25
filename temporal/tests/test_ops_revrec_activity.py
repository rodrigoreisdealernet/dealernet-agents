from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import ops_revrec
from temporal.src.agents.revrec_analyst import run_revrec_analyst as _run_revrec_analyst


class _FakeTransport:
    def __init__(self, responses: list[Mapping[str, Any]]) -> None:
        self._responses = list(responses)
        self.calls: list[list[dict[str, Any]]] = []

    async def complete(
        self,
        *,
        messages: list[Mapping[str, Any]],
        tools: list[Mapping[str, Any]],
        response_schema: dict[str, Any],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> Mapping[str, Any]:
        del tools, response_schema, temperature, max_output_tokens
        self.calls.append([dict(message) for message in messages])
        return self._responses.pop(0)


def _assistant_response(*, content: str | None = None, tool_calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return {"choices": [{"message": message}]}


@pytest.mark.asyncio
async def test_ops_revrec_analyze_executes_configured_query_time_series_tool_round(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = _FakeTransport(
        [
            _assistant_response(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "query_time_series",
                            "arguments": json.dumps({"entity_id": "asset-1", "kinds": ["checkout"]}),
                        },
                    }
                ]
            ),
            _assistant_response(content=json.dumps({"contract_id": "c1", "findings": []})),
        ]
    )

    async def _run_with_fake_transport(contract_payload: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        return await _run_revrec_analyst(contract_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_revrec, "run_revrec_analyst", _run_with_fake_transport)

    result = await ops_revrec.ops_revrec_analyze(
        {
            "contract_id": "c1",
            "time_series_points": [
                {"entity_id": "asset-1", "kind": "checkout", "at": "2026-06-01T00:00:00Z"},
                {"entity_id": "asset-1", "kind": "return", "at": "2026-06-02T00:00:00Z"},
            ],
        },
        {
            "system_prompt": "Analyze revrec findings.",
            "user_prompt_template": "Contract {contract_id} evidence:\n{evidence_json}",
            "tools": ["query_time_series"],
            "bounds": {"max_tool_rounds": 2},
        },
    )

    assert result == {"contract_id": "c1", "findings": []}
    tool_messages = [message for message in transport.calls[1] if message.get("role") == "tool"]
    assert len(tool_messages) == 1
    tool_evidence = json.loads(str(tool_messages[0]["content"]))
    assert tool_evidence["tool_name"] == "query_time_series"
    assert tool_evidence["evidence"]["status"] == "ok"
    assert tool_evidence["evidence"]["count"] == 1


class _FakeOpsPersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "ops_agent_config_current": [],
            "ops_output_schema_registry": [],
            "ops_workflow_run": [],
            "finding": [],
            "fact_types": [{"id": "fact-rental-revenue", "key": "rental_revenue"}],
            "time_series_points": [],
            "invoice_adjustment_draft": [],
            "rental_current_entity_state": [],
        }

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
        del columns, order_by, descending
        rows = [dict(row) for row in self.tables.get(resource, [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        if limit is not None:
            rows = rows[:limit]
        return rows

    def insert(self, resource: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        self.tables.setdefault(resource, []).append(row)
        return row

    def upsert(self, resource: str, payload: Mapping[str, Any], *, on_conflict: str) -> dict[str, Any]:
        conflict_keys = [part.strip() for part in on_conflict.split(",")]
        row = dict(payload)
        table = self.tables.setdefault(resource, [])
        for idx, existing in enumerate(table):
            if all(existing.get(key) == row.get(key) for key in conflict_keys):
                merged = {**existing, **row}
                merged["id"] = existing.get("id")
                table[idx] = merged
                return merged
        row.setdefault("id", str(uuid4()))
        table.append(row)
        return row

    def update(
        self,
        resource: str,
        payload: Mapping[str, Any],
        *,
        filters: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        updated: list[dict[str, Any]] = []
        table = self.tables.setdefault(resource, [])
        for idx, row in enumerate(table):
            if all(row.get(key) == value for key, value in filters.items()):
                merged = {**row, **dict(payload)}
                table[idx] = merged
                updated.append(merged)
        return updated


@pytest.fixture()
def fake_ops_client(monkeypatch: pytest.MonkeyPatch) -> _FakeOpsPersistenceClient:
    client = _FakeOpsPersistenceClient()
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    monkeypatch.setattr(ops_revrec, "_fact_type_id_cache", {})
    return client


def test_ops_load_agent_config_reads_current_row_and_errors_if_missing(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    fake_ops_client.tables["ops_output_schema_registry"].append(
        {"schema_key": "revrec_finding_v1", "schema_json": {"type": "object"}}
    )
    fake_ops_client.tables["ops_agent_config_current"].append(
        {
            "tenant_id": "tenant-a",
            "agent_key": "revrec-analyst",
            "enabled": True,
            "tools": ["query_time_series"],
            "output_schema_key": "revrec_finding_v1",
            "bounds": {"max_findings_per_run": 10},
            "thresholds": {"min_confidence_to_surface": 0.8},
            "auto_apply": True,
        }
    )
    cfg = ops_revrec.ops_load_agent_config("tenant-a", "revrec-analyst")
    assert cfg["tools"] == ["query_time_series"]
    assert cfg["bounds"]["max_findings_per_run"] == 10
    assert cfg["auto_apply"] is False

    with pytest.raises(ops_revrec.AgentConfigNotFoundError):
        ops_revrec.ops_load_agent_config("tenant-b", "revrec-analyst")


def test_ops_load_agent_config_errors_if_output_schema_key_unknown(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    fake_ops_client.tables["ops_agent_config_current"].append(
        {
            "tenant_id": "tenant-a",
            "agent_key": "revrec-analyst",
            "enabled": True,
            "tools": ["query_time_series"],
            "output_schema_key": "unknown_key",
            "bounds": {"max_findings_per_run": 10},
            "thresholds": {"min_confidence_to_surface": 0.8},
            "auto_apply": False,
        }
    )
    with pytest.raises(ops_revrec.UnknownOutputSchemaKeyError):
        ops_revrec.ops_load_agent_config("tenant-a", "revrec-analyst")


def test_interpolate_prompt_template_requires_all_variables() -> None:
    rendered = ops_revrec.interpolate_prompt_template(
        "Tenant {{ tenant_name }} contract {contract_id}",
        {"tenant_name": "Tenant A", "contract_id": "C-1"},
    )
    assert rendered == "Tenant Tenant A contract C-1"

    with pytest.raises(ops_revrec.PromptTemplateInterpolationError):
        ops_revrec.interpolate_prompt_template("Missing {contract_id} and {{ cycle }}", {"contract_id": "C-1"})


def test_ops_scope_revrec_contracts_filters_scope_window_and_bounds(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    contract_id = str(uuid4())
    line_on_rent = str(uuid4())
    line_returned = str(uuid4())
    fake_ops_client.tables["rental_current_entity_state"] = [
        {
            "entity_id": contract_id,
            "entity_type": "rental_contract",
            "data": {"tenant_id": "tenant-a", "status": "active", "contract_number": "C-1"},
        },
        {
            "entity_id": str(uuid4()),
            "entity_type": "rental_contract",
            "data": {"tenant_id": "tenant-b", "status": "active", "contract_number": "C-2"},
        },
        {
            "entity_id": line_on_rent,
            "entity_type": "rental_contract_line",
            "data": {
                "tenant_id": "tenant-a",
                "branch_id": "branch-a",
                "contract_id": contract_id,
                "status": "on_rent",
                "asset_id": str(uuid4()),
            },
        },
        {
            "entity_id": line_returned,
            "entity_type": "rental_contract_line",
            "data": {
                "tenant_id": "tenant-a",
                "branch_id": "branch-a",
                "contract_id": contract_id,
                "status": "returned",
                "actual_end": "2026-06-01T06:00:00Z",
            },
        },
    ]
    scoped = ops_revrec.ops_scope_revrec_contracts(
        "tenant-a",
        {
            "branch_id": "branch-a",
            "run_window_start": "2026-06-01T00:00:00Z",
            "run_window_end": "2026-06-02T00:00:00Z",
            "max_contracts": 1,
        },
    )
    assert len(scoped) == 1
    assert scoped[0]["contract_id"] == contract_id
    assert {item["line_item_id"] for item in scoped[0]["line_items"]} == {line_on_rent, line_returned}


def test_ops_list_open_finding_fingerprints_returns_distinct_pending(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    fake_ops_client.tables["finding"] = [
        {"tenant_id": "tenant-a", "status": "pending_approval", "fingerprint": "f-1"},
        {"tenant_id": "tenant-a", "status": "pending_approval", "fingerprint": "f-1"},
        {"tenant_id": "tenant-a", "status": "approved", "fingerprint": "f-2"},
        {"tenant_id": "tenant-b", "status": "pending_approval", "fingerprint": "f-3"},
    ]
    assert ops_revrec.ops_list_open_finding_fingerprints("tenant-a") == ["f-1"]


def test_ops_workflow_run_create_and_finalize_persist_rows(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    run = ops_revrec.ops_create_workflow_run("revenue_recognition", "tenant-a", {"window": "today"})
    assert run["run_id"]
    assert len(fake_ops_client.tables["ops_workflow_run"]) == 1
    persisted = fake_ops_client.tables["ops_workflow_run"][0]
    assert persisted["status"] == "running"

    assert ops_revrec.ops_finalize_workflow_run(run["run_id"], {"status": "succeeded", "recorded_findings": 2}) is True
    assert fake_ops_client.tables["ops_workflow_run"][0]["status"] == "succeeded"


def test_ops_record_finding_upserts_and_appends_audit_event(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    run_id = "run-1"
    contract_id = str(uuid4())
    line_item_id = str(uuid4())
    fake_ops_client.tables["ops_workflow_run"] = [
        {"run_id": run_id, "tenant_id": "tenant-a", "workflow_key": "revenue_recognition"}
    ]
    finding = {
        "contract_id": contract_id,
        "line_item_id": line_item_id,
        "finding_type": "unbilled_on_rent",
        "severity": "high",
        "fingerprint": "fp-1",
        "rationale": "missing bill",
        "evidence": ["line missing invoice"],
    }
    first = ops_revrec.ops_record_finding(finding, run_id)
    second = ops_revrec.ops_record_finding(finding, run_id)
    assert first["finding_id"] == second["finding_id"]
    assert len(fake_ops_client.tables["finding"]) == 1
    assert len(fake_ops_client.tables["time_series_points"]) == 2
    assert fake_ops_client.tables["time_series_points"][0]["data_payload"]["event_type"] == "finding_recorded"


def test_ops_record_finding_disposition_upserts_status_and_audits(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    run_id = "run-2"
    fake_ops_client.tables["ops_workflow_run"] = [
        {"run_id": run_id, "tenant_id": "tenant-a", "workflow_key": "revenue_recognition"}
    ]
    finding = {
        "contract_id": str(uuid4()),
        "line_item_id": str(uuid4()),
        "finding_type": "rate_tier_mismatch",
        "severity": "medium",
        "fingerprint": "fp-2",
    }
    assert ops_revrec.ops_record_finding_disposition(
        finding,
        "approved",
        run_id,
        {"approver_id": "manager-1", "note": "ok"},
    )
    assert fake_ops_client.tables["finding"][0]["status"] == "approved"
    assert fake_ops_client.tables["time_series_points"][0]["data_payload"]["event_type"] == "finding_disposition_approved"


def test_ops_draft_invoice_adjustment_inserts_draft_and_audit(fake_ops_client: _FakeOpsPersistenceClient) -> None:
    run_id = "run-3"
    fake_ops_client.tables["ops_workflow_run"] = [
        {"run_id": run_id, "tenant_id": "tenant-a", "workflow_key": "revenue_recognition"}
    ]
    finding = {
        "contract_id": str(uuid4()),
        "line_item_id": str(uuid4()),
        "finding_type": "billing_past_return",
        "severity": "high",
        "fingerprint": "fp-3",
        "delta": "145.50",
        "proposed_action": "create_invoice_adjustment",
    }
    result = ops_revrec.ops_draft_invoice_adjustment(
        finding,
        run_id,
        {"approver_id": "manager-2", "note": "approved"},
    )
    assert result["status"] == "draft"
    assert len(fake_ops_client.tables["invoice_adjustment_draft"]) == 1
    assert fake_ops_client.tables["invoice_adjustment_draft"][0]["amount"] == 145.5
    assert fake_ops_client.tables["time_series_points"][0]["data_payload"]["event_type"] == "invoice_adjustment_drafted"


def test_ops_draft_invoice_adjustment_invalid_delta_defaults_to_zero(
    fake_ops_client: _FakeOpsPersistenceClient,
) -> None:
    run_id = "run-4"
    fake_ops_client.tables["ops_workflow_run"] = [
        {"run_id": run_id, "tenant_id": "tenant-a", "workflow_key": "revenue_recognition"}
    ]
    finding = {
        "contract_id": str(uuid4()),
        "line_item_id": str(uuid4()),
        "finding_type": "billing_past_return",
        "severity": "high",
        "fingerprint": "fp-4",
        "delta": "not-a-number",
    }
    ops_revrec.ops_draft_invoice_adjustment(finding, run_id, {"approver_id": "manager-3"})
    assert fake_ops_client.tables["invoice_adjustment_draft"][0]["amount"] == 0.0
