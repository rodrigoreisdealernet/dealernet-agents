from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

# Service Estimate Authorization Rescue Agent (issue #81).
#
# Like the vehicle stock-aging analyst this agent uses NO tools: all evidence is
# provided inline in the user prompt, so chat_with_tools is invoked with an empty
# tool list (which means the transport never sends a `tool_choice`). Structured
# output is still validated client-side against the closed schema below.
#
# Assist-only: the agent only recommends a reviewable next contact/recovery
# action; it never sends SMS/notifications, authorizes/reprices/discounts/cancels
# estimates, generates VendaPerdida, or moves money.

_RECOMMENDED_ACTIONS = ("contact_customer", "offer_discount", "reprice", "escalate", "monitor")


class ServiceEstimateFindingV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    estimate_id: str
    os_id: str = ""
    finding_type: str = "estimate_rescue"
    severity: str = "medium"
    recommended_action: str
    recoverable_value: float = 0.0
    predicted_breach_at: dt.datetime | None = None
    days_to_breach: int | None = None
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    rationale: str


def service_estimate_finding_v1_schema() -> dict[str, Any]:
    return ServiceEstimateFindingV1.model_json_schema()


async def _no_tool_executor(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    # The service-estimate rescue agent is configured without tools; this executor
    # only exists to satisfy the chat_with_tools contract and short-circuits any
    # (unexpected) tool request.
    return {"status": "unsupported_tool", "tool_name": tool_name}


async def run_service_estimate_rescue(
    estimate_payload: Mapping[str, Any],
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
        response_format=ServiceEstimateFindingV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "ServiceEstimateFindingV1",
    "run_service_estimate_rescue",
    "service_estimate_finding_v1_schema",
]
