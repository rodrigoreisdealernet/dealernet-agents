"""Tests for the Service Estimate Authorization Rescue Agent (issue #81).

Mirrors ``test_ops_vehicle_aging.py`` (which itself mirrors the revrec test
conventions): a ``_FakeTransport`` stands in for the Azure LLM, a fake
persistence client stands in for Supabase, the deterministic helpers are
unit-tested directly, and the workflow is driven against a stubbed activity
layer by patching ``temporalio.workflow.execute_activity``.

Every test traces back to an acceptance criterion in
``docs/prd/2026-06-25-agente-resgate-orcamento-oficina.md`` §7 (AC-B1..AC-B8)
and ``docs/specs/81-feat-ops-agente-dia-de.md``.
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
from temporal.src.activities import ops_revrec, ops_service_estimate
from temporal.src.activities.ops_service_estimate import (
    _estimate_fingerprint,
    _service_estimate_finding_for_storage,
    _severity_for,
    ops_scope_service_estimates,
)
from temporal.src.agents.openai_client import StructuredOutputRetriesExceededError
from temporal.src.agents.service_estimate_rescue import (
    ServiceEstimateFindingV1,
    run_service_estimate_rescue,
    service_estimate_finding_v1_schema,
)
from temporal.src.workflows.ops.service_estimate_rescue import (
    ServiceEstimateRescueWorkflow,
    ServiceEstimateRescueWorkflowInput,
)

_TENANT = "tenant-a"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NEW_SOURCE_FILES = (
    "temporal/src/agents/service_estimate_rescue.py",
    "temporal/src/activities/ops_service_estimate.py",
    "temporal/src/workflows/ops/service_estimate_rescue.py",
    "temporal/scripts/run_service_estimate_rescue.py",
)


# ===========================================================================
# Deterministic helpers — severity, fingerprint, finding row shaping
# AC-B3: severity is high for declined and for pending with line_value >= the
#        high-value threshold, else medium.
# AC-B6: finding row maps contract_id/line_item_id/delta/proposed_action/...
# ===========================================================================


def test_severity_for_declined_is_always_high() -> None:
    # AC-B3: a declined estimate is a confirmed lost sale -> always high,
    # regardless of its recoverable value (even below the high-value line).
    assert _severity_for("declined", 0.0) == "high"
    assert _severity_for("declined", 100.0) == "high"
    assert _severity_for("declined", 50000.0) == "high"


def test_severity_for_pending_respects_high_value_threshold() -> None:
    # AC-B3: pending estimates are high only at or above the high-value line
    # (default 5000); below it they are medium.
    assert _severity_for("pending", 4999.99) == "medium"
    assert _severity_for("pending", 5000.0) == "high"
    assert _severity_for("pending", 5000.01) == "high"
    assert _severity_for("pending", 0.0) == "medium"


def test_severity_for_honours_custom_high_value_threshold() -> None:
    # Lowering the threshold escalates more pending estimates to high.
    assert _severity_for("pending", 2000.0, high_value_threshold=1500.0) == "high"
    assert _severity_for("pending", 1499.99, high_value_threshold=1500.0) == "medium"


def test_estimate_fingerprint_is_exact_sha256() -> None:
    # AC-B3: fingerprint = sha256(f"{tenant_id}:{estimate_id}:estimate_rescue").
    expected = hashlib.sha256(f"{_TENANT}:est-1:estimate_rescue".encode()).hexdigest()
    assert _estimate_fingerprint(_TENANT, "est-1") == expected
    # Deterministic and estimate/tenant-scoped.
    assert _estimate_fingerprint(_TENANT, "est-1") == _estimate_fingerprint(_TENANT, "est-1")
    assert _estimate_fingerprint(_TENANT, "est-1") != _estimate_fingerprint(_TENANT, "est-2")
    assert _estimate_fingerprint(_TENANT, "est-1") != _estimate_fingerprint("tenant-b", "est-1")


def test_service_estimate_finding_for_storage_maps_canonical_finding_row() -> None:
    # AC-B6: contract_id = parent OS id; line_item_id = NULL; delta = recoverable
    # value; proposed_action = recommended_action; expected carries the estimate
    # facts; billed = {}.
    finding = {
        "estimate_id": "est-uuid-123",
        "os_id": "os-uuid-999",
        "tenant_id": _TENANT,
        "finding_type": "estimate_rescue",
        "severity": "high",
        "estimate_status": "declined",
        "line_value": 8000.0,
        "recoverable_value": 8000.0,
        "lost_sale_reason": "preco",
        "customer": "Cliente Sul",
        "vehicle": "Kicks 2026",
        "order_number": "OS-1001",
        "recommended_action": "contact_customer",
        "evidence": ["declined for price"],
        "confidence": 0.7,
        "rationale": "high-value lost sale worth a follow-up",
    }
    row = _service_estimate_finding_for_storage(finding)

    assert row["contract_id"] == "os-uuid-999"
    assert row["line_item_id"] is None
    assert row["delta"] == 8000.0
    assert row["proposed_action"] == "contact_customer"
    assert row["finding_type"] == "estimate_rescue"
    assert row["severity"] == "high"
    assert row["billed"] == {}
    # tenant/fingerprint carry through the spread so the upsert key survives.
    assert row["tenant_id"] == _TENANT
    # estimate_id is not a contract uuid, so it rides in `expected` instead of
    # line_item_id.
    assert row["expected"]["estimate_id"] == "est-uuid-123"
    assert row["expected"]["estimate_status"] == "declined"
    assert row["expected"]["line_value"] == 8000.0
    assert row["expected"]["lost_sale_reason"] == "preco"
    assert row["expected"]["customer"] == "Cliente Sul"


def test_service_estimate_finding_for_storage_defaults_type_and_severity() -> None:
    row = _service_estimate_finding_for_storage(
        {"estimate_id": "est-9", "os_id": "os-9", "recoverable_value": 10.0, "recommended_action": "monitor"}
    )
    assert row["contract_id"] == "os-9"
    assert row["line_item_id"] is None
    assert row["finding_type"] == "estimate_rescue"
    assert row["severity"] == "medium"
    assert row["delta"] == 10.0
    assert row["proposed_action"] == "monitor"
    assert row["billed"] == {}


# ===========================================================================
# Agent surface — pydantic schema + run_service_estimate_rescue (no tools)
# AC-B1: schema parity with the migration registry row.
# AC-B2: NO tools => transport never sees a tools list; extra=forbid.
# ===========================================================================


def test_finding_v1_rejects_extra_fields() -> None:
    valid = ServiceEstimateFindingV1(
        estimate_id="est-1", recommended_action="contact_customer", rationale="declined lost sale"
    )
    assert valid.finding_type == "estimate_rescue"
    assert valid.severity == "medium"
    assert valid.os_id == ""
    assert valid.recoverable_value == 0.0

    with pytest.raises(ValidationError):
        ServiceEstimateFindingV1(
            estimate_id="est-1",
            recommended_action="contact_customer",
            rationale="declined",
            surprise="not allowed",  # type: ignore[call-arg]
        )


def test_finding_v1_schema_matches_db_registry_contract() -> None:
    # AC-B1: the Python output model and the migration's ops_output_schema_registry
    # row must agree, or the worker would validate against a different contract
    # than the DB advertises.
    schema = service_estimate_finding_v1_schema()
    assert schema["title"] == "ServiceEstimateFindingV1"
    assert schema["additionalProperties"] is False
    assert sorted(schema["required"]) == ["estimate_id", "rationale", "recommended_action"]

    migration = (
        _REPO_ROOT / "supabase/migrations/20260627090100_service_estimate_rescue_agent.sql"
    ).read_text()
    match = re.search(r"'(\{.*?\})'::jsonb", migration, re.S)
    assert match, "expected an embedded jsonb schema literal in the migration"
    registry = json.loads(match.group(1))
    assert registry["title"] == "ServiceEstimateFindingV1"
    assert registry["additionalProperties"] is False
    assert sorted(registry["required"]) == ["estimate_id", "rationale", "recommended_action"]
    assert sorted(registry["required"]) == sorted(schema["required"])
    assert set(registry["properties"]) == set(schema["properties"])


class _FakeTransport:
    """Mirror of the revrec/vehicle-aging ``_FakeTransport`` that records tools."""

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
async def test_run_service_estimate_rescue_sends_no_tools_and_returns_validated_finding() -> None:
    transport = _FakeTransport(
        [
            _assistant_json(
                {
                    "estimate_id": "est-1",
                    "recommended_action": "contact_customer",
                    "rationale": "high-value declined estimate; worth a recovery call",
                }
            )
        ]
    )
    result = await run_service_estimate_rescue(
        {"estimate_id": "est-1", "tenant_id": _TENANT},
        system_prompt="You are a service-estimate authorization rescue analyst.",
        user_prompt_template="Assess est-1.",
        transport=transport,
    )

    # AC-B2: no tools were offered, so the closed-loop never sends a tool_choice
    # (the transport only sets tool_choice when the tools list is non-empty).
    assert transport.tools_seen == [[]]
    assert len(transport.calls) == 1  # single round, no tool turn
    assert result == {
        "estimate_id": "est-1",
        "os_id": "",
        "finding_type": "estimate_rescue",
        "severity": "medium",
        "recommended_action": "contact_customer",
        "recoverable_value": 0.0,
        "evidence": [],
        "confidence": 0.0,
        "rationale": "high-value declined estimate; worth a recovery call",
    }


@pytest.mark.asyncio
async def test_run_service_estimate_rescue_rejects_extra_field_from_model() -> None:
    # AC-B2: extra=forbid is enforced end-to-end: a model response with an unknown
    # key never validates, and after the bounded retry the run fails closed.
    bad = {
        "estimate_id": "est-1",
        "recommended_action": "contact_customer",
        "rationale": "declined",
        "ai_hallucinated_field": 1,
    }
    transport = _FakeTransport([_assistant_json(bad), _assistant_json(bad)])
    with pytest.raises(StructuredOutputRetriesExceededError):
        await run_service_estimate_rescue(
            {"estimate_id": "est-1"},
            system_prompt="s",
            user_prompt_template="u",
            transport=transport,
        )
    # Still no tools across both schema attempts.
    assert transport.tools_seen == [[], []]


# ===========================================================================
# Scope activity — ops_scope_service_estimates against a faked view
# AC-B3: only non-cancelled pending/declined returned, ordered declined-then-
#        value-desc; severity high for declined and high-value pending; each row
#        carries the fingerprint / finding_type / recoverable_value; bounded.
# ===========================================================================


class _FakeServiceEstimateView:
    """Persistence stub that models ``v_dia_service_estimate_current``.

    The SQL view (Phase A, exercised by psql in AC-A1) already excludes
    ``cancelada`` OS payloads and estimates whose status is neither ``pending``
    nor ``declined``. This fake mirrors that contract so the activity test
    documents that authorized/cancelled estimates never reach a finding, while
    still exercising the activity's real deterministic work (severity, ordering,
    fingerprint, recoverable value, bounding).
    """

    def __init__(self, raw_rows: list[dict[str, Any]]) -> None:
        # Apply the view predicate up front, exactly as the SQL view would.
        self._rows = [
            {k: v for k, v in row.items() if k != "_os_cancelled"}
            for row in raw_rows
            if not row.get("_os_cancelled", False)
            and str(row.get("estimate_status") or "pending") in ("pending", "declined")
        ]

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
        assert resource == "v_dia_service_estimate_current"
        rows = [dict(row) for row in self._rows]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if row.get(key) == value]
        if limit is not None:
            rows = rows[:limit]
        return rows


def _raw_estimate_row(
    estimate_id: str,
    *,
    status: str,
    line_value: float,
    rank: int,
    os_id: str | None = None,
    os_cancelled: bool = False,
    lost_sale_reason: str | None = None,
) -> dict[str, Any]:
    return {
        "estimate_id": estimate_id,
        "os_id": os_id or f"os-{estimate_id}",
        "source_record_id": f"demo-dia-{estimate_id}",
        "order_number": f"ON-{estimate_id}",
        "customer": f"Cliente {estimate_id}",
        "vehicle": f"Carro {estimate_id}",
        "technician": "Tecnico A",
        "estimate_status": status,
        "line_value": line_value,
        "lost_sale_reason": lost_sale_reason,
        "estimate_description": f"Servico {estimate_id}",
        "recovery_rank": rank,
        "_os_cancelled": os_cancelled,
    }


@pytest.fixture()
def fake_estimate_view(monkeypatch: pytest.MonkeyPatch) -> _FakeServiceEstimateView:
    # Mirror of the seed dataset: declined + pending + a high-value pending, plus
    # an authorized estimate and a cancelada-OS estimate that the view excludes.
    rows = [
        _raw_estimate_row("est-decl-8000", status="declined", line_value=8000.0, rank=0, lost_sale_reason="preco"),
        _raw_estimate_row("est-decl-1200", status="declined", line_value=1200.0, rank=0, lost_sale_reason="prazo"),
        _raw_estimate_row("est-pend-6000", status="pending", line_value=6000.0, rank=1),
        _raw_estimate_row("est-pend-1200", status="pending", line_value=1200.0, rank=1),
        # Excluded by the view: an authorized estimate is no longer a lost sale.
        _raw_estimate_row("est-auth-9999", status="authorized", line_value=9999.0, rank=2),
        # Excluded by the view: a pending estimate on a cancelled OS.
        _raw_estimate_row("est-cancel-7000", status="pending", line_value=7000.0, rank=1, os_cancelled=True),
    ]
    client = _FakeServiceEstimateView(rows)
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    return client


def test_scope_filters_status_orders_and_scores(fake_estimate_view: _FakeServiceEstimateView) -> None:
    scoped = ops_scope_service_estimates(_TENANT, {})

    ids = [item["estimate_id"] for item in scoped]
    # Exactly the four non-cancelled pending/declined estimates, ordered
    # declined-before-pending then line_value desc.
    assert ids == ["est-decl-8000", "est-decl-1200", "est-pend-6000", "est-pend-1200"]
    # Authorized + cancelada-OS estimates never surface.
    assert "est-auth-9999" not in ids
    assert "est-cancel-7000" not in ids

    by_id = {item["estimate_id"]: item for item in scoped}
    # AC-B3: declined is always high; pending high only at/above the threshold.
    assert by_id["est-decl-8000"]["severity"] == "high"
    assert by_id["est-decl-1200"]["severity"] == "high"  # declined, even though < 5000
    assert by_id["est-pend-6000"]["severity"] == "high"  # pending >= 5000
    assert by_id["est-pend-1200"]["severity"] == "medium"  # pending < 5000
    assert {item["severity"] for item in scoped} == {"high", "medium"}

    # Deterministic dedupe / money fields derived from the view.
    sample = by_id["est-decl-8000"]
    assert sample["fingerprint"] == _estimate_fingerprint(_TENANT, "est-decl-8000")
    assert sample["finding_type"] == "estimate_rescue"
    assert sample["recoverable_value"] == 8000.0
    assert sample["line_value"] == 8000.0
    assert sample["os_id"] == "os-est-decl-8000"
    assert sample["tenant_id"] == _TENANT
    assert sample["lost_sale_reason"] == "preco"


def test_scope_respects_max_estimates_bound(fake_estimate_view: _FakeServiceEstimateView) -> None:
    scoped = ops_scope_service_estimates(_TENANT, {"max_estimates": 2})
    assert [item["estimate_id"] for item in scoped] == ["est-decl-8000", "est-decl-1200"]


def test_scope_high_value_threshold_override_changes_pending_severity(
    fake_estimate_view: _FakeServiceEstimateView,
) -> None:
    # Lowering the high-value line escalates the cheap pending estimate to high.
    scoped = ops_scope_service_estimates(_TENANT, {"thresholds": {"high_value_threshold": 1000.0}})
    by_id = {item["estimate_id"]: item for item in scoped}
    assert by_id["est-pend-1200"]["severity"] == "high"


# ===========================================================================
# Workflow — ServiceEstimateRescueWorkflow against a stubbed activity layer
# AC-B4: happy path records all + empty-scope no-op; AC-B5: dedupe + bounding.
# ===========================================================================

_WORKFLOW_KEY = "service-estimate-rescue"


def _default_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "auto_apply": False,
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 0},
        "thresholds": {"high_value_threshold": 5000.0},
        "system_prompt": "s",
        "user_prompt_template": "u",
        "tools": [],
    }
    base.update(overrides)
    return base


def _scoped_estimate(
    estimate_id: str,
    *,
    status: str,
    rank: int,
    line_value: float,
    severity: str,
    os_id: str | None = None,
) -> dict[str, Any]:
    return {
        "estimate_id": estimate_id,
        "os_id": os_id or f"os-{estimate_id}",
        "tenant_id": _TENANT,
        "order_number": f"ON-{estimate_id}",
        "customer": f"Cliente {estimate_id}",
        "vehicle": f"Carro {estimate_id}",
        "technician": "Tecnico A",
        "estimate_status": status,
        "line_value": line_value,
        "recoverable_value": line_value,
        "lost_sale_reason": "preco" if status == "declined" else None,
        "estimate_description": f"Servico {estimate_id}",
        "severity": severity,
        "recovery_rank": rank,
        "finding_type": "estimate_rescue",
        "fingerprint": _estimate_fingerprint(_TENANT, estimate_id),
    }


def _build_harness(
    *,
    config: dict[str, Any],
    scoped: list[dict[str, Any]],
    assessment_by_estimate: dict[str, dict[str, Any]],
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
        if fn_name == "ops_scope_service_estimates":
            return scoped
        if fn_name == "ops_service_estimate_assess":
            state["assess_kwargs"].append(kw)
            return assessment_by_estimate[str(args[0]["estimate_id"])]
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    return state, fake_execute_activity


def _assessment(recommended_action: str = "contact_customer", rationale: str = "rescue") -> dict[str, Any]:
    return {
        "estimate_id": "ignored",
        "recommended_action": recommended_action,
        "evidence": ["evidence line"],
        "confidence": 0.6,
        "rationale": rationale,
    }


async def _run_workflow(state_execute) -> dict[str, Any]:  # noqa: ANN001
    _, fake_execute = state_execute
    wf = ServiceEstimateRescueWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_service_estimate_workflow"), create=True),
    ):
        return await wf.run(ServiceEstimateRescueWorkflowInput(tenant_id=_TENANT))


def _three_scoped() -> list[dict[str, Any]]:
    # Order by (recovery_rank asc, line_value desc): A, B, C.
    return [
        _scoped_estimate("est-A", status="declined", rank=0, line_value=8000.0, severity="high"),
        _scoped_estimate("est-B", status="declined", rank=0, line_value=1200.0, severity="high"),
        _scoped_estimate("est-C", status="pending", rank=1, line_value=6000.0, severity="high"),
    ]


@pytest.mark.asyncio
async def test_workflow_records_all_findings_when_none_open() -> None:
    # AC-B4: three scoped, no open fingerprints -> recorded 3, deduped 0.
    scoped = _three_scoped()
    assessment = {v["estimate_id"]: _assessment() for v in scoped}
    harness = _build_harness(config=_default_config(), scoped=scoped, assessment_by_estimate=assessment)
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["status"] == "succeeded"
    assert result["run_id"] == "run-1"
    assert result["total_estimates_scoped"] == 3
    assert result["recorded_findings"] == 3
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 3
    assert result["remaining_findings_count"] == 0
    assert result["auto_apply"] is False
    assert len(state["recorded_findings"]) == 3

    # Recorded in (recovery_rank asc, line_value desc) order, carrying severity +
    # the LLM action + the canonical finding type.
    recorded_ids = [f["estimate_id"] for f in state["recorded_findings"]]
    assert recorded_ids == ["est-A", "est-B", "est-C"]
    first = state["recorded_findings"][0]
    assert first["severity"] == "high"
    assert first["recommended_action"] == "contact_customer"
    assert first["finding_type"] == "estimate_rescue"
    assert first["fingerprint"] == _estimate_fingerprint(_TENANT, "est-A")
    # Fire-and-forget: the run finalised without ever blocking on approval.
    assert state["finalized"]["status"] == "succeeded"
    assert state["finalized"]["auto_apply"] is False


@pytest.mark.asyncio
async def test_workflow_dedupes_when_all_fingerprints_already_open() -> None:
    # AC-B5: all three scoped fingerprints already open -> recorded 0, deduped 3.
    scoped = _three_scoped()
    assessment = {v["estimate_id"]: _assessment() for v in scoped}
    existing = [_estimate_fingerprint(_TENANT, v["estimate_id"]) for v in scoped]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_estimate=assessment,
        existing_fingerprints=existing,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_estimates_scoped"] == 3
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 3
    assert result["processed_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_dedupes_only_already_open_fingerprints() -> None:
    # AC-B5: one open -> recorded 2, deduped 1.
    scoped = _three_scoped()
    assessment = {v["estimate_id"]: _assessment() for v in scoped}
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_estimate=assessment,
        existing_fingerprints=[_estimate_fingerprint(_TENANT, "est-B")],
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["recorded_findings"] == 2
    assert result["deduped_findings"] == 1
    recorded_ids = [f["estimate_id"] for f in state["recorded_findings"]]
    assert recorded_ids == ["est-A", "est-C"]


@pytest.mark.asyncio
async def test_workflow_forces_auto_apply_false_even_if_config_enables_it() -> None:
    # AC-B4 / SEC-B1: v1 invariant — never auto-apply.
    scoped = [_scoped_estimate("est-A", status="declined", rank=0, line_value=8000.0, severity="high")]
    assessment = {"est-A": _assessment()}
    harness = _build_harness(
        config=_default_config(auto_apply=True),
        scoped=scoped,
        assessment_by_estimate=assessment,
    )
    result = await _run_workflow(harness)
    assert result["auto_apply"] is False


@pytest.mark.asyncio
async def test_workflow_bounds_processed_findings_and_reports_remainder() -> None:
    # AC-B5: max_findings_per_run=1 -> processed 1, remaining 2, keeping top-rank.
    scoped = _three_scoped()
    assessment = {v["estimate_id"]: _assessment() for v in scoped}
    harness = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 1, "max_tool_rounds": 0}),
        scoped=scoped,
        assessment_by_estimate=assessment,
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["processed_findings"] == 1
    assert result["remaining_findings_count"] == 2
    assert result["recorded_findings"] == 1
    assert len(state["recorded_findings"]) == 1
    # The single processed finding is the top-ranked one (declined, highest value).
    assert state["recorded_findings"][0]["estimate_id"] == "est-A"


@pytest.mark.asyncio
async def test_workflow_empty_scope_finalizes_and_persists_workflow_key() -> None:
    # AC-B4: empty scope -> total_estimates_scoped 0, records nothing, still
    # finalizes the run keyed by the agent key.
    harness = _build_harness(config=_default_config(), scoped=[], assessment_by_estimate={})
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_estimates_scoped"] == 0
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 0
    assert result["run_id"] == "run-1"
    assert state["created_workflow_key"] == _WORKFLOW_KEY
    assert state["finalized"] is not None
    assert state["finalized"]["total_estimates_scoped"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_assess_activity_has_heartbeat_timeout_and_retry_cap() -> None:
    # ADR-0003 wiring: the LLM activity runs with a 45 s heartbeat timeout and a
    # retry cap of 2 attempts. This fails if either is reverted.
    scoped = [_scoped_estimate("est-A", status="declined", rank=0, line_value=8000.0, severity="high")]
    assessment = {"est-A": _assessment()}
    harness = _build_harness(config=_default_config(), scoped=scoped, assessment_by_estimate=assessment)
    state, _ = harness

    await _run_workflow(harness)

    assert state["assess_kwargs"], "ops_service_estimate_assess was never called"
    kw = state["assess_kwargs"][0]
    heartbeat_timeout = kw.get("heartbeat_timeout")
    assert heartbeat_timeout is not None
    assert heartbeat_timeout.total_seconds() == 45
    retry_policy = kw.get("retry_policy")
    assert retry_policy is not None
    assert retry_policy.maximum_attempts == 2


# ===========================================================================
# Worker registration + import hygiene
# AC-B7: registration is covered by test_worker_registration.py (not duplicated);
#        here we sanity-check the workflow is decorated and every activity wires.
# AC-B8: new files must not import any rental_* module.
# ===========================================================================


def test_service_estimate_workflow_and_activities_are_registered_in_worker() -> None:
    from temporal.tests.test_worker_registration import (
        _extract_worker_activity_references,
        _extract_worker_workflow_references,
    )

    assert hasattr(ServiceEstimateRescueWorkflow, "__temporal_workflow_definition")
    assert "ServiceEstimateRescueWorkflow" in _extract_worker_workflow_references()

    import inspect

    decorated = {
        name
        for name, obj in inspect.getmembers(ops_service_estimate)
        if (
            callable(obj)
            and hasattr(obj, "__temporal_activity_definition")
            and inspect.getmodule(obj) is ops_service_estimate
        )
    }
    assert decorated, "expected @activity.defn functions in ops_service_estimate"

    registered = {fn for alias, fn in _extract_worker_activity_references() if alias == "ops_service_estimate"}
    unregistered = sorted(decorated - registered)
    assert not unregistered, f"ops_service_estimate activities not registered in worker.py: {unregistered}"


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
