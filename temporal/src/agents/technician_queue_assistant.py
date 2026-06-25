from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants for the service technician role.
#   t1 — Inspect returned equipment, document damage, open repair follow-up
#   t2 — Execute PM work orders; diagnose and repair faults
#   t5 — Prepare repaired equipment for return to service (rent-ready check)
OM_TAG_RETURNED_UNIT = "service-technician:t1"
OM_TAG_PM_WORK = "service-technician:t2"
OM_TAG_ACTIVE_REPAIR = "service-technician:t2"
OM_TAG_RENT_READY_CHECK = "service-technician:t5"

_ITEM_TYPE_TAGS: dict[str, str] = {
    "returned_unit": OM_TAG_RETURNED_UNIT,
    "pm_work": OM_TAG_PM_WORK,
    "active_repair": OM_TAG_ACTIVE_REPAIR,
    "rent_ready_check": OM_TAG_RENT_READY_CHECK,
}


class TechnicianQueueItemV1(BaseModel):
    """Single ranked item in the technician morning queue.

    Covers returned units needing inspection/repair follow-up, PM work to
    execute, active repairs, and near-complete units needing rent-ready
    confirmation. Designed as an *assist* surface only — the technician or
    foreman makes all disposition decisions and the system records them.
    """

    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1)
    item_type: str = Field(
        pattern="^(returned_unit|pm_work|active_repair|rent_ready_check)$"
    )
    priority: str = Field(pattern="^(critical|high|medium|low)")
    recommendation: str = Field(
        description="Concise next-step recommendation for the technician."
    )
    priority_reasons: list[str] = Field(
        default_factory=list,
        description=(
            "Explicit priority reasons. Must include relevant entries from: "
            "contract_risk, overdue_maintenance, parts_blocker, "
            "has_return_condition_evidence. Each entry is a human-readable statement. "
            "When data is insufficient to determine a reason, include "
            "'insufficient_data: <field>' so the technician knows what is missing."
        ),
    )
    evidence: list[str] = Field(
        default_factory=list,
        description=(
            "Traceable evidence strings citing PM trigger, WO status, parts state, "
            "return condition, contract status, etc."
        ),
    )
    blockers: list[str] = Field(
        default_factory=list,
        description="Explicit blocking conditions that prevent this unit from being rent-ready.",
    )
    contract_risk: bool = Field(
        default=False,
        description="True when a live contract or imminent rental depends on this unit.",
    )
    overdue_maintenance: bool = Field(
        default=False,
        description="True when the PM or repair has exceeded its target completion window.",
    )
    parts_blocker: bool = Field(
        default=False,
        description="True when the work order is waiting on parts.",
    )
    has_return_condition_evidence: bool = Field(
        default=False,
        description=(
            "True when a return inspection or condition report already exists for "
            "this unit, so the technician can start work without a detective pass."
        ),
    )
    rent_ready_eta: str | None = Field(
        default=None,
        description=(
            "ISO date estimate for return to rent-ready status — "
            "presented for technician/foreman approval only, never mutated automatically."
        ),
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = Field(
        description="Explanation of why this item is ranked at this priority.",
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals are stale.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of the stale signals so the technician knows what to verify.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description="Operating-model task tags (service-technician:tN) for this item.",
    )
    work_order_id: str | None = Field(
        default=None,
        description="Source PM work order or maintenance record ID for drill-down.",
    )


def technician_queue_item_v1_schema() -> dict[str, Any]:
    return TechnicianQueueItemV1.model_json_schema()


async def run_technician_queue_assistant(
    item_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assistant for a single technician queue item.

    Returns a ``TechnicianQueueItemV1`` dict enriched with operating-model tags
    and any stale-data callouts identified during the tool-call conversation.

    Fails closed: if context is missing or ambiguous the assistant sets
    confidence=0 and populates ``priority_reasons`` with explicit
    ``insufficient_data:`` entries so the technician sees what is unknown.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=TechnicianQueueItemV1,
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
    "OM_TAG_ACTIVE_REPAIR",
    "OM_TAG_PM_WORK",
    "OM_TAG_RENT_READY_CHECK",
    "OM_TAG_RETURNED_UNIT",
    "TechnicianQueueItemV1",
    "run_technician_queue_assistant",
    "technician_queue_item_v1_schema",
]
