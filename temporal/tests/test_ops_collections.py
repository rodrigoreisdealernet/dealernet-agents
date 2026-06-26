"""Tests for the Collections Prioritizer ops agent (issue #82).

Mirrors ``test_ops_vehicle_aging.py``: deterministic helpers are tested directly,
the LLM surface uses a fake transport, Supabase reads are faked, and the workflow
is driven by patching ``temporalio.workflow.execute_activity``.
"""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import re
from collections.abc import Mapping
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import temporalio.workflow as tw_mod
from pydantic import ValidationError
from temporal.src.activities import ops_collections, ops_revrec
from temporal.src.activities.ops_collections import (
    _bounded_evidence,
    _collections_finding_for_storage,
    _collections_fingerprint,
    _severity_for_days,
    ops_collections_assess,
    ops_scope_collections,
)
from temporal.src.agents.collections_prioritizer import (
    CollectionsFindingV1,
    collections_finding_v1_schema,
    run_collections_prioritizer,
)
from temporal.src.agents.openai_client import StructuredOutputRetriesExceededError
from temporal.src.workflows.ops.collections_prioritizer import (
    CollectionsPrioritizerWorkflow,
    CollectionsPrioritizerWorkflowInput,
)

_TENANT = "tenant-a"
_REPO_ROOT = Path(__file__).resolve().parents[2]
_TRIAD_FILES = (
    "temporal/src/agents/collections_prioritizer.py",
    "temporal/src/activities/ops_collections.py",
    "temporal/src/workflows/ops/collections_prioritizer.py",
)
_WORKFLOW_KEY = "collections-prioritizer"


def test_collections_fingerprint_is_exact_customer_scoped_sha256() -> None:
    expected = hashlib.sha256(f"{_TENANT}:cust-1:collections_priority".encode()).hexdigest()
    assert _collections_fingerprint(_TENANT, "cust-1") == expected
    assert _collections_fingerprint(_TENANT, "cust-1") == _collections_fingerprint(_TENANT, "cust-1")
    assert _collections_fingerprint(_TENANT, "cust-1") != _collections_fingerprint(_TENANT, "cust-2")
    assert _collections_fingerprint(_TENANT, "cust-1") != _collections_fingerprint("tenant-b", "cust-1")


def test_severity_for_days_bucket_boundaries() -> None:
    assert _severity_for_days(0) == "low"
    assert _severity_for_days(1) == "medium"
    assert _severity_for_days(30) == "medium"
    assert _severity_for_days(31) == "high"
    assert _severity_for_days(90) == "high"
    assert _severity_for_days(91) == "critical"


def test_collections_finding_for_storage_maps_and_bounds_pii_summary() -> None:
    long_note = "x" * 400
    finding = {
        "customer_id": "cust-1",
        "tenant_id": _TENANT,
        "finding_type": "collections_priority",
        "severity": "critical",
        "recommended_action": "renegotiate",
        "total_exposure": 9876.54,
        "days_overdue": 120,
        "next_step_note": long_note,
        "evidence": [f"note-{idx}-" + long_note for idx in range(7)],
        "confidence": 0.83,
        "rationale": "PROMISE-NOTE-SECRET " + ("z" * 600),
    }

    row = _collections_finding_for_storage(finding)

    assert row["contract_id"] == "cust-1"
    assert row["line_item_id"] is None
    assert row["delta"] == 9876.54
    assert row["proposed_action"] == "renegotiate"
    assert row["finding_type"] == "collections_priority"
    assert row["severity"] == "critical"
    assert row["billed"] == {}
    assert row["tenant_id"] == _TENANT
    assert len(row["evidence"]) == 5
    assert all(len(item) <= 240 for item in row["evidence"])
    assert all(item.endswith("…") for item in row["evidence"])
    assert row["expected"] == {
        "customer_id": "cust-1",
        "total_exposure": 9876.54,
        "days_overdue": 120,
        "predicted_breach_at": None,
        "days_to_breach": None,
        "recommended_action": "renegotiate",
        "next_step_note": row["expected"]["next_step_note"],
        "evidence_summary": row["evidence"],
    }
    assert len(row["expected"]["next_step_note"]) <= 240
    assert row["expected"]["next_step_note"].endswith("…")

    # SEC-3/AC-17: persisted rationale is bounded so model output cannot echo a
    # full contact-note transcript verbatim into the finding row / audit event.
    assert len(row["rationale"]) <= 500
    assert row["rationale"].endswith("…")
    assert ("z" * 600) not in row["rationale"]


def test_collections_finding_v1_rejects_extra_fields() -> None:
    valid = CollectionsFindingV1(customer_id="cust-1", recommended_action="call", rationale="overdue")
    assert valid.finding_type == "collections_priority"
    assert valid.severity == "medium"
    assert valid.total_exposure == 0.0

    with pytest.raises(ValidationError):
        CollectionsFindingV1(
            customer_id="cust-1",
            recommended_action="call",
            rationale="overdue",
            hallucinated="not allowed",  # type: ignore[call-arg]
        )


def test_collections_finding_v1_schema_matches_db_registry_contract_exactly() -> None:
    schema = collections_finding_v1_schema()
    assert schema["title"] == "CollectionsFindingV1"
    assert schema["additionalProperties"] is False
    assert sorted(schema["required"]) == ["customer_id", "rationale", "recommended_action"]

    migration = (_REPO_ROOT / "supabase/migrations/20260627130600_collections_prioritizer_agent.sql").read_text()
    match = re.search(r"'(\{.*?\})'::jsonb", migration, re.S)
    assert match, "expected an embedded jsonb schema literal in the collections migration"
    registry = json.loads(match.group(1))
    assert registry == schema


class _FakeTransport:
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
async def test_run_collections_prioritizer_sends_no_tools_and_returns_validated_finding() -> None:
    transport = _FakeTransport(
        [
            _assistant_json(
                {
                    "customer_id": "cust-1",
                    "severity": "high",
                    "recommended_action": "renegotiate",
                    "total_exposure": 5000.0,
                    "days_overdue": 64,
                    "next_step_note": "Call finance manager today.",
                    "evidence": ["64 days overdue"],
                    "confidence": 0.72,
                    "rationale": "large balance and broken promise",
                }
            )
        ]
    )

    result = await run_collections_prioritizer(
        {"customer_id": "cust-1", "tenant_id": _TENANT},
        system_prompt="You prioritize collections.",
        user_prompt_template="Assess cust-1.",
        transport=transport,
    )

    assert transport.tools_seen == [[]]
    assert len(transport.calls) == 1
    assert result == {
        "customer_id": "cust-1",
        "finding_type": "collections_priority",
        "severity": "high",
        "recommended_action": "renegotiate",
        "total_exposure": 5000.0,
        "days_overdue": 64,
        "next_step_note": "Call finance manager today.",
        "evidence": ["64 days overdue"],
        "confidence": 0.72,
        "rationale": "large balance and broken promise",
    }


@pytest.mark.asyncio
async def test_run_collections_prioritizer_rejects_extra_field_from_model() -> None:
    bad = {
        "customer_id": "cust-1",
        "recommended_action": "call",
        "rationale": "overdue",
        "unknown_extra": "fail closed",
    }
    transport = _FakeTransport([_assistant_json(bad), _assistant_json(bad)])

    with pytest.raises(StructuredOutputRetriesExceededError):
        await run_collections_prioritizer(
            {"customer_id": "cust-1"},
            system_prompt="s",
            user_prompt_template="u",
            transport=transport,
        )
    assert len(transport.calls) == 2
    assert transport.tools_seen == [[], []]


class _FakeSelectClient:
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


def _receivable_row(
    receivable_id: str,
    customer_id: str,
    *,
    balance: float,
    days_overdue: int,
    due_offset_days: int | None = None,
    status: str = "aberto",
) -> dict[str, Any]:
    due_offset = -days_overdue if due_offset_days is None else due_offset_days
    return {
        "entity_id": receivable_id,
        "source_record_id": f"TEST-{receivable_id}",
        "name": f"Receivable {receivable_id}",
        "customer_id": customer_id,
        "customer_name": f"Customer {customer_id}",
        "document_number": f"DOC-{receivable_id}",
        "receivable_type": "a_receber",
        "balance": balance,
        "due_date": (date.today() + timedelta(days=due_offset)).isoformat(),
        "collector_code": "C01",
        "collector_name": "Collector",
        "status": status,
        "days_overdue": days_overdue,
    }


@pytest.fixture()
def fake_collections_views(monkeypatch: pytest.MonkeyPatch) -> _FakeSelectClient:
    long_note = "promessa de pagamento com detalhes sensiveis " * 12
    rows = [
        _receivable_row("rec-a1", "cust-a", balance=7000.0, days_overdue=95),
        _receivable_row("rec-a2", "cust-a", balance=1500.0, days_overdue=10),
        _receivable_row("rec-b1", "cust-b", balance=4000.0, days_overdue=40),
        _receivable_row("rec-near", "cust-near", balance=600.0, days_overdue=0, due_offset_days=3),
        _receivable_row("rec-c1", "cust-c", balance=9000.0, days_overdue=0, due_offset_days=10),
        _receivable_row("rec-d1", "cust-d", balance=8000.0, days_overdue=60, status="liquidado"),
    ]
    contacts = [
        {
            "entity_id": "contact-old",
            "source_record_id": "TEST-contact-old",
            "customer_id": "cust-a",
            "receivable_id": "rec-a1",
            "action": "call",
            "note": "old note",
            "contact_date": "2026-01-01",
            "next_contact_date": None,
            "result": "promised",
        },
        {
            "entity_id": "contact-new",
            "source_record_id": "TEST-contact-new",
            "customer_id": "cust-a",
            "receivable_id": "rec-a1",
            "action": "renegotiate",
            "note": long_note,
            "contact_date": "2026-01-05",
            "next_contact_date": "2026-01-07",
            "result": "broken_promise",
        },
        {
            "entity_id": "contact-b",
            "source_record_id": "TEST-contact-b",
            "customer_id": "cust-b",
            "receivable_id": "rec-b1",
            "action": "send_notice",
            "note": "left voicemail",
            "contact_date": "2026-01-03",
            "next_contact_date": None,
            "result": "no_answer",
        },
    ]
    client = _FakeSelectClient(
        {
            "v_dia_receivable_current": rows,
            "v_dia_collection_contact_current": contacts,
        }
    )
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    return client


def test_scope_orders_by_exposure_sets_severity_fingerprint_and_bounded_notes(
    fake_collections_views: _FakeSelectClient,
) -> None:
    scoped = ops_scope_collections(_TENANT, {"thresholds": {"near_due_days": -5}})

    assert [item["customer_id"] for item in scoped] == ["cust-a", "cust-b", "cust-near"]
    assert "cust-near" in [item["customer_id"] for item in scoped]
    assert "cust-c" not in [item["customer_id"] for item in scoped]
    assert "cust-d" not in [item["customer_id"] for item in scoped]

    by_customer = {item["customer_id"]: item for item in scoped}
    assert by_customer["cust-a"]["total_exposure"] == 8500.0
    assert by_customer["cust-a"]["max_days_overdue"] == 95
    assert by_customer["cust-a"]["days_overdue"] == 95
    assert by_customer["cust-a"]["severity"] == "critical"
    assert by_customer["cust-a"]["fingerprint"] == _collections_fingerprint(_TENANT, "cust-a")
    assert len(by_customer["cust-a"]["open_receivables"]) == 2
    assert [note["contact_id"] for note in by_customer["cust-a"]["recent_collection_contacts"]] == [
        "contact-new",
        "contact-old",
    ]
    assert len(by_customer["cust-a"]["recent_collection_contacts"][0]["note"]) <= 240
    assert by_customer["cust-a"]["recent_collection_contacts"][0]["note"].endswith("…")
    assert by_customer["cust-b"]["severity"] == "high"
    assert by_customer["cust-near"]["max_days_overdue"] == 0
    assert by_customer["cust-near"]["severity"] == "low"


@pytest.mark.asyncio
async def test_ops_collections_assess_prompt_uses_bounded_contact_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    raw_note = "PROMISE-PII-RAW " * 40
    rows = [
        _receivable_row("rec-pii", "cust-pii", balance=2500.0, days_overdue=12),
    ]
    contacts = [
        {
            "entity_id": f"contact-{idx}",
            "source_record_id": f"TEST-contact-{idx}",
            "customer_id": "cust-pii",
            "receivable_id": "rec-pii",
            "action": "call",
            "note": raw_note if idx == 6 else f"short note {idx}",
            "contact_date": f"2026-01-0{idx + 1}",
            "next_contact_date": None,
            "result": "promised",
        }
        for idx in range(7)
    ]
    client = _FakeSelectClient(
        {
            "v_dia_receivable_current": rows,
            "v_dia_collection_contact_current": contacts,
        }
    )
    monkeypatch.setattr(ops_revrec, "_ops_client", client)
    scoped_payload = ops_scope_collections(_TENANT, {"thresholds": {"near_due_days": -5}})[0]
    bounded_note = scoped_payload["recent_collection_contacts"][0]["note"]
    assert len(scoped_payload["recent_collection_contacts"]) == 5
    assert len(bounded_note) <= 240
    assert bounded_note.endswith("…")
    assert bounded_note != raw_note

    captured: dict[str, Any] = {}

    async def fake_run(payload: Mapping[str, Any], **kwargs: Any) -> dict[str, Any]:
        captured["payload"] = payload
        captured["system_prompt"] = kwargs["system_prompt"]
        captured["user_prompt_template"] = kwargs["user_prompt_template"]
        return {
            "customer_id": payload["customer_id"],
            "recommended_action": "call",
            "next_step_note": "Call with bounded evidence.",
            "evidence": [bounded_note, *["extra evidence " + str(i) for i in range(6)]],
            "confidence": 0.7,
            "rationale": "bounded note reviewed",
        }

    monkeypatch.setattr(ops_collections, "run_collections_prioritizer", fake_run)
    result = await ops_collections_assess(
        scoped_payload,
        {
            "system_prompt": "Use bounded evidence for {customer_id}.",
            "user_prompt_template": "Evidence: {evidence_json}",
            "bounds": {"max_tool_rounds": 0},
        },
    )

    rendered_prompt = captured["user_prompt_template"]
    assert bounded_note[:-1] in rendered_prompt
    assert "\\u2026" in rendered_prompt
    assert raw_note not in rendered_prompt
    assert len(result["evidence"]) == 5
    assert result["evidence"][0] == bounded_note
    assert raw_note not in json.dumps(result["evidence"])


def test_scope_respects_max_customers_bound(fake_collections_views: _FakeSelectClient) -> None:
    scoped = ops_scope_collections(_TENANT, {"thresholds": {"near_due_days": -5}, "max_customers": 1})
    assert [item["customer_id"] for item in scoped] == ["cust-a"]


def _default_config(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "auto_apply": False,
        "bounds": {"max_findings_per_run": 50, "max_tool_rounds": 0, "max_customers": 200},
        "thresholds": {"near_due_days": -5},
        "system_prompt": "s",
        "user_prompt_template": "u",
        "tools": [],
    }
    base.update(overrides)
    return base


def _scoped_customer(customer_id: str, *, exposure: float, days: int, severity: str) -> dict[str, Any]:
    return {
        "customer_id": customer_id,
        "tenant_id": _TENANT,
        "customer_name": f"Customer {customer_id}",
        "open_receivables": [],
        "recent_collection_contacts": [],
        "total_exposure": exposure,
        "max_days_overdue": days,
        "days_overdue": days,
        "severity": severity,
        "finding_type": "collections_priority",
        "fingerprint": _collections_fingerprint(_TENANT, customer_id),
    }


def _assessment(action: str = "call", rationale: str = "overdue") -> dict[str, Any]:
    return {
        "customer_id": "ignored",
        "recommended_action": action,
        "next_step_note": "call today",
        "evidence": ["overdue balance"],
        "confidence": 0.61,
        "rationale": rationale,
    }


def _build_harness(
    *,
    config: dict[str, Any],
    scoped: list[dict[str, Any]],
    assessment_by_customer: dict[str, dict[str, Any]],
    existing_fingerprints: list[str] | None = None,
):
    state: dict[str, Any] = {
        "recorded_findings": [],
        "finalized": None,
        "created_workflow_key": None,
        "scope_args": None,
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
        if fn_name == "ops_scope_collections":
            state["scope_args"] = args
            return scoped
        if fn_name == "ops_collections_assess":
            state["assess_kwargs"].append(kw)
            return assessment_by_customer[str(args[0]["customer_id"])]
        if fn_name == "ops_list_open_finding_fingerprints":
            return existing
        if fn_name == "ops_record_finding":
            state["recorded_findings"].append(args[0])
            return {"finding_id": f"finding-{len(state['recorded_findings'])}"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    return state, fake_execute_activity


async def _run_workflow(state_execute) -> dict[str, Any]:  # noqa: ANN001
    _, fake_execute = state_execute
    wf = CollectionsPrioritizerWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "logger", logging.getLogger("test_collections_workflow"), create=True),
    ):
        return await wf.run(CollectionsPrioritizerWorkflowInput(tenant_id=_TENANT))


@pytest.mark.asyncio
async def test_workflow_records_all_findings_when_no_fingerprints_are_open() -> None:
    scoped = [
        _scoped_customer("cust-a", exposure=8500.0, days=95, severity="critical"),
        _scoped_customer("cust-b", exposure=4000.0, days=40, severity="high"),
        _scoped_customer("cust-c", exposure=1200.0, days=5, severity="medium"),
    ]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_customer={c["customer_id"]: _assessment(action="renegotiate") for c in scoped},
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["status"] == "succeeded"
    assert result["run_id"] == "run-1"
    assert result["total_customers_scoped"] == 3
    assert result["recorded_findings"] == 3
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 3
    assert result["remaining_findings_count"] == 0
    assert result["auto_apply"] is False
    assert [f["customer_id"] for f in state["recorded_findings"]] == ["cust-a", "cust-b", "cust-c"]
    first = state["recorded_findings"][0]
    assert first["agent_key"] == _WORKFLOW_KEY
    assert first["finding_type"] == "collections_priority"
    assert first["severity"] == "critical"
    assert first["total_exposure"] == 8500.0
    assert first["recommended_action"] == "renegotiate"
    assert first["fingerprint"] == _collections_fingerprint(_TENANT, "cust-a")
    assert state["finalized"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_workflow_dedupes_when_all_fingerprints_already_open() -> None:
    scoped = [
        _scoped_customer("cust-a", exposure=8500.0, days=95, severity="critical"),
        _scoped_customer("cust-b", exposure=4000.0, days=40, severity="high"),
        _scoped_customer("cust-c", exposure=1200.0, days=5, severity="medium"),
    ]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_customer={c["customer_id"]: _assessment() for c in scoped},
        existing_fingerprints=[_collections_fingerprint(_TENANT, c["customer_id"]) for c in scoped],
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 3
    assert result["processed_findings"] == 0
    assert state["recorded_findings"] == []


@pytest.mark.asyncio
async def test_workflow_dedupes_only_open_fingerprints() -> None:
    scoped = [
        _scoped_customer("cust-a", exposure=8500.0, days=95, severity="critical"),
        _scoped_customer("cust-b", exposure=4000.0, days=40, severity="high"),
        _scoped_customer("cust-c", exposure=1200.0, days=5, severity="medium"),
    ]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_customer={c["customer_id"]: _assessment() for c in scoped},
        existing_fingerprints=[_collections_fingerprint(_TENANT, "cust-b")],
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["recorded_findings"] == 2
    assert result["deduped_findings"] == 1
    assert [f["customer_id"] for f in state["recorded_findings"]] == ["cust-a", "cust-c"]


@pytest.mark.asyncio
async def test_workflow_forces_auto_apply_false_even_if_config_enables_it() -> None:
    scoped = [_scoped_customer("cust-a", exposure=8500.0, days=95, severity="critical")]
    harness = _build_harness(
        config=_default_config(auto_apply=True),
        scoped=scoped,
        assessment_by_customer={"cust-a": _assessment()},
    )

    result = await _run_workflow(harness)

    assert result["auto_apply"] is False


@pytest.mark.asyncio
async def test_workflow_empty_scope_finalizes_with_zero_recorded() -> None:
    harness = _build_harness(config=_default_config(), scoped=[], assessment_by_customer={})
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["total_customers_scoped"] == 0
    assert result["recorded_findings"] == 0
    assert result["deduped_findings"] == 0
    assert result["processed_findings"] == 0
    assert result["run_id"] == "run-1"
    assert state["created_workflow_key"] == _WORKFLOW_KEY
    assert state["finalized"] is not None


@pytest.mark.asyncio
async def test_workflow_bounds_processed_findings_to_highest_exposure() -> None:
    scoped = [
        _scoped_customer("cust-a", exposure=8500.0, days=95, severity="critical"),
        _scoped_customer("cust-b", exposure=4000.0, days=40, severity="high"),
        _scoped_customer("cust-c", exposure=1200.0, days=5, severity="medium"),
    ]
    harness = _build_harness(
        config=_default_config(bounds={"max_findings_per_run": 1, "max_tool_rounds": 0, "max_customers": 200}),
        scoped=scoped,
        assessment_by_customer={c["customer_id"]: _assessment() for c in scoped},
    )
    state, _ = harness

    result = await _run_workflow(harness)

    assert result["processed_findings"] == 1
    assert result["remaining_findings_count"] == 2
    assert result["recorded_findings"] == 1
    assert state["recorded_findings"][0]["customer_id"] == "cust-a"
    assert state["recorded_findings"][0]["total_exposure"] == 8500.0


@pytest.mark.asyncio
async def test_workflow_assess_activity_has_heartbeat_timeout_and_retry_cap() -> None:
    scoped = [_scoped_customer("cust-a", exposure=8500.0, days=95, severity="critical")]
    harness = _build_harness(
        config=_default_config(),
        scoped=scoped,
        assessment_by_customer={"cust-a": _assessment()},
    )
    state, _ = harness

    await _run_workflow(harness)

    assert state["assess_kwargs"], "ops_collections_assess was never scheduled"
    kw = state["assess_kwargs"][0]
    heartbeat_timeout = kw.get("heartbeat_timeout")
    assert heartbeat_timeout is not None
    assert heartbeat_timeout.total_seconds() == 45
    retry_policy = kw.get("retry_policy")
    assert retry_policy is not None
    assert retry_policy.maximum_attempts == 2


def test_collections_workflow_activities_and_run_now_are_registered() -> None:
    import inspect

    from temporal.src import worker as worker_module
    from temporal.src.ops_api.app import _AGENT_SCHEDULE_ID_BUILDERS, _OPS_AGENT_KEYS
    from temporal.tests.test_worker_registration import _extract_worker_workflow_references

    assert hasattr(CollectionsPrioritizerWorkflow, "__temporal_workflow_definition")
    assert "CollectionsPrioritizerWorkflow" in _extract_worker_workflow_references()

    decorated = {
        name
        for name, obj in inspect.getmembers(ops_collections)
        if callable(obj)
        and hasattr(obj, "__temporal_activity_definition")
        and inspect.getmodule(obj) is ops_collections
    }
    registered = {fn.__name__ for fn in worker_module._COLLECTIONS_ACTIVITIES}
    assert decorated == registered
    worker_source = (_REPO_ROOT / "temporal/src/worker.py").read_text()
    assert "*_COLLECTIONS_ACTIVITIES" in worker_source
    assert "collections-prioritizer" in _OPS_AGENT_KEYS
    assert "collections-prioritizer" in _AGENT_SCHEDULE_ID_BUILDERS


def test_collections_triad_files_do_not_import_rental_helpers() -> None:
    offenders: list[str] = []
    for rel_path in _TRIAD_FILES:
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
    assert not offenders, f"collections triad must not import rental_* helpers: {offenders}"


def test_bounded_evidence_limits_count_and_text_length() -> None:
    bounded = _bounded_evidence(["x" * 400 for _ in range(8)])
    assert len(bounded) == 5
    assert all(len(item) <= 240 for item in bounded)
    assert all(item.endswith("…") for item in bounded)
