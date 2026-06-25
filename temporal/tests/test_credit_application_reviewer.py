from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest
from temporal.src.agents.credit_analyst import (
    CreditApplicationProposalV1,
    OM_TAG_CREDIT_APPLICATION,
    credit_application_proposal_v1_schema,
    run_credit_application_reviewer,
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


async def _noop_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
    del name, args
    return {}


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_credit_application_proposal_v1_schema_is_valid_json_schema() -> None:
    schema = credit_application_proposal_v1_schema()
    assert schema["type"] == "object"
    assert "application_id" in schema["properties"]
    assert "risk_level" in schema["properties"]
    assert "recommended_action" in schema["properties"]
    assert "proposed_credit_limit" in schema["properties"]
    assert "rationale" in schema["properties"]


@pytest.mark.parametrize(
    "risk_level", ["low", "medium", "high", "critical"]
)
def test_credit_application_proposal_v1_accepts_valid_risk_levels(risk_level: str) -> None:
    p = CreditApplicationProposalV1(
        application_id=str(uuid4()),
        risk_level=risk_level,
        recommended_action="no_op",
        confidence=0.8,
        rationale="ok",
    )
    assert p.risk_level == risk_level


def test_credit_application_proposal_v1_rejects_invalid_risk_level() -> None:
    with pytest.raises(ValueError):
        CreditApplicationProposalV1(
            application_id=str(uuid4()),
            risk_level="extreme",
            recommended_action="approve",
            confidence=0.9,
            rationale="ok",
        )


@pytest.mark.parametrize(
    "action",
    [
        "approve",
        "approve_with_conditions",
        "deny",
        "request_more_info",
        "manual_review",
        "no_op",
    ],
)
def test_credit_application_proposal_v1_accepts_valid_actions(action: str) -> None:
    p = CreditApplicationProposalV1(
        application_id=str(uuid4()),
        risk_level="low",
        recommended_action=action,
        confidence=0.9,
        rationale="ok",
    )
    assert p.recommended_action == action


def test_credit_application_proposal_v1_defaults() -> None:
    p = CreditApplicationProposalV1(
        application_id=str(uuid4()),
        risk_level="medium",
        recommended_action="no_op",
        confidence=0.75,
        rationale="stable account",
    )
    assert p.proposed_credit_limit == 0.0
    assert p.proposed_terms == ""
    assert p.current_credit_limit == 0.0
    assert p.requested_credit_limit == 0.0
    assert p.stale_inputs == []
    assert p.operating_model_tags == []
    assert p.evidence == []
    assert p.material_signal_key == ""
    assert p.customer_id == ""
    assert p.account_id == ""


def test_operating_model_tag_constant() -> None:
    assert OM_TAG_CREDIT_APPLICATION == "credit-billing-analyst:t2"


# ---------------------------------------------------------------------------
# run_credit_application_reviewer — agent loop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_credit_application_reviewer_approve_response() -> None:
    application_id = str(uuid4())
    expected = {
        "application_id": application_id,
        "customer_id": "cust-1",
        "account_id": "acct-1",
        "risk_level": "low",
        "recommended_action": "approve",
        "proposed_credit_limit": 50000.0,
        "proposed_terms": "net30",
        "current_credit_limit": 25000.0,
        "requested_credit_limit": 50000.0,
        "operating_model_tags": [OM_TAG_CREDIT_APPLICATION],
        "evidence": ["3 trade references verified", "payment history clean for 2 years"],
        "stale_inputs": [],
        "material_signal_key": "app-approve-low-risk",
        "confidence": 0.91,
        "rationale": "Clean payment history with strong trade references supports approval.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(expected))])
    result = await run_credit_application_reviewer(
        {"application_id": application_id, "tenant_id": "t-1"},
        system_prompt="Review credit application.",
        user_prompt_template="Application {application_id}.",
        tools=[],
        tool_executor=_noop_executor,
        transport=transport,
    )
    assert result["application_id"] == application_id
    assert result["recommended_action"] == "approve"
    assert result["proposed_credit_limit"] == 50000.0
    assert result["confidence"] == 0.91
    assert len(transport.calls) == 1


@pytest.mark.asyncio
async def test_run_credit_application_reviewer_deny_with_stale_inputs() -> None:
    application_id = str(uuid4())
    expected = {
        "application_id": application_id,
        "customer_id": "cust-2",
        "account_id": "acct-2",
        "risk_level": "high",
        "recommended_action": "deny",
        "proposed_credit_limit": 0.0,
        "proposed_terms": "",
        "current_credit_limit": 0.0,
        "requested_credit_limit": 75000.0,
        "operating_model_tags": [OM_TAG_CREDIT_APPLICATION],
        "evidence": ["previous account had NSF in 2025"],
        "stale_inputs": ["trade references not yet verified — manual review may be needed"],
        "material_signal_key": "app-deny-high-risk",
        "confidence": 0.72,
        "rationale": "Prior NSF history and unverified trade references do not support approval.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(expected))])
    result = await run_credit_application_reviewer(
        {"application_id": application_id, "tenant_id": "t-1"},
        system_prompt="Review.",
        user_prompt_template="Application.",
        tools=[],
        tool_executor=_noop_executor,
        transport=transport,
    )
    assert result["recommended_action"] == "deny"
    assert result["risk_level"] == "high"
    assert len(result["stale_inputs"]) > 0


@pytest.mark.asyncio
async def test_run_credit_application_reviewer_uses_tool_then_responds() -> None:
    application_id = str(uuid4())
    transport = _FakeTransport(
        [
            _assistant_message(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "query_entity",
                            "arguments": json.dumps({"entity_id": application_id}),
                        },
                    }
                ]
            ),
            _assistant_message(
                content=json.dumps(
                    {
                        "application_id": application_id,
                        "customer_id": "cust-3",
                        "account_id": "acct-3",
                        "risk_level": "medium",
                        "recommended_action": "approve_with_conditions",
                        "proposed_credit_limit": 30000.0,
                        "proposed_terms": "net45",
                        "current_credit_limit": 20000.0,
                        "requested_credit_limit": 40000.0,
                        "operating_model_tags": [OM_TAG_CREDIT_APPLICATION],
                        "evidence": ["entity details retrieved"],
                        "stale_inputs": [],
                        "material_signal_key": "app-medium-conditional",
                        "confidence": 0.78,
                        "rationale": "Medium risk — approve with lower limit and net45 terms.",
                    }
                )
            ),
        ]
    )
    tool_calls: list[tuple[str, dict[str, Any]]] = []

    async def record_executor(name: str, args: dict[str, Any]) -> dict[str, Any]:
        tool_calls.append((name, args))
        return {"entity_id": application_id, "data": {}}

    result = await run_credit_application_reviewer(
        {"application_id": application_id, "tenant_id": "t-1"},
        system_prompt="Review application.",
        user_prompt_template="Application {application_id}.",
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
    assert result["recommended_action"] == "approve_with_conditions"
    assert result["proposed_credit_limit"] == 30000.0
    assert len(tool_calls) == 1
    assert len(transport.calls) == 2


@pytest.mark.asyncio
async def test_run_credit_application_reviewer_serialises_to_dict() -> None:
    application_id = str(uuid4())
    payload = {
        "application_id": application_id,
        "customer_id": "cust-4",
        "account_id": "acct-4",
        "risk_level": "low",
        "recommended_action": "approve",
        "proposed_credit_limit": 20000.0,
        "proposed_terms": "net30",
        "current_credit_limit": 10000.0,
        "requested_credit_limit": 20000.0,
        "operating_model_tags": [OM_TAG_CREDIT_APPLICATION],
        "evidence": [],
        "stale_inputs": [],
        "material_signal_key": "low-risk-approve",
        "confidence": 0.88,
        "rationale": "Clean record.",
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(payload))])
    result = await run_credit_application_reviewer(
        {"application_id": application_id, "tenant_id": "t-1"},
        system_prompt="Review.",
        user_prompt_template="Application.",
        tools=[],
        tool_executor=_noop_executor,
        transport=transport,
    )
    assert isinstance(result, dict)
    assert result["proposed_credit_limit"] == 20000.0
    assert result["proposed_terms"] == "net30"
