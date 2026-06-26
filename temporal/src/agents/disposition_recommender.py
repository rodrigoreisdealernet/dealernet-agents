"""Disposition recommendation agent.

Turns lifecycle evidence for a single asset into a canonical disposition
recommendation: keep, sell_now, or replace.

Operating-model coverage (Regional / Enterprise Operations Executive):
  t1 — Review fleet lifecycle status and dispose recommendations
  t5 — Approve capital expenditure or sale authorisation

The agent is strictly advisory — no asset sale, retirement purchase, or
depreciation journal is ever executed automatically.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .i18n import with_language_directive
from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

OM_TAG_LIFECYCLE = "operations-executive:t1"
OM_TAG_CAPEX = "operations-executive:t5"

_ACTION_TAGS: dict[str, str] = {
    "keep": OM_TAG_LIFECYCLE,
    "sell_now": OM_TAG_CAPEX,
    "replace": OM_TAG_CAPEX,
}


class DispositionRecommendationV1(BaseModel):
    """Single ranked disposition recommendation for one asset.

    Covers the evidence bundle, recommended action, timing rationale, and
    confidence score required for an executive to approve or defer the
    recommendation directly from the review queue.
    """

    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1)
    recommended_action: str = Field(
        pattern="^(keep|sell_now|replace)$",
        description="Canonical lifecycle disposition: keep the asset, sell it now, or replace it.",
    )
    timing_rationale: str = Field(
        description=(
            "When and why to act — covers the urgency window, key triggers "
            "(age, utilization, maintenance cost, market conditions), and "
            "recommended timeline for the executive's decision."
        ),
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Model confidence in the recommended action (0–1).",
    )
    evidence: list[str] = Field(
        default_factory=list,
        description="Traceable evidence strings from utilization, maintenance history, and lifecycle facts.",
    )
    priority: str = Field(
        pattern="^(critical|high|medium|low)$",
        description="Review urgency for the executive queue.",
    )
    rationale: str = Field(
        description="Full explanation of the recommendation, combining lifecycle evidence and financial context.",
    )
    age_months: int | None = Field(
        default=None,
        description="Asset age in whole months at the time of assessment.",
    )
    estimated_residual_value: float | None = Field(
        default=None,
        description="Estimated residual / market value in tenant currency at assessment date.",
    )
    total_cost_of_ownership: float | None = Field(
        default=None,
        description=(
            "Cumulative maintenance and operating cost over asset lifetime, "
            "if available from maintenance history."
        ),
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals are stale or missing.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of stale signals so the reviewer knows what to refresh.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description="Operating-model task tags (operations-executive:tN) for this finding.",
    )


def disposition_recommendation_v1_schema() -> dict[str, Any]:
    return DispositionRecommendationV1.model_json_schema()


async def run_disposition_recommender(
    asset_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    locale: str | None = None,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assessor for a single asset disposition finding.

    Returns a ``DispositionRecommendationV1`` dict enriched with operating-model
    tags and any stale-data callouts identified during the tool-call conversation.
    """
    messages = [
        {"role": "system", "content": with_language_directive(system_prompt, locale)},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=DispositionRecommendationV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    recommendation = result.response.model_dump(mode="json")
    tag = _ACTION_TAGS.get(str(recommendation.get("recommended_action") or "keep"), OM_TAG_LIFECYCLE)
    if tag not in recommendation.get("operating_model_tags", []):
        recommendation.setdefault("operating_model_tags", []).append(tag)
    if OM_TAG_LIFECYCLE not in recommendation.get("operating_model_tags", []):
        recommendation["operating_model_tags"].append(OM_TAG_LIFECYCLE)
    return recommendation


__all__ = [
    "OM_TAG_LIFECYCLE",
    "OM_TAG_CAPEX",
    "DispositionRecommendationV1",
    "disposition_recommendation_v1_schema",
    "run_disposition_recommender",
]
