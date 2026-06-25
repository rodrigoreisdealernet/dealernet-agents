# MuleSoft API exchange workflows

**Status:** Draft  
**Related issues:** #485, #892, #1150  
**Related ADRs:** [ADR-0037](../adrs/0037-integration-connector-framework.md)

## Supported exchanges

| Exchange | Direction | Source of truth | Replay / backfill semantics |
|---|---|---|---|
| `rental_contract_snapshot` | Wynne → MuleSoft | Wynne `rental_contract` current entity snapshot | Automatic runs dedupe on `entity_id + entity_version`. Operator replay/backfill republishes the latest current snapshot for scoped entity ids with a workflow-scoped replay token. |
| `invoice_snapshot` | Wynne → MuleSoft | Wynne `invoice` current entity snapshot | Automatic runs dedupe on `entity_id + entity_version`. Operator replay/backfill republishes the latest current snapshot for scoped entity ids with a workflow-scoped replay token. |
| `delivery_receipt` | MuleSoft → Wynne | MuleSoft delivery acknowledgement state | Inbound callbacks dedupe on MuleSoft delivery id before workflow handoff; repeated callbacks update the same delivery-log and sync-state scope. |

## Field mappings

### `rental_contract_snapshot`

| Wynne field | MuleSoft field |
|---|---|
| `entity_id` | `wynneContractId` |
| `external_id_map.external_id` (or `entity_id` fallback) | `contractId` |
| `data.contract_number` | `contractNumber` |
| `data.status` | `status` |
| `data.branch_id` | `branchId` |
| `data.customer_id` | `customerId` |
| `data.billing_account_id` | `billingAccountId` |
| `data.start_date` | `startDate` |
| `data.expected_end_date` | `expectedEndDate` |
| current entity version | `snapshotVersion` |

### `invoice_snapshot`

| Wynne field | MuleSoft field |
|---|---|
| `entity_id` | `wynneInvoiceId` |
| `external_id_map.external_id` (or `entity_id` fallback) | `invoiceId` |
| `data.invoice_number` | `invoiceNumber` |
| `data.status` | `status` |
| `data.contract_id` | `contractId` |
| `data.billing_account_id` | `billingAccountId` |
| `data.transaction_currency_code` | `currencyCode` |
| `data.subtotal_amount` | `subtotalAmount` |
| `data.tax_total` | `taxTotal` |
| `data.total_amount` | `invoiceTotal` |
| `data.issued_at` | `issuedAt` |
| current entity version | `snapshotVersion` |

### `delivery_receipt`

| MuleSoft field | Wynne persistence |
|---|---|
| `deliveryId` | `integration_delivery_log.provider_delivery_id` + inbound idempotency key |
| `subjectExchangeKey` | `integration_sync_state.exchange_key` |
| `entityType` | `external_id_map.entity_type` |
| `entityId` | `external_id_map.entity_id` / `integration_sync_state.scope_key` |
| `externalId` | `external_id_map.external_id` |
| `status` | `integration_sync_state.state.delivery_status` |
| `cursor` | `integration_sync_state.cursor` |
| `message` | `integration_sync_state.state.message` |

## Persistence contract

- `integration_config` stores tenant-scoped MuleSoft endpoint paths, mappings, enablement, and env-var secret references.
- `external_id_map` stores durable Wynne ↔ MuleSoft aliases per supported exchange.
- `integration_sync_state` stores the last outbound entity-version cursor or inbound delivery cursor per exchange scope.
- `integration_delivery_log` stores inbound dedupe keys, outbound idempotency keys, request/response payloads, workflow ids, and retry history.
