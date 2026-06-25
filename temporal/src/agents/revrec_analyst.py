from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

# tool name, JSON-serializable arguments -> tool result (sync or async)
ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]


class RevRecFindingAmounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rate_type: str | None = None
    amount: float | None = None
    period: str | None = None


class RevRecFindingV1Item(BaseModel):
    model_config = ConfigDict(extra="forbid")

    finding_type: str
    line_item_id: str = Field(min_length=1)
    severity: str
    expected: RevRecFindingAmounts = Field(default_factory=RevRecFindingAmounts)
    billed: RevRecFindingAmounts = Field(default_factory=RevRecFindingAmounts)
    delta: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    proposed_action: str | None = None
    confidence: float = 0.0
    rationale: str


class RevRecFindingV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_id: str
    findings: list[RevRecFindingV1Item] = Field(default_factory=list)


def revrec_finding_v1_schema() -> dict[str, Any]:
    return RevRecFindingV1.model_json_schema()


async def run_revrec_analyst(
    contract_payload: Mapping[str, Any],
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
        response_format=RevRecFindingV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "RevRecFindingV1",
    "RevRecFindingV1Item",
    "run_revrec_analyst",
    "revrec_finding_v1_schema",
]
