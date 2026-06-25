from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants for the branch operations manager role.
# Threaded into every brief item so downstream consumers can filter or route
# by task category without re-parsing free-text rationale.
#   t1 — Review overnight contract/AP-hold/utilization exceptions
#   t4 — Coordinate dispatch exceptions and delivery sequencing
#   t5 — Coordinate unavailable units, maintenance priorities, shop follow-up
#   t6 — Review weekly sales plans, route customer follow-up prompts
OM_TAG_CONTRACT_EXCEPTION = "branch-operations-manager:t1"
OM_TAG_AP_HOLD = "branch-operations-manager:t1"
OM_TAG_UTILIZATION_OUTLIER = "branch-operations-manager:t1"
OM_TAG_DISPATCH_EXCEPTION = "branch-operations-manager:t4"
OM_TAG_MAINTENANCE_BLOCKER = "branch-operations-manager:t5"
OM_TAG_UNAVAILABLE_UNIT = "branch-operations-manager:t5"
OM_TAG_CUSTOMER_FOLLOWUP = "branch-operations-manager:t6"

_ITEM_TYPE_TAGS: dict[str, str] = {
    "contract_exception": OM_TAG_CONTRACT_EXCEPTION,
    "ap_hold": OM_TAG_AP_HOLD,
    "utilization_outlier": OM_TAG_UTILIZATION_OUTLIER,
    "dispatch_exception": OM_TAG_DISPATCH_EXCEPTION,
    "maintenance_blocker": OM_TAG_MAINTENANCE_BLOCKER,
    "unavailable_unit": OM_TAG_UNAVAILABLE_UNIT,
    "customer_followup": OM_TAG_CUSTOMER_FOLLOWUP,
}

_VALID_ITEM_TYPES = "|".join(_ITEM_TYPE_TAGS.keys())


class BranchBriefItemV1(BaseModel):
    """Single ranked item in the branch morning brief.

    Covers overnight contract/AP/utilization exceptions, dispatch risks,
    unavailable-unit / maintenance blockers, and high-value customer follow-up
    prompts.  Designed to be an *assist* surface only — no customer-facing,
    money-moving, or status-changing actions are performed automatically.
    """

    model_config = ConfigDict(extra="forbid")

    item_id: str = Field(min_length=1, description="Source record ID (contract, asset, customer, etc.).")
    item_type: str = Field(
        pattern=f"^({_VALID_ITEM_TYPES})$",
    )
    priority: str = Field(pattern="^(critical|high|medium|low)$")
    recommendation: str = Field(
        description="Concise next-step recommendation for the branch manager."
    )
    owner_team: str = Field(
        description="The team or person who should action this item (e.g. counter, yard, shop, sales)."
    )
    evidence: list[str] = Field(
        default_factory=list,
        description="Traceable evidence strings citing contract status, AR balance, utilization %, etc.",
    )
    blockers: list[str] = Field(
        default_factory=list,
        description="Explicit conditions preventing resolution without human decision.",
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = Field(
        description="Explanation of why this item is ranked at this priority."
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals are stale.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of the stale signals so the manager knows what to refresh.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description="Operating-model task tags (branch-operations-manager:tN) for this item.",
    )
    source_record_id: str | None = Field(
        default=None,
        description="Primary source record ID for drill-down (contract_id, asset_id, etc.).",
    )
    secondary_record_id: str | None = Field(
        default=None,
        description="Secondary source record ID (e.g. billing_account_id for AP holds).",
    )


def branch_brief_item_v1_schema() -> dict[str, Any]:
    return BranchBriefItemV1.model_json_schema()


async def run_branch_brief_assistant(
    item_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assistant for a single branch brief item.

    Returns a ``BranchBriefItemV1`` dict enriched with operating-model tags and
    any stale-data callouts identified during the tool-call conversation.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=BranchBriefItemV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    item = result.response.model_dump(mode="json")
    # Ensure the canonical operating-model tag for this item type is present.
    tag = _ITEM_TYPE_TAGS.get(str(item.get("item_type") or ""))
    if tag and tag not in item.get("operating_model_tags", []):
        item.setdefault("operating_model_tags", []).append(tag)
    return item


__all__ = [
    "BranchBriefItemV1",
    "OM_TAG_AP_HOLD",
    "OM_TAG_CONTRACT_EXCEPTION",
    "OM_TAG_CUSTOMER_FOLLOWUP",
    "OM_TAG_DISPATCH_EXCEPTION",
    "OM_TAG_MAINTENANCE_BLOCKER",
    "OM_TAG_UNAVAILABLE_UNIT",
    "OM_TAG_UTILIZATION_OUTLIER",
    "branch_brief_item_v1_schema",
    "run_branch_brief_assistant",
]
