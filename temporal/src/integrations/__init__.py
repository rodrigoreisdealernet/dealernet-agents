"""Shared integration / connector framework (ADR-0037).

Provider adapters live under sub-packages of this module and must implement
the BaseConnector contract. Use the registry to look up providers by name.

Descartes-compatible helpers are also re-exported here for backward
compatibility with callers that import from this package directly.
"""

from .base import (
    BaseConnector,
    ConnectorCapability,
    ConnectorHealthStatus,
    HealthCheckResult,
    RetryClass,
    SecretRef,
)
from .billtrust import (
    BilltrustAuthError,
    BilltrustHealthcheckResult,
    run_billtrust_healthcheck,
    validate_billtrust_config,
)
from .coupa import (
    CoupaAuthError,
    CoupaHealthcheckResult,
    run_coupa_healthcheck,
    validate_coupa_config,
)
from .descartes import (
    DescartesAuthError,
    DescartesHealthcheckResult,
    run_descartes_healthcheck,
    validate_descartes_config,
)
from .mulesoft import (
    MuleSoftCallbackReceipt,
    MuleSoftExchangeDefinition,
    build_mulesoft_signature,
    build_outbound_payload,
    get_exchange_definition,
    verify_mulesoft_signature,
)
from .registry import ConnectorProvider, ConnectorRegistry, build_connector_registry, registry
from .sage import (
    SageAuthError,
    SageHealthcheckResult,
    run_sage_healthcheck,
    validate_sage_config,
)
from .samsara import (
    SamsaraAuthError,
    SamsaraHealthcheckResult,
    run_samsara_healthcheck,
    validate_samsara_config,
)

__all__ = [
    "BaseConnector",
    "BilltrustAuthError",
    "BilltrustHealthcheckResult",
    "ConnectorCapability",
    "ConnectorHealthStatus",
    "ConnectorProvider",
    "ConnectorRegistry",
    "CoupaAuthError",
    "CoupaHealthcheckResult",
    "DescartesAuthError",
    "DescartesHealthcheckResult",
    "HealthCheckResult",
    "MuleSoftCallbackReceipt",
    "MuleSoftExchangeDefinition",
    "RetryClass",
    "SageAuthError",
    "SageHealthcheckResult",
    "SamsaraAuthError",
    "SamsaraHealthcheckResult",
    "SecretRef",
    "build_connector_registry",
    "build_mulesoft_signature",
    "build_outbound_payload",
    "get_exchange_definition",
    "registry",
    "run_billtrust_healthcheck",
    "run_coupa_healthcheck",
    "run_descartes_healthcheck",
    "run_sage_healthcheck",
    "run_samsara_healthcheck",
    "validate_billtrust_config",
    "validate_coupa_config",
    "validate_descartes_config",
    "validate_sage_config",
    "validate_samsara_config",
    "verify_mulesoft_signature",
]
