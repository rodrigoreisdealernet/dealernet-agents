"""MuleSoft integration provider.

Implements the shared connector contract for MuleSoft as a customer-facing
integration target (ADR-0037, epic #892, issue #1149).

MuleSoft is treated as an iPaaS target, not the internal architecture.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from .catalog import (
    MULESOFT_ENDPOINT_CATALOG,
    EndpointDefinition,
    FlowDirection,
    MappingProfile,
)
from .config import (
    MulesoftAuthType,
    MulesoftConnectionConfig,
    MulesoftFeatureConfig,
    MulesoftSecretRefs,
)
from .connector import MulesoftConnector


@dataclass(frozen=True)
class MuleSoftExchangeDefinition:
    exchange_key: str
    direction: Literal["outbound", "inbound"]
    source_of_truth: Literal["dia", "mulesoft"]
    entity_type: str
    replay_semantics: str
    field_mapping: dict[str, str]


class MuleSoftCallbackReceipt(BaseModel):
    delivery_id: str = Field(min_length=1)
    subject_exchange_key: Literal["rental_contract_snapshot", "invoice_snapshot"]
    entity_type: Literal["rental_contract", "invoice"]
    entity_id: str = Field(min_length=1)
    external_id: str | None = None
    status: Literal["accepted", "rejected", "retrying"]
    cursor: str | None = None
    message: str | None = None
    received_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


_EXCHANGES: dict[str, MuleSoftExchangeDefinition] = {
    "rental_contract_snapshot": MuleSoftExchangeDefinition(
        exchange_key="rental_contract_snapshot",
        direction="outbound",
        source_of_truth="dia",
        entity_type="rental_contract",
        replay_semantics=(
            "Replay and backfill republish the latest current Dealernet rental-contract snapshot for the "
            "scoped entity ids. Automatic runs dedupe on entity version; explicit replays use the "
            "workflow-scoped replay token so retries stay idempotent while operator-initiated reruns "
            "still produce a fresh publish."
        ),
        field_mapping={
            "entity_id": "diaContractId",
            "external_id": "contractId",
            "contract_number": "contractNumber",
            "status": "status",
            "branch_id": "branchId",
            "customer_id": "customerId",
            "billing_account_id": "billingAccountId",
            "start_date": "startDate",
            "expected_end_date": "expectedEndDate",
        },
    ),
    "invoice_snapshot": MuleSoftExchangeDefinition(
        exchange_key="invoice_snapshot",
        direction="outbound",
        source_of_truth="dia",
        entity_type="invoice",
        replay_semantics=(
            "Replay and backfill republish the latest current Dealernet invoice snapshot for the scoped "
            "entity ids. Automatic runs dedupe on entity version; explicit replays use the workflow-"
            "scoped replay token so retries stay idempotent while operator-initiated reruns still "
            "produce a fresh publish."
        ),
        field_mapping={
            "entity_id": "diaInvoiceId",
            "external_id": "invoiceId",
            "invoice_number": "invoiceNumber",
            "status": "status",
            "contract_id": "contractId",
            "billing_account_id": "billingAccountId",
            "transaction_currency_code": "currencyCode",
            "subtotal_amount": "subtotalAmount",
            "tax_total": "taxTotal",
            "total_amount": "invoiceTotal",
            "issued_at": "issuedAt",
        },
    ),
    "delivery_receipt": MuleSoftExchangeDefinition(
        exchange_key="delivery_receipt",
        direction="inbound",
        source_of_truth="mulesoft",
        entity_type="integration_delivery",
        replay_semantics=(
            "Inbound delivery receipts are deduplicated on MuleSoft delivery id before workflow "
            "handoff. Replayed callbacks update the same delivery-log row and sync-state scope instead "
            "of creating duplicate business effects."
        ),
        field_mapping={
            "delivery_id": "deliveryId",
            "subject_exchange_key": "subjectExchangeKey",
            "entity_type": "entityType",
            "entity_id": "entityId",
            "external_id": "externalId",
            "status": "status",
            "cursor": "cursor",
            "message": "message",
            "received_at": "receivedAt",
        },
    ),
}


def get_exchange_definition(exchange_key: str) -> MuleSoftExchangeDefinition:
    definition = _EXCHANGES.get(exchange_key)
    if definition is None:
        raise ValueError(f"Unsupported MuleSoft exchange: {exchange_key}")
    return definition


def build_outbound_payload(
    *,
    exchange_key: str,
    entity_id: str,
    version_number: int,
    data: dict[str, Any],
    external_id: str | None,
) -> dict[str, Any]:
    definition = get_exchange_definition(exchange_key)
    if definition.direction != "outbound":
        raise ValueError(f"{exchange_key} is not an outbound MuleSoft exchange")

    if exchange_key == "rental_contract_snapshot":
        return {
            "contractId": external_id or entity_id,
            "diaContractId": entity_id,
            "contractNumber": str(data.get("contract_number") or ""),
            "status": str(data.get("status") or ""),
            "branchId": str(data.get("branch_id") or ""),
            "customerId": str(data.get("customer_id") or ""),
            "billingAccountId": str(data.get("billing_account_id") or ""),
            "startDate": data.get("start_date"),
            "expectedEndDate": data.get("expected_end_date"),
            "snapshotVersion": version_number,
            "sourceOfTruth": definition.source_of_truth,
        }
    if exchange_key == "invoice_snapshot":
        return {
            "invoiceId": external_id or entity_id,
            "diaInvoiceId": entity_id,
            "invoiceNumber": str(data.get("invoice_number") or ""),
            "status": str(data.get("status") or ""),
            "contractId": str(data.get("contract_id") or ""),
            "billingAccountId": str(data.get("billing_account_id") or ""),
            "currencyCode": str(data.get("transaction_currency_code") or ""),
            "subtotalAmount": data.get("subtotal_amount"),
            "taxTotal": data.get("tax_total"),
            "invoiceTotal": data.get("total_amount"),
            "issuedAt": data.get("issued_at"),
            "snapshotVersion": version_number,
            "sourceOfTruth": definition.source_of_truth,
        }
    raise ValueError(f"Unsupported outbound MuleSoft exchange: {exchange_key}")


def build_mulesoft_signature(*, secret: str, delivery_id: str, body: bytes) -> str:
    payload = delivery_id.encode("utf-8") + b"." + body
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def verify_mulesoft_signature(*, secret: str, delivery_id: str, body: bytes, signature: str) -> bool:
    expected = build_mulesoft_signature(secret=secret, delivery_id=delivery_id, body=body)
    return hmac.compare_digest(expected, signature.strip())


__all__ = [
    "MULESOFT_ENDPOINT_CATALOG",
    "EndpointDefinition",
    "FlowDirection",
    "MappingProfile",
    "MuleSoftCallbackReceipt",
    "MuleSoftExchangeDefinition",
    "MulesoftAuthType",
    "MulesoftConnectionConfig",
    "MulesoftConnector",
    "MulesoftFeatureConfig",
    "MulesoftSecretRefs",
    "build_mulesoft_signature",
    "build_outbound_payload",
    "get_exchange_definition",
    "verify_mulesoft_signature",
]
