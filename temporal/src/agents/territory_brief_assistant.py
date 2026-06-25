from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants for the outside sales representative role.
# Threaded into every brief item so downstream consumers can filter or route
# by task category without re-parsing free-text rationale.
#   t1 — Maintain the territory account plan: review contractor/project pipelines,
#         prioritize target accounts, schedule next-contact dates.
#   t2 — Visit active jobsites and customer offices: review equipment performance,
#         probe upcoming phases, log account notes.
#   t4 — Update CRM opportunity stages, visit notes, and promised follow-ups after
#         each account interaction.
OM_TAG_TERRITORY_PLAN = "outside-sales-representative:t1"
OM_TAG_SITE_VISIT = "outside-sales-representative:t2"
OM_TAG_FOLLOWUP_UPDATE = "outside-sales-representative:t4"

_BRIEF_TYPE_TAGS: dict[str, str] = {
    "pre_visit": OM_TAG_SITE_VISIT,
    "territory_plan": OM_TAG_TERRITORY_PLAN,
    "followup_update": OM_TAG_FOLLOWUP_UPDATE,
}

_VALID_BRIEF_TYPES = "|".join(_BRIEF_TYPE_TAGS.keys())


class TerritoryBriefItemV1(BaseModel):
    """Single account entry in the territory account brief.

    Assembles recent rentals, open opportunities, visit history, multi-branch
    signals, promised follow-ups, and branch-side execution risks into a
    disposition-ready brief the rep can review before a call or site visit.

    Design constraints:
    - assist only — no automatic customer outreach, account-stage mutation,
      pricing commitment, or branch promise.
    - All recommendations and risks carry evidence and freshness indicators
      so the rep can verify the source before acting.
    - An explicit follow_up_draft field supports post-visit review without
      silently mutating CRM stages.
    - A no-op state (brief_type='territory_plan' with no material signals) is
      explicitly surfaced rather than presenting a falsely complete brief.
    """

    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, description="Source customer or account record ID.")
    account_name: str = Field(default="")
    brief_type: str = Field(
        pattern=f"^({_VALID_BRIEF_TYPES})$",
        description=(
            "Classification of this brief entry: 'pre_visit' for an upcoming call or site visit, "
            "'territory_plan' for the weekly account plan review, "
            "'followup_update' for a post-visit follow-up context update."
        ),
    )
    priority: str = Field(pattern="^(critical|high|medium|low)$")
    recommended_action: str = Field(
        description="Concise next-step recommendation for the rep before or after the visit.",
    )
    follow_up_draft: str = Field(
        default="",
        description=(
            "Draft follow-up context for the rep to review and edit after a visit or call. "
            "Never written to CRM stages, notes, or outreach automatically."
        ),
    )
    open_opportunities: int = Field(
        default=0,
        description="Count of open CRM opportunities linked to this account.",
    )
    recent_rentals: list[str] = Field(
        default_factory=list,
        description="Summaries of recent rental activity for this account (last 90 days).",
    )
    visit_history: list[str] = Field(
        default_factory=list,
        description="Notable past visit or contact notes relevant to the next conversation.",
    )
    promised_follow_ups: list[str] = Field(
        default_factory=list,
        description="Promised next steps from prior interactions that are still open.",
    )
    branch_risks: list[str] = Field(
        default_factory=list,
        description=(
            "Branch-side execution risks relevant to the account: availability gaps, "
            "dispatch issues, maintenance blockers, or utilization outliers."
        ),
    )
    cross_branch_signals: list[str] = Field(
        default_factory=list,
        description="Notable signals from other branches serving this account.",
    )
    evidence: list[str] = Field(
        default_factory=list,
        description=(
            "Traceable evidence strings citing CRM, rental history, utilization, "
            "contact gaps, and branch records. Freshness indicator included per signal."
        ),
    )
    freshness_warnings: list[str] = Field(
        default_factory=list,
        description=(
            "Signals where the underlying data is stale or incomplete. "
            "The rep should verify these before acting."
        ),
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = Field(
        description="Explanation of why this account is prioritised at this level for this brief.",
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals are stale or missing.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of stale signals so the rep knows what to refresh.",
    )
    source_account_id: str | None = Field(
        default=None,
        description="Drill-down link to the source CRM or RentalMan account record.",
    )
    source_opportunity_id: str | None = Field(
        default=None,
        description="Drill-down link to the primary open CRM opportunity, if any.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description=(
            "Operating-model task tags (outside-sales-representative:tN) for this brief item."
        ),
    )


def territory_brief_item_v1_schema() -> dict[str, Any]:
    return TerritoryBriefItemV1.model_json_schema()


async def run_territory_brief_assistant(
    account_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assistant for a single territory account brief item.

    Returns a ``TerritoryBriefItemV1`` dict enriched with operating-model tags
    and any stale-data callouts identified during the tool-call conversation.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=TerritoryBriefItemV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    item = result.response.model_dump(mode="json")
    # Ensure the canonical operating-model tag for this brief type is present.
    tag = _BRIEF_TYPE_TAGS.get(str(item.get("brief_type") or ""))
    if tag and tag not in item.get("operating_model_tags", []):
        item.setdefault("operating_model_tags", []).append(tag)
    return item


__all__ = [
    "OM_TAG_TERRITORY_PLAN",
    "OM_TAG_SITE_VISIT",
    "OM_TAG_FOLLOWUP_UPDATE",
    "TerritoryBriefItemV1",
    "territory_brief_item_v1_schema",
    "run_territory_brief_assistant",
]
