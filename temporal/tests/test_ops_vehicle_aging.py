"""Tests for the Vehicle Inventory Analyst (anticipatory stock analysis).

The agent no longer fires on a naive "90 days in stock" threshold. It surfaces a
finding only when the deterministic signal engine
(``vehicle_inventory_signals``) detects an anticipatory problem — floor-plan band
escalation, margin erosion, or model-year carryover. These tests cover the
activity layer (scope + finding shaping), the agent surface (schema v2, no
tools) and the workflow (dedupe, supersede, bounding, fire-and-forget).

The pure signal engine itself is unit-tested in
``test_vehicle_inventory_signals.py``.
"""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import re
from collections.abc import Mapping
from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from pydantic import ValidationError
from temporal.src.activities import ops_revrec, ops_vehicle_aging
from temporal.src.activities.ops_vehicle_aging import (
    _finding_fingerprint,
    _vehicle_finding_for_storage,
    ops_scope_vehicle_aging,
)
from temporal.src.agents.openai_client import StructuredOutputRetriesExceededError
from temporal.src.agents.vehicle_aging_analyst import (
    VehicleAgingFindingV2,
    run_vehicle_aging_analyst,
    vehicle_aging_finding_v2_schema,
)
from temporal.src.agents.vehicle_inventory_signals import (
    FINDING_CARRYOVER_MODEL_YEAR,
    FINDING_FLOOR_PLAN_ESCALATION,
    FINDING_MARGIN_EROSION,
)
from temporal.src.workflows.ops.vehicle_aging import (
    VehicleAgingWorkflow,
    VehicleAgingWorkflowInput,
)

_TENANT = "tenant-a"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NEW_SOURCE_FILES = (
    "temporal/src/agents/vehicle_aging_analyst.py",
    "temporal/src/agents/vehicle_inventory_signals.py",
    "temporal/src/activities/ops_vehicle_aging.py",
    "temporal/src/workflows/ops/vehicle_aging.py",
    "temporal/scripts/run_vehicle_aging.py",
)


# ===========================================================================
# Deterministic helpers — fingerprint + finding row shaping
# ===========================================================================


def test_finding_fingerprint_is_exact_sha256_per_type() -> None:
    # fingerprint = sha256(f"{tenant}:{vehicle}:{finding_type}"): vehicle-scoped
    # AND type-scoped so a unit can move between problems without colliding.
    ft = FINDING_FLOOR_PLAN_ESCALATION
    expected = hashlib.sha256(f"{_TENANT}:veh-1:{ft}".encode()).hexdigest()
    assert _finding_fingerprint(_TENANT, "veh-1", ft) == expected
    assert _finding_fingerprint(_TENANT, "veh-1", ft) != _finding_fingerprint(_TENANT, "veh-2", ft)
    assert _finding_fingerprint(_TENANT, "veh-1", ft) != _finding_fingerprint("tenant-b", "veh-1", ft)
    # Different finding type for the same vehicle -> different fingerprint.
    assert _finding_fingerprint(_TENANT, "veh-1", ft) != _finding_fingerprint(
        _TENANT, "veh-1", FINDING_MARGIN_EROSION
    )


def test_vehicle_finding_for_storage_maps_canonical_finding_row() -> None:
    # contract_id = vehicle entity_id; line_item_id = NULL; delta = exposure;
    # proposed_action = recommended_action; expected JSON carries the vehicle facts.
    finding = {
        "vehicle_id": "veh-uuid-123",
        "tenant_id": _TENANT,
        "finding_type": FINDING_FLOOR_PLAN_ESCALATION,
        "severity": "high",
        "brand": "Nissan",
        "model": "Kicks",
        "model_year": 2026,
        "store": "Filial Sul",
        "condition": "novo",
        "cost": 125000.0,
        "sale_price": 152900.0,
        "days_in_stock": 86,
        "signals": [FINDING_FLOOR_PLAN_ESCALATION],
        "monthly_carry": 1875.0,
        "accrued_floor_plan": 4200.0,
        "gross_margin": 27900.0,
        "floor_plan_cost": 3823.42,
        "estimated_exposure": 625.0,
        "recommended_action": "markdown",
        "evidence": ["floor plan about to step up a band"],
        "confidence": 0.7,
        "rationale": "escalation imminent",
    }
    row = _vehicle_finding_for_storage(finding)

    assert row["contract_id"] == "veh-uuid-123"
    assert row["line_item_id"] is None
    assert row["delta"] == 625.0
    assert row["proposed_action"] == "markdown"
    assert row["finding_type"] == FINDING_FLOOR_PLAN_ESCALATION
    assert row["severity"] == "high"
    assert row["billed"] == {}
    assert row["tenant_id"] == _TENANT
    assert row["expected"] == {
        "brand": "Nissan",
        "model": "Kicks",
        "model_year": 2026,
        "store": "Filial Sul",
        "days_in_stock": 86,
        "signals": [FINDING_FLOOR_PLAN_ESCALATION],
        "recommended_action": "markdown",
        "monthly_carry": 1875.0,
        "accrued_floor_plan": 4200.0,
        "gross_margin": 27900.0,
        "floor_plan_cost": 3823.42,
        "sale_price": 152900.0,
        "cost": 125000.0,
    }


def test_vehicle_finding_for_storage_defaults_type_and_severity() -> None:
    row = _vehicle_finding_for_storage({"vehicle_id": "veh-9", "estimated_exposure": 10.0})
    assert row["contract_id"] == "veh-9"
    assert row["line_item_id"] is None
    assert row["finding_type"] == FINDING_FLOOR_PLAN_ESCALATION
    assert row["severity"] == "medium"
    assert row["delta"] == 10.0


# ===========================================================================
# Agent surface — pydantic schema v2 + run_vehicle_aging_analyst (no tools)
# ===========================================================================


def test_finding_v2_rejects_extra_fields() -> None:
    valid = VehicleAgingFindingV2(vehicle_id="veh-1", recommended_action="markdown", rationale="risk")
    assert valid.finding_type == FINDING_FLOOR_PLAN_ESCALATION
    assert valid.severity == "medium"
    assert valid.signals == []

    with pytest.raises(ValidationError):
        VehicleAgingFindingV2(
            vehicle_id="veh-1",
            recommended_action="markdown",
            rationale="risk",
            surprise="not allowed",  # type: ignore[call-arg]
        )


def test_finding_v2_schema_matches_db_registry_contract() -> None:
    # The Python output model and the migration's ops_output_schema_registry row
    # must agree, or the worker would validate against a different contract than
    # the DB advertises.
    schema = vehicle_aging_finding_v2_schema()
    assert schema["title"] == "VehicleAgingFindingV2"
    assert schema["additionalProperties"] is False
    assert sorted(schema["required"]) == ["rationale", "recommended_action", "vehicle_id"]

    migration = (_REPO_ROOT / "supabase/migrations/20260628120000_vehicle_aging_agent_v2.sql").read_text()
    match = re.search(r"'(\{.*?\})'::jsonb", migration, re.S)
    assert match, "expected an embedded jsonb schema literal in the migration"
    registry = json.loads(match.group(1))
    assert registry["title"] == "VehicleAgingFindingV2"
    assert registry["additionalProperties"] is False
    assert sorted(registry["required"]) == sorted(schema["required"])
    assert set(registry["properties"]) == set(schema["properties"])


class _FakeTransport:
    """Mirror of the revrec ``_FakeTransport`` that also records the tools list."""

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
async def test_run_vehicle_aging_analyst_sends_no_tools_and_returns_validated_finding() -> None:
    transport = _FakeTransport(
        [
            _assistant_json(
                {
                    "vehicle_id": "veh-1",
                    "recommended_action": "wholesale_auction",
                    "rationale": "floor-plan carry escalating; move it",
                }
            )
        ]
    )
    result = await run_vehicle_aging_analyst(
        {"vehicle_id": "veh-1", "tenant_id": _TENANT},
        system_prompt="You are a vehicle inventory analyst.",
        user_prompt_template="Assess veh-1.",
        transport=transport,
    )

    # No tools were offered, so the closed-loop never sends a tool_choice.
    assert transport.tools_seen == [[]]
    assert len(transport.calls) == 1  # single round, no tool turn
    assert result == {
        "vehicle_id": "veh-1",
        "finding_type": FINDING_FLOOR_PLAN_ESCALATION,
        "severity": "medium",
        "days_in_stock": 0,
        "signals": [],
        "recommended_action": "wholesale_auction",
        "estimated_exposure": 0.0,
        "evidence": [],
        "confidence": 0.0,
        "rationale": "floor-plan carry escalating; move it",
    }


@pytest.mark.asyncio
async def test_run_vehicle_aging_analyst_rejects_extra_field_from_model() -> None:
    # extra=forbid is enforced end-to-end: a model response with an unknown key
    # never validates, and after the bounded retry the run fails closed.
    bad = {
        "vehicle_id": "veh-1",
        "recommended_action": "markdown",
        "rationale": "risk",
        "ai_hallucinated_field": 1,
    }
    transport = _FakeTransport([_assistant_json(bad), _assistant_json(bad)])
    with pytest.raises(StructuredOutputRetriesExceededError):
        await run_vehicle_aging_analyst(
            {"vehicle_id": "veh-1"},
            system_prompt="s",
            user_prompt_template="u",
            transport=transport,
        )


# ===========================================================================
# Scope activity — ops_scope_vehicle_aging against a faked v_dia_vehicle_current
# AC: only vehicles with a fired anticipatory signal are scoped; an old-but-
#     healthy vehicle (240 days, wide margin, current model year) is NOT scoped.
# ===========================================================================

_CURRENT_YEAR = date.today().year


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


def _vehicle_row(
    vehicle_id: str,
    *,
    days: int,
    condition: str,
    cost: float,
    sale_price: float,
    model_year: int,
    status: str = "em_estoque",
) -> dict[str, Any]:
    return {
        "entity_id": vehicle_id,
        "source_record_id": f"demo-dia-{vehicle_id}",
        "name": f"Car {vehicle_id}",
        "condition": condition,
        "brand": "Brand",
        "model": "Model",
        "model_year": model_year,
        "cost": cost,
        "sale_price": sale_price,
        "store": "Matriz",
        "status": status,
        "days_in_stock": days,
        # Linear view number; the engine computes its own accrued curve.
        "floor_plan_cost": round(cost * 0.13 / 365 * days, 2),
    }


@pytest.fixture()
def fake_vehicle_view(monkeypatch: pytest.MonkeyPatch) -> _FakeSelectClient:
    rows = [
        # margin erosion (critical): thin margin + deep accrued at 200 days.
        _vehicle_row("veh-margin", days=200, condition="usado", cost=90000, sale_price=95000, model_year=2020),
        # floor-plan band escalation (medium): 88d is within 7 of the 90d band.
        _vehicle_row("veh-esc", days=88, condition="novo", cost=90000, sale_price=112000, model_year=_CURRENT_YEAR),
        # carryover (high): new unit one model year behind, > 45 days, off-boundary.
        _vehicle_row("veh-carry", days=52, condition="novo", cost=22000, sale_price=26000, model_year=_CURRENT_YEAR - 1),
        # CONTROL old-but-healthy: 240 days yet wide margin, stable top band,
        # current model year -> NO signal, must NOT be scoped.
        _vehicle_row("veh-healthy", days=240, condition="usado", cost=99000, sale_price=130000, model_year=2020),
        # CONTROL fresh: still within grace, healthy -> NO signal.
        _vehicle_row("veh-fresh", days=20, condition="novo", cost=98000, sale_price=121000, model_year=_CURRENT_YEAR),
        # Sold: filtered by the em_estoque predicate even though it is the oldest.
        _vehicle_row("veh-sold", days=300, condition="usado", cost=90000, sale_price=95000, model_year=2020, status="vendido"),
    ]
    client = _FakeSelectClient({"v_dia_vehicle_current": rows})
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    return client


def test_scope_surfaces_only_signalled_vehicles_ordered_by_severity(fake_vehicle_view: _FakeSelectClient) -> None:
    scoped = ops_scope_vehicle_aging(_TENANT, {})
    by_id = {item["vehicle_id"]: item for item in scoped}
    ids = [item["vehicle_id"] for item in scoped]

    # Only the three problem vehicles; healthy/fresh/sold are excluded.
    assert set(ids) == {"veh-margin", "veh-esc", "veh-carry"}
    assert "veh-healthy" not in ids  # 240 days but no problem -> the key proof
    assert "veh-fresh" not in ids
    assert "veh-sold" not in ids

    # Ordered by severity desc, then exposure desc: critical margin first,
    # then high carryover, then medium escalation.
    assert ids == ["veh-margin", "veh-carry", "veh-esc"]

    assert by_id["veh-margin"]["finding_type"] == FINDING_MARGIN_EROSION
    assert by_id["veh-margin"]["severity"] == "critical"
    assert by_id["veh-esc"]["finding_type"] == FINDING_FLOOR_PLAN_ESCALATION
    assert by_id["veh-esc"]["severity"] == "medium"
    assert by_id["veh-carry"]["finding_type"] == FINDING_CARRYOVER_MODEL_YEAR
    assert by_id["veh-carry"]["severity"] == "high"

    # Deterministic dedupe fields keyed per (tenant, vehicle, finding_type).
    sample = by_id["veh-esc"]
    assert sample["fingerprint"] == _finding_fingerprint(_TENANT, "veh-esc", FINDING_FLOOR_PLAN_ESCALATION)
    assert sample["signals"] == [FINDING_FLOOR_PLAN_ESCALATION]
    assert sample["estimated_exposure"] > 0
    assert sample["tenant_id"] == _TENANT
    assert sample["signal_evidence"], "deterministic evidence should be attached"


def test_scope_never_fires_on_days_alone(fake_vehicle_view: _FakeSelectClient) -> None:
    # The legacy "90+ days" warning is gone: a 240-day unit with a healthy margin
    # produces no finding. Removing the problem vehicles would leave scope empty
    # despite multiple aged units in the view.
    scoped = ops_scope_vehicle_aging(_TENANT, {})
    aged_but_unscoped = [v for v in ("veh-healthy",) if v in {i["vehicle_id"] for i in scoped}]
    assert aged_but_unscoped == []


def test_scope_respects_max_vehicles_bound(fake_vehicle_view: _FakeSelectClient) -> None:
    scoped = ops_scope_vehicle_aging(_TENANT, {"max_vehicles": 2})
    assert [item["vehicle_id"] for item in scoped] == ["veh-margin", "veh-carry"]


def test_scope_threshold_override_suppresses_carryover(fake_vehicle_view: _FakeSelectClient) -> None:
    # Raising carryover_min_days above the unit's age suppresses that signal; the
    # carryover vehicle then has no other signal and drops out of scope.
    scoped = ops_scope_vehicle_aging(_TENANT, {"thresholds": {"carryover_min_days": 999}})
    assert "veh-carry" not in {item["vehicle_id"] for item in scoped}
    assert {"veh-margin", "veh-esc"} <= {item["vehicle_id"] for item in scoped}


# ===========================================================================
# Workflow — VehicleAgingWorkflow against a stubbed activity layer
# AC: dedup, auto_apply stays false, bounding, summary keys, fire-and-forget.
# ===========================================================================

_WORKFLOW_KEY = "vehicle-aging-analyst"


def _default_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "auto_apply": False,
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 0},
        "thresholds": {},
        "system_prompt": "s",
        "user_prompt_template": "u",
        "tools": [],
    }
    base.update(overrides)
    return base


def _scoped_vehicle(
    vehicle_id: str,
    *,
    severity: str,
    exposure: float,
    finding_type: str = FINDING_FLOOR_PLAN_ESCALATION,
    days: int = 90,
) -> dict[str, Any]:
    return {
        "vehicle_id": vehicle_id,
        "tenant_id": _TENANT,
        "days_in_stock": days,
        "finding_type": finding_type,
        "severity": severity,
        "signals": [finding_type],
        "brand": "Brand",
        "model": "Model",
        "model_year": 2022,
        "store": "Matriz",
        "condition": "usado",
        "cost": 100000.0,
        "sale_price": 130000.0,
        "monthly_carry": 1500.0,
        "accrued_floor_plan": 4000.0,
        "gross_margin": 30000.0,
        "floor_plan_cost": exposure,
        "estimated_exposure": exposure,
        "fingerprint": _finding_fingerprint(_TENANT, vehicle_id, finding_type),
    }


def _build_harness(
    *,
    config: dict[str, Any],
    scoped: list[dict[str, Any]],
    assessment_by_vehicle: dict[str, dict[str, Any]],
    existing_fingerprints: list[str] | None = None,
    superseded_count: int = 0,
):
    state: dict[str, Any] = {
        "recorded_findings": [],
        "finalized": None,
        "created_workflow_key": None,
        "assess_kwargs": [],
        "expire_args": None,
        "expire_kwargs": None,
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
        if fn_name == "ops_scope_vehicle_aging":
            return scoped
        if fn_name == "ops_vehicle_aging_assess":
            state["assess_kwargs"].append(kw)
            return assessment_by_vehicle[str(args[0]["vehicle_id"])]
        if fn_name == "ops_vehicle_aging_expire_out_of_scope_findings":
            state["expire_args"] = args
            state["expire_kwargs"] = kw
            return superseded_count
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    return state, fake_execute_activity


def _assessment(recommended_action: str = "markdown", rationale: str = "risk") -> dict[str, Any]:
    return {
        "vehicle_id": "ignored",
        "recommended_action": recommended_action,
        "evidence": ["evidence line"],
        "confidence": 0.6,
        "rationale": rationale,
    }


async def _run_workflow(state_execute) -> dict[str, Any]:  # noqa: ANN001
    _, fake_execute = state_execute
    wf = VehicleAgingWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_vehicle_aging_workflow"), create=True),
    ):
        return await wf.run(VehicleAgingWorkflowInput(tenant_id=_TENANT))


def _default_scope() -> list[dict[str, Any]]:
    return [
        _scoped_vehicle("veh-crit", severity="critical", exposure=4273.97, finding_type=FINDING_MARGIN_EROSION),
        _scoped_vehicle("veh-high", severity="high", exposure=3063.01),
        _scoped_vehicle("veh-med", severity="medium", exposure=2849.32),
    ]


@pytest.mark.asyncio
async def test_workflow_records_all_findings_when_none_open() -> None:
    scoped = _default_scope()
    assessment = {v["vehicle_id"]: _assessment(recommended_action="markdown") for v in scoped}
    harness = _build_harness(config=_default_config(), scoped=scoped, assessment_by_vehicle=assessment)
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["status"] == "succeeded"
    assert result["run_id"] == "run-1"
    assert result["total_vehicles_scoped"] == 3
    assert result["recorded_findings"] == 3
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 3
    assert result["remaining_findings_count"] == 0
    assert result["auto_apply"] is False
    assert len(state["recorded_findings"]) == 3

    # Recorded in severity-desc / exposure-desc order, carrying the LLM action.
    recorded_ids = [f["vehicle_id"] for f in state["recorded_findings"]]
    assert recorded_ids == ["veh-crit", "veh-high", "veh-med"]
    first = state["recorded_findings"][0]
    assert first["severity"] == "critical"
    assert first["recommended_action"] == "markdown"
    assert first["finding_type"] == FINDING_MARGIN_EROSION
    assert first["fingerprint"] == _finding_fingerprint(_TENANT, "veh-crit", FINDING_MARGIN_EROSION)
    assert state["finalized"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_workflow_dedupes_when_all_fingerprints_already_open() -> None:
    scoped = _default_scope()
    assessment = {v["vehicle_id"]: _assessment() for v in scoped}
    existing = [v["fingerprint"] for v in scoped]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_vehicle=assessment,
        existing_fingerprints=existing,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_vehicles_scoped"] == 3
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 3
    assert result["processed_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_dedupes_only_already_open_fingerprints() -> None:
    scoped = _default_scope()
    assessment = {v["vehicle_id"]: _assessment() for v in scoped}
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_vehicle=assessment,
        existing_fingerprints=[_finding_fingerprint(_TENANT, "veh-high", FINDING_FLOOR_PLAN_ESCALATION)],
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["recorded_findings"] == 2
    assert result["deduped_findings"] == 1
    recorded_ids = [f["vehicle_id"] for f in state["recorded_findings"]]
    assert recorded_ids == ["veh-crit", "veh-med"]


@pytest.mark.asyncio
async def test_workflow_forces_auto_apply_false_even_if_config_enables_it() -> None:
    scoped = [_scoped_vehicle("veh-crit", severity="critical", exposure=4273.97)]
    assessment = {"veh-crit": _assessment()}
    harness = _build_harness(
        config=_default_config(auto_apply=True),
        scoped=scoped,
        assessment_by_vehicle=assessment,
    )
    result = await _run_workflow(harness)
    assert result["auto_apply"] is False


@pytest.mark.asyncio
async def test_workflow_bounds_processed_findings_and_reports_remainder() -> None:
    scoped = _default_scope()
    assessment = {v["vehicle_id"]: _assessment() for v in scoped}
    harness = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 1, "max_tool_rounds": 0}),
        scoped=scoped,
        assessment_by_vehicle=assessment,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["processed_findings"] == 1
    assert result["remaining_findings_count"] == 2
    assert result["recorded_findings"] == 1
    assert len(state["recorded_findings"]) == 1
    # The single processed finding is the most severe / highest-exposure one.
    assert state["recorded_findings"][0]["vehicle_id"] == "veh-crit"


@pytest.mark.asyncio
async def test_workflow_empty_scope_finalizes_and_persists_workflow_key() -> None:
    harness = _build_harness(config=_default_config(), scoped=[], assessment_by_vehicle={})
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_vehicles_scoped"] == 0
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 0
    assert result["run_id"] == "run-1"
    assert state["created_workflow_key"] == _WORKFLOW_KEY
    assert state["finalized"] is not None
    # CRITICAL early-return guard: an empty scope must short-circuit BEFORE the
    # expire activity, otherwise an empty in_scope set would supersede EVERY open
    # finding for this tenant+agent.
    assert state["expire_args"] is None
    assert result["superseded_findings"] == 0


@pytest.mark.asyncio
async def test_workflow_assess_activity_has_heartbeat_timeout_and_retry_cap() -> None:
    # ADR-0003 wiring: the LLM activity runs with a 45 s heartbeat timeout and a
    # retry cap of 2 attempts.
    scoped = [_scoped_vehicle("veh-crit", severity="critical", exposure=4273.97)]
    assessment = {"veh-crit": _assessment()}
    harness = _build_harness(config=_default_config(), scoped=scoped, assessment_by_vehicle=assessment)
    state, _ = harness

    await _run_workflow(harness)

    assert state["assess_kwargs"], "ops_vehicle_aging_assess was never called"
    kw = state["assess_kwargs"][0]
    heartbeat_timeout = kw.get("heartbeat_timeout")
    assert heartbeat_timeout is not None
    assert heartbeat_timeout.total_seconds() == 45
    retry_policy = kw.get("retry_policy")
    assert retry_policy is not None
    assert retry_policy.maximum_attempts == 2


# ===========================================================================
# Workflow scope reconciliation — supersede out-of-scope findings (issue #72)
# ===========================================================================


@pytest.mark.asyncio
async def test_workflow_computes_in_scope_fingerprints_and_reports_superseded() -> None:
    scoped = [
        _scoped_vehicle("veh-crit", severity="critical", exposure=4273.97, finding_type=FINDING_MARGIN_EROSION),
        _scoped_vehicle("veh-high", severity="high", exposure=3063.01),
    ]
    assessment = {v["vehicle_id"]: _assessment() for v in scoped}
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_vehicle=assessment,
        superseded_count=3,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["superseded_findings"] == 3
    assert state["expire_args"] is not None, "expire activity was never called"
    tenant_arg, in_scope_arg = state["expire_args"]
    assert tenant_arg == _TENANT
    expected_in_scope = sorted(
        {
            _finding_fingerprint(_TENANT, "veh-crit", FINDING_MARGIN_EROSION),
            _finding_fingerprint(_TENANT, "veh-high", FINDING_FLOOR_PLAN_ESCALATION),
        }
    )
    assert in_scope_arg == expected_in_scope


@pytest.mark.asyncio
async def test_workflow_supersedes_out_of_scope_finding_keeps_in_scope() -> None:
    # End-to-end at the workflow level: drive the REAL expire helper against a
    # fake persistence client.
    from temporal.tests.test_ops_revrec_activity import _FakeOpsPersistenceClient

    ops_client = _FakeOpsPersistenceClient()
    in_scope_fp = _finding_fingerprint(_TENANT, "veh-crit", FINDING_MARGIN_EROSION)
    stale_fp = _finding_fingerprint(_TENANT, "veh-OLD", FINDING_FLOOR_PLAN_ESCALATION)
    ops_client.tables["finding"] = [
        {
            "id": "finding-in-scope",
            "tenant_id": _TENANT,
            "agent_key": _WORKFLOW_KEY,
            "status": "pending_approval",
            "fingerprint": in_scope_fp,
        },
        {
            "id": "finding-stale",
            "tenant_id": _TENANT,
            "agent_key": _WORKFLOW_KEY,
            "status": "pending_approval",
            "fingerprint": stale_fp,
        },
    ]

    scoped = [_scoped_vehicle("veh-crit", severity="critical", exposure=4273.97, finding_type=FINDING_MARGIN_EROSION)]
    assessment = {"veh-crit": _assessment()}

    state: dict[str, Any] = {"recorded_findings": []}

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):  # noqa: ANN001
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_create_workflow_run":
            return {"run_id": "run-1"}
        if fn_name == "ops_finalize_workflow_run":
            return True
        if fn_name == "ops_load_agent_config":
            return _default_config()
        if fn_name == "ops_scope_vehicle_aging":
            return scoped
        if fn_name == "ops_vehicle_aging_assess":
            return assessment[str(args[0]["vehicle_id"])]
        if fn_name == "ops_vehicle_aging_expire_out_of_scope_findings":
            return ops_revrec.ops_expire_out_of_scope_findings(args[0], _WORKFLOW_KEY, args[1])
        if fn_name == "ops_list_open_finding_fingerprints":
            return [in_scope_fp]  # the in-scope finding already exists -> deduped
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": "finding-x"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    wf = VehicleAgingWorkflow()
    with (
        patch.object(ops_revrec, "_ops_client", ops_client),
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute_activity),
        patch.object(tw_mod, "logger", logging.getLogger("test_vehicle_aging_workflow"), create=True),
    ):
        result = await wf.run(VehicleAgingWorkflowInput(tenant_id=_TENANT))

    assert result["superseded_findings"] == 1
    rows = {row["id"]: row for row in ops_client.tables["finding"]}
    assert rows["finding-stale"]["status"] == "superseded"
    assert rows["finding-in-scope"]["status"] == "pending_approval"


# ===========================================================================
# Worker registration + import hygiene
# ===========================================================================


def test_vehicle_aging_workflow_and_activities_are_registered_in_worker() -> None:
    from temporal.tests.test_worker_registration import (
        _extract_worker_activity_references,
        _extract_worker_workflow_references,
    )

    assert hasattr(VehicleAgingWorkflow, "__temporal_workflow_definition")
    assert "VehicleAgingWorkflow" in _extract_worker_workflow_references()

    import inspect

    decorated = {
        name
        for name, obj in inspect.getmembers(ops_vehicle_aging)
        if (
            callable(obj)
            and hasattr(obj, "__temporal_activity_definition")
            and inspect.getmodule(obj) is ops_vehicle_aging
        )
    }
    assert decorated, "expected @activity.defn functions in ops_vehicle_aging"

    registered = {fn for alias, fn in _extract_worker_activity_references() if alias == "ops_vehicle_aging"}
    unregistered = sorted(decorated - registered)
    assert not unregistered, f"ops_vehicle_aging activities not registered in worker.py: {unregistered}"


def test_new_files_do_not_import_rental_helpers() -> None:
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
