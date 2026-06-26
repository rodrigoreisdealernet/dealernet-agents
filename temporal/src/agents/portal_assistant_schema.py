"""Structured output schema for the live Portal conversational assistant (DIA).

The assistant answers BI questions with real data (read-only tools run in the
backend) AND proposes UI navigation. Navigation is returned as ``actions`` that
the **frontend** executes via ``openWindow`` — the backend never drives the UI.

Kept deliberately small for the MVP: the only action is ``open_screen``. No
data-mutating actions (approve/reject/CRUD) are exposed here.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class AssistantAction(BaseModel):
    """A single UI action for the frontend to execute after replying."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["open_screen"] = Field(
        description="Action kind. Only 'open_screen' is supported in this version.",
    )
    component_key: str = Field(
        min_length=1,
        description=(
            "Screen key to open. MUST be one of the component_key values listed in "
            "the available_screens context — never invent a key."
        ),
    )
    title: str = Field(
        min_length=1,
        description="Window title to show for the opened screen (use the screen's label).",
    )
    # dict[str, str] (not dict[str, Any]) keeps the JSON schema open for arbitrary
    # keys while the closed-schema enforcer leaves additionalProperties intact.
    # Navigation params (e.g. findingId, agentKey) are always strings.
    params: dict[str, str] = Field(
        default_factory=dict,
        description="Optional navigation params for the screen (e.g. {'findingId': '...'}).",
    )
    reason: str = Field(
        default="",
        description="Short justification, shown for transparency (e.g. 'abrindo o painel de vendas').",
    )


class AssistantReplyV1(BaseModel):
    """Structured turn returned by the conversational assistant."""

    model_config = ConfigDict(extra="forbid")

    reply: str = Field(
        min_length=1,
        description="Natural-language answer in the requested portal locale, concise and factual.",
    )
    actions: list[AssistantAction] = Field(
        default_factory=list,
        description="UI actions to run after the reply (navigation). Empty when none apply.",
    )
    suggestions: list[str] = Field(
        default_factory=list,
        description="Up to 3 short follow-up prompts the user might ask next.",
    )


def assistant_reply_v1_schema() -> dict[str, Any]:
    """Export the response JSON schema (for inspection / registration)."""
    return AssistantReplyV1.model_json_schema()


__all__ = [
    "AssistantAction",
    "AssistantReplyV1",
    "assistant_reply_v1_schema",
]
