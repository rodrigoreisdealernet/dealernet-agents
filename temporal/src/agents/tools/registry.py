from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Any

from .rental_data import (
    AppScope,
    RentalDataStore,
    ToolValidationError,
    get_invoice_detail,
    get_rate_card,
    get_telematics,
    query_entity,
    query_facts,
    query_relationships,
    query_time_series,
)

ToolCallable = Callable[..., dict[str, Any]]

AVAILABLE_TOOLS: dict[str, ToolCallable] = {
    "query_entity": query_entity,
    "query_time_series": query_time_series,
    "query_relationships": query_relationships,
    "query_facts": query_facts,
    "get_invoice_detail": get_invoice_detail,
    "get_rate_card": get_rate_card,
    "get_telematics": get_telematics,
}


@dataclass(frozen=True)
class AgentToolConfig:
    tools: list[str]


def build_agent_tool_registry(
    config: AgentToolConfig,
    *,
    store: RentalDataStore,
    scope: AppScope,
) -> dict[str, ToolCallable]:
    registry: dict[str, ToolCallable] = {}
    for tool_name in config.tools:
        tool = AVAILABLE_TOOLS.get(tool_name)
        if tool is None:
            raise ToolValidationError(f"Unsupported tool configured: {tool_name}")
        registry[tool_name] = partial(tool, store, scope)
    return registry
