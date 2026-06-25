from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants for the outside sales representative role.
# Threaded into every account thread so downstream consumers can filter or
# route by task category without re-parsing free-text rationale.
#   t6 — Review dormant or lost accounts, run win-back outreach campaigns
#   t7 — Review multi-branch rental history, utilization shifts, at-risk or
#         growth accounts
OM_TAG_WIN_BACK = "outside-sales-representative:t6"
OM_TAG_ACCOUNT_HEALTH = "outside-sales-representative:t7"

_SIGNAL_TYPE_TAGS: dict[str, str] = {
    "dormant": OM_TAG_WIN_BACK,
    "lost": OM_TAG_WIN_BACK,
    "at_risk": OM_TAG_ACCOUNT_HEALTH,
    "growth_opportunity": OM_TAG_ACCOUNT_HEALTH,
}


class AccountHealthThreadV1(BaseModel):
    """Single ranked thread in the account health and dormant-account growth queue.

    Collapses all relevant signals (rental history, utilization, open
    opportunities, contact gaps) for one account into a single reviewable
    thread.  The outreach_draft is a rep-editable suggestion — no automatic
    outreach, account-stage mutation, or commercial offer is ever made.
    """

    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1)
    account_name: str = Field(default="")
    health_signal: str = Field(
        pattern="^(dormant|lost|at_risk|growth_opportunity)$",
        description="Primary account health classification for this thread.",
    )
    priority: str = Field(pattern="^(critical|high|medium|low)$")
    recommended_angle: str = Field(
        description="Win-back, retention, or growth angle for the rep to act on."
    )
    outreach_draft: str = Field(
        default="",
        description=(
            "Draft outreach rationale for rep review and editing — "
            "never sent automatically."
        ),
    )
    evidence: list[str] = Field(
        default_factory=list,
        description="Traceable evidence strings from rental history, utilization, and CRM.",
    )
    contact_gap_days: int = Field(
        default=0,
        description="Days since last logged contact or interaction.",
    )
    last_rental_date: str | None = Field(
        default=None,
        description="ISO date of the account's most recent rental activity.",
    )
    utilization_trend: str = Field(
        default="unknown",
        pattern="^(improving|stable|declining|unknown)$",
    )
    open_opportunities: int = Field(
        default=0,
        description="Count of open CRM opportunities linked to this account.",
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = Field(
        description="Explanation of why this account is ranked at this priority."
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals are stale.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of stale signals so the rep knows what to refresh.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description="Operating-model task tags (outside-sales-representative:tN) for this thread.",
    )


def account_health_thread_v1_schema() -> dict[str, Any]:
    return AccountHealthThreadV1.model_json_schema()


async def run_account_health_assistant(
    account_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assistant for a single account health thread.

    Returns an ``AccountHealthThreadV1`` dict enriched with operating-model
    tags and any stale-data callouts identified during the tool-call
    conversation.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=AccountHealthThreadV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    thread = result.response.model_dump(mode="json")
    # Ensure the canonical operating-model tag for this signal type is present.
    tag = _SIGNAL_TYPE_TAGS.get(str(thread.get("health_signal") or ""))
    if tag and tag not in thread.get("operating_model_tags", []):
        thread.setdefault("operating_model_tags", []).append(tag)
    return thread


__all__ = [
    "OM_TAG_WIN_BACK",
    "OM_TAG_ACCOUNT_HEALTH",
    "AccountHealthThreadV1",
    "account_health_thread_v1_schema",
    "run_account_health_assistant",
]
