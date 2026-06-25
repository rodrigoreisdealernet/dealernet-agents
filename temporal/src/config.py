from __future__ import annotations

from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AzureOpenAIConfigurationError(ValueError):
    """Raised when Azure OpenAI settings are missing or incomplete."""


class AzureOpenAIEndpointConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: str
    api_key: str
    deployment: str
    api_version: str


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False, populate_by_name=True)

    temporal_address: str = Field("temporal:7233", validation_alias="TEMPORAL_ADDRESS")
    temporal_namespace: str = Field("default", validation_alias="TEMPORAL_NAMESPACE")
    temporal_task_queue: str = Field("main", validation_alias="TEMPORAL_TASK_QUEUE")
    supabase_url: str = Field("http://supabase:8000", validation_alias="SUPABASE_URL")
    supabase_service_role_key: str = Field("dev-service-role-key", validation_alias="SUPABASE_SERVICE_ROLE_KEY")

    azure_openai_endpoint: str | None = Field(None, validation_alias="AZURE_OPENAI_ENDPOINT")
    azure_openai_api_key: str | None = Field(None, validation_alias=AliasChoices("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_KEY"))
    azure_openai_deployment: str | None = Field(None, validation_alias="AZURE_OPENAI_DEPLOYMENT")
    azure_openai_api_version: str | None = Field(None, validation_alias="AZURE_OPENAI_API_VERSION")

    azure_openai_secondary_endpoint: str | None = Field(None, validation_alias="AZURE_OPENAI_SECONDARY_ENDPOINT")
    azure_openai_secondary_api_key: str | None = Field(None, validation_alias=AliasChoices("AZURE_OPENAI_SECONDARY_API_KEY", "AZURE_OPENAI_SECONDARY_KEY"))
    azure_openai_secondary_deployment: str | None = Field(None, validation_alias="AZURE_OPENAI_SECONDARY_DEPLOYMENT")
    azure_openai_secondary_api_version: str | None = Field(None, validation_alias="AZURE_OPENAI_SECONDARY_API_VERSION")

    def resolve_azure_openai_endpoints(self) -> tuple[AzureOpenAIEndpointConfig, ...]:
        """Return configured Azure OpenAI deployments in failover order."""

        primary = self._build_endpoint_config(
            label="primary",
            endpoint=self.azure_openai_endpoint,
            api_key=self.azure_openai_api_key,
            deployment=self.azure_openai_deployment,
            api_version=self.azure_openai_api_version,
            required=True,
        )
        endpoints = [primary]

        secondary_values = (
            self.azure_openai_secondary_endpoint,
            self.azure_openai_secondary_api_key,
            self.azure_openai_secondary_deployment,
            self.azure_openai_secondary_api_version,
        )
        if any(value for value in secondary_values):
            secondary = self._build_endpoint_config(
                label="secondary",
                endpoint=self.azure_openai_secondary_endpoint,
                api_key=self.azure_openai_secondary_api_key,
                deployment=self.azure_openai_secondary_deployment,
                api_version=self.azure_openai_secondary_api_version or self.azure_openai_api_version,
                required=False,
            )
            endpoints.append(secondary)

        return tuple(endpoints)

    @staticmethod
    def _build_endpoint_config(
        *,
        label: str,
        endpoint: str | None,
        api_key: str | None,
        deployment: str | None,
        api_version: str | None,
        required: bool,
    ) -> AzureOpenAIEndpointConfig:
        values = {
            "endpoint": endpoint,
            "api_key": api_key,
            "deployment": deployment,
            "api_version": api_version,
        }
        missing = [field for field, value in values.items() if not value]
        if missing:
            prefix = f"Azure OpenAI {label}"
            if required or any(value for value in values.values()):
                missing_fields = ", ".join(missing)
                raise AzureOpenAIConfigurationError(f"{prefix} configuration is incomplete; missing: {missing_fields}")
        return AzureOpenAIEndpointConfig(**values)


settings = Settings()
