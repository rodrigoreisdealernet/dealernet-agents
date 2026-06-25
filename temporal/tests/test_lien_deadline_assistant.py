from __future__ import annotations

import json
from datetime import date, timedelta
from uuid import uuid4

import pytest
from temporal.src.agents.lien_deadline_assistant import (
    LienDeadlineProposalV1,
    LienWaiverProposalV1,
    OM_TAG_LIEN_DEADLINE,
    OM_TAG_LIEN_WAIVER,
    calculate_prelim_notice_deadline,
    is_notice_required,
    lien_deadline_proposal_v1_schema,
    lien_waiver_proposal_v1_schema,
    run_lien_deadline_assistant,
    run_lien_waiver_assistant,
)
from typing import Any
from collections.abc import Mapping


# ---------------------------------------------------------------------------
# Fake transport for agent tests
# ---------------------------------------------------------------------------


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
        self.calls.append([dict(m) for m in messages])
        return self._responses.pop(0)


def _assistant_message(
    *,
    content: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    msg: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg}]}


async def _noop_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
    del name, args
    return {}


# ===========================================================================
# Deterministic deadline calculation
# ===========================================================================


class TestCalculatePrelimNoticeDeadline:
    def test_california_20_day_window(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 10),
        )
        assert result["notice_required"] is True
        assert result["days_window"] == 20
        assert result["deadline_date"] == "2026-06-21"
        assert result["days_remaining"] == 11
        assert result["urgency"] == "warning"  # 11 <= 14 → warning
        assert result["stale_inputs"] == []

    def test_california_warning_within_14_days(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 10),
        )
        # 11 days remaining: within warning range (≤ 14 days)
        assert result["urgency"] == "warning"

    def test_california_warning_threshold_exactly(self) -> None:
        first_furnishing = date(2026, 6, 1)
        # reference = June 7 → deadline June 21 → 14 days remaining exactly = warning
        result = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 7),
        )
        assert result["days_remaining"] == 14
        assert result["urgency"] == "warning"

    def test_california_critical_within_5_days(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 17),
        )
        assert result["days_remaining"] == 4
        assert result["urgency"] == "critical"

    def test_california_overdue(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 25),  # 4 days past deadline
        )
        assert result["days_remaining"] == -4
        assert result["urgency"] == "overdue"

    def test_colorado_no_notice_required(self) -> None:
        result = calculate_prelim_notice_deadline(
            state="CO",
            first_furnishing_date=date(2026, 6, 1),
            reference_date=date(2026, 6, 10),
        )
        assert result["notice_required"] is False
        assert result["urgency"] == "not_required"
        assert result["deadline_date"] is None
        assert result["stale_inputs"] == []

    def test_florida_45_day_window(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="FL",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 10),
        )
        assert result["days_window"] == 45
        assert result["deadline_date"] == "2026-07-16"
        assert result["days_remaining"] == 36
        assert result["urgency"] == "ok"

    def test_texas_15_day_window(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="TX",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 10),
        )
        assert result["days_window"] == 15
        assert result["deadline_date"] == "2026-06-16"
        assert result["days_remaining"] == 6
        assert result["urgency"] == "warning"  # 6 > 5 → warning (not critical)

    def test_unknown_state_returns_unknown_jurisdiction(self) -> None:
        result = calculate_prelim_notice_deadline(
            state="ZZ",
            first_furnishing_date=date(2026, 6, 1),
        )
        assert result["urgency"] == "unknown_jurisdiction"
        assert result["deadline_date"] is None
        assert len(result["stale_inputs"]) > 0
        assert "ZZ" in result["stale_inputs"][0]

    def test_case_insensitive_state(self) -> None:
        result_upper = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=date(2026, 6, 1),
            reference_date=date(2026, 6, 10),
        )
        result_lower = calculate_prelim_notice_deadline(
            state="ca",
            first_furnishing_date=date(2026, 6, 1),
            reference_date=date(2026, 6, 10),
        )
        assert result_upper["deadline_date"] == result_lower["deadline_date"]

    def test_oregon_8_day_window(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="OR",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 5),
        )
        assert result["days_window"] == 8
        assert result["deadline_date"] == "2026-06-09"
        assert result["days_remaining"] == 4
        assert result["urgency"] == "critical"

    def test_deadline_exactly_on_deadline_date(self) -> None:
        first_furnishing = date(2026, 6, 1)
        result = calculate_prelim_notice_deadline(
            state="CA",
            first_furnishing_date=first_furnishing,
            reference_date=date(2026, 6, 21),  # deadline day itself
        )
        assert result["days_remaining"] == 0
        assert result["urgency"] == "critical"  # 0 is not < 0, so ≤5 → critical


class TestIsNoticeRequired:
    def test_california_requires_notice(self) -> None:
        assert is_notice_required("CA") is True

    def test_colorado_no_notice_required(self) -> None:
        assert is_notice_required("CO") is False

    def test_unknown_state_defaults_to_required(self) -> None:
        assert is_notice_required("ZZ") is True

    def test_new_jersey_no_notice_required(self) -> None:
        assert is_notice_required("NJ") is False


# ===========================================================================
# LienDeadlineProposalV1 schema and model
# ===========================================================================


class TestLienDeadlineProposalV1:
    def test_schema_is_valid_json_schema(self) -> None:
        schema = lien_deadline_proposal_v1_schema()
        assert schema["type"] == "object"
        assert "obligation_id" in schema["properties"]
        assert "urgency" in schema["properties"]
        assert "recommended_action" in schema["properties"]
        assert "rationale" in schema["properties"]

    @pytest.mark.parametrize(
        "urgency",
        ["overdue", "critical", "warning", "ok", "not_required", "unknown_jurisdiction"],
    )
    def test_accepts_valid_urgency_values(self, urgency: str) -> None:
        p = LienDeadlineProposalV1(
            obligation_id=str(uuid4()),
            urgency=urgency,
            recommended_action="no_op",
            rationale="ok",
        )
        assert p.urgency == urgency

    def test_rejects_invalid_urgency(self) -> None:
        with pytest.raises(ValueError):
            LienDeadlineProposalV1(
                obligation_id=str(uuid4()),
                urgency="extreme",
                recommended_action="no_op",
                rationale="test",
            )

    @pytest.mark.parametrize(
        "action",
        [
            "send_notice",
            "schedule_notice",
            "acknowledge_no_action_required",
            "manual_review",
            "escalate_missing_data",
            "no_op",
        ],
    )
    def test_accepts_valid_recommended_actions(self, action: str) -> None:
        p = LienDeadlineProposalV1(
            obligation_id=str(uuid4()),
            urgency="ok",
            recommended_action=action,
            rationale="ok",
        )
        assert p.recommended_action == action

    def test_defaults(self) -> None:
        p = LienDeadlineProposalV1(
            obligation_id=str(uuid4()),
            urgency="ok",
            recommended_action="no_op",
            rationale="stable",
        )
        assert p.deadline_date is None
        assert p.days_remaining is None
        assert p.notice_sent is False
        assert p.stale_inputs == []
        assert p.operating_model_tags == []
        assert p.evidence == []
        assert p.material_signal_key == ""

    def test_operating_model_tag_constant(self) -> None:
        assert OM_TAG_LIEN_DEADLINE == "credit-billing-analyst:t4"


# ===========================================================================
# LienWaiverProposalV1 schema and model
# ===========================================================================


class TestLienWaiverProposalV1:
    def test_schema_is_valid_json_schema(self) -> None:
        schema = lien_waiver_proposal_v1_schema()
        assert schema["type"] == "object"
        assert "obligation_id" in schema["properties"]
        assert "waiver_type" in schema["properties"]
        assert "waiver_status" in schema["properties"]
        assert "recommended_action" in schema["properties"]

    @pytest.mark.parametrize(
        "waiver_type",
        [
            "conditional_partial",
            "unconditional_partial",
            "conditional_final",
            "unconditional_final",
            "unknown",
        ],
    )
    def test_accepts_valid_waiver_types(self, waiver_type: str) -> None:
        p = LienWaiverProposalV1(
            obligation_id=str(uuid4()),
            waiver_type=waiver_type,
            waiver_status="pending_receipt",
            recommended_action="request_waiver",
            rationale="ok",
        )
        assert p.waiver_type == waiver_type

    @pytest.mark.parametrize(
        "status",
        ["pending_receipt", "received", "missing", "expired", "sent_awaiting_return", "not_required"],
    )
    def test_accepts_valid_waiver_statuses(self, status: str) -> None:
        p = LienWaiverProposalV1(
            obligation_id=str(uuid4()),
            waiver_type="conditional_partial",
            waiver_status=status,
            recommended_action="no_op",
            rationale="ok",
        )
        assert p.waiver_status == status

    @pytest.mark.parametrize(
        "action",
        ["request_waiver", "confirm_waiver_received", "close_obligation", "manual_review", "no_op"],
    )
    def test_accepts_valid_recommended_actions(self, action: str) -> None:
        p = LienWaiverProposalV1(
            obligation_id=str(uuid4()),
            waiver_type="conditional_final",
            waiver_status="pending_receipt",
            recommended_action=action,
            rationale="ok",
        )
        assert p.recommended_action == action

    def test_defaults(self) -> None:
        p = LienWaiverProposalV1(
            obligation_id=str(uuid4()),
            waiver_type="unknown",
            waiver_status="pending_receipt",
            recommended_action="no_op",
            rationale="stable",
        )
        assert p.payment_amount == 0.0
        assert p.stale_inputs == []
        assert p.operating_model_tags == []
        assert p.evidence == []
        assert p.material_signal_key == ""

    def test_operating_model_tag_constant(self) -> None:
        assert OM_TAG_LIEN_WAIVER == "credit-billing-analyst:t5"


# ===========================================================================
# run_lien_deadline_assistant agent loop
# ===========================================================================


@pytest.mark.asyncio
async def test_run_lien_deadline_assistant_direct_response() -> None:
    obligation_id = str(uuid4())
    expected = {
        "obligation_id": obligation_id,
        "project_id": "proj-1",
        "account_id": "acct-1",
        "state": "CA",
        "deadline_date": "2026-07-01",
        "days_remaining": 14,
        "deadline_type": "preliminary_notice",
        "urgency": "warning",
        "notice_sent": False,
        "recommended_action": "schedule_notice",
        "operating_model_tags": [OM_TAG_LIEN_DEADLINE],
        "evidence": ["contract signed 2026-06-11", "first equipment delivered 2026-06-11"],
        "stale_inputs": [],
        "material_signal_key": "ca-prelim-2026-07-01",
        "confidence": 0.9,
        "rationale": "Deadline approaching in 14 days — schedule preliminary notice.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(expected))])
    result = await run_lien_deadline_assistant(
        {"obligation_id": obligation_id},
        system_prompt="Assess lien deadline.",
        user_prompt_template="Obligation {obligation_id}.",
        tools=[],
        tool_executor=_noop_executor,
        transport=transport,
    )
    assert result["obligation_id"] == obligation_id
    assert result["urgency"] == "warning"
    assert result["recommended_action"] == "schedule_notice"
    assert result["confidence"] == 0.9
    assert len(transport.calls) == 1


@pytest.mark.asyncio
async def test_run_lien_deadline_assistant_uses_tool_then_responds() -> None:
    obligation_id = str(uuid4())
    transport = _FakeTransport(
        [
            _assistant_message(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "query_entity",
                            "arguments": json.dumps({"entity_id": obligation_id}),
                        },
                    }
                ]
            ),
            _assistant_message(
                content=json.dumps(
                    {
                        "obligation_id": obligation_id,
                        "project_id": "proj-2",
                        "account_id": "acct-2",
                        "state": "TX",
                        "deadline_date": "2026-06-16",
                        "days_remaining": 2,
                        "deadline_type": "preliminary_notice",
                        "urgency": "critical",
                        "notice_sent": False,
                        "recommended_action": "send_notice",
                        "operating_model_tags": [OM_TAG_LIEN_DEADLINE],
                        "evidence": ["contract details retrieved"],
                        "stale_inputs": [],
                        "material_signal_key": "tx-prelim-2026-06-16",
                        "confidence": 0.92,
                        "rationale": "2 days until Texas deadline — send notice immediately.",
                    }
                )
            ),
        ]
    )

    tool_calls: list[tuple[str, dict[str, Any]]] = []

    async def record_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
        tool_calls.append((name, args))
        return {"entity_id": obligation_id, "data": {}}

    result = await run_lien_deadline_assistant(
        {"obligation_id": obligation_id},
        system_prompt="Assess lien.",
        user_prompt_template="Check obligation.",
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "query_entity",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        tool_executor=record_executor,
        transport=transport,
    )
    assert result["recommended_action"] == "send_notice"
    assert result["urgency"] == "critical"
    assert len(tool_calls) == 1
    assert len(transport.calls) == 2


# ===========================================================================
# run_lien_waiver_assistant agent loop
# ===========================================================================


@pytest.mark.asyncio
async def test_run_lien_waiver_assistant_direct_response() -> None:
    obligation_id = str(uuid4())
    expected = {
        "obligation_id": obligation_id,
        "project_id": "proj-3",
        "account_id": "acct-3",
        "payment_id": "pay-1",
        "waiver_type": "conditional_partial",
        "payment_amount": 15000.0,
        "waiver_status": "pending_receipt",
        "recommended_action": "request_waiver",
        "operating_model_tags": [OM_TAG_LIEN_WAIVER],
        "evidence": ["payment processed 2026-06-10", "waiver not yet returned"],
        "stale_inputs": [],
        "material_signal_key": "waiver-pay-1-missing",
        "confidence": 0.88,
        "rationale": "Payment recorded but waiver not yet received — request waiver from customer.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(expected))])
    result = await run_lien_waiver_assistant(
        {"obligation_id": obligation_id},
        system_prompt="Track lien waiver.",
        user_prompt_template="Obligation {obligation_id}.",
        tools=[],
        tool_executor=_noop_executor,
        transport=transport,
    )
    assert result["obligation_id"] == obligation_id
    assert result["waiver_status"] == "pending_receipt"
    assert result["recommended_action"] == "request_waiver"
    assert len(transport.calls) == 1


@pytest.mark.asyncio
async def test_run_lien_waiver_assistant_escalates_missing_waiver() -> None:
    obligation_id = str(uuid4())
    transport = _FakeTransport(
        [
            _assistant_message(
                content=json.dumps(
                    {
                        "obligation_id": obligation_id,
                        "project_id": "proj-4",
                        "account_id": "acct-4",
                        "payment_id": "pay-2",
                        "waiver_type": "conditional_final",
                        "payment_amount": 48000.0,
                        "waiver_status": "missing",
                        "recommended_action": "manual_review",
                        "operating_model_tags": [OM_TAG_LIEN_WAIVER],
                        "evidence": ["final payment processed 30 days ago"],
                        "stale_inputs": ["waiver history unavailable — manual review required"],
                        "material_signal_key": "final-waiver-missing",
                        "confidence": 0.65,
                        "rationale": "Final payment made 30 days ago, waiver not received — escalate.",
                    }
                )
            ),
        ]
    )
    result = await run_lien_waiver_assistant(
        {"obligation_id": obligation_id},
        system_prompt="Track.",
        user_prompt_template="Obligation.",
        tools=[],
        tool_executor=_noop_executor,
        transport=transport,
    )
    assert result["waiver_status"] == "missing"
    assert result["recommended_action"] == "manual_review"
    assert len(result["stale_inputs"]) > 0


# ===========================================================================
# Evidence rendering — stale_inputs surface uncertainty
# ===========================================================================


def test_stale_inputs_surface_in_unknown_jurisdiction() -> None:
    result = calculate_prelim_notice_deadline(
        state="ZZ",
        first_furnishing_date=date(2026, 6, 1),
    )
    assert len(result["stale_inputs"]) > 0
    assert "manual compliance review required" in result["stale_inputs"][0]


def test_stale_inputs_empty_for_known_state() -> None:
    result = calculate_prelim_notice_deadline(
        state="CA",
        first_furnishing_date=date(2026, 6, 1),
        reference_date=date(2026, 6, 10),
    )
    assert result["stale_inputs"] == []


# ===========================================================================
# Duplicate collapse via material_signal_key
# ===========================================================================


def test_deadline_proposal_material_signal_key_represents_obligation() -> None:
    p = LienDeadlineProposalV1(
        obligation_id="obl-1",
        urgency="warning",
        recommended_action="schedule_notice",
        material_signal_key="ca-prelim-2026-07-01",
        rationale="ok",
    )
    assert p.material_signal_key == "ca-prelim-2026-07-01"


def test_waiver_proposal_material_signal_key_represents_obligation() -> None:
    p = LienWaiverProposalV1(
        obligation_id="obl-2",
        waiver_type="conditional_partial",
        waiver_status="pending_receipt",
        recommended_action="request_waiver",
        material_signal_key="waiver-pay-1-missing",
        rationale="ok",
    )
    assert p.material_signal_key == "waiver-pay-1-missing"
