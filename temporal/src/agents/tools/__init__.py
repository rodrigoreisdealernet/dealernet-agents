"""Read-only rental data tools for agent evidence gathering."""

from .registry import AgentToolConfig, build_agent_tool_registry
from .rental_data import (
    AppScope,
    InMemoryRentalReadModel,
    PostgrestReadClient,
    RentalDataStore,
    SqlRentalReadModel,
    SupabaseRentalReadModel,
    build_service_role_rental_store,
    get_invoice_detail,
    get_rate_card,
    get_telematics,
    query_entity,
    query_facts,
    query_relationships,
    query_time_series,
)

__all__ = [
    "AgentToolConfig",
    "AppScope",
    "PostgrestReadClient",
    "InMemoryRentalReadModel",
    "RentalDataStore",
    "SupabaseRentalReadModel",
    "SqlRentalReadModel",
    "build_service_role_rental_store",
    "build_agent_tool_registry",
    "get_invoice_detail",
    "get_rate_card",
    "get_telematics",
    "query_entity",
    "query_facts",
    "query_relationships",
    "query_time_series",
]
