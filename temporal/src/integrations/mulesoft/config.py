"""MuleSoft connection configuration schemas.

These Pydantic models map directly to the JSON stored in integration_config:
  - connection_config  → MulesoftConnectionConfig
  - secret_refs        → MulesoftSecretRefs
  - feature_config     → MulesoftFeatureConfig

Secrets are never stored as values. MulesoftSecretRefs holds opaque path
references resolved at runtime via the platform secret-delivery mechanism.
"""

from __future__ import annotations

import enum
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_LOCALHOST_ADDRESSES = frozenset({"localhost", "127.0.0.1", "::1"})


def _require_https_or_localhost_http(url: str, field_name: str) -> None:
    """Raise ValueError if *url* uses HTTP for a non-localhost host.

    HTTPS is required for any credential-bearing connection.  Plain HTTP is
    only permitted for local/dev endpoints (localhost, 127.0.0.1, ::1) where
    there is no risk of transmitting credentials over a public network.
    """
    parsed = urlparse(url)
    if parsed.scheme == "http":
        host = parsed.hostname or ""
        if host not in _LOCALHOST_ADDRESSES:
            raise ValueError(
                f"{field_name} must use HTTPS for non-localhost endpoints "
                f"(got scheme='http', host={host!r}). "
                "Plain HTTP is only permitted for localhost / 127.0.0.1 / ::1 "
                "development targets."
            )


class MulesoftAuthType(str, enum.Enum):
    """Supported auth strategies for a MuleSoft connection."""

    CLIENT_CREDENTIALS = "client_credentials"  # OAuth 2.0 client credentials
    BASIC = "basic"                             # HTTP Basic (username + password)
    API_KEY = "api_key"                         # Static API key in header/query


class MulesoftConnectionConfig(BaseModel):
    """Non-secret connection parameters stored in integration_config.connection_config.

    All fields here are safe to store in Postgres. Credentials belong in
    MulesoftSecretRefs, not here.
    """

    model_config = ConfigDict(extra="forbid")

    base_url: str = Field(
        ...,
        description="Base URL of the customer's MuleSoft Anypoint or runtime endpoint.",
        examples=["https://mulesoft.acme.com/api/v1"],
    )
    auth_type: MulesoftAuthType = Field(
        MulesoftAuthType.CLIENT_CREDENTIALS,
        description="Authentication strategy to use when calling MuleSoft.",
    )
    org_id: str | None = Field(
        None,
        description="MuleSoft Anypoint organization ID (required for management API calls).",
    )
    environment_id: str | None = Field(
        None,
        description="MuleSoft Anypoint environment ID (e.g. 'Sandbox', 'Production').",
    )
    api_key_header: str = Field(
        "X-Api-Key",
        description="HTTP header name to use when auth_type is api_key.",
    )
    token_url: str | None = Field(
        None,
        description=(
            "OAuth 2.0 token endpoint URL. Required when auth_type is client_credentials. "
            "Defaults to {base_url}/oauth/token if omitted."
        ),
    )
    timeout_seconds: int = Field(
        30,
        ge=1,
        le=120,
        description="HTTP timeout in seconds for outbound requests.",
    )
    tls_verify: bool = Field(
        True,
        description="Whether to verify the MuleSoft TLS certificate. Should be True in production.",
    )

    @field_validator("base_url")
    @classmethod
    def _base_url_scheme(cls, v: str) -> str:
        if not v.startswith(("https://", "http://")):
            raise ValueError("base_url must start with https:// or http://")
        _require_https_or_localhost_http(v, "base_url")
        return v.rstrip("/")

    @field_validator("token_url")
    @classmethod
    def _token_url_scheme(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.startswith(("https://", "http://")):
            raise ValueError("token_url must start with https:// or http://")
        _require_https_or_localhost_http(v, "token_url")
        return v.rstrip("/")

    @model_validator(mode="after")
    def _token_url_required_for_client_credentials(self) -> MulesoftConnectionConfig:
        if self.auth_type == MulesoftAuthType.CLIENT_CREDENTIALS and not self.token_url:
            # Derive a default so callers do not have to set it explicitly,
            # but they can override it for non-standard token endpoints.
            object.__setattr__(self, "token_url", f"{self.base_url}/oauth/token")
        return self


class MulesoftSecretRefs(BaseModel):
    """References to secrets in the platform secret store.

    Fields hold opaque path/key strings (e.g. ``vault/tenants/acme/mulesoft/client_secret``).
    The actual secret values are resolved at runtime and must never be stored here.
    """

    model_config = ConfigDict(extra="forbid")

    # OAuth 2.0 client credentials
    client_id_ref: str | None = Field(
        None,
        description="Secret ref for OAuth client_id (required when auth_type=client_credentials).",
    )
    client_secret_ref: str | None = Field(
        None,
        description="Secret ref for OAuth client_secret (required when auth_type=client_credentials).",
    )
    # HTTP Basic
    username_ref: str | None = Field(
        None,
        description="Secret ref for HTTP Basic username (required when auth_type=basic).",
    )
    password_ref: str | None = Field(
        None,
        description="Secret ref for HTTP Basic password (required when auth_type=basic).",
    )
    # API key
    api_key_ref: str | None = Field(
        None,
        description="Secret ref for static API key (required when auth_type=api_key).",
    )
    # Inbound webhook HMAC (optional; required if delivery_receipt flow is enabled)
    inbound_hmac_secret_ref: str | None = Field(
        None,
        description="Secret ref for HMAC secret used to validate inbound MuleSoft callbacks.",
    )

    @model_validator(mode="after")
    def _validate_required_refs_present(self) -> MulesoftSecretRefs:
        """Individual auth checks are deferred to MulesoftFeatureConfig.validate_for_auth_type."""
        return self


class EnabledFlowConfig(BaseModel):
    """Per-flow configuration when an admin enables a catalog endpoint."""

    model_config = ConfigDict(extra="forbid")

    mapping_profile: str = Field(
        "default",
        description="Name of the MappingProfile to use for this flow.",
    )
    policy_inputs: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Operator-supplied policy inputs for this flow (e.g. target queue, filter). "
            "Keys must match the endpoint's requires_policy_inputs list."
        ),
    )


class MulesoftFeatureConfig(BaseModel):
    """Provider-specific feature flags stored in integration_config.feature_config.

    Controls which catalog endpoints are active and how each is configured.
    """

    model_config = ConfigDict(extra="forbid")

    enabled_flows: dict[str, EnabledFlowConfig] = Field(
        default_factory=dict,
        description=(
            "Mapping of endpoint key → per-flow config. "
            "Only keys present in MULESOFT_ENDPOINT_CATALOG are valid."
        ),
    )

    @field_validator("enabled_flows")
    @classmethod
    def _validate_flow_keys(cls, v: dict[str, EnabledFlowConfig]) -> dict[str, EnabledFlowConfig]:
        from .catalog import MULESOFT_ENDPOINT_CATALOG

        unknown = set(v) - set(MULESOFT_ENDPOINT_CATALOG)
        if unknown:
            raise ValueError(
                f"Unknown flow key(s): {sorted(unknown)}. "
                f"Valid keys: {sorted(MULESOFT_ENDPOINT_CATALOG)}"
            )
        return v

    def validate_for_auth_type(
        self,
        auth_type: MulesoftAuthType,
        secret_refs: MulesoftSecretRefs,
    ) -> list[str]:
        """Return a list of validation error messages (empty = valid).

        Checks that secret refs required for the chosen auth type are present,
        and that flows requiring policy inputs have those inputs supplied.
        """
        from .catalog import MULESOFT_ENDPOINT_CATALOG

        errors: list[str] = []

        if auth_type == MulesoftAuthType.CLIENT_CREDENTIALS:
            if not secret_refs.client_id_ref:
                errors.append("client_id_ref is required for auth_type=client_credentials")
            if not secret_refs.client_secret_ref:
                errors.append("client_secret_ref is required for auth_type=client_credentials")
        elif auth_type == MulesoftAuthType.BASIC:
            if not secret_refs.username_ref:
                errors.append("username_ref is required for auth_type=basic")
            if not secret_refs.password_ref:
                errors.append("password_ref is required for auth_type=basic")
        elif auth_type == MulesoftAuthType.API_KEY:
            if not secret_refs.api_key_ref:
                errors.append("api_key_ref is required for auth_type=api_key")

        for flow_key, flow_cfg in self.enabled_flows.items():
            endpoint = MULESOFT_ENDPOINT_CATALOG.get(flow_key)
            if endpoint is None:
                continue
            for required_input in endpoint.requires_policy_inputs:
                if required_input == "hmac_secret_ref":
                    if not secret_refs.inbound_hmac_secret_ref:
                        errors.append(
                            f"Flow '{flow_key}' requires inbound_hmac_secret_ref to be set"
                        )
                elif required_input not in flow_cfg.policy_inputs:
                    errors.append(
                        f"Flow '{flow_key}' requires policy input '{required_input}'"
                    )

        return errors
