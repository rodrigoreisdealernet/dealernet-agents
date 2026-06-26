from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import pytest
from temporal.src.agents.portal_assistant import (
    MAX_CHART_POINTS,
    allowed_screen_keys,
    build_messages,
    filter_actions_to_allowlist,
    run_portal_assistant,
    sanitize_charts,
)
from temporal.src.agents.portal_assistant_schema import (
    AssistantAction,
    AssistantChart,
    AssistantChartSeries,
    AssistantReplyV1,
)


class _FakeTransport:
    """Replays canned chat completions (mirrors test_openai_client._FakeTransport)."""

    def __init__(self, responses: list[Mapping[str, Any]]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def complete(
        self,
        *,
        messages: list[Mapping[str, Any]],
        tools: list[Mapping[str, Any]],
        response_schema: dict[str, Any],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> Mapping[str, Any]:
        self.calls.append({"messages": [dict(m) for m in messages], "tools": list(tools)})
        return self._responses.pop(0)


class _FakeReadClient:
    """Stands in for PostgrestReadClient — records the view it was asked for."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.requested_views: list[str] = []

    def select(self, resource: str, **_kwargs: Any) -> list[dict[str, Any]]:
        self.requested_views.append(resource)
        return list(self._rows)


def _assistant_message(*, content: str | None = None, tool_calls: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return {"choices": [{"message": message}]}


_CONTEXT = {
    "current_screen": "dia-overview",
    "empresa_id": "emp-1",
    "available_screens": [
        {"component_key": "dia-sales", "title": "Vendas (VN/VU)", "solution": "Fast BI"},
        {"component_key": "dia-overview", "title": "Visão do Dono", "solution": "Fast BI"},
    ],
}


@pytest.mark.asyncio
async def test_run_portal_assistant_answers_with_bi_data_and_navigates() -> None:
    final_reply = {
        "reply": "Suas vendas somam R$ 1,2M no mês. Abri o painel de vendas.",
        "actions": [{"type": "open_screen", "component_key": "dia-sales", "title": "Vendas (VN/VU)"}],
        "suggestions": ["E a margem?", "Como está o estoque?"],
    }
    transport = _FakeTransport(
        [
            _assistant_message(
                tool_calls=[
                    {
                        "id": "call-1",
                        "type": "function",
                        "function": {"name": "get_owner_kpis", "arguments": "{}"},
                    }
                ]
            ),
            _assistant_message(content=json.dumps(final_reply)),
        ]
    )
    read_client = _FakeReadClient([{"sales_revenue_month": 1200000, "sales_units_month": 42}])

    reply = await run_portal_assistant(
        [{"role": "user", "content": "como estão minhas vendas hoje?"}],
        _CONTEXT,
        read_client=read_client,
        transport=transport,
    )

    assert isinstance(reply, AssistantReplyV1)
    assert "vendas" in reply.reply.lower()
    # The BI tool actually executed against the (fake) data source.
    assert read_client.requested_views == ["v_dia_owner_kpis"]
    assert [a.component_key for a in reply.actions] == ["dia-sales"]


@pytest.mark.asyncio
async def test_run_portal_assistant_drops_navigation_outside_allowlist() -> None:
    # Model tries to open a screen the user has no access to (not in available_screens).
    final_reply = {
        "reply": "Aqui está.",
        "actions": [
            {"type": "open_screen", "component_key": "admin-users", "title": "Usuários"},
            {"type": "open_screen", "component_key": "dia-sales", "title": "Vendas"},
        ],
        "suggestions": [],
    }
    transport = _FakeTransport([_assistant_message(content=json.dumps(final_reply))])

    reply = await run_portal_assistant(
        [{"role": "user", "content": "abre o cadastro de usuários"}],
        _CONTEXT,
        read_client=_FakeReadClient([]),
        transport=transport,
    )
    filtered = filter_actions_to_allowlist(reply, allowed_screen_keys(_CONTEXT))

    keys = [a.component_key for a in filtered.actions]
    assert "admin-users" not in keys  # dropped: outside the permissioned allowlist
    assert keys == ["dia-sales"]


def test_filter_actions_to_allowlist_is_noop_when_all_allowed() -> None:
    reply = AssistantReplyV1(
        reply="ok",
        actions=[AssistantAction(type="open_screen", component_key="dia-sales", title="Vendas")],
    )
    out = filter_actions_to_allowlist(reply, {"dia-sales", "dia-overview"})
    assert out is reply  # unchanged object when nothing is dropped


@pytest.mark.asyncio
async def test_run_portal_assistant_returns_inline_chart_from_tool() -> None:
    final_reply = {
        "reply": "Tendência das vendas dos últimos dias:",
        "charts": [
            {
                "title": "Vendas por dia",
                "type": "line",
                "x_key": "sale_date",
                "series": [{"key": "revenue", "label": "Receita", "format": "currency"}],
                "data": [
                    {"sale_date": "2026-06-24", "revenue": 1200000},
                    {"sale_date": "2026-06-25", "revenue": 1500000},
                ],
                "value_format": "currency",
            }
        ],
    }
    transport = _FakeTransport(
        [
            _assistant_message(
                tool_calls=[
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "get_sales_trend", "arguments": "{}"},
                    }
                ]
            ),
            _assistant_message(content=json.dumps(final_reply)),
        ]
    )
    read_client = _FakeReadClient([{"sale_date": "2026-06-25", "revenue": 1500000}])

    reply = await run_portal_assistant(
        [{"role": "user", "content": "mostre a tendência de vendas"}],
        _CONTEXT,
        read_client=read_client,
        transport=transport,
    )

    assert read_client.requested_views == ["v_dia_sales_trend"]
    assert len(reply.charts) == 1
    assert reply.charts[0].type == "line"
    assert reply.charts[0].series[0].key == "revenue"
    assert len(reply.charts[0].data) == 2


def test_sanitize_charts_drops_empty_and_caps_points() -> None:
    big = AssistantChart(
        title="X",
        type="line",
        x_key="d",
        series=[AssistantChartSeries(key="v")],
        data=[{"d": str(i), "v": float(i)} for i in range(MAX_CHART_POINTS + 15)],
    )
    empty = AssistantChart(title="Y", type="bar", x_key="d", series=[AssistantChartSeries(key="v")], data=[])
    reply = AssistantReplyV1(reply="ok", charts=[big, empty])

    out = sanitize_charts(reply)

    assert len(out.charts) == 1  # empty dropped
    assert len(out.charts[0].data) == MAX_CHART_POINTS  # capped


def test_build_messages_injects_allowlist_into_system_prompt() -> None:
    messages, allowed = build_messages(
        [{"role": "user", "content": "oi"}],
        _CONTEXT,
    )
    assert messages[0]["role"] == "system"
    assert "dia-sales" in messages[0]["content"]
    # Period-disambiguation guidance must be present (issue #104).
    assert "PERÍODO" in messages[0]["content"]
    assert messages[-1] == {"role": "user", "content": "oi"}
    assert allowed == {"dia-sales", "dia-overview"}
