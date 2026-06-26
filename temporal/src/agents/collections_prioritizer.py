from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools


class CollectionsFindingV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer_id: str
    finding_type: str = "collections_priority"
    severity: str = "medium"
    recommended_action: str
    total_exposure: float = 0.0
    days_overdue: int = 0
    predicted_breach_at: dt.datetime | None = None
    days_to_breach: int | None = None
    next_step_note: str = ""
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    rationale: str


def collections_finding_v1_schema() -> dict[str, Any]:
    return CollectionsFindingV1.model_json_schema()


async def _no_tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"status": "unsupported_tool", "tool_name": tool_name}


async def run_collections_prioritizer(
    payload: Mapping[str, Any],
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
        response_format=CollectionsFindingV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "CollectionsFindingV1",
    "collections_finding_v1_schema",
    "run_collections_prioritizer",
]
