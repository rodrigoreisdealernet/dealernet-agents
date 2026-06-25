"""Base connector contract for the shared integration framework (ADR-0037).

Every provider adapter must subclass BaseConnector and implement at minimum:
  - provider_name (class attribute)
  - supported_capabilities (class attribute)
  - healthcheck()

Optional operations (pull, push, webhook_ingest) are declared via
ConnectorCapability flags and validated by the registry at registration time.
"""

from __future__ import annotations

import enum
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


class ConnectorCapability(str, enum.Enum):
    """Operations a connector adapter may declare support for."""

    PULL = "pull"
    PUSH = "push"
    WEBHOOK_INGEST = "webhook_ingest"
    HEALTHCHECK = "healthcheck"


class RetryClass(str, enum.Enum):
    """Retry classification for connector failures.

    Consumers use this to decide whether to retry, back off, or dead-letter.
    """

    TRANSIENT = "transient"
    RATE_LIMIT = "rate_limit"
    AUTH = "auth"
    INVALID_REQUEST = "invalid_request"
    CONFLICT = "conflict"
    FATAL = "fatal"


class ConnectorHealthStatus(str, enum.Enum):
    """Coarse health state returned by a connector healthcheck."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


@dataclass(frozen=True)
class SecretRef:
    """A reference to a secret value in the approved platform secret source.

    The actual secret value is *never* stored here; only the opaque path/key
    used to resolve it at runtime via the platform secret-delivery mechanism.
    """

    ref: str
    description: str = ""

    def __post_init__(self) -> None:
        if not self.ref:
            raise ValueError("SecretRef.ref must not be empty")


@dataclass
class HealthCheckResult:
    """Result returned by BaseConnector.healthcheck().

    Attributes
    ----------
    status:
        Coarse health classification.
    checks:
        Ordered list of named check results. Each entry is a dict with at
        minimum ``name`` (str) and ``ok`` (bool). Additional keys are
        provider-specific and must not include secret values or business data.
    retry_class:
        When status is not HEALTHY, the retry classification that should drive
        operator escalation and automated retry decisions.
    message:
        Human-readable summary (no secrets, no business data).
    checked_at:
        UTC timestamp of the check.
    """

    status: ConnectorHealthStatus
    checks: list[dict[str, Any]] = field(default_factory=list)
    retry_class: RetryClass | None = None
    message: str = ""
    checked_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def is_healthy(self) -> bool:
        return self.status == ConnectorHealthStatus.HEALTHY


class BaseConnector(ABC):
    """Abstract base for all provider connectors.

    Subclasses must set:
      provider_name (str)          – stable identifier used in integration_config.provider
      supported_capabilities       – frozenset of ConnectorCapability values

    Subclasses must implement:
      healthcheck()                – see docstring below

    Subclasses should implement (when capability is declared):
      pull(), push(), webhook_ingest()
    """

    provider_name: str = ""
    supported_capabilities: frozenset[ConnectorCapability] = frozenset(
        {ConnectorCapability.HEALTHCHECK}
    )

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if cls.provider_name and ConnectorCapability.HEALTHCHECK not in cls.supported_capabilities:
            raise TypeError(
                f"{cls.__name__}: all connectors must declare HEALTHCHECK capability"
            )

    @abstractmethod
    async def healthcheck(self) -> HealthCheckResult:
        """Run a non-destructive connectivity and configuration check.

        Requirements:
        - Must not send or receive business data.
        - Must not modify remote state.
        - Must classify the failure using RetryClass when status != HEALTHY.
        - Must return within a reasonable timeout (caller enforces externally).

        The check should exercise at minimum:
        1. Auth credential resolution and token acquisition.
        2. Reachability of the configured base endpoint.
        3. Presence of required feature configuration (enabled flows, etc.).
        """

    def supports(self, capability: ConnectorCapability) -> bool:
        """Return True if the connector declares the given capability."""
        return capability in self.supported_capabilities
