from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .i18n import with_language_directive
from .openai_client import ChatCompletionTransport, chat_with_tools
from .vehicle_inventory_signals import FINDING_FLOOR_PLAN_ESCALATION

# Vehicle Stock-Aging Analyst — anticipatory inventory analysis.
#
# The deterministic signal engine (vehicle_inventory_signals) decides WHAT the
# problem is (finding_type), HOW bad (severity) and the money exposure. The LLM
# only prioritizes, recommends a reviewable action and explains — so it uses NO
# tools: all evidence is provided inline in the user prompt and chat_with_tools
# is invoked with an empty tool list. Structured output is validated client-side
# against the closed schema (see openai_client._enforce_closed_schema).

_RECOMMENDED_ACTIONS = ("monitor", "markdown", "transfer", "prioritize_sale", "wholesale_auction")


class VehicleAgingFindingV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vehicle_id: str
    finding_type: str = FINDING_FLOOR_PLAN_ESCALATION
    severity: str = "medium"
    days_in_stock: int = 0
    predicted_breach_at: dt.datetime | None = None
    days_to_breach: int | None = None
    signals: list[str] = Field(default_factory=list)
    recommended_action: str
    estimated_exposure: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    rationale: str


# Backwards-compatible alias so callers/tests importing the v1 name keep working
# against the evolved schema.
VehicleAgingFindingV1 = VehicleAgingFindingV2


def vehicle_aging_finding_v2_schema() -> dict[str, Any]:
    return VehicleAgingFindingV2.model_json_schema()


# Legacy name retained for older imports.
vehicle_aging_finding_v1_schema = vehicle_aging_finding_v2_schema


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
    locale: str | None = None,
    max_tool_rounds: int = 0,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    messages = [
        {"role": "system", "content": with_language_directive(system_prompt, locale)},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=[],
        tool_executor=_no_tool_executor,
        response_format=VehicleAgingFindingV2,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    return result.response.model_dump(mode="json")


__all__ = [
    "VehicleAgingFindingV1",
    "VehicleAgingFindingV2",
    "run_vehicle_aging_analyst",
    "vehicle_aging_finding_v1_schema",
    "vehicle_aging_finding_v2_schema",
]
