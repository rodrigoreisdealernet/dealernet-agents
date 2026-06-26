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


class AssistantChartSeries(BaseModel):
    """One drawn series of a chart (maps to ChartCard's ChartSeries)."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, description="Numeric field present in each data point.")
    label: str = Field(default="", description="Legend/tooltip name (defaults to key when empty).")
    format: Literal["currency", "percent", "number"] = Field(
        default="number",
        description="Value formatting for this series.",
    )


class AssistantChart(BaseModel):
    """Inline chart spec rendered by the frontend ChartCard (recharts).

    The assistant fills ``data`` strictly from BI tool results — never invented.
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, description="Chart title.")
    type: Literal["line", "bar", "pie"] = Field(description="Chart kind.")
    x_key: str = Field(min_length=1, description="Field used as the category/x axis (and pie slice name).")
    series: list[AssistantChartSeries] = Field(
        min_length=1,
        description="One drawn series per item; pie uses the first series.",
    )
    # Mixed value type: x_key is a category/date string, series values are numbers.
    data: list[dict[str, float | str]] = Field(
        default_factory=list,
        description="Already-resolved data points sourced from tools. Keep concise (<= 30 points).",
    )
    value_format: Literal["currency", "percent", "number"] = Field(
        default="number",
        description="Default axis/tooltip formatting.",
    )


class AssistantReplyV1(BaseModel):
    """Structured turn returned by the conversational assistant."""

    model_config = ConfigDict(extra="forbid")

    reply: str = Field(
        min_length=1,
        description=(
            "Answer in Brazilian Portuguese (pt-BR), concise and factual. May use simple "
            "Markdown (bold, lists, tables) — the chat renders it."
        ),
    )
    actions: list[AssistantAction] = Field(
        default_factory=list,
        description="UI actions to run after the reply (navigation). Empty when none apply.",
    )
    charts: list[AssistantChart] = Field(
        default_factory=list,
        description="Inline charts to render in the chat, built from tool data. Empty when none apply.",
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
    "AssistantChart",
    "AssistantChartSeries",
    "AssistantReplyV1",
    "assistant_reply_v1_schema",
]
