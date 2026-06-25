"""MuleSoft connector: connection lifecycle and healthcheck.

Implements BaseConnector for the MuleSoft iPaaS target (ADR-0037, issue #1149).

The healthcheck performs three non-destructive checks in order:
  1. Auth check  – resolves secret refs and acquires/verifies a token or
                   credential without sending business data.
  2. Connectivity – a lightweight GET to the configured base URL (HEAD or
                    a well-known probe path).
  3. Config check – validates that enabled flows have required policy inputs
                    and that the mapping profiles are known.

Each check is reported independently so operators receive actionable failure
detail (e.g. "auth: expired client secret" rather than a generic error).
"""

from __future__ import annotations

import asyncio
import logging
import ssl
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from ..base import (
    BaseConnector,
    ConnectorCapability,
    ConnectorHealthStatus,
    HealthCheckResult,
    RetryClass,
)
from ..registry import registry
from .catalog import MULESOFT_ENDPOINT_CATALOG
from .config import MulesoftAuthType, MulesoftConnectionConfig, MulesoftFeatureConfig, MulesoftSecretRefs

logger = logging.getLogger(__name__)

# Maximum milliseconds to spend on a single HTTP probe during healthcheck
_PROBE_TIMEOUT_SECONDS = 10


class SecretResolutionError(RuntimeError):
    """Raised when a required secret reference cannot be resolved."""


class MulesoftConnector(BaseConnector):
    """Connector adapter for MuleSoft as a customer-facing integration target.

    Instantiate with resolved (non-secret) config objects; the connector
    expects secret values to be injected via *resolved_secrets* rather than
    read directly from the platform secret store. This keeps the connector
    testable without live secret-delivery infrastructure.

    Parameters
    ----------
    connection_config:
        Parsed MulesoftConnectionConfig for this tenant.
    secret_refs:
        MulesoftSecretRefs with opaque secret-path references.
    feature_config:
        MulesoftFeatureConfig with enabled flows and mapping profiles.
    resolved_secrets:
        Optional mapping of secret_ref_value → resolved_secret_value injected
        by the platform secret delivery mechanism at runtime. During tests,
        pass fixture values directly.
    """

    provider_name = "mulesoft"
    supported_capabilities: frozenset[ConnectorCapability] = frozenset(
        {
            ConnectorCapability.HEALTHCHECK,
            ConnectorCapability.PUSH,
            ConnectorCapability.WEBHOOK_INGEST,
        }
    )

    def __init__(
        self,
        *,
        connection_config: MulesoftConnectionConfig,
        secret_refs: MulesoftSecretRefs,
        feature_config: MulesoftFeatureConfig,
        resolved_secrets: dict[str, str] | None = None,
    ) -> None:
        self._cfg = connection_config
        self._refs = secret_refs
        self._features = feature_config
        self._secrets: dict[str, str] = resolved_secrets or {}

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def healthcheck(self) -> HealthCheckResult:
        """Run auth, connectivity, and configuration checks.

        Returns a HealthCheckResult with an independent status per check so
        operators can identify exactly which aspect is failing.
        """
        checks: list[dict[str, Any]] = []
        overall = ConnectorHealthStatus.HEALTHY
        retry_class: RetryClass | None = None
        messages: list[str] = []

        # 1. Auth check
        auth_ok, auth_detail, auth_retry = await self._check_auth()
        checks.append({"name": "auth", "ok": auth_ok, "detail": auth_detail})
        if not auth_ok:
            overall = ConnectorHealthStatus.UNHEALTHY
            retry_class = auth_retry
            messages.append(f"auth: {auth_detail}")

        # 2. Connectivity check (only meaningful if auth passed)
        if auth_ok:
            conn_ok, conn_detail, conn_retry = await self._check_connectivity()
            checks.append({"name": "connectivity", "ok": conn_ok, "detail": conn_detail})
            if not conn_ok:
                overall = ConnectorHealthStatus.UNHEALTHY
                if retry_class is None:
                    retry_class = conn_retry
                messages.append(f"connectivity: {conn_detail}")
        else:
            checks.append(
                {"name": "connectivity", "ok": False, "detail": "skipped – auth failed"}
            )

        # 3. Configuration check (always run regardless of network state)
        cfg_errors = self._check_configuration()
        cfg_ok = len(cfg_errors) == 0
        checks.append(
            {
                "name": "configuration",
                "ok": cfg_ok,
                "detail": "; ".join(cfg_errors) if cfg_errors else "ok",
            }
        )
        if not cfg_ok:
            if overall == ConnectorHealthStatus.HEALTHY:
                overall = ConnectorHealthStatus.DEGRADED
            if retry_class is None:
                retry_class = RetryClass.INVALID_REQUEST
            messages.extend(cfg_errors)

        return HealthCheckResult(
            status=overall,
            checks=checks,
            retry_class=retry_class,
            message="; ".join(messages) if messages else "all checks passed",
        )

    # ------------------------------------------------------------------
    # Internal check helpers
    # ------------------------------------------------------------------

    async def _check_auth(
        self,
    ) -> tuple[bool, str, RetryClass | None]:
        """Verify that the configured auth credentials can be resolved.

        For client_credentials, attempts a token request. For basic and
        api_key, verifies that the secret refs resolve to non-empty values
        without making a remote call.

        Returns (ok, detail_message, retry_class_on_failure).
        """
        auth_type = self._cfg.auth_type

        try:
            if auth_type == MulesoftAuthType.CLIENT_CREDENTIALS:
                return await self._check_oauth_token()
            elif auth_type == MulesoftAuthType.BASIC:
                return self._check_basic_creds()
            elif auth_type == MulesoftAuthType.API_KEY:
                return self._check_api_key()
            else:
                return False, f"unsupported auth_type: {auth_type}", RetryClass.INVALID_REQUEST
        except SecretResolutionError as exc:
            return False, str(exc), RetryClass.AUTH
        except Exception as exc:  # noqa: BLE001
            logger.warning("mulesoft auth check error provider=mulesoft error=%s", exc)
            return False, f"unexpected error during auth check: {type(exc).__name__}", RetryClass.TRANSIENT

    async def _check_oauth_token(self) -> tuple[bool, str, RetryClass | None]:
        """Attempt to acquire an OAuth 2.0 client-credentials token."""
        client_id = self._resolve_ref(self._refs.client_id_ref, "client_id_ref")
        client_secret = self._resolve_ref(self._refs.client_secret_ref, "client_secret_ref")
        token_url = self._cfg.token_url or f"{self._cfg.base_url}/oauth/token"

        payload = urllib_parse.urlencode(
            {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            }
        ).encode()

        try:
            req = urllib_request.Request(
                token_url,
                data=payload,
                method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            loop = asyncio.get_running_loop()
            ssl_ctx = self._build_ssl_context()
            resp_data = await loop.run_in_executor(
                None,
                lambda: _urlopen_json_with_timeout(req, _PROBE_TIMEOUT_SECONDS, ssl_ctx),
            )
            if resp_data.get("access_token"):
                return True, "oauth token acquired", None
            return False, "token response missing access_token", RetryClass.AUTH
        except urllib_error.HTTPError as exc:
            if exc.code in (401, 403):
                return False, f"auth rejected (HTTP {exc.code})", RetryClass.AUTH
            if exc.code == 429:
                return False, f"rate limited (HTTP {exc.code})", RetryClass.RATE_LIMIT
            return False, f"token endpoint HTTP {exc.code}", RetryClass.TRANSIENT
        except urllib_error.URLError as exc:
            return False, f"cannot reach token endpoint: {exc.reason}", RetryClass.TRANSIENT

    def _check_basic_creds(self) -> tuple[bool, str, RetryClass | None]:
        username = self._resolve_ref(self._refs.username_ref, "username_ref")
        password = self._resolve_ref(self._refs.password_ref, "password_ref")
        if username and password:
            return True, "basic credentials present", None
        return False, "username or password ref resolved to empty value", RetryClass.AUTH

    def _check_api_key(self) -> tuple[bool, str, RetryClass | None]:
        key = self._resolve_ref(self._refs.api_key_ref, "api_key_ref")
        if key:
            return True, "api key present", None
        return False, "api_key_ref resolved to empty value", RetryClass.AUTH

    async def _check_connectivity(self) -> tuple[bool, str, RetryClass | None]:
        """Probe the base URL with a HEAD request."""
        probe_url = self._cfg.base_url
        try:
            req = urllib_request.Request(probe_url, method="HEAD")
            self._apply_auth_header(req)
            loop = asyncio.get_running_loop()
            ssl_ctx = self._build_ssl_context()
            await loop.run_in_executor(
                None,
                lambda: _urlopen_json_with_timeout(req, _PROBE_TIMEOUT_SECONDS, ssl_ctx),
            )
            return True, f"reachable ({probe_url})", None
        except urllib_error.HTTPError as exc:
            # 4xx responses still mean we reached the server
            if exc.code < 500:
                return True, f"reachable ({probe_url}, HTTP {exc.code})", None
            return False, f"server error (HTTP {exc.code})", RetryClass.TRANSIENT
        except urllib_error.URLError as exc:
            return False, f"unreachable: {exc.reason}", RetryClass.TRANSIENT
        except Exception as exc:  # noqa: BLE001
            return False, f"probe error: {type(exc).__name__}", RetryClass.TRANSIENT

    def _check_configuration(self) -> list[str]:
        """Validate feature config and return list of human-readable errors."""
        errors = self._features.validate_for_auth_type(
            self._cfg.auth_type, self._refs
        )

        for flow_key, flow_cfg in self._features.enabled_flows.items():
            endpoint = MULESOFT_ENDPOINT_CATALOG.get(flow_key)
            if endpoint is None:
                errors.append(f"Unknown flow key '{flow_key}' in enabled_flows")
                continue
            valid_profiles = {p.value for p in endpoint.supported_mapping_profiles}
            if flow_cfg.mapping_profile not in valid_profiles:
                errors.append(
                    f"Flow '{flow_key}': mapping_profile '{flow_cfg.mapping_profile}' "
                    f"not supported. Valid: {sorted(valid_profiles)}"
                )

        return errors

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _resolve_ref(self, ref: str | None, field_name: str) -> str:
        """Return the resolved secret value for *ref* or raise SecretResolutionError."""
        if not ref:
            raise SecretResolutionError(
                f"Secret ref '{field_name}' is not configured for this connection"
            )
        value = self._secrets.get(ref)
        if value is None:
            raise SecretResolutionError(
                f"Secret ref '{field_name}' (ref={ref!r}) could not be resolved; "
                "check that the secret exists in the platform secret store"
            )
        return value

    def _apply_auth_header(self, req: urllib_request.Request) -> None:
        """Attach auth credentials to a urllib Request for connectivity probing."""
        import base64

        auth_type = self._cfg.auth_type
        try:
            if auth_type == MulesoftAuthType.BASIC:
                username = self._resolve_ref(self._refs.username_ref, "username_ref")
                password = self._resolve_ref(self._refs.password_ref, "password_ref")
                encoded = base64.b64encode(f"{username}:{password}".encode()).decode()
                req.add_header("Authorization", f"Basic {encoded}")
            elif auth_type == MulesoftAuthType.API_KEY:
                key = self._resolve_ref(self._refs.api_key_ref, "api_key_ref")
                req.add_header(self._cfg.api_key_header, key)
        except SecretResolutionError:
            pass  # connectivity probe continues without auth header

    def _build_ssl_context(self) -> ssl.SSLContext:
        """Return an SSL context that honours the tls_verify configuration setting.

        When tls_verify is True (the default), returns a default context that
        fully verifies the server certificate chain and hostname.  When
        tls_verify is False, returns a context with certificate verification
        disabled — intended only for internal test endpoints where a trusted
        certificate cannot be issued.
        """
        if self._cfg.tls_verify:
            return ssl.create_default_context()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx


def _urlopen_json_with_timeout(
    req: urllib_request.Request,
    timeout: int,
    ssl_context: ssl.SSLContext | None = None,
) -> dict:
    """Open *req* and return parsed JSON body, or empty dict for non-JSON.

    *ssl_context* is forwarded to urllib so callers can control TLS certificate
    verification behaviour.  Pass ``None`` to use Python's default SSL context.
    """
    import json

    with urllib_request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
        raw = resp.read()
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return {}


# Register this connector with the module-level registry on import.
registry.register(MulesoftConnector)
