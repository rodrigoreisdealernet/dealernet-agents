from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.activities import ops_fleet, ops_revrec
from temporal.src.agents.fleet_auditor import run_fleet_auditor as _run_fleet_auditor


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


class _FakeOpsPersistenceClient:
    def __init__(self) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "rental_current_entity_state": [],
            "rental_current_relationships": [],
            "fact_types": [],
            "entity_facts": [],
            "time_series_points": [],
            "finding": [],
            "fleet_disposition_handoff_draft": [],
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
        conflict_key = on_conflict.strip()
        rows = self.tables.setdefault(resource, [])
        for index, current in enumerate(rows):
            if current.get(conflict_key) == payload.get(conflict_key):
                merged = {**current, **dict(payload)}
                merged.setdefault("id", current.get("id") or str(uuid4()))
                rows[index] = merged
                return merged
        row = dict(payload)
        row.setdefault("id", str(uuid4()))
        rows.append(row)
        return row


@pytest.mark.asyncio
async def test_ops_fleet_assess_configured_rental_data_tools_can_return_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-a"
    asset_id = str(uuid4())
    branch_id = str(uuid4())
    transport = _FakeTransport(
        [
            _assistant_response(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "query_time_series",
                            "arguments": json.dumps({"fact_key": "rental_order_count", "entity_id": asset_id}),
                        },
                    }
                ]
            ),
            _assistant_response(
                tool_calls=[
                    {
                        "id": "call-2",
                        "type": "function",
                        "function": {
                            "name": "query_entity",
                            "arguments": json.dumps({"entity_type": "branch", "entity_id": branch_id}),
                        },
                    }
                ]
            ),
            _assistant_response(
                content=json.dumps(
                    {
                        "asset_id": asset_id,
                        "disposition": "keep",
                        "target_branch_id": None,
                        "utilization_pct": 11.0,
                        "evidence": ["idle asset"],
                        "estimated_monthly_revenue_uplift": 0.0,
                        "confidence": 0.8,
                        "rationale": "monitor",
                    }
                )
            ),
        ]
    )

    async def _run_with_fake_transport(asset_payload: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        return await _run_fleet_auditor(asset_payload, transport=transport, **kwargs)

    monkeypatch.setattr(ops_fleet, "run_fleet_auditor", _run_with_fake_transport)

    result = await ops_fleet.ops_fleet_assess(
        {
            "tenant_id": tenant_id,
            "asset_id": asset_id,
            "home_branch_id": branch_id,
            "utilization_pct": 11.0,
            "rental_data": {
                "entities": [
                    {
                        "entity_id": asset_id,
                        "entity_type": "asset",
                        "data": {"tenant_id": tenant_id, "branch_id": str(uuid4())},
                    },
                    {
                        "entity_id": branch_id,
                        "entity_type": "branch",
                        "data": {"tenant_id": tenant_id, "branch_id": branch_id},
                    }
                ],
                "relationships": [],
                "facts": [],
                "time_series": [
                    {
                        "point_id": str(uuid4()),
                        "entity_id": asset_id,
                        "fact_key": "rental_order_count",
                        "observed_at": "2026-06-01T00:00:00Z",
                        "data_payload": {"kind": "demand"},
                        "metadata": {},
                        "tenant_id": tenant_id,
                        "branch_id": None,
                    }
                ],
                "invoices": [],
                "rate_cards": [],
                "telematics": [],
            },
        },
        {
            "system_prompt": "Assess fleet utilization.",
            "user_prompt_template": "Asset {asset_id}",
            "tools": ["rental_data"],
            "bounds": {"max_tool_rounds": 2},
        },
    )

    assert result["asset_id"] == asset_id
    tool_messages = [
        message
        for tool_round in transport.calls[1:]
        for message in tool_round
        if message.get("role") == "tool"
    ]
    evidence_by_tool_name: dict[str, Any] = {}
    for message in tool_messages:
        payload = json.loads(str(message["content"]))
        evidence_by_tool_name[str(payload["tool_name"])] = payload["evidence"]
    assert evidence_by_tool_name["query_time_series"]["count"] == 1
    assert evidence_by_tool_name["query_entity"]["count"] == 1


def test_ops_scope_fleet_assets_loads_history_and_demand_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    tenant_id = "tenant-a"
    asset_id = str(uuid4())
    category_id = str(uuid4())
    branch_id = str(uuid4())
    order_id = str(uuid4())
    line_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["fact_types"] = [{"id": "fact-rental-order-count", "key": "rental_order_count"}]
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": asset_id,
            "entity_type": "asset",
            "data": {
                "tenant_id": tenant_id,
                "status": "available",
                "branch_id": branch_id,
                "category_id": category_id,
                "utilization_pct": 12.0,
            },
        },
        {
            "entity_id": order_id,
            "entity_type": "rental_order",
            "data": {"tenant_id": tenant_id, "branch_id": branch_id},
        },
        {
            "entity_id": branch_id,
            "entity_type": "branch",
            "data": {"tenant_id": tenant_id, "branch_id": branch_id},
        },
        {
            "entity_id": line_id,
            "entity_type": "rental_order_line",
            "data": {
                "tenant_id": tenant_id,
                "branch_id": branch_id,
                "category_id": category_id,
                "rental_order_id": order_id,
            },
        },
    ]
    client.tables["time_series_points"] = [
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-rental-order-count",
            "observed_at": "2026-06-01T00:00:00Z",
            "data_payload": {"kind": "asset_history"},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-01T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": branch_id,
            "fact_type_id": "fact-rental-order-count",
            "observed_at": "2026-06-02T00:00:00Z",
            "data_payload": {"kind": "branch_demand"},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-02T00:00:00Z",
        }
    ]
    client.tables["rental_current_relationships"] = [
        {
            "relationship_id": str(uuid4()),
            "relationship_type": "branch_has_asset",
            "parent_id": branch_id,
            "child_id": asset_id,
            "metadata": {},
            "valid_from": "2026-01-01T00:00:00Z",
            "valid_to": None,
        }
    ]

    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_fleet.ops_scope_fleet_assets(tenant_id, {"utilization_threshold": 30})

    assert len(scoped) == 1
    payload = scoped[0]
    assert payload["asset_id"] == asset_id
    assert payload["time_series_points"]
    assert payload["demand_entities"]
    assert payload["rental_data"]["entities"]
    entity_ids = {str(entity.get("entity_id") or "") for entity in payload["rental_data"]["entities"]}
    assert branch_id in entity_ids
    assert payload["rental_data"]["time_series"][0]["fact_key"] == "rental_order_count"
    assert any(
        str(point.get("entity_id") or "") == branch_id and point.get("data_payload", {}).get("kind") == "branch_demand"
        for point in payload["rental_data"]["time_series"]
    )
    assert payload["rental_data"]["relationships"][0]["tenant_id"] == tenant_id
    assert payload["demand_gap_state"] == "ok"
    assert payload["demand_gap_snapshot"]["home_branch_id"] == branch_id
    assert payload["demand_gap_snapshot"]["home_branch_gap"] == 0


def test_ops_scope_fleet_assets_uses_audit_window_for_utilization(monkeypatch: pytest.MonkeyPatch) -> None:
    tenant_id = "tenant-a"
    branch_id = str(uuid4())
    category_id = str(uuid4())
    include_asset_id = str(uuid4())
    exclude_asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["fact_types"] = [{"id": "fact-utilization", "key": "utilization_pct"}]
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": include_asset_id,
            "entity_type": "asset",
            "data": {
                "tenant_id": tenant_id,
                "status": "available",
                "branch_id": branch_id,
                "category_id": category_id,
                "utilization_pct": 95.0,
            },
        },
        {
            "entity_id": exclude_asset_id,
            "entity_type": "asset",
            "data": {
                "tenant_id": tenant_id,
                "status": "available",
                "branch_id": branch_id,
                "category_id": category_id,
                "utilization_pct": 5.0,
            },
        },
    ]
    client.tables["time_series_points"] = [
        {
            "id": str(uuid4()),
            "entity_id": include_asset_id,
            "fact_type_id": "fact-utilization",
            "observed_at": "2026-06-15T00:00:00Z",
            "data_payload": {"utilization_pct": 10.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-15T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": include_asset_id,
            "fact_type_id": "fact-utilization",
            "observed_at": "2026-05-20T00:00:00Z",
            "data_payload": {"utilization_pct": 99.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-05-20T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": exclude_asset_id,
            "fact_type_id": "fact-utilization",
            "observed_at": "2026-06-15T00:00:00Z",
            "data_payload": {"utilization_pct": 85.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-15T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": exclude_asset_id,
            "fact_type_id": "fact-utilization",
            "observed_at": "2026-05-20T00:00:00Z",
            "data_payload": {"utilization_pct": 5.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-05-20T00:00:00Z",
        },
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_fleet.ops_scope_fleet_assets(
        tenant_id,
        {
            "utilization_threshold": 30,
            "thresholds": {"source_stale_threshold_hours": 240},
            "run_window_start": "2026-06-01T00:00:00Z",
            "run_window_end": "2026-06-30T23:59:59Z",
        },
    )

    assert [payload["asset_id"] for payload in scoped] == [include_asset_id]
    assert scoped[0]["utilization_pct"] == pytest.approx(10.0)
    assert all(point["observed_at"].startswith("2026-06") for point in scoped[0]["time_series_points"])


def test_ops_scope_fleet_assets_tracks_benchmark_and_telematics_traceability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = "tenant-a"
    branch_id = str(uuid4())
    category_id = str(uuid4())
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["fact_types"] = [
        {"id": "fact-utilization", "key": "utilization_pct"},
        {"id": "fact-benchmark", "key": "benchmark_utilization_pct"},
        {"id": "fact-telematics", "key": "telematics_ping"},
        {"id": "fact-revenue", "key": "rental_revenue"},
        {"id": "fact-maintenance", "key": "maintenance_cost"},
        {"id": "fact-downtime", "key": "downtime_hours"},
        {"id": "fact-resale", "key": "resale_value"},
        {"id": "fact-replacement", "key": "replacement_cost"},
    ]
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": asset_id,
            "entity_type": "asset",
            "data": {
                "tenant_id": tenant_id,
                "status": "available",
                "branch_id": branch_id,
                "category_id": category_id,
                "utilization_pct": 25.0,
                "age_years": 6.0,
                "service_hours": 4200.0,
            },
        },
    ]
    client.tables["time_series_points"] = [
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-utilization",
            "observed_at": "2026-06-15T00:00:00Z",
            "data_payload": {"utilization_pct": 22.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-15T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-benchmark",
            "observed_at": "2026-06-15T00:00:00Z",
            "data_payload": {"benchmark_utilization_pct": 64.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-15T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-telematics",
            "observed_at": "2026-06-01T00:00:00Z",
            "data_payload": {"lat": 10.0, "lng": 20.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-01T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-revenue",
            "observed_at": "2026-06-10T00:00:00Z",
            "data_payload": {"revenue_amount": 2400.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-10T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-maintenance",
            "observed_at": "2026-06-12T00:00:00Z",
            "data_payload": {"amount": 900.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-12T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-downtime",
            "observed_at": "2026-06-14T00:00:00Z",
            "data_payload": {"downtime_hours": 18.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-14T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-resale",
            "observed_at": "2026-06-13T00:00:00Z",
            "data_payload": {"resale_value": 15000.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-13T00:00:00Z",
        },
        {
            "id": str(uuid4()),
            "entity_id": asset_id,
            "fact_type_id": "fact-replacement",
            "observed_at": "2026-06-13T00:00:00Z",
            "data_payload": {"replacement_cost": 42000.0},
            "metadata": {"tenant_id": tenant_id},
            "created_at": "2026-06-13T00:00:00Z",
        },
    ]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_fleet.ops_scope_fleet_assets(
        tenant_id,
        {
            "utilization_threshold": 30,
            "thresholds": {"source_stale_threshold_hours": 240},
            "run_window_start": "2026-06-01T00:00:00Z",
            "run_window_end": "2026-06-30T23:59:59Z",
        },
    )

    assert len(scoped) == 1
    payload = scoped[0]
    assert payload["benchmark_utilization_pct"] == pytest.approx(64.0)
    assert payload["benchmark_gap_pct"] == pytest.approx(-42.0)
    assert payload["benchmark_evidence"]
    assert payload["kpi_evidence"]
    assert payload["telematics_evidence"]
    assert payload["rental_data"]["telematics"]
    assert "Telematics signal is stale or missing." in payload["stale_signals"]
    assert payload["lifecycle_snapshot"]["revenue_history"]["average_value"] == pytest.approx(2400.0)
    assert payload["lifecycle_snapshot"]["maintenance_and_downtime"]["average_maintenance_cost"] == pytest.approx(900.0)
    assert payload["lifecycle_snapshot"]["maintenance_and_downtime"]["average_downtime_hours"] == pytest.approx(18.0)
    assert payload["lifecycle_snapshot"]["age_and_hours"]["age_years"] == pytest.approx(6.0)
    assert payload["lifecycle_snapshot"]["age_and_hours"]["service_hours"] == pytest.approx(4200.0)
    assert payload["lifecycle_snapshot"]["market_context"]["resale_replacement_ratio"] == pytest.approx(15000.0 / 42000.0)
    assert payload["source_gap_state"] == "degraded"
    assert "stale_revenue" in payload["source_gaps"]
    assert payload["demand_gap_state"] == "manual_evidence_required"
    assert "missing_branch_category_demand" in payload["source_gaps"]


def test_ops_requires_transfer_approval_accepts_canonical_dispositions() -> None:
    assert ops_fleet.ops_requires_transfer_approval({"disposition": "keep"}, {}) is True
    assert ops_fleet.ops_requires_transfer_approval({"disposition": "sell"}, {}) is True
    assert ops_fleet.ops_requires_transfer_approval({"disposition": "replace"}, {}) is True


def test_ops_draft_disposition_handoff_persists_draft_with_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeOpsPersistenceClient()
    tenant_id = str(uuid4())
    finding_id = str(uuid4())
    fingerprint = "fleet:branch-a:cat-1:cross_branch_utilization_outlier:buy"
    client.tables["finding"] = [{"id": finding_id, "tenant_id": tenant_id, "fingerprint": fingerprint}]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    result = ops_fleet.ops_draft_disposition_handoff(
        {
            "tenant_id": tenant_id,
            "asset_id": str(uuid4()),
            "fingerprint": fingerprint,
            "disposition": "replace",
            "proposed_action": "buy",
            "recommendation_path": "buy",
            "rationale": "asset replacement approved",
            "evidence": ["utilization below threshold", "high maintenance spend"],
        },
        {"approver_id": "exec-1", "approver_name": "Exec", "note": "approved with rationale"},
    )

    assert result["status"] == "draft"
    assert result["handoff_path"] == "procurement"
    assert result["disposition"] == "replace"
    drafts = client.tables["fleet_disposition_handoff_draft"]
    assert len(drafts) == 1
    assert drafts[0]["finding_id"] == finding_id
    assert drafts[0]["payload"]["rationale"] == "asset replacement approved"
    assert drafts[0]["payload"]["evidence"] == ["utilization below threshold", "high maintenance spend"]


def test_ops_draft_disposition_handoff_is_idempotent_for_same_finding(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeOpsPersistenceClient()
    tenant_id = str(uuid4())
    finding_id = str(uuid4())
    fingerprint = "fleet:branch-a:cat-1:cross_branch_utilization_outlier:replace"
    client.tables["finding"] = [{"id": finding_id, "tenant_id": tenant_id, "fingerprint": fingerprint}]
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    first = ops_fleet.ops_draft_disposition_handoff(
        {
            "tenant_id": tenant_id,
            "asset_id": str(uuid4()),
            "fingerprint": fingerprint,
            "disposition": "replace",
            "rationale": "first decision",
            "evidence": ["first"],
        },
        {"approver_id": "exec-1", "approver_name": "Exec", "note": "first note"},
    )
    second = ops_fleet.ops_draft_disposition_handoff(
        {
            "tenant_id": tenant_id,
            "asset_id": str(uuid4()),
            "fingerprint": fingerprint,
            "disposition": "replace",
            "rationale": "second decision",
            "evidence": ["second"],
        },
        {"approver_id": "exec-2", "approver_name": "Exec Two", "note": "second note"},
    )

    drafts = client.tables["fleet_disposition_handoff_draft"]
    assert len(drafts) == 1
    assert first["handoff_id"] == second["handoff_id"] == drafts[0]["id"]
    assert drafts[0]["finding_id"] == finding_id
    assert drafts[0]["payload"]["rationale"] == "second decision"
    assert drafts[0]["payload"]["evidence"] == ["second"]
    assert drafts[0]["approver"]["approver_id"] == "exec-2"


def test_ops_scope_fleet_assets_supports_non_utilization_threshold_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    tenant_id = "tenant-a"
    branch_id = str(uuid4())
    category_id = str(uuid4())
    asset_id = str(uuid4())
    client = _FakeOpsPersistenceClient()
    client.tables["fact_types"] = []
    client.tables["rental_current_entity_state"] = [
        {
            "entity_id": asset_id,
            "entity_type": "asset",
            "data": {
                "tenant_id": tenant_id,
                "status": "available",
                "branch_id": branch_id,
                "category_id": category_id,
                "utilization_pct": 92.0,
                "age_years": 13.0,
                "service_hours": 14000.0,
            },
        },
    ]
    client.tables["time_series_points"] = []
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_fleet.ops_scope_fleet_assets(
        tenant_id,
        {
            "thresholds": {
                "utilization_pct_threshold": 30,
                "asset_age_years_threshold": 10,
                "service_hours_threshold": 12000,
            },
            "run_window_start": "2026-06-01T00:00:00Z",
            "run_window_end": "2026-06-30T23:59:59Z",
        },
    )

    assert len(scoped) == 1
    assert set(scoped[0]["threshold_flags"]) == {"asset_age_years_threshold", "service_hours_threshold"}
    assert scoped[0]["source_gap_state"] == "blocked"
    assert scoped[0]["demand_gap_state"] == "manual_evidence_required"
    assert "missing_branch_category_demand" in scoped[0]["source_gaps"]


def test_fleet_finding_for_storage_includes_demand_gap_snapshot() -> None:
    stored = ops_fleet._fleet_finding_for_storage(  # noqa: SLF001
        {
            "asset_id": "asset-1",
            "source_gap_state": "blocked",
            "demand_gap_state": "manual_evidence_required",
            "demand_gap_snapshot": {
                "category_id": "cat-1",
                "home_branch_id": "branch-a",
                "manual_evidence": ["No branch/category demand evidence was found in the audit window."],
            },
        }
    )

    assert stored["expected"]["demand_gap_state"] == "manual_evidence_required"
    assert stored["expected"]["demand_gap_snapshot"]["manual_evidence"] == [
        "No branch/category demand evidence was found in the audit window."
    ]
