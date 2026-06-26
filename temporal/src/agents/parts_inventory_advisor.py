from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools


class PartsInventoryFindingV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    part_id: str
    finding_type: str = "replenish_now"
    severity: str = "medium"
    recommended_action: str
    quantity_suggested: int = 0
    value_at_risk: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    rationale: str


def parts_inventory_finding_v1_schema() -> dict[str, Any]:
    return PartsInventoryFindingV1.model_json_schema()


async def _no_tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"status": "unsupported_tool", "tool_name": tool_name}


async def run_parts_inventory_advisor(
    part_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    max_tool_rounds: int = 0,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=[],
        tool_executor=_no_tool_executor,
        response_format=PartsInventoryFindingV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "PartsInventoryFindingV1",
    "parts_inventory_finding_v1_schema",
    "run_parts_inventory_advisor",
]
