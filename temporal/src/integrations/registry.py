"""Connector registry for the shared integration framework.

Register provider adapters so they can be discovered by name from
integration_config rows without hard-coded import trees.

``ConnectorProvider`` and ``build_connector_registry`` are retained for
backward compatibility with callers written against the Descartes-era API.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .base import BaseConnector
    from .descartes import DescartesHealthcheckResult

logger = logging.getLogger(__name__)


class ConnectorRegistry:
    """Thread-safe mapping from provider name -> connector class.

    Usage::

        registry.register(MulesoftConnector)

        cls = registry.get("mulesoft")
    """

    def __init__(self) -> None:
        self._providers: dict[str, type[BaseConnector]] = {}

    def register(self, connector_cls: type[BaseConnector]) -> None:
        """Register a connector class.

        Raises ValueError if the class has no provider_name or if the name is
        already occupied by a different class.
        """
        name = connector_cls.provider_name
        if not name:
            raise ValueError(f"Connector class {connector_cls.__name__} has no provider_name")
        existing = self._providers.get(name)
        if existing is not None and existing is not connector_cls:
            raise ValueError(
                f"Provider '{name}' is already registered by {existing.__name__}; "
                f"cannot register {connector_cls.__name__}"
            )
        self._providers[name] = connector_cls
        logger.debug("registered connector provider=%s class=%s", name, connector_cls.__name__)

    def get(self, provider_name: str) -> type[BaseConnector] | None:
        """Return the connector class for *provider_name*, or None."""
        return self._providers.get(provider_name)

    def require(self, provider_name: str) -> type[BaseConnector]:
        """Return the connector class or raise KeyError if not registered."""
        cls = self.get(provider_name)
        if cls is None:
            raise KeyError(f"No connector registered for provider '{provider_name}'")
        return cls

    def registered_providers(self) -> list[str]:
        """Return sorted list of registered provider names."""
        return sorted(self._providers)


# Module-level singleton – import this in provider modules to self-register.
registry = ConnectorRegistry()


# ---------------------------------------------------------------------------
# Descartes-era lightweight registry (retained for backward compatibility)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ConnectorProvider:
    key: str
    enabled_scopes: tuple[str, ...]
    validate_config: Callable[[Mapping[str, Any]], list[str]]
    healthcheck: Callable[[Mapping[str, Any]], DescartesHealthcheckResult]

def build_connector_registry() -> dict[str, ConnectorProvider]:
    from .billtrust import run_billtrust_healthcheck, validate_billtrust_config
    from .coupa import run_coupa_healthcheck, validate_coupa_config
    from .descartes import run_descartes_healthcheck, validate_descartes_config
    from .netsuite import run_netsuite_healthcheck, validate_netsuite_config
    from .sage import run_sage_healthcheck, validate_sage_config
    from .samsara import run_samsara_healthcheck, validate_samsara_config

    return {
        "billtrust": ConnectorProvider(
            key="billtrust",
            enabled_scopes=("invoices", "payments", "ar_aging"),
            validate_config=validate_billtrust_config,
            healthcheck=run_billtrust_healthcheck,
        ),
        "descartes": ConnectorProvider(
            key="descartes",
            enabled_scopes=("route", "shipment", "compliance"),
            validate_config=validate_descartes_config,
            healthcheck=run_descartes_healthcheck,
        ),
        "coupa": ConnectorProvider(
            key="coupa",
            enabled_scopes=("requisitions", "purchase_orders", "suppliers", "invoices"),
            validate_config=validate_coupa_config,
            healthcheck=run_coupa_healthcheck,
        ),
        "netsuite": ConnectorProvider(
            key="netsuite",
            enabled_scopes=("items", "customers", "vendors", "invoices"),
            validate_config=validate_netsuite_config,
            healthcheck=run_netsuite_healthcheck,
        ),
        "sage_intacct": ConnectorProvider(
            key="sage_intacct",
            enabled_scopes=("general_ledger", "accounts_payable", "accounts_receivable", "cash_management"),
            validate_config=validate_sage_config,
            healthcheck=run_sage_healthcheck,
        ),
        "samsara": ConnectorProvider(
            key="samsara",
            enabled_scopes=("gps", "hours", "eld", "dashcam_events"),
            validate_config=validate_samsara_config,
            healthcheck=run_samsara_healthcheck,
        ),
    }
