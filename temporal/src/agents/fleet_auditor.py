from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]


class FleetRecommendationV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1)
    disposition: str = Field(pattern="^(keep|transfer|sell|replace|re_rent_out)$")
    target_branch_id: str | None = None
    utilization_pct: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    estimated_monthly_revenue_uplift: float = 0.0
    confidence: float = 0.0
    rationale: str


def fleet_recommendation_v1_schema() -> dict[str, Any]:
    return FleetRecommendationV1.model_json_schema()


async def run_fleet_auditor(
    asset_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=FleetRecommendationV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "FleetRecommendationV1",
    "fleet_recommendation_v1_schema",
    "run_fleet_auditor",
]
