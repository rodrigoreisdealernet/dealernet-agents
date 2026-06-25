# Equipment Rental ERP Domain Model (MVP)

**Status:** Approved for implementation
**Owner:** Engineering
**Related issues:** #3 (research), #5 (implementation)

## Overview
This specification defines the canonical domain language, entity relationships, and lifecycle/business rules for the equipment rental ERP MVP in `Volaris-AI/wynne-lvl-3`.

It is the implementation baseline for schema and service work tracked in:
- Epic: `Volaris-AI/wynne-lvl-3#2`
- Domain spec issue: `Volaris-AI/wynne-lvl-3#3`

## Metadata
- **Spec ID**: `equipment-rental-domain-model-mvp`
- **Status**: Approved for implementation
- **Version**: `1.0.0`
- **Repository**: `Volaris-AI/wynne-lvl-3`
- **Related Epic**: `Volaris-AI/wynne-lvl-3#2`
- **Related Issue**: `Volaris-AI/wynne-lvl-3#3`
- **Published**: `2026-06-05`
- **Last Updated**: `2026-06-05`

## Scope (MVP)
The MVP domain covers:
- Asset inventory and categorization
- Rental demand capture (`RentalOrder`) and fulfillment execution (`Contract`)
- Customer commercial structures (billing account, contacts, job sites)
- Cross-branch operational movement (`Transfer`)
- Core fleet safety/quality controls (maintenance and inspections)
- Invoice boundary logic for billable rental periods and non-rental charges

## Non-Goals (MVP)
The MVP does **not** include:
- Full accounting ledger/GL posting
- Tax engine integration and jurisdiction-specific tax logic
- Dynamic pricing optimization or AI pricing recommendations
- Field service scheduling optimization
- Telematics ingestion beyond optional references in event payload metadata
- Multi-company intercompany eliminations

---

## 1. Canonical Glossary

| Term | Definition |
|------|-----------|
| **Asset** | A uniquely identifiable rentable or support unit (e.g., excavator, generator, attachment) tracked through lifecycle, branch location, and availability. |
| **AssetCategory** | A classification for assets that defines rental characteristics such as default rate structure, utilization grouping, and operational handling constraints. |
| **Branch** | An internal operating location responsible for asset custody, dispatch, and local fleet availability. |
| **Customer** | The legal customer organization or person receiving rental services. |
| **BillingAccount** | The receivables/account-structure entity that defines invoicing ownership, credit posture, and payment terms for one customer context. |
| **Contact** | A named individual associated with a customer and/or job site for operational coordination, approvals, and billing communication. |
| **JobSite** | The physical delivery/use location for rented assets and related service actions. |
| **RentalOrder** | A customer demand record representing requested equipment, time window, and job site intent before legal/commercial fulfillment is finalized. |
| **RentalLineItem** | A line-level demand or fulfillment unit tied to one `RentalOrder`, referencing one requested `AssetCategory` and optionally one reserved/assigned `Asset`. |
| **Contract** | The legally and commercially binding rental agreement generated from an approved rental order (or equivalent internal request), defining billable terms and fulfillment commitments. |
| **Transfer** | An internal branch-to-branch movement process for asset custody reallocation, including requested, in-transit, and received states. |
| **Inspection** | A formal check event (pre-rental, in-rental, return, transfer, maintenance gate) that captures condition and compliance outcomes for an asset. |
| **MaintenanceRecord** | A maintenance activity record for an asset (preventive or corrective), including status, timestamps, and outcomes that can affect rentability. |
| **Invoice** | A billable document issued against a contract/billing account boundary, containing charge lines for rental and non-rental billables. |

---

## 2. Entity Relationships

```
Branch ──owns──> Asset
Branch ──originates──> Transfer
Branch ──receives──> Transfer
Transfer ──moves──> Asset

AssetCategory ──classifies──> Asset

Customer ──has──> BillingAccount
Customer ──has──> Contact
Customer ──places──> RentalOrder

RentalOrder ──delivered_to──> JobSite
RentalOrder ──contains──> RentalLineItem
RentalLineItem ──rents──> Asset

Contract ──covers──> RentalOrder
Contract ──billed_by──> BillingAccount

Invoice ──generated_from──> Contract
Invoice ──covers_order──> RentalOrder  (for spot/non-contract billing)

MaintenanceRecord ──against──> Asset
Inspection ──on──> Asset
Inspection ──triggers──> MaintenanceRecord  (on fail, optional)
```

All entities are stored in the generic `entities` table with the `entity_type` field set to the entity name in snake_case (e.g. `asset`, `rental_order`). State is captured in `entity_versions` (SCD2 JSONB snapshots). Edges are recorded in `relationships_v2`.

### Primary Cardinalities
- One `AssetCategory` to many `Asset`
- One `Customer` to many `BillingAccount`
- One `Customer` to many `Contact`
- One `Customer` to many `JobSite`
- One `BillingAccount` to many `RentalOrder`
- One `JobSite` to many `RentalOrder`
- One `RentalOrder` to many `RentalLineItem`
- One `RentalOrder` to zero or many `Contract` (MVP target: one active contract per order)
- One `Contract` to many `RentalLineItem` (fulfilled subset of order lines)
- One `Asset` to many `RentalLineItem` over time (max one active outbound rental assignment at a time)
- One `Asset` to many `MaintenanceRecord`
- One `Asset` to many `Inspection`
- One `Contract` to many `Invoice`
- One `Asset` to many `Transfer`
- One `Transfer` references exactly one origin `Branch` and one destination `Branch`

### Canonical Relationship Types (for `relationships_v2.relationship_type`)
- `asset_in_category` (`AssetCategory -> Asset`)
- `customer_has_billing_account` (`Customer -> BillingAccount`)
- `customer_has_contact` (`Customer -> Contact`)
- `customer_has_jobsite` (`Customer -> JobSite`)
- `billing_account_places_rental_order` (`BillingAccount -> RentalOrder`)
- `rental_order_for_jobsite` (`RentalOrder -> JobSite`)
- `rental_order_has_line_item` (`RentalOrder -> RentalLineItem`)
- `contract_fulfills_rental_order` (`Contract -> RentalOrder`)
- `contract_includes_line_item` (`Contract -> RentalLineItem`)
- `line_item_assigned_asset` (`RentalLineItem -> Asset`)
- `asset_home_branch` (`Asset -> Branch`)
- `transfer_origin_branch` (`Transfer -> Branch`)
- `transfer_destination_branch` (`Transfer -> Branch`)
- `transfer_moves_asset` (`Transfer -> Asset`)
- `asset_has_maintenance_record` (`Asset -> MaintenanceRecord`)
- `asset_has_inspection` (`Asset -> Inspection`)
- `invoice_bills_contract` (`Invoice -> Contract`)
- `invoice_bills_billing_account` (`Invoice -> BillingAccount`)

---

## 3. Asset Status Lifecycle

```
           ┌─────────────────────────────────────────────────────┐
           │                                                     │
    ┌──────▼──────┐   checkout      ┌──────────┐   return    ┌──▼──────────┐
    │  available  │ ──────────────► │  on_rent │ ──────────► │  returned   │
    └──────┬──────┘                 └──────────┘             └──────┬──────┘
           │                                                         │
           │ transfer                                                │ pass inspection
           ▼                                                         ▼
    ┌──────────────┐  receive      ┌─────────────┐         ┌────────────────┐
    │  in_transit  │ ────────────► │  available  │         │   available    │
    └──────────────┘               └─────────────┘         └────────────────┘
                                                                     │ fail inspection
                                                                     ▼
    ┌──────────────┐  open maint  ┌─────────────────┐      ┌─────────────────┐
    │ maintenance  │ ◄────────── │ inspection_hold  │      │ inspection_hold │
    └──────┬───────┘              └─────────────────┘      └─────────────────┘
           │ complete                       │ pass                   │ open maint
           ▼                                ▼                        ▼
    ┌──────────────┐               ┌───────────────┐       ┌────────────────┐
    │  available   │               │   available   │       │  maintenance   │
    └──────────────┘               └───────────────┘       └────────────────┘
```

**Valid `asset_status` values (stored in `entity_versions.data->>'status'`):**

| Value | Description |
|-------|-------------|
| `available` | Ready to rent or transfer |
| `on_rent` | Currently rented on an active `RentalLineItem`; requires an active `Contract` |
| `returned` | Returned, awaiting inspection before re-availability |
| `in_transit` | In-flight between branches; blocks new outbound rental assignment |
| `inspection_hold` | Failed inspection; blocked from dispatch and rental invoicing accrual |
| `maintenance` | Under active maintenance; blocked from dispatch and rental invoicing accrual |
| `unavailable` | Administratively blocked |
| `retired` | Decommissioned; terminal for rental operations |

---

## 4. Rental Order & Contract Lifecycle

**`RentalOrder` lifecycle (demand):**

| Value | Description |
|-------|-------------|
| `draft` | Quote stage |
| `submitted` | Submitted for approval |
| `approved` | Accepted but not yet on-hire |
| `partially_fulfilled` | At least one asset on-hire |
| `fulfilled` | All assets on-hire; order fully executed |
| `cancelled` | Voided before or after on-hire with audit reason |

**`Contract` lifecycle (legal/commercial):**

| Value | Description |
|-------|-------------|
| `draft` | Not yet executed; no invoice issuance |
| `active` | Executed; governs current orders; requires linked order to be `approved` or `partially_fulfilled` |
| `suspended` | Temporarily halted |
| `closed` | Completed or terminated; rental accrual stopped |
| `void` | Cancelled with audit reason |

Rules:
- A contract cannot become `active` unless the linked rental order is `approved` or `partially_fulfilled`.
- Order fulfillment is driven by line-item assignment and contract activation, not by order creation alone.
- Cancelling an order after contract activation requires contract `void` or `closed` transition with audit reason.

---

## 5. Transfer Rules

- A transfer **must be blocked** if the asset's current status is not `available`.
- The transfer lifecycle: `requested` → `approved` → `in_transit` → `received` → `cancelled`.
- Asset entering `in_transit` must transition to `in_transit` status.
- Destination branch custody changes only at `received`.
- Active outbound rental assignment blocks transfer unless a forced override is approved and audited.

---

## 6. Inspection Rules

- Inspection types: `checkout`, `return`, `service`.
- Outcomes: `pass`, `fail`.
- A **pass** at `checkout` keeps asset `on_rent`; at `return`/`service` moves asset to `available`.
- A **fail** always moves asset to `inspection_hold`.
- Assets due for mandatory inspection cannot move to `on_rent` until passed.
- From `inspection_hold`, a maintenance record may be opened, which moves asset to `maintenance`.

---

## 7. Maintenance Rules

- A maintenance record can be opened against an asset in `available`, `inspection_hold`, or `returned` status.
- Opening a maintenance record transitions the asset to `maintenance`.
- Assets in `on_rent` or `in_transit` block maintenance record creation.
- Maintenance records must preserve maintenance type (`preventive`/`corrective`) and completion outcome.
- Downtime is measured from `opened_at` to `completed_at` in minutes.
- Completing the record transitions the asset to `available`.
- Downtime is written as a `time_series_points` row with `fact_type` = `asset_downtime`.
- Return inspections may generate maintenance requirements before next availability.

---

## 8. Invoice Rules

- Invoices are generated against `Contract` + `BillingAccount` scope.
- Invoice status values: `draft`, `pending`, `sent`, `paid`, `void`.
- An invoice stores `billing_period_start`, `billing_period_end`, `subtotal`, `tax`, and `total` in `entity_versions.data`.
- One invoice can contain multiple contracts only when billing account, currency, and invoicing cycle match (MVP default: single-contract invoices).
- Rental charges stop accruing at contract line return timestamp.
- Non-rental charges (delivery, pickup, damage, fuel, fees) must reference contract line or contract header source.
- No invoice issuance for `draft` or `void` contracts.
- Invoicing is operational billing only; no GL/AP integration is in scope.

---

## 9. Rate Types

| Rate type | Description |
|-----------|-------------|
| `daily` | Per calendar day |
| `weekly` | Per 7-day block |
| `monthly` | Per 28-day block |
| `weekly_overtime` | Additional daily rate after weekly minimum |

Rules:
- Each contract line has exactly one base rate type at a time.
- Billable period segmentation must preserve explicit rate-type boundaries.
- Proration policy for partial periods must be deterministic and versioned in contract metadata.

**Internal vs External Rentals:**
- `external_customer` — standard customer billing; requires a valid `Customer` + `BillingAccount`.
- `internal_branch` — internal consumption/usage; may use an internal billing account but still requires contract traceability; excluded from external revenue reporting by channel flag.

**Re-rent:** where a Branch rents an asset from a third party to fulfil a Customer order. Re-rent lines must be explicitly flagged at line item level (`is_re_rent=true`). Owned-asset utilization metrics must exclude re-rent lines unless explicitly requested.

---

## 10. Schema Approach (Supabase)

All domain objects follow the **entity/SCD2/relationship** pattern from `DATABASE.md` and `Guide_for_agents_using_supabase_template.md`:

```
entities(entity_type='asset', ...)
entity_versions(entity_id, data={'status':'available','category_id':'...','serial':'...','rate_daily':150})
relationships_v2(relationship_type='asset_home_branch', parent_id=branch_entity_id, child_id=asset_entity_id)
```

Time-based event data (meter readings, downtime) uses `time_series_points`. Aggregated KPIs use `entity_facts`.

### Core Mapping
- `entities`: one row per canonical entity instance (`entity_type` values: `asset`, `asset_category`, `rental_order`, `rental_line_item`, `contract`, `customer`, `billing_account`, `contact`, `job_site`, `branch`, `maintenance_record`, `inspection`, `invoice`, `transfer`).
- `entity_versions`: SCD2 snapshot of mutable attributes (status, names, terms, dates, pricing metadata, flags).
- `relationships_v2`: canonical typed links listed above with SCD2 validity windows.
- `fact_types`: registry for KPI/event keys (e.g., `asset_status_code`, `contract_daily_rate`, `line_item_is_re_rent`, `invoice_total_amount`, `asset_utilization_percent`).
- `entity_facts`: numeric current-state facts (status codes, totals, utilization, counters) with optional dimensions for non-numeric meaning.
- `time_series_points`: raw event history (status changes, dispatch/return timestamps, inspection events, transfer events, invoice issuance events).

### Entity Type and Fact Key Conventions
- Use lowercase snake_case keys for `entity_type`, `relationship_type`, and `fact_types.key`.
- Keep human-readable labels in metadata/dimensions, not in IDs.
- Keep external ERP IDs in `entities.source_record_id` or version metadata.

### Recommended Dimensions (`dim_*`) for MVP
- `dim_asset_status`
- `dim_contract_status`
- `dim_order_status`
- `dim_rate_type`
- `dim_transfer_status`
- `dim_rental_channel`

Use numeric codes in `entity_facts.value` with `dimension_type` + `dimension_id` pointing to these dimensions.

### Write/Derivation Pattern
1. Upsert entities and SCD2 versions.
2. Insert raw domain event into `time_series_points`.
3. Derive and upsert current numeric state into `entity_facts`.
4. Maintain relationship history through `relationships_v2` SCD2 rows.

### Data Governance Requirements
- Enable RLS on all core and `dim_*` tables.
- Use transactions for multi-step writes that update events and facts.
- Avoid storing high-frequency mutable telemetry in `entity_versions`; use `time_series_points`.

### Fact Types Seeded

| key | label | unit |
|-----|-------|------|
| `asset_meter_reading` | Asset Meter Reading | hours |
| `asset_downtime` | Asset Downtime | minutes |
| `branch_on_rent_count` | Branch On-Rent Count | count |
| `branch_utilization_rate` | Branch Utilization Rate | percent |
| `invoice_total` | Invoice Total | USD |
| `rental_revenue` | Rental Revenue | USD |

---

## 11. Analytics Outputs

| Metric | Source |
|--------|--------|
| Asset meter readings / usage events | `time_series_points` (fact: `asset_meter_reading`) |
| Asset downtime history | `time_series_points` (fact: `asset_downtime`) + `v_asset_downtime_history` |
| Per-asset analytics (revenue, utilization %, downtime %, ROI, rental frequency, last order) | `entity_facts` projection (`asset_*` fact types) + `v_asset_analytics_current` |
| Branch on-rent count | `entity_facts` (fact: `branch_on_rent_count`) + `v_branch_utilization` |
| Branch utilization rate | `entity_facts` (fact: `branch_utilization_rate`) |
| Invoice totals | `entity_facts` (fact: `invoice_total`) |

### Per-asset analytics formulas

- `lifetime_revenue` = `sum(invoice_line.amount)` for current invoice lines linked to a serialized contract line
- `utilization_pct` = `included_rental_minutes / calendar_minutes * 100`
- `downtime_pct` = `total_downtime_minutes / calendar_minutes * 100`
- `rental_frequency` = `count(distinct contract_id)` for included rental lines
- `roi_pct` = `(lifetime_revenue - cost_basis) / cost_basis * 100` (null when cost basis is missing/invalid)
- `last_order_at` = latest contract-line `actual_start` (falling back to `planned_start`)
- Default exclusion: re-rent/leased lines are excluded from utilization and ROI calculations unless a consumer chooses a non-default projection.
- Projection cleanup behavior: recompute removes stale `asset_roi_pct` rows when cost basis is missing/invalid and removes stale `asset_last_order_epoch` rows when no order-start remains; both are regenerated by rerunning `rental_recompute_asset_analytics(...)` after source data is restored.

---

## Validation and Test Strategy

### Spec Validation (now)
- Validate glossary completeness against required canonical entities.
- Validate lifecycle consistency so status transitions are deterministic and non-ambiguous.
- Validate relationship cardinalities support expected workflows (order -> contract -> invoice, asset -> transfer/maintenance/inspection).

### Implementation Validation (follow-on stories)
- Migration tests: ensure `entity_type`, relationship types, and fact type keys are seeded as defined.
- Service-level tests: enforce lifecycle transition guards (e.g., cannot set asset `on_rent` without active contract line).
- Invoicing tests: verify rental accrual stop at return timestamp and correct inclusion of non-rental charges.
- Re-rent tests: verify owned utilization excludes re-rent by default.
- Transfer tests: verify custody branch changes only at transfer `received`.

### Operational Validation
- Add dashboard checks for inconsistent states (e.g., `on_rent` assets with no active contract line).
- Add anomaly queries for overlapping active line assignments per asset.

## Follow-up Risks and Open Questions
- **Rate proration ambiguity**: if not standardized early, invoice disputes will increase.
- **Internal rental accounting policy**: needs explicit downstream reporting policy to avoid metric contamination.
- **Re-rent cost capture**: if supplier-cost linkage is deferred, margin analytics will be incomplete.
- **Cross-branch transfer latency**: delayed receiving events can misstate availability and utilization.
- **Status code drift**: if dimension rows are edited in place, historical interpretation can break.

## Unblocking Criteria for Epic #2
This specification is intended to unblock child implementation stories under `Volaris-AI/wynne-lvl-3#2` by providing:
- Canonical entity names
- Canonical relationship types
- Canonical lifecycle states and transition constraints
- Canonical Supabase generic-model mapping rules
