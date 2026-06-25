"""Tests for the Vehicle Stock-Aging Analyst (issue #32).

Mirrors the revrec test conventions (``test_ops_revrec_activity.py`` /
``test_revrec_workflow.py``): a ``_FakeTransport`` stands in for the Azure LLM,
a fake persistence client stands in for Supabase, the deterministic helpers are
unit-tested directly, and the workflow is driven against a stubbed activity
layer by patching ``temporalio.workflow.execute_activity``.

Every test traces back to an acceptance criterion in
``docs/specs/32-feat-ops-primeiro-agente-dia.md``.
"""

from __future__ import annotations

import ast
import hashlib
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
from temporal.src.activities import ops_revrec, ops_vehicle_aging
from temporal.src.activities.ops_vehicle_aging import (
    _severity_for_days,
    _stock_aging_fingerprint,
    _vehicle_finding_for_storage,
    ops_scope_vehicle_aging,
)
from temporal.src.agents.openai_client import StructuredOutputRetriesExceededError
from temporal.src.agents.vehicle_aging_analyst import (
    VehicleAgingFindingV1,
    run_vehicle_aging_analyst,
    vehicle_aging_finding_v1_schema,
)
from temporal.src.workflows.ops.vehicle_aging import (
    VehicleAgingWorkflow,
    VehicleAgingWorkflowInput,
)

_TENANT = "tenant-a"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NEW_SOURCE_FILES = (
    "temporal/src/agents/vehicle_aging_analyst.py",
    "temporal/src/activities/ops_vehicle_aging.py",
    "temporal/src/workflows/ops/vehicle_aging.py",
    "temporal/scripts/run_vehicle_aging.py",
)


# ===========================================================================
# Deterministic helpers — severity, fingerprint, finding row shaping
# AC: "Severity buckets ... 75-84 -> medium/approaching; 85-90 -> high/imminent;
#      >90 -> critical/breached."
# ===========================================================================


def test_severity_for_days_bucket_boundaries() -> None:
    # 74 is below the scope threshold but the pure function still classifies it
    # as the medium/approaching band (warning_floor 75, imminent_floor 85).
    assert _severity_for_days(74) == ("medium", "approaching")
    assert _severity_for_days(75) == ("medium", "approaching")
    assert _severity_for_days(80) == ("medium", "approaching")
    assert _severity_for_days(84) == ("medium", "approaching")
    # 85..90 is the imminent (high) band.
    assert _severity_for_days(85) == ("high", "imminent")
    assert _severity_for_days(86) == ("high", "imminent")
    assert _severity_for_days(89) == ("high", "imminent")
    assert _severity_for_days(90) == ("high", "imminent")
    # > 90 is breached (critical).
    assert _severity_for_days(91) == ("critical", "breached")
    assert _severity_for_days(120) == ("critical", "breached")
    assert _severity_for_days(240) == ("critical", "breached")


def test_severity_for_days_honours_custom_thresholds() -> None:
    # Raising the warning/breach lines shifts every band accordingly.
    assert _severity_for_days(70, warning_days=60, breach_days=80) == ("medium", "approaching")
    assert _severity_for_days(76, warning_days=60, breach_days=80) == ("high", "imminent")
    assert _severity_for_days(81, warning_days=60, breach_days=80) == ("critical", "breached")


def test_stock_aging_fingerprint_is_exact_sha256() -> None:
    # AC: fingerprint = sha256(f"{tenant_id}:{vehicle_id}:stock_aging_90d").
    expected = hashlib.sha256(f"{_TENANT}:veh-1:stock_aging_90d".encode()).hexdigest()
    assert _stock_aging_fingerprint(_TENANT, "veh-1") == expected
    # Deterministic and vehicle-scoped: same inputs -> same hash, different
    # vehicle -> different hash, different tenant -> different hash.
    assert _stock_aging_fingerprint(_TENANT, "veh-1") == _stock_aging_fingerprint(_TENANT, "veh-1")
    assert _stock_aging_fingerprint(_TENANT, "veh-1") != _stock_aging_fingerprint(_TENANT, "veh-2")
    assert _stock_aging_fingerprint(_TENANT, "veh-1") != _stock_aging_fingerprint("tenant-b", "veh-1")


def test_vehicle_finding_for_storage_maps_canonical_finding_row() -> None:
    # AC: contract_id = vehicle entity_id; line_item_id = NULL; delta ~ floor_plan_cost;
    # proposed_action = recommended_action; expected JSON carries the vehicle facts.
    finding = {
        "vehicle_id": "veh-uuid-123",
        "tenant_id": _TENANT,
        "finding_type": "stock_aging_90d",
        "severity": "high",
        "brand": "Nissan",
        "model": "Kicks",
        "model_year": 2026,
        "store": "Filial Sul",
        "condition": "novo",
        "cost": 125000.0,
        "sale_price": 152900.0,
        "days_in_stock": 86,
        "aging_bucket": "imminent",
        "floor_plan_cost": 3823.42,
        "estimated_exposure": 3823.42,
        "recommended_action": "markdown",
        "evidence": ["86 days in stock"],
        "confidence": 0.7,
        "rationale": "approaching the 90-day floor-plan line",
    }
    row = _vehicle_finding_for_storage(finding)

    assert row["contract_id"] == "veh-uuid-123"
    assert row["line_item_id"] is None
    assert row["delta"] == 3823.42
    assert row["proposed_action"] == "markdown"
    assert row["finding_type"] == "stock_aging_90d"
    assert row["severity"] == "high"
    assert row["billed"] == {}
    # The fingerprint / tenant carry through the spread so the upsert key survives.
    assert row["tenant_id"] == _TENANT
    assert row["expected"] == {
        "brand": "Nissan",
        "model": "Kicks",
        "model_year": 2026,
        "store": "Filial Sul",
        "days_in_stock": 86,
        "aging_bucket": "imminent",
        "recommended_action": "markdown",
        "floor_plan_cost": 3823.42,
        "sale_price": 152900.0,
        "cost": 125000.0,
    }


def test_vehicle_finding_for_storage_defaults_type_and_severity() -> None:
    row = _vehicle_finding_for_storage({"vehicle_id": "veh-9", "estimated_exposure": 10.0})
    assert row["contract_id"] == "veh-9"
    assert row["line_item_id"] is None
    assert row["finding_type"] == "stock_aging_90d"
    assert row["severity"] == "medium"
    assert row["delta"] == 10.0


# ===========================================================================
# Agent surface — pydantic schema + run_vehicle_aging_analyst (no tools)
# AC: "strict:false, pydantic validation, NO tools => no tool_choice sent;
#      VehicleAgingFindingV1 rejects extra fields (extra=forbid)."
# ===========================================================================


def test_finding_v1_rejects_extra_fields() -> None:
    valid = VehicleAgingFindingV1(vehicle_id="veh-1", recommended_action="markdown", rationale="aged")
    assert valid.finding_type == "stock_aging_90d"
    assert valid.severity == "medium"
    assert valid.aging_bucket == "approaching"

    with pytest.raises(ValidationError):
        VehicleAgingFindingV1(
            vehicle_id="veh-1",
            recommended_action="markdown",
            rationale="aged",
            surprise="not allowed",  # type: ignore[call-arg]
        )


def test_finding_v1_schema_matches_db_registry_contract() -> None:
    # The Python output model and the migration's ops_output_schema_registry row
    # must agree, or the worker would validate against a different contract than
    # the DB advertises.
    schema = vehicle_aging_finding_v1_schema()
    assert schema["title"] == "VehicleAgingFindingV1"
    assert schema["additionalProperties"] is False
    assert sorted(schema["required"]) == ["rationale", "recommended_action", "vehicle_id"]

    migration = (_REPO_ROOT / "supabase/migrations/20260626140000_vehicle_aging_agent.sql").read_text()
    match = re.search(r"'(\{.*?\})'::jsonb", migration, re.S)
    assert match, "expected an embedded jsonb schema literal in the migration"
    registry = json.loads(match.group(1))
    assert registry["title"] == "VehicleAgingFindingV1"
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
                    "rationale": "200 days in stock; floor-plan exposure rising",
                }
            )
        ]
    )
    result = await run_vehicle_aging_analyst(
        {"vehicle_id": "veh-1", "tenant_id": _TENANT},
        system_prompt="You are a vehicle stock-aging analyst.",
        user_prompt_template="Assess veh-1.",
        transport=transport,
    )

    # No tools were offered, so the closed-loop never sends a tool_choice (the
    # Azure transport only sets tool_choice when the tools list is non-empty).
    assert transport.tools_seen == [[]]
    assert len(transport.calls) == 1  # single round, no tool turn
    assert result == {
        "vehicle_id": "veh-1",
        "finding_type": "stock_aging_90d",
        "severity": "medium",
        "days_in_stock": 0,
        "aging_bucket": "approaching",
        "recommended_action": "wholesale_auction",
        "estimated_exposure": 0.0,
        "evidence": [],
        "confidence": 0.0,
        "rationale": "200 days in stock; floor-plan exposure rising",
    }


@pytest.mark.asyncio
async def test_run_vehicle_aging_analyst_rejects_extra_field_from_model() -> None:
    # extra=forbid is enforced end-to-end: a model response with an unknown key
    # never validates, and after the bounded retry the run fails closed.
    bad = {
        "vehicle_id": "veh-1",
        "recommended_action": "markdown",
        "rationale": "aged",
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
# AC: scope = em_estoque AND days_in_stock >= 75, ordered desc; sold + <75d excluded.
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


def _vehicle_row(vehicle_id: str, *, days: int, status: str = "em_estoque", floor: float = 0.0) -> dict[str, Any]:
    return {
        "entity_id": vehicle_id,
        "source_record_id": f"demo-dia-{vehicle_id}",
        "name": f"Car {vehicle_id}",
        "condition": "usado",
        "brand": "Brand",
        "model": "Model",
        "model_year": 2022,
        "cost": 100000.0,
        "sale_price": 130000.0,
        "store": "Matriz",
        "status": status,
        "days_in_stock": days,
        "floor_plan_cost": floor,
    }


@pytest.fixture()
def fake_vehicle_view(monkeypatch: pytest.MonkeyPatch) -> _FakeSelectClient:
    # Mirror of the seed dataset: six in-stock vehicles >= 75d, two controls
    # below the threshold, and one sold vehicle (300d) that must be filtered out
    # by the em_estoque predicate even though it is the oldest.
    rows = [
        _vehicle_row("veh-120", days=120, floor=4273.97),
        _vehicle_row("veh-90", days=90, floor=3205.48),
        _vehicle_row("veh-89", days=89, floor=3169.86),
        _vehicle_row("veh-86", days=86, floor=3063.01),
        _vehicle_row("veh-80", days=80, floor=2849.32),
        _vehicle_row("veh-75", days=75, floor=2671.23),
        _vehicle_row("veh-74", days=74, floor=2635.62),  # below threshold -> excluded
        _vehicle_row("veh-45", days=45, floor=1602.74),  # below threshold -> excluded
        _vehicle_row("veh-sold", days=300, status="vendido", floor=10684.93),  # sold -> excluded
    ]
    client = _FakeSelectClient({"v_dia_vehicle_current": rows})
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    return client


def test_scope_filters_status_threshold_and_orders_desc(fake_vehicle_view: _FakeSelectClient) -> None:
    scoped = ops_scope_vehicle_aging(_TENANT, {})

    ids = [item["vehicle_id"] for item in scoped]
    # Exactly the six em_estoque vehicles >= 75d, sorted by days_in_stock desc.
    assert ids == ["veh-120", "veh-90", "veh-89", "veh-86", "veh-80", "veh-75"]
    # The sold (300d) and the < 75d controls are gone.
    assert "veh-sold" not in ids
    assert "veh-74" not in ids
    assert "veh-45" not in ids

    by_id = {item["vehicle_id"]: item for item in scoped}
    assert by_id["veh-120"]["severity"] == "critical"
    assert by_id["veh-120"]["aging_bucket"] == "breached"
    assert by_id["veh-90"]["severity"] == "high"
    assert by_id["veh-89"]["severity"] == "high"
    assert by_id["veh-86"]["severity"] == "high"
    assert by_id["veh-80"]["severity"] == "medium"
    assert by_id["veh-75"]["severity"] == "medium"
    assert by_id["veh-75"]["aging_bucket"] == "approaching"

    # At least one of each severity is present (spec: medium/high/critical).
    assert {item["severity"] for item in scoped} == {"medium", "high", "critical"}

    # Deterministic dedupe fields + exposure derived from the view.
    sample = by_id["veh-86"]
    assert sample["fingerprint"] == _stock_aging_fingerprint(_TENANT, "veh-86")
    assert sample["finding_type"] == "stock_aging_90d"
    assert sample["estimated_exposure"] == 3063.01
    assert sample["floor_plan_cost"] == 3063.01
    assert sample["tenant_id"] == _TENANT


def test_scope_respects_max_vehicles_bound(fake_vehicle_view: _FakeSelectClient) -> None:
    scoped = ops_scope_vehicle_aging(_TENANT, {"max_vehicles": 2})
    assert [item["vehicle_id"] for item in scoped] == ["veh-120", "veh-90"]


def test_scope_threshold_override_excludes_below_new_warning(fake_vehicle_view: _FakeSelectClient) -> None:
    # Raise the warning line to 85: only 85..90 + breached survive.
    scoped = ops_scope_vehicle_aging(_TENANT, {"thresholds": {"aging_warning_days": 85}})
    assert [item["vehicle_id"] for item in scoped] == ["veh-120", "veh-90", "veh-89", "veh-86"]


# ===========================================================================
# Workflow — VehicleAgingWorkflow against a stubbed activity layer
# AC: dedup (recorded=0/deduped=N on re-run), auto_apply stays false, bounding,
#     summary keys, and fire-and-forget (no approval blocking).
# ===========================================================================

_WORKFLOW_KEY = "vehicle-aging-analyst"


def _default_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "auto_apply": False,
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 0},
        "thresholds": {"aging_warning_days": 75, "aging_breach_days": 90},
        "system_prompt": "s",
        "user_prompt_template": "u",
        "tools": [],
    }
    base.update(overrides)
    return base


def _scoped_vehicle(vehicle_id: str, *, days: int, severity: str, bucket: str, floor: float) -> dict[str, Any]:
    return {
        "vehicle_id": vehicle_id,
        "tenant_id": _TENANT,
        "days_in_stock": days,
        "severity": severity,
        "aging_bucket": bucket,
        "brand": "Brand",
        "model": "Model",
        "model_year": 2022,
        "store": "Matriz",
        "condition": "usado",
        "cost": 100000.0,
        "sale_price": 130000.0,
        "floor_plan_cost": floor,
        "estimated_exposure": floor,
        "fingerprint": _stock_aging_fingerprint(_TENANT, vehicle_id),
    }


def _build_harness(
    *,
    config: dict[str, Any],
    scoped: list[dict[str, Any]],
    assessment_by_vehicle: dict[str, dict[str, Any]],
    existing_fingerprints: list[str] | None = None,
):
    state: dict[str, Any] = {
        "recorded_findings": [],
        "finalized": None,
        "created_workflow_key": None,
        "assess_kwargs": [],
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
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    return state, fake_execute_activity


def _assessment(recommended_action: str = "markdown", rationale: str = "aged") -> dict[str, Any]:
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


@pytest.mark.asyncio
async def test_workflow_records_all_findings_when_none_open() -> None:
    scoped = [
        _scoped_vehicle("veh-120", days=120, severity="critical", bucket="breached", floor=4273.97),
        _scoped_vehicle("veh-86", days=86, severity="high", bucket="imminent", floor=3063.01),
        _scoped_vehicle("veh-80", days=80, severity="medium", bucket="approaching", floor=2849.32),
    ]
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

    # Recorded in days_in_stock-desc order, carrying severity + the LLM action.
    recorded_ids = [f["vehicle_id"] for f in state["recorded_findings"]]
    assert recorded_ids == ["veh-120", "veh-86", "veh-80"]
    first = state["recorded_findings"][0]
    assert first["severity"] == "critical"
    assert first["recommended_action"] == "markdown"
    assert first["finding_type"] == "stock_aging_90d"
    assert first["fingerprint"] == _stock_aging_fingerprint(_TENANT, "veh-120")
    # Fire-and-forget: the run finalised without ever blocking on approval.
    assert state["finalized"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_workflow_dedupes_when_all_fingerprints_already_open() -> None:
    scoped = [
        _scoped_vehicle("veh-120", days=120, severity="critical", bucket="breached", floor=4273.97),
        _scoped_vehicle("veh-86", days=86, severity="high", bucket="imminent", floor=3063.01),
        _scoped_vehicle("veh-80", days=80, severity="medium", bucket="approaching", floor=2849.32),
    ]
    assessment = {v["vehicle_id"]: _assessment() for v in scoped}
    existing = [_stock_aging_fingerprint(_TENANT, v["vehicle_id"]) for v in scoped]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_vehicle=assessment,
        existing_fingerprints=existing,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    # Re-run dedupe: nothing recorded, every scoped vehicle deduped.
    assert result["total_vehicles_scoped"] == 3
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 3
    assert result["processed_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_dedupes_only_already_open_fingerprints() -> None:
    scoped = [
        _scoped_vehicle("veh-120", days=120, severity="critical", bucket="breached", floor=4273.97),
        _scoped_vehicle("veh-86", days=86, severity="high", bucket="imminent", floor=3063.01),
        _scoped_vehicle("veh-80", days=80, severity="medium", bucket="approaching", floor=2849.32),
    ]
    assessment = {v["vehicle_id"]: _assessment() for v in scoped}
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_vehicle=assessment,
        existing_fingerprints=[_stock_aging_fingerprint(_TENANT, "veh-86")],
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["recorded_findings"] == 2
    assert result["deduped_findings"] == 1
    recorded_ids = [f["vehicle_id"] for f in state["recorded_findings"]]
    assert recorded_ids == ["veh-120", "veh-80"]


@pytest.mark.asyncio
async def test_workflow_forces_auto_apply_false_even_if_config_enables_it() -> None:
    scoped = [_scoped_vehicle("veh-120", days=120, severity="critical", bucket="breached", floor=4273.97)]
    assessment = {"veh-120": _assessment()}
    harness = _build_harness(
        config=_default_config(auto_apply=True),
        scoped=scoped,
        assessment_by_vehicle=assessment,
    )
    result = await _run_workflow(harness)
    assert result["auto_apply"] is False


@pytest.mark.asyncio
async def test_workflow_bounds_processed_findings_and_reports_remainder() -> None:
    scoped = [
        _scoped_vehicle("veh-120", days=120, severity="critical", bucket="breached", floor=4273.97),
        _scoped_vehicle("veh-86", days=86, severity="high", bucket="imminent", floor=3063.01),
        _scoped_vehicle("veh-80", days=80, severity="medium", bucket="approaching", floor=2849.32),
    ]
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
    # The single processed finding is the most-aged one (days desc ordering).
    assert state["recorded_findings"][0]["vehicle_id"] == "veh-120"


@pytest.mark.asyncio
async def test_workflow_empty_scope_finalizes_and_persists_workflow_key() -> None:
    harness = _build_harness(config=_default_config(), scoped=[], assessment_by_vehicle={})
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_vehicles_scoped"] == 0
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 0
    assert result["run_id"] == "run-1"
    # The run row is keyed by the agent key so ops_agent_status_view can align.
    assert state["created_workflow_key"] == _WORKFLOW_KEY
    assert state["finalized"] is not None


@pytest.mark.asyncio
async def test_workflow_assess_activity_has_heartbeat_timeout_and_retry_cap() -> None:
    # ADR-0003 wiring: the LLM activity runs with a 45 s heartbeat timeout and a
    # retry cap of 2 attempts. This fails if either is reverted.
    scoped = [_scoped_vehicle("veh-120", days=120, severity="critical", bucket="breached", floor=4273.97)]
    assessment = {"veh-120": _assessment()}
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
# Worker registration + import hygiene
# AC: worker registers VehicleAgingWorkflow + activities; no rental_* imports.
# ===========================================================================


def test_vehicle_aging_workflow_and_activities_are_registered_in_worker() -> None:
    from temporal.tests.test_worker_registration import (
        _extract_worker_activity_references,
        _extract_worker_workflow_references,
    )

    # The workflow class is decorated and registered.
    assert hasattr(VehicleAgingWorkflow, "__temporal_workflow_definition")
    assert "VehicleAgingWorkflow" in _extract_worker_workflow_references()

    # Every @activity.defn in ops_vehicle_aging is wired into Worker(activities=[...]).
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
