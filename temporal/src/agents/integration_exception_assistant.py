from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .openai_client import ChatCompletionTransport, chat_with_tools

ToolExecutor = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]

# Operating-model tag constants for the rental-software-administrator role.
# Threaded into every exception thread so downstream consumers can filter or
# route by task category without re-parsing free-text rationale.
#   t5 — Monitor customer-portal integration health and investigate data-flow
#         exceptions before customer self-service goes stale.
#   t6 — Monitor logistics and mobile-app integrations so dispatch, field, and
#         rental-system records remain aligned.
#   t7 — Audit stale or re-keyed master data when branch workflows depend on
#         outdated availability, contract, or customer records.
OM_TAG_PORTAL_EXCEPTION = "rental-software-administrator:t5"
OM_TAG_LOGISTICS_EXCEPTION = "rental-software-administrator:t6"
OM_TAG_MASTER_DATA_DRIFT = "rental-software-administrator:t7"

_EXCEPTION_TYPE_TAGS: dict[str, str] = {
    "portal_exception": OM_TAG_PORTAL_EXCEPTION,
    "logistics_exception": OM_TAG_LOGISTICS_EXCEPTION,
    "master_data_drift": OM_TAG_MASTER_DATA_DRIFT,
}


class IntegrationExceptionThreadV1(BaseModel):
    """Single ranked thread in the integration and master-data exception queue.

    Collapses all relevant signals (integration delivery failures, portal sync
    errors, logistics/mobile mismatches, stale master-data records) for one
    canonical issue into a single reviewable thread.  Duplicate symptoms that
    share the same underlying outage or data-quality problem are grouped into
    one canonical thread.  The workflow is *assist* only — no automatic data
    correction, retry approval bypass, or customer communication is performed.
    """

    model_config = ConfigDict(extra="forbid")

    exception_id: str = Field(min_length=1, description="Canonical identifier for this exception thread.")
    exception_type: str = Field(
        pattern="^(portal_exception|logistics_exception|master_data_drift)$",
        description="Primary exception classification for this thread.",
    )
    priority: str = Field(pattern="^(critical|high|medium|low)$")
    title: str = Field(
        default="",
        description="Short human-readable title for the exception thread.",
    )
    summary: str = Field(
        default="",
        description="Concise summary of the issue, affected workflows, and business impact.",
    )
    affected_workflows: list[str] = Field(
        default_factory=list,
        description="Workflow or record identifiers affected by this exception.",
    )
    likely_root_cause: str = Field(
        description="AI-assessed most probable root cause for this exception thread.",
    )
    recommended_action: str = Field(
        description=(
            "Concise next-step recommendation for the administrator — "
            "investigation or fix path only, no automatic action is taken."
        ),
    )
    evidence: list[str] = Field(
        default_factory=list,
        description=(
            "Traceable evidence strings citing integration delivery logs, "
            "portal sync errors, logistics mismatches, or stale-record signals."
        ),
    )
    duplicate_signal_count: int = Field(
        default=0,
        description="Count of deduplicated sibling signals collapsed into this thread.",
    )
    source_connector: str = Field(
        default="",
        description="Integration connector key (e.g. mulesoft, descartes, portal, samsara) or 'master_data'.",
    )
    tenant_id: str = Field(default="")
    freshness_note: str = Field(
        default="",
        description="Human-readable note about data freshness for this thread.",
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = Field(
        description="Explanation of why this thread is ranked at this priority.",
    )
    is_stale_data: bool = Field(
        default=False,
        description="True when one or more input signals are stale.",
    )
    stale_signals: list[str] = Field(
        default_factory=list,
        description="Descriptions of the stale signals so the administrator knows what to refresh.",
    )
    operating_model_tags: list[str] = Field(
        default_factory=list,
        description=(
            "Operating-model task tags (rental-software-administrator:tN) for this thread."
        ),
    )


def integration_exception_thread_v1_schema() -> dict[str, Any]:
    return IntegrationExceptionThreadV1.model_json_schema()


async def run_integration_exception_assistant(
    exception_payload: Mapping[str, Any],
    *,
    system_prompt: str,
    user_prompt_template: str,
    tools: Sequence[Mapping[str, Any]],
    tool_executor: ToolExecutor,
    max_tool_rounds: int = 5,
    transport: ChatCompletionTransport | None = None,
) -> dict[str, Any]:
    """Run the AI assistant for a single integration exception thread.

    Returns an ``IntegrationExceptionThreadV1`` dict enriched with
    operating-model tags and any stale-data callouts identified during the
    tool-call conversation.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_template},
    ]
    result = await chat_with_tools(
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        response_format=IntegrationExceptionThreadV1,
        max_tool_rounds=max_tool_rounds,
        transport=transport,
    )
    thread = result.response.model_dump(mode="json")
    # Ensure the canonical operating-model tag for this exception type is present.
    tag = _EXCEPTION_TYPE_TAGS.get(str(thread.get("exception_type") or ""))
    if tag and tag not in thread.get("operating_model_tags", []):
        thread.setdefault("operating_model_tags", []).append(tag)
    return thread


__all__ = [
    "OM_TAG_LOGISTICS_EXCEPTION",
    "OM_TAG_MASTER_DATA_DRIFT",
    "OM_TAG_PORTAL_EXCEPTION",
    "IntegrationExceptionThreadV1",
    "integration_exception_thread_v1_schema",
    "run_integration_exception_assistant",
]
