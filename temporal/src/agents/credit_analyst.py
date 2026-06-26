from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]


class CreditProposalV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1)
    risk_level: str = Field(pattern="^(low|medium|high|critical)$")
    proposed_action: str = Field(
        pattern="^(no_op|routine_follow_up|review_notice_of_intent|review_lien_preparation|manual_portfolio_review)$"
    )
    current_exposure: float = 0.0
    aging_trend: str = Field(
        default="stable",
        pattern="^(improving|stable|deteriorating|unknown)$",
    )
    payment_behavior_score: float = 0.0
    overdue_amount: float = 0.0
    oldest_overdue_days: int = 0
    escalation_stage: str = Field(
        default="routine_follow_up",
        pattern="^(routine_follow_up|approaching_formal_escalation|formal_escalation_review|manual_review|no_op)$",
    )
    stale_inputs: list[str] = Field(default_factory=list)
    material_signal_key: str = ""
    operating_model_tags: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    rationale: str


def credit_proposal_v1_schema() -> dict[str, Any]:
    return CreditProposalV1.model_json_schema()


async def run_credit_analyst(
    account_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
    on_llm_call: Callable[[Any], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=CreditProposalV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
        on_llm_call=on_llm_call,
    )
    return result.response.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Credit Application proposal model (t2)
# ---------------------------------------------------------------------------

# Operating-model tag for t2: Process new customer credit applications,
# evaluate creditworthiness, and set or update limits and payment terms.
OM_TAG_CREDIT_APPLICATION = "credit-billing-analyst:t2"


class CreditApplicationProposalV1(BaseModel):
    """Single credit-application review thread for analyst approval.

    The AI layer assembles creditworthiness evidence (trade references, payment
    history, exposure requested) and proposes a limit or payment terms for
    human review.  No limit or term change is ever applied automatically —
    all modifications require analyst approval.
    """

    model_config = ConfigDict(extra="forbid")

    application_id: str = Field(min_length=1)
    customer_id: str = Field(default="")
    account_id: str = Field(default="")
    risk_level: str = Field(pattern="^(low|medium|high|critical)$")
    recommended_action: str = Field(
        pattern="^(approve|approve_with_conditions|deny|request_more_info|manual_review|no_op)$",
    )
    proposed_credit_limit: float = Field(
        default=0.0,
        ge=0.0,
        description="Proposed credit limit in dollars; 0 means no change proposed.",
    )
    proposed_terms: str = Field(
        default="",
        description="Proposed payment terms (e.g. net30, net45, net60, cod, prepay).",
    )
    current_credit_limit: float = Field(default=0.0, ge=0.0)
    requested_credit_limit: float = Field(default=0.0, ge=0.0)
    operating_model_tags: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)
    stale_inputs: list[str] = Field(default_factory=list)
    material_signal_key: str = Field(default="")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str


def credit_application_proposal_v1_schema() -> dict[str, Any]:
    return CreditApplicationProposalV1.model_json_schema()


async def run_credit_application_reviewer(
    application_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Agentic creditworthiness review for a single credit application.

    Assembles trade-reference, payment-history, and exposure evidence and
    proposes whether to approve, condition, or deny the application.  The
    analyst must approve any resulting credit-limit or payment-terms change.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=CreditApplicationProposalV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "CreditApplicationProposalV1",
    "CreditProposalV1",
    "OM_TAG_CREDIT_APPLICATION",
    "credit_application_proposal_v1_schema",
    "credit_proposal_v1_schema",
    "run_credit_analyst",
    "run_credit_application_reviewer",
]
