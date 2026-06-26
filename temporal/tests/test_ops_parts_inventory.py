"""Tests for the Parts Inventory Advisor (issue #80).

Mirrors ``test_ops_vehicle_aging.py``: a fake Azure transport validates the
closed no-tools analyst, a fake persistence client stands in for Supabase views,
and the workflow is driven by patching ``temporalio.workflow.execute_activity``.

Every test traces back to AC-001..AC-016 in
``docs/prd/2026-06-25-agente-pecas-reposicao-estoque.md``.
"""

from __future__ import annotations

import ast
import datetime as dt
import hashlib
import inspect
import json
import logging
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from pydantic import ValidationError
from temporal.src.activities import ops_parts_inventory, ops_revrec
from temporal.src.activities.ops_parts_inventory import (
    _parts_finding_for_storage,
    _parts_fingerprint,
    _windowed_velocity,
    ops_parts_inventory_assess,
    ops_scope_parts_dead_stock,
    ops_scope_parts_replenish,
)
from temporal.src.agents.openai_client import StructuredOutputRetriesExceededError
from temporal.src.agents.parts_inventory_advisor import (
    PartsInventoryFindingV1,
    parts_inventory_finding_v1_schema,
    run_parts_inventory_advisor,
)
from temporal.src.workflows.ops.parts_inventory import PartsInventoryWorkflow, PartsInventoryWorkflowInput

_TENANT = "tenant-a"
_WORKFLOW_KEY = "parts-inventory-advisor"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NEW_SOURCE_FILES = (
    "temporal/src/agents/parts_inventory_advisor.py",
    "temporal/src/activities/ops_parts_inventory.py",
    "temporal/src/workflows/ops/parts_inventory.py",
)


# ===========================================================================
# Deterministic helpers + schema contract
# AC-003, AC-005, AC-008
# ===========================================================================


def test_parts_fingerprint_is_exact_sha256_per_part_and_type() -> None:
    expected = hashlib.sha256(f"{_TENANT}:part-1:dead_stock".encode()).hexdigest()
    assert _parts_fingerprint(_TENANT, "part-1", "dead_stock") == expected
    assert _parts_fingerprint(_TENANT, "part-1", "dead_stock") == _parts_fingerprint(
        _TENANT, "part-1", "dead_stock"
    )
    assert _parts_fingerprint(_TENANT, "part-1", "dead_stock") != _parts_fingerprint(
        _TENANT, "part-1", "replenish_now"
    )
    assert _parts_fingerprint(_TENANT, "part-1", "dead_stock") != _parts_fingerprint(
        "tenant-b", "part-1", "dead_stock"
    )


def test_parts_finding_for_storage_maps_canonical_finding_row() -> None:
    finding = {
        "part_id": "part-uuid-123",
        "tenant_id": _TENANT,
        "finding_type": "dead_stock",
        "severity": "high",
        "part_number": "PN-123",
        "manufacturer": "Bosch",
        "stock_status": "ok",
        "quantity_in_stock": 6.0,
        "reorder_point": 2.0,
        "stock_value": 1500.0,
        "velocity": 0.0,
        "quantity_suggested": 0,
        "value_at_risk": 1500.0,
        "recommended_action": "liquidate",
        "evidence": ["no sales in 90 days"],
        "confidence": 0.8,
        "rationale": "held value with no movement",
        "fingerprint": _parts_fingerprint(_TENANT, "part-uuid-123", "dead_stock"),
    }
    row = _parts_finding_for_storage(finding)

    assert row["contract_id"] == "part-uuid-123"
    assert row["line_item_id"] is None
    assert row["delta"] == 1500.0
    assert row["proposed_action"] == "liquidate"
    assert row["finding_type"] == "dead_stock"
    assert row["severity"] == "high"
    assert row["billed"] == {}
    assert row["tenant_id"] == _TENANT
    assert row["fingerprint"] == finding["fingerprint"]
    assert row["expected"] == {
        "part_number": "PN-123",
        "manufacturer": "Bosch",
        "stock_status": "ok",
        "quantity_in_stock": 6.0,
        "reorder_point": 2.0,
        "stock_value": 1500.0,
        "velocity": 0.0,
        "quantity_suggested": 0,
        "recommended_action": "liquidate",
    }


def test_parts_finding_for_storage_defaults_type_and_severity() -> None:
    row = _parts_finding_for_storage({"part_id": "part-9", "value_at_risk": 10.0})
    assert row["contract_id"] == "part-9"
    assert row["line_item_id"] is None
    assert row["finding_type"] == "replenish_now"
    assert row["severity"] == "medium"
    assert row["delta"] == 10.0


def test_parts_inventory_finding_v1_rejects_extra_fields_and_fills_defaults() -> None:
    valid = PartsInventoryFindingV1(part_id="part-1", recommended_action="order_now", rationale="below reorder")
    assert valid.finding_type == "replenish_now"
    assert valid.severity == "medium"
    assert valid.quantity_suggested == 0
    assert valid.value_at_risk == 0.0
    assert valid.evidence == []
    assert valid.confidence == 0.0

    with pytest.raises(ValidationError):
        PartsInventoryFindingV1(
            part_id="part-1",
            recommended_action="order_now",
            rationale="below reorder",
            surprise="not allowed",
        )


def test_parts_inventory_schema_matches_db_registry_contract() -> None:
    schema = parts_inventory_finding_v1_schema()
    assert schema["title"] == "PartsInventoryFindingV1"
    assert schema["additionalProperties"] is False
    assert sorted(schema["required"]) == ["part_id", "rationale", "recommended_action"]

    migration = (_REPO_ROOT / "supabase/migrations/20260627130002_parts_inventory_agent.sql").read_text()
    match = re.search(r"'(\{.*?\})'::jsonb", migration, re.S)
    assert match, "expected an embedded jsonb schema literal in the migration"
    registry = json.loads(match.group(1))
    assert registry["title"] == schema["title"]
    assert registry["additionalProperties"] is False
    assert sorted(registry["required"]) == sorted(schema["required"])
    assert set(registry["properties"]) == set(schema["properties"])


# ===========================================================================
# Agent surface — closed no-tools output
# AC-001, AC-002
# ===========================================================================


class _FakeTransport:
    """Mirror of the revrec fake transport that records the tools list."""

    def __init__(self, responses: list[Mapping[str, Any]]) -> None:
        self._responses = list(responses)
        self.calls: list[list[dict[str, Any]]] = []
        self.tools_seen: list[list[Any]] = []

    async def complete(
        self,
        *,
        messages: list[Mapping[str, Any]],
        tools: list[Mapping[str, Any]],
        response_schema: dict[str, Any],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> Mapping[str, Any]:
        del response_schema, temperature, max_output_tokens
        self.calls.append([dict(message) for message in messages])
        self.tools_seen.append(list(tools))
        return self._responses.pop(0)


def _assistant_json(content: Mapping[str, Any]) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": json.dumps(content)}}]}


@pytest.mark.asyncio
async def test_run_parts_inventory_advisor_sends_no_tools_and_returns_validated_finding() -> None:
    transport = _FakeTransport(
        [
            _assistant_json(
                {
                    "part_id": "part-1",
                    "recommended_action": "order_now",
                    "rationale": "below reorder point with recent demand",
                }
            )
        ]
    )

    result = await run_parts_inventory_advisor(
        {"part_id": "part-1", "tenant_id": _TENANT},
        system_prompt="You are a parts inventory advisor.",
        user_prompt_template="Assess part-1.",
        transport=transport,
    )

    assert transport.tools_seen == [[]]
    assert len(transport.calls) == 1
    assert result == {
        "part_id": "part-1",
        "finding_type": "replenish_now",
        "severity": "medium",
        "recommended_action": "order_now",
        "quantity_suggested": 0,
        "value_at_risk": 0.0,
        "evidence": [],
        "confidence": 0.0,
        "rationale": "below reorder point with recent demand",
    }


@pytest.mark.asyncio
async def test_run_parts_inventory_advisor_rejects_extra_field_from_model() -> None:
    bad = {
        "part_id": "part-1",
        "recommended_action": "order_now",
        "rationale": "below reorder",
        "ai_hallucinated_field": 1,
    }
    transport = _FakeTransport([_assistant_json(bad), _assistant_json(bad)])
    with pytest.raises(StructuredOutputRetriesExceededError):
        await run_parts_inventory_advisor(
            {"part_id": "part-1"},
            system_prompt="s",
            user_prompt_template="u",
            transport=transport,
        )


# ===========================================================================
# Scope activities against faked parts views
# AC-004, AC-005, AC-006
# ===========================================================================


class _FakeSelectClient:
    """Minimal persistence stub: equality-filtered ``select`` over in-memory rows."""

    def __init__(self, rows_by_table: dict[str, list[dict[str, Any]]]) -> None:
        self.tables = rows_by_table

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


def _part_row(
    part_id: str,
    *,
    status: str,
    qty: float,
    reorder: float,
    unit_cost: float,
    stock_value: float,
    rank: int | None = None,
) -> dict[str, Any]:
    row = {
        "entity_id": part_id,
        "part_number": f"PN-{part_id}",
        "manufacturer": "Bosch",
        "unit_cost": unit_cost,
        "quantity_in_stock": qty,
        "min_stock": max(0.0, reorder - 1),
        "reorder_point": reorder,
        "stock_value": stock_value,
        "stock_status": status,
    }
    if rank is not None:
        row["criticality_rank"] = rank
    return row


def _sale(part_id: str, quantity: float, days_ago: int | None) -> dict[str, Any]:
    sale_date = "not-a-date" if days_ago is None else (dt.date.today() - dt.timedelta(days=days_ago)).isoformat()
    return {"part_id": part_id, "quantity": quantity, "sale_date": sale_date}


@pytest.fixture()
def fake_parts_views(monkeypatch: pytest.MonkeyPatch) -> _FakeSelectClient:
    rows_by_table = {
        "v_dia_parts_critical": [
            _part_row("part-zero", status="zerado", qty=0, reorder=4, unit_cost=25.0, stock_value=0.0, rank=0),
            _part_row("part-critical", status="critico", qty=1, reorder=5, unit_cost=10.0, stock_value=10.0, rank=1),
            _part_row("part-low", status="baixo", qty=2, reorder=10, unit_cost=100.0, stock_value=200.0, rank=2),
        ],
        "v_dia_part_current": [
            _part_row("part-dead", status="ok", qty=6, reorder=2, unit_cost=250.0, stock_value=1500.0),
            _part_row("part-active", status="ok", qty=5, reorder=2, unit_cost=100.0, stock_value=500.0),
            _part_row("part-empty", status="ok", qty=0, reorder=2, unit_cost=100.0, stock_value=0.0),
        ],
        "v_dia_part_sale_current": [
            _sale("part-zero", 1, 10),
            _sale("part-critical", 20, 10),
            _sale("part-low", 5, 10),
            _sale("part-active", 3, 10),
            _sale("part-dead", 8, 200),
            _sale("part-dead", 99, None),
        ],
    }
    client = _FakeSelectClient(rows_by_table)
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    return client


def test_scope_replenish_severity_quantity_priority_and_fingerprint(fake_parts_views: _FakeSelectClient) -> None:
    del fake_parts_views
    scoped = ops_scope_parts_replenish(_TENANT, {"thresholds": {"velocity_window_days": 90}})

    ids = [item["part_id"] for item in scoped]
    assert ids == ["part-zero", "part-critical", "part-low"]
    assert [item["priority"] for item in scoped] == sorted(
        [item["priority"] for item in scoped], reverse=True
    )

    by_id = {item["part_id"]: item for item in scoped}
    assert by_id["part-zero"]["severity"] == "critical"
    assert by_id["part-critical"]["severity"] == "high"
    assert by_id["part-low"]["severity"] == "medium"
    assert by_id["part-zero"]["quantity_suggested"] == 4
    assert by_id["part-critical"]["quantity_suggested"] == 4
    assert by_id["part-low"]["quantity_suggested"] == 8
    assert by_id["part-low"]["value_at_risk"] == 800.0
    assert by_id["part-zero"]["velocity"] == 1
    assert by_id["part-critical"]["velocity"] == 20
    assert by_id["part-low"]["velocity"] == 5
    assert by_id["part-zero"]["priority"] == 3010.0
    assert by_id["part-critical"]["priority"] == 2200.1
    assert by_id["part-low"]["priority"] == 1052.0
    for item in scoped:
        assert item["finding_type"] == "replenish_now"
        assert item["fingerprint"] == _parts_fingerprint(_TENANT, item["part_id"], "replenish_now")


def test_scope_dead_stock_returns_only_zero_velocity_in_stock_part(fake_parts_views: _FakeSelectClient) -> None:
    del fake_parts_views
    scoped = ops_scope_parts_dead_stock(_TENANT, {"thresholds": {"velocity_window_days": 90}})

    assert [item["part_id"] for item in scoped] == ["part-dead"]
    dead = scoped[0]
    assert dead["finding_type"] == "dead_stock"
    assert dead["value_at_risk"] == 1500.0
    assert dead["velocity"] == 0.0
    assert dead["severity"] == "high"
    assert dead["fingerprint"] == _parts_fingerprint(_TENANT, "part-dead", "dead_stock")


def test_scope_dead_stock_threshold_overrides_and_medium_severity(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeSelectClient(
        {
            "v_dia_part_current": [
                _part_row("part-slow", status="ok", qty=3, reorder=1, unit_cost=200.0, stock_value=600.0),
                _part_row("part-high", status="ok", qty=4, reorder=1, unit_cost=300.0, stock_value=1200.0),
                _part_row("part-cheap", status="ok", qty=2, reorder=1, unit_cost=150.0, stock_value=300.0),
                _part_row("part-too-fast", status="ok", qty=2, reorder=1, unit_cost=400.0, stock_value=800.0),
            ],
            "v_dia_part_sale_current": [
                _sale("part-slow", 1, 10),
                _sale("part-too-fast", 2, 10),
            ],
        }
    )
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    scoped = ops_scope_parts_dead_stock(
        _TENANT,
        {
            "thresholds": {
                "velocity_window_days": 90,
                "dead_stock_max_velocity": 1,
                "dead_stock_min_value": 500,
                "dead_stock_high_value": 1000,
            }
        },
    )

    assert [item["part_id"] for item in scoped] == ["part-high", "part-slow"]
    by_id = {item["part_id"]: item for item in scoped}
    assert by_id["part-high"]["severity"] == "high"
    assert by_id["part-slow"]["severity"] == "medium"
    assert by_id["part-slow"]["velocity"] == 1.0
    assert by_id["part-slow"]["value_at_risk"] == 600.0


def test_scope_functions_respect_max_parts_and_min_max_clamp(monkeypatch: pytest.MonkeyPatch) -> None:
    rows_by_table = {
        "v_dia_parts_critical": [
            _part_row(
                f"part-replenish-{idx:03d}",
                status="baixo",
                qty=0,
                reorder=1,
                unit_cost=10.0,
                stock_value=float(idx),
                rank=2,
            )
            for idx in range(600)
        ],
        "v_dia_part_current": [
            _part_row(
                f"part-dead-{idx:03d}",
                status="ok",
                qty=1,
                reorder=1,
                unit_cost=10.0,
                stock_value=float(idx + 1),
            )
            for idx in range(600)
        ],
        "v_dia_part_sale_current": [],
    }
    client = _FakeSelectClient(rows_by_table)
    monkeypatch.setattr(ops_revrec, "_ops_client", client)

    replenish_top_two = ops_scope_parts_replenish(_TENANT, {"max_parts": 2})
    dead_stock_top_two = ops_scope_parts_dead_stock(_TENANT, {"max_parts": 2})
    assert [item["part_id"] for item in replenish_top_two] == ["part-replenish-599", "part-replenish-598"]
    assert [item["part_id"] for item in dead_stock_top_two] == ["part-dead-599", "part-dead-598"]

    assert len(ops_scope_parts_replenish(_TENANT, {"max_parts": 99999})) == 500
    assert len(ops_scope_parts_dead_stock(_TENANT, {"max_parts": 99999})) == 500

    # Mirrors ops_vehicle_aging semantics: falsy max_parts means unset, so the default applies before clamping.
    assert len(ops_scope_parts_replenish(_TENANT, {"max_parts": 0})) == 200
    assert len(ops_scope_parts_dead_stock(_TENANT, {"max_parts": 0})) == 200


def test_windowed_velocity_counts_only_parseable_sales_inside_window() -> None:
    now = dt.date(2026, 6, 25)
    rows = [
        {"part_id": "part-1", "quantity": 7, "sale_date": "2026-06-15T12:00:00Z"},
        {"part_id": "part-1", "quantity": 11, "sale_date": "2025-12-07"},
        {"part_id": "part-1", "quantity": 99, "sale_date": "malformed"},
        {"part_id": "part-2", "quantity": 13, "sale_date": "2026-06-20"},
    ]
    assert _windowed_velocity(rows, "part-1", 90, now) == 7.0


# ===========================================================================
# Assess activity — LLM fields accepted, deterministic fields re-pinned
# AC-007
# ===========================================================================


@pytest.mark.asyncio
async def test_ops_parts_inventory_assess_repins_deterministic_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    async def fake_run_parts_inventory_advisor(
        part_payload: Mapping[str, Any],
        *,
        system_prompt: str,
        user_prompt_template: str,
        max_tool_rounds: int = 0,
        transport: Any | None = None,
    ) -> dict[str, Any]:
        del transport
        calls.append(
            {
                "part_payload": dict(part_payload),
                "system_prompt": system_prompt,
                "user_prompt_template": user_prompt_template,
                "max_tool_rounds": max_tool_rounds,
            }
        )
        return {
            "part_id": "model-part",
            "finding_type": "dead_stock",
            "severity": "low",
            "recommended_action": "monitor",
            "quantity_suggested": 999,
            "value_at_risk": 9999.0,
            "evidence": ["model evidence"],
            "confidence": 0.7,
            "rationale": "model recommends monitoring",
        }

    monkeypatch.setattr(ops_parts_inventory, "run_parts_inventory_advisor", fake_run_parts_inventory_advisor)
    monkeypatch.setattr(ops_parts_inventory.activity, "heartbeat", lambda: None)

    part_payload = {
        "tenant_id": _TENANT,
        "part_id": "part-1",
        "part_number": "PN-1",
        "manufacturer": "Bosch",
        "stock_status": "zerado",
        "quantity_in_stock": 0,
        "reorder_point": 5,
        "stock_value": 0.0,
        "velocity": 3.0,
        "quantity_suggested": 5,
        "value_at_risk": 100.0,
        "finding_type": "replenish_now",
        "severity": "critical",
    }
    config = {
        "bounds": {"max_tool_rounds": 2},
        "system_prompt": "Tenant {tenant_id}: advise {manufacturer} parts.",
        "user_prompt_template": "Assess {part_id} {finding_type} {quantity_suggested} {value_at_risk}.",
    }

    result = await ops_parts_inventory_assess(part_payload, config)

    assert result["part_id"] == "part-1"
    assert result["finding_type"] == "replenish_now"
    assert result["severity"] == "critical"
    assert result["quantity_suggested"] == 5
    assert result["value_at_risk"] == 100.0
    assert result["recommended_action"] == "monitor"
    assert result["evidence"] == ["model evidence"]
    assert result["confidence"] == 0.7
    assert calls[0]["system_prompt"] == "Tenant tenant-a: advise Bosch parts."
    assert calls[0]["user_prompt_template"] == "Assess part-1 replenish_now 5 100.0."
    assert calls[0]["max_tool_rounds"] == 2


# ===========================================================================
# Workflow against stubbed activity layer
# AC-009, AC-010, AC-011, AC-012, AC-016
# ===========================================================================


def _default_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "auto_apply": False,
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 0},
        "thresholds": {"velocity_window_days": 90},
        "system_prompt": "s",
        "user_prompt_template": "u",
        "tools": [],
    }
    base.update(overrides)
    return base


def _scoped_part(
    part_id: str,
    *,
    finding_type: str,
    severity: str,
    priority: float,
    quantity_suggested: int,
    value_at_risk: float,
) -> dict[str, Any]:
    return {
        "part_id": part_id,
        "tenant_id": _TENANT,
        "part_number": f"PN-{part_id}",
        "manufacturer": "Bosch",
        "stock_status": "zerado" if finding_type == "replenish_now" else "ok",
        "quantity_in_stock": 0 if finding_type == "replenish_now" else 5,
        "reorder_point": 5,
        "stock_value": value_at_risk,
        "velocity": 2.0,
        "severity": severity,
        "priority": priority,
        "quantity_suggested": quantity_suggested,
        "value_at_risk": value_at_risk,
        "finding_type": finding_type,
        "fingerprint": _parts_fingerprint(_TENANT, part_id, finding_type),
    }


def _assessment(recommended_action: str = "order_now", rationale: str = "needs action") -> dict[str, Any]:
    return {
        "part_id": "ignored",
        "recommended_action": recommended_action,
        "evidence": ["evidence line"],
        "confidence": 0.6,
        "rationale": rationale,
    }


def _build_harness(
    *,
    config: dict[str, Any],
    replenish_scoped: list[dict[str, Any]],
    dead_stock_scoped: list[dict[str, Any]],
    assessment_by_part: dict[str, dict[str, Any]],
    existing_fingerprints: list[str] | None = None,
):
    state: dict[str, Any] = {
        "recorded_findings": [],
        "finalized": None,
        "created_workflow_key": None,
        "assess_kwargs": [],
        "scope_contexts": [],
    }
    existing = existing_fingerprints or []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):  # noqa: ANN001
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            state["created_workflow_key"] = args[0]
            return {"run_id": "run-1"}
        if fn_name == "ops_finalize_workflow_run":
            state["finalized"] = args[1]
            return True
        if fn_name == "ops_load_agent_config":
            return config
        if fn_name == "ops_scope_parts_replenish":
            state["scope_contexts"].append(args[1])
            return replenish_scoped
        if fn_name == "ops_scope_parts_dead_stock":
            state["scope_contexts"].append(args[1])
            return dead_stock_scoped
        if fn_name == "ops_parts_inventory_assess":
            state["assess_kwargs"].append(kw)
            return assessment_by_part[str(args[0]["part_id"])]
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    return state, fake_execute_activity


async def _run_workflow(state_execute) -> dict[str, Any]:  # noqa: ANN001
    _, fake_execute = state_execute
    wf = PartsInventoryWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_parts_inventory_workflow"), create=True),
    ):
        return await wf.run(PartsInventoryWorkflowInput(tenant_id=_TENANT))


@pytest.mark.asyncio
async def test_workflow_records_all_findings_when_none_open() -> None:
    replenish = [
        _scoped_part(
            "part-low", finding_type="replenish_now", severity="medium", priority=1000, quantity_suggested=2, value_at_risk=50.0
        ),
        _scoped_part(
            "part-critical", finding_type="replenish_now", severity="critical", priority=3000, quantity_suggested=5, value_at_risk=100.0
        ),
    ]
    dead = [
        _scoped_part(
            "part-dead", finding_type="dead_stock", severity="high", priority=2000, quantity_suggested=0, value_at_risk=1500.0
        )
    ]
    scoped = [*replenish, *dead]
    assert [part["part_id"] for part in scoped] == ["part-low", "part-critical", "part-dead"]
    assessment = {part["part_id"]: _assessment(recommended_action="order_now") for part in scoped}
    harness = _build_harness(
        config=_default_config(),
        replenish_scoped=replenish,
        dead_stock_scoped=dead,
        assessment_by_part=assessment,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["status"] == "succeeded"
    assert result["run_id"] == "run-1"
    assert result["total_parts_scoped"] == 3
    assert result["recorded_findings"] == 3
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 3
    assert result["remaining_findings_count"] == 0
    assert result["auto_apply"] is False
    assert len(state["recorded_findings"]) == 3
    assert [finding["part_id"] for finding in state["recorded_findings"]] == [
        "part-critical",
        "part-dead",
        "part-low",
    ]
    first = state["recorded_findings"][0]
    assert first["agent_key"] == _WORKFLOW_KEY
    assert first["workflow_id"] == "ops-parts-inventory:run-1"
    assert first["severity"] == "critical"
    assert first["recommended_action"] == "order_now"
    assert first["finding_type"] == "replenish_now"
    assert first["fingerprint"] == _parts_fingerprint(_TENANT, "part-critical", "replenish_now")
    assert state["finalized"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_workflow_dedupes_when_all_fingerprints_already_open() -> None:
    replenish = [
        _scoped_part(
            "part-critical", finding_type="replenish_now", severity="critical", priority=3000, quantity_suggested=5, value_at_risk=100.0
        ),
        _scoped_part(
            "part-low", finding_type="replenish_now", severity="medium", priority=1000, quantity_suggested=2, value_at_risk=50.0
        ),
    ]
    dead = [
        _scoped_part(
            "part-dead", finding_type="dead_stock", severity="high", priority=2000, quantity_suggested=0, value_at_risk=1500.0
        )
    ]
    scoped = [*replenish, *dead]
    assessment = {part["part_id"]: _assessment() for part in scoped}
    existing = [part["fingerprint"] for part in scoped]
    harness = _build_harness(
        config=_default_config(),
        replenish_scoped=replenish,
        dead_stock_scoped=dead,
        assessment_by_part=assessment,
        existing_fingerprints=existing,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_parts_scoped"] == 3
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 3
    assert result["processed_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_dedupes_only_already_open_fingerprints() -> None:
    replenish = [
        _scoped_part(
            "part-critical", finding_type="replenish_now", severity="critical", priority=3000, quantity_suggested=5, value_at_risk=100.0
        ),
        _scoped_part(
            "part-low", finding_type="replenish_now", severity="medium", priority=1000, quantity_suggested=2, value_at_risk=50.0
        ),
    ]
    dead = [
        _scoped_part(
            "part-dead", finding_type="dead_stock", severity="high", priority=2000, quantity_suggested=0, value_at_risk=1500.0
        )
    ]
    scoped = [*replenish, *dead]
    assessment = {part["part_id"]: _assessment() for part in scoped}
    harness = _build_harness(
        config=_default_config(),
        replenish_scoped=replenish,
        dead_stock_scoped=dead,
        assessment_by_part=assessment,
        existing_fingerprints=[_parts_fingerprint(_TENANT, "part-dead", "dead_stock")],
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["recorded_findings"] == 2
    assert result["deduped_findings"] == 1
    assert [finding["part_id"] for finding in state["recorded_findings"]] == ["part-critical", "part-low"]


@pytest.mark.asyncio
async def test_workflow_forces_auto_apply_false_even_if_config_enables_it() -> None:
    replenish = [
        _scoped_part(
            "part-critical", finding_type="replenish_now", severity="critical", priority=3000, quantity_suggested=5, value_at_risk=100.0
        )
    ]
    harness = _build_harness(
        config=_default_config(auto_apply=True),
        replenish_scoped=replenish,
        dead_stock_scoped=[],
        assessment_by_part={"part-critical": _assessment()},
    )
    result = await _run_workflow(harness)
    assert result["auto_apply"] is False


@pytest.mark.asyncio
async def test_workflow_bounds_processed_findings_and_reports_remainder() -> None:
    replenish = [
        _scoped_part(
            "part-critical", finding_type="replenish_now", severity="critical", priority=3000, quantity_suggested=5, value_at_risk=100.0
        ),
        _scoped_part(
            "part-low", finding_type="replenish_now", severity="medium", priority=1000, quantity_suggested=2, value_at_risk=50.0
        ),
    ]
    dead = [
        _scoped_part(
            "part-dead", finding_type="dead_stock", severity="high", priority=2000, quantity_suggested=0, value_at_risk=1500.0
        )
    ]
    scoped = [*replenish, *dead]
    harness = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 1, "max_tool_rounds": 0}),
        replenish_scoped=replenish,
        dead_stock_scoped=dead,
        assessment_by_part={part["part_id"]: _assessment() for part in scoped},
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["processed_findings"] == 1
    assert result["remaining_findings_count"] == 2
    assert result["recorded_findings"] == 1
    assert len(state["recorded_findings"]) == 1
    assert state["recorded_findings"][0]["part_id"] == "part-critical"


@pytest.mark.asyncio
async def test_workflow_empty_scope_finalizes_and_persists_workflow_key() -> None:
    harness = _build_harness(
        config=_default_config(),
        replenish_scoped=[],
        dead_stock_scoped=[],
        assessment_by_part={},
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_parts_scoped"] == 0
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 0
    assert result["run_id"] == "run-1"
    assert state["created_workflow_key"] == _WORKFLOW_KEY
    assert state["finalized"] is not None
    assert state["assess_kwargs"] == []


@pytest.mark.asyncio
async def test_workflow_assess_activity_has_heartbeat_timeout_and_retry_cap() -> None:
    replenish = [
        _scoped_part(
            "part-critical", finding_type="replenish_now", severity="critical", priority=3000, quantity_suggested=5, value_at_risk=100.0
        )
    ]
    harness = _build_harness(
        config=_default_config(),
        replenish_scoped=replenish,
        dead_stock_scoped=[],
        assessment_by_part={"part-critical": _assessment()},
    )
    state, _ = harness

    await _run_workflow(harness)

    assert state["assess_kwargs"], "ops_parts_inventory_assess was never called"
    kw = state["assess_kwargs"][0]
    heartbeat_timeout = kw.get("heartbeat_timeout")
    assert heartbeat_timeout is not None
    assert heartbeat_timeout.total_seconds() == 45
    retry_policy = kw.get("retry_policy")
    assert retry_policy is not None
    assert retry_policy.maximum_attempts == 2


# ===========================================================================
# Worker/API registration, import hygiene, and assist-only persistence
# AC-013, AC-014, AC-015, AC-016
# ===========================================================================


def test_parts_inventory_workflow_and_activities_are_registered_in_worker() -> None:
    from temporal.src import worker as worker_module
    from temporal.tests.test_worker_registration import (
        _extract_worker_activity_references,
        _extract_worker_workflow_references,
    )

    assert hasattr(PartsInventoryWorkflow, "__temporal_workflow_definition")
    assert "PartsInventoryWorkflow" in _extract_worker_workflow_references()

    decorated = {
        name
        for name, obj in inspect.getmembers(ops_parts_inventory)
        if callable(obj)
        and hasattr(obj, "__temporal_activity_definition")
        and inspect.getmodule(obj) is ops_parts_inventory
    }
    assert decorated, "expected @activity.defn functions in ops_parts_inventory"

    registered = {fn for alias, fn in _extract_worker_activity_references() if alias == "ops_parts_inventory"}
    registered.update(fn.__name__ for fn in getattr(worker_module, "_PARTS_INVENTORY_ACTIVITIES", ()))
    unregistered = sorted(decorated - registered)
    assert not unregistered, f"ops_parts_inventory activities not registered in worker.py: {unregistered}"


def test_parts_inventory_is_run_now_able_and_uses_expected_schedule_id() -> None:
    from temporal.src import worker as worker_module
    from temporal.src.ops_api.app import _AGENT_SCHEDULE_ID_BUILDERS, _OPS_AGENT_KEYS

    assert _WORKFLOW_KEY in _OPS_AGENT_KEYS
    assert _AGENT_SCHEDULE_ID_BUILDERS[_WORKFLOW_KEY](_TENANT) == f"ops:{_TENANT}:{_WORKFLOW_KEY}"
    assert worker_module._schedule_id_for_tenant(_TENANT, worker_module._PARTS_INVENTORY_AGENT_KEY) == (
        f"ops:{_TENANT}:{_WORKFLOW_KEY}"
    )


def test_new_parts_inventory_files_do_not_import_rental_helpers() -> None:
    offenders: list[str] = []
    for rel_path in _NEW_SOURCE_FILES:
        tree = ast.parse((_REPO_ROOT / rel_path).read_text())
        for node in ast.walk(tree):
            modules: list[str] = []
            if isinstance(node, ast.ImportFrom) and node.module:
                modules.append(node.module)
            if isinstance(node, ast.Import):
                modules.extend(alias.name for alias in node.names)
            if isinstance(node, ast.ImportFrom):
                modules.extend(alias.name for alias in node.names)
            for module in modules:
                if "rental" in module:
                    offenders.append(f"{rel_path}: {module}")
    assert not offenders, f"new files must not import rental_* helpers: {offenders}"


def test_parts_inventory_source_is_assist_only_and_uses_generic_persistence_wrappers() -> None:
    source = (_REPO_ROOT / "temporal/src/activities/ops_parts_inventory.py").read_text()
    forbidden_write_markers = (
        "purchase_order",
        "create_purchase",
        "create_requisition",
        "update_requisition",
        "create_inventory",
        "update_inventory",
        "insert_inventory",
        "upsert_inventory",
    )
    assert not [marker for marker in forbidden_write_markers if marker in source]
    assert "ops_revrec.ops_record_finding" in source
    assert "ops_revrec.ops_create_workflow_run" in source
    assert "ops_revrec.ops_finalize_workflow_run" in source
