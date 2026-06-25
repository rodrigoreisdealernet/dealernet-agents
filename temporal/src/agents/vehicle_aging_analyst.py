from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

# Vehicle Stock-Aging Analyst (issue #32).
#
# Unlike the revenue-recognition analyst this agent uses NO tools: all evidence
# is provided inline in the user prompt, so chat_with_tools is invoked with an
# empty tool list (which means the transport never sends a `tool_choice`).
# Structured output is still validated client-side against the closed schema
# (strict=False on the Azure side; see openai_client._enforce_closed_schema).

_RECOMMENDED_ACTIONS = ("monitor", "markdown", "transfer", "prioritize_sale", "wholesale_auction")


class VehicleAgingFindingV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vehicle_id: str
    finding_type: str = "stock_aging_90d"
    severity: str = "medium"
    days_in_stock: int = 0
    aging_bucket: str = "approaching"
    recommended_action: str
    estimated_exposure: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    rationale: str


def vehicle_aging_finding_v1_schema() -> dict[str, Any]:
    return VehicleAgingFindingV1.model_json_schema()


async def _no_tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    # The vehicle aging analyst is configured without tools; this executor only
    # exists to satisfy the chat_with_tools contract and short-circuits any
    # (unexpected) tool request.
    return {"status": "unsupported_tool", "tool_name": tool_name}


async def run_vehicle_aging_analyst(
    vehicle_payload: Mapping[str, Any],
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
        response_format=VehicleAgingFindingV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "VehicleAgingFindingV1",
    "run_vehicle_aging_analyst",
    "vehicle_aging_finding_v1_schema",
]
