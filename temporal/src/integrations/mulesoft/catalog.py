"""MuleSoft endpoint / flow catalog.

Defines the first-release set of API exchanges supported between Dealernet and a
customer's MuleSoft deployment. Each entry is an EndpointDefinition that
captures the exchange key, direction, human label, and supported mapping
profiles.

Keep this catalog additive. Do not remove or rename existing entries once
any tenant has enabled them – later delivery stories depend on the stable
exchange keys.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class FlowDirection(str, enum.Enum):
    """Data flow direction for an exchange."""

    OUTBOUND = "outbound"   # Dealernet → MuleSoft (customer systems)
    INBOUND = "inbound"     # MuleSoft → Dealernet
    BIDIRECTIONAL = "bidirectional"


class MappingProfile(str, enum.Enum):
    """Named field-mapping profiles that can be selected per flow.

    Profiles represent a stable mapping contract. Add new profiles rather
    than changing existing ones to avoid breaking live tenants.
    """

    DEFAULT = "default"
    RENTAL_V1 = "rental_v1"
    INVOICE_V1 = "invoice_v1"
    ASSET_V1 = "asset_v1"
    CUSTOMER_V1 = "customer_v1"


@dataclass(frozen=True)
class EndpointDefinition:
    """Definition of a single MuleSoft exchange endpoint.

    Attributes
    ----------
    key:
        Stable snake_case identifier used in integration_config.feature_config
        and integration_delivery_log.exchange_key. Never rename after release.
    label:
        Human-readable name shown in admin UI.
    direction:
        Which side initiates the data flow.
    description:
        Brief summary of what data is exchanged and why.
    supported_mapping_profiles:
        Ordered list of mapping profiles available for this endpoint;
        the first entry is the recommended default.
    requires_policy_inputs:
        Names of per-flow policy input fields an admin must supply when
        enabling this endpoint (e.g. a target queue name, filter expression).
        Empty means no operator input beyond enabling the flow.
    """

    key: str
    label: str
    direction: FlowDirection
    description: str
    supported_mapping_profiles: list[MappingProfile] = field(default_factory=list)
    requires_policy_inputs: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# First-release endpoint catalog
# ---------------------------------------------------------------------------

MULESOFT_ENDPOINT_CATALOG: dict[str, EndpointDefinition] = {
    ep.key: ep
    for ep in [
        EndpointDefinition(
            key="rental_contract_snapshot",
            label="Rental Contract Snapshot",
            direction=FlowDirection.OUTBOUND,
            description=(
                "Publishes a normalised rental-contract snapshot to the customer's MuleSoft "
                "deployment whenever a contract is created, modified, or closed."
            ),
            supported_mapping_profiles=[MappingProfile.RENTAL_V1, MappingProfile.DEFAULT],
        ),
        EndpointDefinition(
            key="invoice_snapshot",
            label="Invoice Snapshot",
            direction=FlowDirection.OUTBOUND,
            description=(
                "Publishes a normalised invoice record to MuleSoft on creation and on "
                "status transitions (issued, paid, voided)."
            ),
            supported_mapping_profiles=[MappingProfile.INVOICE_V1, MappingProfile.DEFAULT],
        ),
        EndpointDefinition(
            key="asset_sync",
            label="Asset / Fleet Sync",
            direction=FlowDirection.OUTBOUND,
            description=(
                "Pushes fleet asset master-data changes (metadata, status, location) "
                "to the customer's MuleSoft deployment for ERP/telematics correlation."
            ),
            supported_mapping_profiles=[MappingProfile.ASSET_V1, MappingProfile.DEFAULT],
        ),
        EndpointDefinition(
            key="customer_sync",
            label="Customer / Account Sync",
            direction=FlowDirection.OUTBOUND,
            description=(
                "Publishes Dealernet customer/account data to MuleSoft for CRM or ERP "
                "reconciliation. Operator must confirm field-mapping profile."
            ),
            supported_mapping_profiles=[MappingProfile.CUSTOMER_V1, MappingProfile.DEFAULT],
        ),
        EndpointDefinition(
            key="delivery_receipt",
            label="Delivery Receipt (Inbound)",
            direction=FlowDirection.INBOUND,
            description=(
                "Receives delivery confirmation callbacks from MuleSoft after it has "
                "processed an outbound payload. Used for idempotent status updates."
            ),
            supported_mapping_profiles=[MappingProfile.DEFAULT],
            requires_policy_inputs=["hmac_secret_ref"],
        ),
    ]
}
