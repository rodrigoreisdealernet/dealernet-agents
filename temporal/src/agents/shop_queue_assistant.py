from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants for the service/maintenance manager role.
# Threaded into every queue item so downstream consumers can filter or route
# by task category without re-parsing free-text rationale.
#   t1 — PM-due list review and work-order opening
#   t2 — Work-order triage and resequencing
#   t3 — Not-available status / return-to-fleet comms
#   t6 — Parts/consumables monitoring
OM_TAG_PM_DUE = "service-maintenance-manager:t1"
OM_TAG_WORK_ORDER_PRIORITY = "service-maintenance-manager:t2"
OM_TAG_NOT_AVAILABLE = "service-maintenance-manager:t3"
OM_TAG_PARTS_BLOCKER = "service-maintenance-manager:t6"

_ITEM_TYPE_TAGS: dict[str, str] = {
    "pm_due": OM_TAG_PM_DUE,
    "work_order_priority": OM_TAG_WORK_ORDER_PRIORITY,
    "not_available_unit": OM_TAG_NOT_AVAILABLE,
    "parts_blocker": OM_TAG_PARTS_BLOCKER,
}


class ShopQueueItemV1(BaseModel):
    """Single ranked item in the morning shop queue.

    Covers PM-due units, open work-order priorities, parts blockers, and
    not-available equipment needing return-to-fleet disposition.  Designed to
    be an *assist* surface only — no status mutations are performed.
    """

    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1)
    item_type: str = Field(
        pattern="^(pm_due|work_order_priority|parts_blocker|not_available_unit)$"
    )
    priority: str = Field(pattern="^(critical|high|medium|low)$")
    recommendation: str = Field(
        description="Concise next-step recommendation for the shop manager."
    )
    evidence: list[str] = Field(
        default_factory=list,
        description="Traceable evidence strings citing PM trigger, WO status, parts state, etc.",
    )
    blockers: list[str] = Field(
        default_factory=list,
        description="Explicit blocking conditions that prevent this unit from being rent-ready.",
    )
    return_to_fleet_eta: str | None = Field(
        default=None,
        description=(
            "ISO date estimate for return to rent-ready status — "
            "presented for human approval only, never mutated automatically."
        ),
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = Field(
        description="Explanation of why this item is ranked at this priority."
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals (meter, tech update, parts) are stale.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of the stale signals so the manager knows what to refresh.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description="Operating-model task tags (service-maintenance-manager:tN) for this item.",
    )
    work_order_id: str | None = Field(
        default=None,
        description="Source PM work order or maintenance record ID for drill-down.",
    )


def shop_queue_item_v1_schema() -> dict[str, Any]:
    return ShopQueueItemV1.model_json_schema()


async def run_shop_queue_assistant(
    item_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assistant for a single shop queue item.

    Returns a ``ShopQueueItemV1`` dict enriched with operating-model tags and
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
        response_format=ShopQueueItemV1,
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
    "OM_TAG_NOT_AVAILABLE",
    "OM_TAG_PARTS_BLOCKER",
    "OM_TAG_PM_DUE",
    "OM_TAG_WORK_ORDER_PRIORITY",
    "ShopQueueItemV1",
    "run_shop_queue_assistant",
    "shop_queue_item_v1_schema",
]
