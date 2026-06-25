from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.agents.credit_analyst import (
    CreditProposalV1,
    credit_proposal_v1_schema,
    run_credit_analyst,
)


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


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------


def test_credit_proposal_v1_schema_is_valid_json_schema() -> None:
    schema = credit_proposal_v1_schema()
    assert schema["type"] == "object"
    assert "account_id" in schema["properties"]
    assert "risk_level" in schema["properties"]
    assert "proposed_action" in schema["properties"]
    assert "rationale" in schema["properties"]


@pytest.mark.parametrize(
    "risk_level", ["low", "medium", "high", "critical"]
)
def test_credit_proposal_v1_accepts_valid_risk_levels(risk_level: str) -> None:
    proposal = CreditProposalV1(
        account_id=str(uuid4()),
        risk_level=risk_level,
        proposed_action="no_op",
        confidence=0.8,
        rationale="ok",
    )
    assert proposal.risk_level == risk_level


def test_credit_proposal_v1_rejects_invalid_risk_level() -> None:
    with pytest.raises(ValueError):
        CreditProposalV1(
            account_id=str(uuid4()),
            risk_level="extreme",
            proposed_action="no_change",
            confidence=0.8,
            rationale="ok",
        )


@pytest.mark.parametrize(
    "action",
    [
        "no_op",
        "routine_follow_up",
        "review_notice_of_intent",
        "review_lien_preparation",
        "manual_portfolio_review",
    ],
)
def test_credit_proposal_v1_accepts_valid_proposed_actions(action: str) -> None:
    proposal = CreditProposalV1(
        account_id=str(uuid4()),
        risk_level="low",
        proposed_action=action,
        confidence=0.9,
        rationale="ok",
    )
    assert proposal.proposed_action == action


def test_credit_proposal_v1_rejects_invalid_proposed_action() -> None:
    with pytest.raises(ValueError):
        CreditProposalV1(
            account_id=str(uuid4()),
            risk_level="low",
            proposed_action="delete_account",
            confidence=0.9,
            rationale="ok",
        )


def test_credit_proposal_v1_defaults() -> None:
    proposal = CreditProposalV1(
        account_id=str(uuid4()),
        risk_level="medium",
        proposed_action="no_op",
        confidence=0.75,
        rationale="stable account",
    )
    assert proposal.current_exposure == 0.0
    assert proposal.overdue_amount == 0.0
    assert proposal.oldest_overdue_days == 0
    assert proposal.escalation_stage == "routine_follow_up"
    assert proposal.stale_inputs == []
    assert proposal.material_signal_key == ""
    assert proposal.operating_model_tags == []
    assert proposal.aging_trend == "stable"
    assert proposal.payment_behavior_score == 0.0
    assert proposal.evidence == []


# ---------------------------------------------------------------------------
# run_credit_analyst — agent loop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_credit_analyst_direct_response_no_tool_calls() -> None:
    account_id = str(uuid4())
    expected = {
        "account_id": account_id,
        "risk_level": "low",
        "proposed_action": "no_op",
        "current_exposure": 1000.0,
        "overdue_amount": 0.0,
        "oldest_overdue_days": 0,
        "escalation_stage": "no_op",
        "stale_inputs": [],
        "material_signal_key": "signal-none",
        "operating_model_tags": ["credit-billing-analyst:t1", "credit-billing-analyst:t8"],
        "aging_trend": "stable",
        "payment_behavior_score": 0.95,
        "evidence": ["all invoices paid on time"],
        "confidence": 0.9,
        "rationale": "Low-risk account with consistent payment history.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(expected))])

    result = await run_credit_analyst(
        {"account_id": account_id, "tenant_id": "t-1"},
        system_prompt="Assess credit risk.",
        user_prompt_template="Assess account {account_id}.",
        tools=[],
        tool_executor=_noop_tool_executor,
        transport=transport,
    )

    assert result["account_id"] == account_id
    assert result["risk_level"] == "low"
    assert result["proposed_action"] == "no_op"
    assert result["confidence"] == 0.9
    assert len(transport.calls) == 1


@pytest.mark.asyncio
async def test_run_credit_analyst_uses_tool_then_responds() -> None:
    account_id = str(uuid4())
    transport = _FakeTransport(
        [
            _assistant_message(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "query_time_series",
                            "arguments": json.dumps({"entity_id": account_id}),
                        },
                    }
                ]
            ),
            _assistant_message(
                content=json.dumps(
                    {
                        "account_id": account_id,
                        "risk_level": "high",
                        "proposed_action": "review_notice_of_intent",
                        "current_exposure": 9500.0,
                        "overdue_amount": 7200.0,
                        "oldest_overdue_days": 67,
                        "escalation_stage": "approaching_formal_escalation",
                        "stale_inputs": [],
                        "material_signal_key": "signal-escalate",
                        "operating_model_tags": ["credit-billing-analyst:t1", "credit-billing-analyst:t8"],
                        "aging_trend": "deteriorating",
                        "payment_behavior_score": 0.3,
                        "evidence": ["3 overdue invoices", "NSF on 2026-05-10"],
                        "confidence": 0.88,
                        "rationale": "Significant exposure with deteriorating payment behavior.",
                    }
                )
            ),
        ]
    )

    calls: list[tuple[str, dict[str, Any]]] = []

    async def _record_tool_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
        calls.append((name, args))
        return {"status": "ok", "points": []}

    result = await run_credit_analyst(
        {"account_id": account_id, "tenant_id": "t-1"},
        system_prompt="Assess credit risk.",
        user_prompt_template="Assess account.",
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "query_time_series",
                    "parameters": {"type": "object", "properties": {}},
                },
            }
        ],
        tool_executor=_record_tool_executor,
        transport=transport,
    )

    assert result["proposed_action"] == "review_notice_of_intent"
    assert result["aging_trend"] == "deteriorating"
    assert len(calls) == 1
    assert calls[0][0] == "query_time_series"
    assert len(transport.calls) == 2


@pytest.mark.asyncio
async def test_run_credit_analyst_serialises_to_dict() -> None:
    account_id = str(uuid4())
    response_payload = {
        "account_id": account_id,
        "risk_level": "medium",
        "proposed_action": "routine_follow_up",
        "current_exposure": 7200.0,
        "overdue_amount": 2400.0,
        "oldest_overdue_days": 35,
        "escalation_stage": "routine_follow_up",
        "stale_inputs": [],
        "material_signal_key": "signal-routine",
        "operating_model_tags": ["credit-billing-analyst:t1", "credit-billing-analyst:t8"],
        "aging_trend": "stable",
        "payment_behavior_score": 0.7,
        "evidence": ["utilization at 90%"],
        "confidence": 0.75,
        "rationale": "Approaching limit — reduce as precaution.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(response_payload))])

    result = await run_credit_analyst(
        {"account_id": account_id, "tenant_id": "t-1"},
        system_prompt="Assess.",
        user_prompt_template="Assess {account_id}.",
        tools=[],
        tool_executor=_noop_tool_executor,
        transport=transport,
    )

    assert isinstance(result, dict)
    assert result["overdue_amount"] == 2400.0
    assert result["escalation_stage"] == "routine_follow_up"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _noop_tool_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
    del name, args
    return {}
