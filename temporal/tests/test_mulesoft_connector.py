"""Unit tests for the MuleSoft connector: config validation, healthcheck, catalog.

Tests are fixture-based and do not require live MuleSoft infrastructure or
Supabase. Network calls are intercepted via urllib.request.urlopen mocking.
"""

from __future__ import annotations

import asyncio
import json
import ssl
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError
from temporal.src.integrations.base import (
    ConnectorCapability,
    ConnectorHealthStatus,
    RetryClass,
    SecretRef,
)
from temporal.src.integrations.mulesoft.catalog import (
    MULESOFT_ENDPOINT_CATALOG,
    FlowDirection,
    MappingProfile,
)
from temporal.src.integrations.mulesoft.config import (
    EnabledFlowConfig,
    MulesoftAuthType,
    MulesoftConnectionConfig,
    MulesoftFeatureConfig,
    MulesoftSecretRefs,
)
from temporal.src.integrations.mulesoft.connector import MulesoftConnector
from temporal.src.integrations.registry import ConnectorRegistry

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_cc_config(base_url: str = "https://mulesoft.acme.com/api/v1") -> MulesoftConnectionConfig:
    return MulesoftConnectionConfig(
        base_url=base_url,
        auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
        token_url=f"{base_url}/oauth/token",
    )


def _make_cc_refs() -> MulesoftSecretRefs:
    return MulesoftSecretRefs(
        client_id_ref="vault/tenants/acme/mulesoft/client_id",
        client_secret_ref="vault/tenants/acme/mulesoft/client_secret",
    )


def _make_empty_features() -> MulesoftFeatureConfig:
    return MulesoftFeatureConfig()


def _make_connector(
    *,
    auth_type: MulesoftAuthType = MulesoftAuthType.CLIENT_CREDENTIALS,
    resolved_secrets: dict[str, str] | None = None,
    enabled_flows: dict[str, EnabledFlowConfig] | None = None,
    tls_verify: bool = True,
) -> MulesoftConnector:
    base_url = "https://mulesoft.acme.com/api/v1"
    refs: MulesoftSecretRefs
    if auth_type == MulesoftAuthType.CLIENT_CREDENTIALS:
        cfg = MulesoftConnectionConfig(
            base_url=base_url,
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
            token_url=f"{base_url}/oauth/token",
            tls_verify=tls_verify,
        )
        refs = _make_cc_refs()
    elif auth_type == MulesoftAuthType.BASIC:
        cfg = MulesoftConnectionConfig(
            base_url=base_url,
            auth_type=MulesoftAuthType.BASIC,
            tls_verify=tls_verify,
        )
        refs = MulesoftSecretRefs(
            username_ref="vault/tenants/acme/mulesoft/user",
            password_ref="vault/tenants/acme/mulesoft/pass",
        )
    elif auth_type == MulesoftAuthType.API_KEY:
        cfg = MulesoftConnectionConfig(
            base_url=base_url,
            auth_type=MulesoftAuthType.API_KEY,
            tls_verify=tls_verify,
        )
        refs = MulesoftSecretRefs(api_key_ref="vault/tenants/acme/mulesoft/api_key")
    else:
        raise ValueError(f"Unsupported auth_type in fixture: {auth_type}")

    features = MulesoftFeatureConfig(enabled_flows=enabled_flows or {})
    return MulesoftConnector(
        connection_config=cfg,
        secret_refs=refs,
        feature_config=features,
        resolved_secrets=resolved_secrets,
    )


# ---------------------------------------------------------------------------
# Config validation tests
# ---------------------------------------------------------------------------


class TestMulesoftConnectionConfig:
    def test_valid_https_url_accepted(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="https://mulesoft.acme.com/api/v1",
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
        )
        assert cfg.base_url == "https://mulesoft.acme.com/api/v1"

    def test_trailing_slash_stripped(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="https://mulesoft.acme.com/api/v1/",
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
        )
        assert not cfg.base_url.endswith("/")

    def test_invalid_url_rejected(self) -> None:
        with pytest.raises(ValidationError):
            MulesoftConnectionConfig(
                base_url="not-a-url",
                auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
            )

    def test_client_credentials_derives_token_url(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="https://mulesoft.acme.com",
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
        )
        assert cfg.token_url == "https://mulesoft.acme.com/oauth/token"

    def test_explicit_token_url_preserved(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="https://mulesoft.acme.com",
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
            token_url="https://sso.acme.com/token",
        )
        assert cfg.token_url == "https://sso.acme.com/token"

    def test_timeout_bounds(self) -> None:
        with pytest.raises(ValidationError):
            MulesoftConnectionConfig(
                base_url="https://x.com",
                auth_type=MulesoftAuthType.BASIC,
                timeout_seconds=0,
            )

    def test_localhost_http_url_accepted(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="http://localhost:8082",
            auth_type=MulesoftAuthType.BASIC,
        )
        assert cfg.base_url == "http://localhost:8082"

    def test_127_0_0_1_http_url_accepted(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="http://127.0.0.1:8082",
            auth_type=MulesoftAuthType.BASIC,
        )
        assert cfg.base_url == "http://127.0.0.1:8082"

    def test_non_localhost_http_base_url_rejected(self) -> None:
        with pytest.raises(ValidationError, match="must use HTTPS"):
            MulesoftConnectionConfig(
                base_url="http://mulesoft.acme.com/api/v1",
                auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
            )

    def test_non_localhost_http_token_url_rejected(self) -> None:
        with pytest.raises(ValidationError, match="must use HTTPS"):
            MulesoftConnectionConfig(
                base_url="https://mulesoft.acme.com",
                auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
                token_url="http://sso.acme.com/token",
            )

    def test_localhost_http_token_url_accepted(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="https://mulesoft.acme.com",
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
            token_url="http://localhost:9000/token",
        )
        assert cfg.token_url == "http://localhost:9000/token"

    def test_ipv6_localhost_http_token_url_accepted(self) -> None:
        cfg = MulesoftConnectionConfig(
            base_url="https://mulesoft.acme.com",
            auth_type=MulesoftAuthType.CLIENT_CREDENTIALS,
            token_url="http://[::1]:9000/token",
        )
        assert cfg.token_url == "http://[::1]:9000/token"


class TestMulesoftSecretRefs:
    def test_secret_ref_requires_nonempty_ref(self) -> None:
        with pytest.raises(ValueError):
            SecretRef(ref="")

    def test_secret_refs_all_optional(self) -> None:
        refs = MulesoftSecretRefs()
        assert refs.client_id_ref is None

    def test_extra_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            MulesoftSecretRefs(unknown_field="x")


class TestMulesoftFeatureConfig:
    def test_empty_enabled_flows_valid(self) -> None:
        f = MulesoftFeatureConfig()
        assert f.enabled_flows == {}

    def test_valid_flow_key_accepted(self) -> None:
        f = MulesoftFeatureConfig(
            enabled_flows={
                "rental_contract_snapshot": EnabledFlowConfig(
                    mapping_profile=MappingProfile.RENTAL_V1.value
                )
            }
        )
        assert "rental_contract_snapshot" in f.enabled_flows

    def test_unknown_flow_key_rejected(self) -> None:
        with pytest.raises(ValidationError, match="Unknown flow key"):
            MulesoftFeatureConfig(enabled_flows={"not_a_real_flow": EnabledFlowConfig()})

    def test_validate_for_auth_cc_missing_client_id(self) -> None:
        f = MulesoftFeatureConfig()
        refs = MulesoftSecretRefs(client_secret_ref="ref/secret")
        errors = f.validate_for_auth_type(MulesoftAuthType.CLIENT_CREDENTIALS, refs)
        assert any("client_id_ref" in e for e in errors)

    def test_validate_for_auth_cc_missing_client_secret(self) -> None:
        f = MulesoftFeatureConfig()
        refs = MulesoftSecretRefs(client_id_ref="ref/id")
        errors = f.validate_for_auth_type(MulesoftAuthType.CLIENT_CREDENTIALS, refs)
        assert any("client_secret_ref" in e for e in errors)

    def test_validate_for_auth_cc_both_present(self) -> None:
        f = MulesoftFeatureConfig()
        refs = MulesoftSecretRefs(
            client_id_ref="ref/id", client_secret_ref="ref/secret"
        )
        errors = f.validate_for_auth_type(MulesoftAuthType.CLIENT_CREDENTIALS, refs)
        assert errors == []

    def test_validate_for_auth_basic_missing_password(self) -> None:
        f = MulesoftFeatureConfig()
        refs = MulesoftSecretRefs(username_ref="ref/user")
        errors = f.validate_for_auth_type(MulesoftAuthType.BASIC, refs)
        assert any("password_ref" in e for e in errors)

    def test_validate_for_auth_api_key_missing(self) -> None:
        f = MulesoftFeatureConfig()
        refs = MulesoftSecretRefs()
        errors = f.validate_for_auth_type(MulesoftAuthType.API_KEY, refs)
        assert any("api_key_ref" in e for e in errors)

    def test_delivery_receipt_requires_hmac_ref(self) -> None:
        f = MulesoftFeatureConfig(
            enabled_flows={"delivery_receipt": EnabledFlowConfig()}
        )
        refs = MulesoftSecretRefs(
            client_id_ref="ref/id", client_secret_ref="ref/secret"
        )
        errors = f.validate_for_auth_type(MulesoftAuthType.CLIENT_CREDENTIALS, refs)
        assert any("inbound_hmac_secret_ref" in e for e in errors)

    def test_delivery_receipt_with_hmac_ref_valid(self) -> None:
        f = MulesoftFeatureConfig(
            enabled_flows={"delivery_receipt": EnabledFlowConfig()}
        )
        refs = MulesoftSecretRefs(
            client_id_ref="ref/id",
            client_secret_ref="ref/secret",
            inbound_hmac_secret_ref="ref/hmac",
        )
        errors = f.validate_for_auth_type(MulesoftAuthType.CLIENT_CREDENTIALS, refs)
        assert errors == []


# ---------------------------------------------------------------------------
# Endpoint catalog tests
# ---------------------------------------------------------------------------


class TestMulesoftEndpointCatalog:
    def test_catalog_not_empty(self) -> None:
        assert len(MULESOFT_ENDPOINT_CATALOG) > 0

    def test_all_keys_are_snake_case(self) -> None:
        for key in MULESOFT_ENDPOINT_CATALOG:
            assert key == key.lower().replace("-", "_"), f"Key not snake_case: {key}"

    def test_outbound_flows_exist(self) -> None:
        outbound = [
            k for k, v in MULESOFT_ENDPOINT_CATALOG.items()
            if v.direction == FlowDirection.OUTBOUND
        ]
        assert len(outbound) >= 1

    def test_inbound_delivery_receipt_defined(self) -> None:
        ep = MULESOFT_ENDPOINT_CATALOG["delivery_receipt"]
        assert ep.direction == FlowDirection.INBOUND
        assert "hmac_secret_ref" in ep.requires_policy_inputs

    def test_rental_contract_snapshot_has_mapping_profile(self) -> None:
        ep = MULESOFT_ENDPOINT_CATALOG["rental_contract_snapshot"]
        assert MappingProfile.RENTAL_V1 in ep.supported_mapping_profiles

    def test_each_endpoint_has_default_or_specific_mapping_profile(self) -> None:
        for key, ep in MULESOFT_ENDPOINT_CATALOG.items():
            has_profile = any(
                p in (MappingProfile.DEFAULT, MappingProfile.RENTAL_V1,
                      MappingProfile.INVOICE_V1, MappingProfile.ASSET_V1,
                      MappingProfile.CUSTOMER_V1)
                for p in ep.supported_mapping_profiles
            )
            assert has_profile, f"Endpoint '{key}' has no valid mapping profile"


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------


class TestConnectorRegistry:
    def test_mulesoft_registered(self) -> None:
        import temporal.src.integrations.mulesoft  # noqa: F401 – triggers self-registration
        from temporal.src.integrations import registry

        cls = registry.get("mulesoft")
        assert cls is not None
        assert cls.provider_name == "mulesoft"

    def test_duplicate_registration_same_class_idempotent(self) -> None:
        reg = ConnectorRegistry()
        reg.register(MulesoftConnector)
        reg.register(MulesoftConnector)  # should not raise
        assert reg.get("mulesoft") is MulesoftConnector

    def test_duplicate_registration_different_class_raises(self) -> None:
        class OtherMulesoft(MulesoftConnector):
            provider_name = "mulesoft"

        reg = ConnectorRegistry()
        reg.register(MulesoftConnector)
        with pytest.raises(ValueError, match="already registered"):
            reg.register(OtherMulesoft)

    def test_require_missing_raises_key_error(self) -> None:
        reg = ConnectorRegistry()
        with pytest.raises(KeyError, match="no_such_provider"):
            reg.require("no_such_provider")

    def test_registered_providers_sorted(self) -> None:
        reg = ConnectorRegistry()
        reg.register(MulesoftConnector)
        providers = reg.registered_providers()
        assert providers == sorted(providers)


# ---------------------------------------------------------------------------
# Healthcheck tests
# ---------------------------------------------------------------------------


def _fake_urlopen_success(req: Any, timeout: int) -> MagicMock:
    mock = MagicMock()
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    mock.read.return_value = json.dumps({"access_token": "tok123"}).encode()
    return mock


def _fake_urlopen_http_401(req: Any, timeout: int) -> None:
    from urllib import error as urllib_error
    raise urllib_error.HTTPError(url="", code=401, msg="Unauthorized", hdrs=None, fp=None)


def _fake_urlopen_http_500(req: Any, timeout: int) -> None:
    from urllib import error as urllib_error
    raise urllib_error.HTTPError(url="", code=500, msg="Server Error", hdrs=None, fp=None)


def _fake_urlopen_url_error(req: Any, timeout: int) -> None:
    from urllib import error as urllib_error
    raise urllib_error.URLError(reason="Connection refused")


class TestMulesoftHealthcheck:
    def _run(self, connector: MulesoftConnector) -> Any:
        return asyncio.run(connector.healthcheck())

    def test_healthy_when_all_checks_pass(self) -> None:
        connector = _make_connector(
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "my-client-id",
                "vault/tenants/acme/mulesoft/client_secret": "my-client-secret",
            }
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=[
                {"access_token": "tok123"},  # token call
                {},                          # connectivity HEAD
            ],
        ):
            result = self._run(connector)

        assert result.status == ConnectorHealthStatus.HEALTHY
        assert result.is_healthy()
        assert result.retry_class is None
        check_names = [c["name"] for c in result.checks]
        assert "auth" in check_names
        assert "connectivity" in check_names
        assert "configuration" in check_names

    def test_unhealthy_when_secret_ref_unresolvable(self) -> None:
        connector = _make_connector(resolved_secrets={})  # no secrets injected
        result = self._run(connector)

        assert result.status == ConnectorHealthStatus.UNHEALTHY
        assert result.retry_class == RetryClass.AUTH
        auth_check = next(c for c in result.checks if c["name"] == "auth")
        assert not auth_check["ok"]

    def test_unhealthy_on_401_from_token_endpoint(self) -> None:
        connector = _make_connector(
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "id",
                "vault/tenants/acme/mulesoft/client_secret": "secret",
            }
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=__import__("urllib.error", fromlist=["HTTPError"]).HTTPError(
                url="", code=401, msg="Unauthorized", hdrs=None, fp=None
            ),
        ):
            result = self._run(connector)

        assert result.status == ConnectorHealthStatus.UNHEALTHY
        assert result.retry_class == RetryClass.AUTH

    def test_unhealthy_on_connectivity_failure(self) -> None:
        connector = _make_connector(
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "id",
                "vault/tenants/acme/mulesoft/client_secret": "secret",
            }
        )
        from urllib.error import URLError

        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=[
                {"access_token": "tok"},  # token succeeds
                URLError(reason="Connection refused"),  # connectivity fails
            ],
        ):
            result = self._run(connector)

        assert result.status == ConnectorHealthStatus.UNHEALTHY
        conn_check = next(c for c in result.checks if c["name"] == "connectivity")
        assert not conn_check["ok"]
        assert result.retry_class == RetryClass.TRANSIENT

    def test_degraded_when_only_config_fails(self) -> None:
        # Enable a flow with an unknown mapping profile
        connector = _make_connector(
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "id",
                "vault/tenants/acme/mulesoft/client_secret": "secret",
            },
            enabled_flows={
                "rental_contract_snapshot": EnabledFlowConfig(
                    mapping_profile="nonexistent_profile"
                )
            },
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=[
                {"access_token": "tok"},  # token
                {},                       # connectivity
            ],
        ):
            result = self._run(connector)

        assert result.status == ConnectorHealthStatus.DEGRADED
        cfg_check = next(c for c in result.checks if c["name"] == "configuration")
        assert not cfg_check["ok"]

    def test_connectivity_skipped_when_auth_fails(self) -> None:
        connector = _make_connector(resolved_secrets={})  # auth will fail
        result = self._run(connector)

        conn_check = next(c for c in result.checks if c["name"] == "connectivity")
        assert not conn_check["ok"]
        assert "skipped" in conn_check["detail"]

    def test_basic_auth_healthcheck_happy_path(self) -> None:
        connector = _make_connector(
            auth_type=MulesoftAuthType.BASIC,
            resolved_secrets={
                "vault/tenants/acme/mulesoft/user": "alice",
                "vault/tenants/acme/mulesoft/pass": "s3cr3t",
            },
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            return_value={},  # connectivity HEAD
        ):
            result = self._run(connector)

        auth_check = next(c for c in result.checks if c["name"] == "auth")
        assert auth_check["ok"]

    def test_api_key_healthcheck_happy_path(self) -> None:
        connector = _make_connector(
            auth_type=MulesoftAuthType.API_KEY,
            resolved_secrets={
                "vault/tenants/acme/mulesoft/api_key": "my-key-value",
            },
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            return_value={},
        ):
            result = self._run(connector)

        auth_check = next(c for c in result.checks if c["name"] == "auth")
        assert auth_check["ok"]

    def test_healthcheck_result_has_no_secrets(self) -> None:
        """Healthcheck output must not contain raw secret values."""
        secret_value = "super-secret-client-secret-value"
        connector = _make_connector(
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "my-client-id",
                "vault/tenants/acme/mulesoft/client_secret": secret_value,
            }
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=[{"access_token": "tok"}, {}],
        ):
            result = self._run(connector)

        serialised = json.dumps(
            {
                "message": result.message,
                "checks": result.checks,
            }
        )
        assert secret_value not in serialised


# ---------------------------------------------------------------------------
# TLS verification tests
# ---------------------------------------------------------------------------


class TestMulesoftTlsVerify:
    """Prove that tls_verify changes connector behaviour, not just field shape."""

    def _run(self, connector: MulesoftConnector) -> Any:
        return asyncio.run(connector.healthcheck())

    def test_tls_verify_true_produces_verified_ssl_context(self) -> None:
        connector = _make_connector(tls_verify=True)
        ctx = connector._build_ssl_context()
        assert ctx.verify_mode == ssl.CERT_REQUIRED
        assert ctx.check_hostname is True

    def test_tls_verify_false_produces_unverified_ssl_context(self) -> None:
        connector = _make_connector(tls_verify=False)
        ctx = connector._build_ssl_context()
        assert ctx.verify_mode == ssl.CERT_NONE
        assert ctx.check_hostname is False

    def test_tls_verify_true_passes_verified_context_to_urlopen(self) -> None:
        """Every urlopen call during healthcheck receives a cert-verifying context."""
        captured: list[ssl.SSLContext | None] = []

        def capturing_urlopen(
            req: Any, timeout: int, ssl_context: ssl.SSLContext | None = None
        ) -> dict:
            captured.append(ssl_context)
            return {"access_token": "tok"} if len(captured) == 1 else {}

        connector = _make_connector(
            tls_verify=True,
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "id",
                "vault/tenants/acme/mulesoft/client_secret": "secret",
            },
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=capturing_urlopen,
        ):
            self._run(connector)

        assert len(captured) == 2, "expected two urlopen calls (token + connectivity)"
        for ctx in captured:
            assert ctx is not None
            assert ctx.verify_mode == ssl.CERT_REQUIRED

    def test_tls_verify_false_passes_unverified_context_to_urlopen(self) -> None:
        """Every urlopen call during healthcheck receives a cert-skipping context."""
        captured: list[ssl.SSLContext | None] = []

        def capturing_urlopen(
            req: Any, timeout: int, ssl_context: ssl.SSLContext | None = None
        ) -> dict:
            captured.append(ssl_context)
            return {"access_token": "tok"} if len(captured) == 1 else {}

        connector = _make_connector(
            tls_verify=False,
            resolved_secrets={
                "vault/tenants/acme/mulesoft/client_id": "id",
                "vault/tenants/acme/mulesoft/client_secret": "secret",
            },
        )
        with patch(
            "temporal.src.integrations.mulesoft.connector._urlopen_json_with_timeout",
            side_effect=capturing_urlopen,
        ):
            self._run(connector)

        assert len(captured) == 2, "expected two urlopen calls (token + connectivity)"
        for ctx in captured:
            assert ctx is not None
            assert ctx.verify_mode == ssl.CERT_NONE


# ---------------------------------------------------------------------------
# Connector capabilities tests
# ---------------------------------------------------------------------------


class TestMulesoftConnectorCapabilities:
    def test_healthcheck_capability_declared(self) -> None:
        assert MulesoftConnector.supports(
            MulesoftConnector, ConnectorCapability.HEALTHCHECK  # type: ignore[arg-type]
        )

    def test_push_capability_declared(self) -> None:
        assert ConnectorCapability.PUSH in MulesoftConnector.supported_capabilities

    def test_webhook_ingest_capability_declared(self) -> None:
        assert ConnectorCapability.WEBHOOK_INGEST in MulesoftConnector.supported_capabilities
