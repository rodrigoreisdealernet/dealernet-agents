"""Rental domain data models (dataclasses / Pydantic-free for Temporal serialisation)."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

# ---------------------------------------------------------------------------
# Enums (plain strings to avoid Temporal serialisation issues)
# ---------------------------------------------------------------------------

class OrderStatus:
    DRAFT = "draft"
    QUOTED = "quoted"
    APPROVED = "approved"
    CONVERTED = "converted"
    CANCELLED = "cancelled"
    EXPIRED = "expired"

    TERMINAL = frozenset({CONVERTED, CANCELLED, EXPIRED})

    # Allowed transitions: {from_status: set_of_valid_to_statuses}
    TRANSITIONS: dict[str, frozenset[str]] = {
        DRAFT:     frozenset({QUOTED, CANCELLED}),
        QUOTED:    frozenset({APPROVED, CANCELLED, EXPIRED}),
        APPROVED:  frozenset({CONVERTED, CANCELLED}),
        CONVERTED: frozenset(),
        CANCELLED: frozenset(),
        EXPIRED:   frozenset(),
    }


class ContractStatus:
    PENDING_EXECUTION = "pending_execution"
    ACTIVE = "active"
    CLOSED = "closed"
    CANCELLED = "cancelled"

    TERMINAL = frozenset({CLOSED, CANCELLED})

    TRANSITIONS: dict[str, frozenset[str]] = {
        PENDING_EXECUTION: frozenset({ACTIVE, CANCELLED}),
        ACTIVE:            frozenset({CLOSED, CANCELLED}),
        CLOSED:            frozenset(),
        CANCELLED:         frozenset(),
    }


class LineStatus:
    PENDING = "pending"
    CHECKED_OUT = "checked_out"
    RETURNED = "returned"
    CANCELLED = "cancelled"

    TERMINAL = frozenset({RETURNED, CANCELLED})


class AssetAvailabilityStatus:
    AVAILABLE = "available"
    ON_TRANSFER = "on_transfer"
    IN_MAINTENANCE = "in_maintenance"
    ON_INSPECTION_HOLD = "on_inspection_hold"
    RETIRED = "retired"
    LOST = "lost"
    CONFLICTING_ASSIGNMENT = "conflicting_assignment"

    BLOCKING = frozenset({
        ON_TRANSFER,
        IN_MAINTENANCE,
        ON_INSPECTION_HOLD,
        RETIRED,
        LOST,
        CONFLICTING_ASSIGNMENT,
    })


class RentalType:
    INTERNAL = "internal"
    EXTERNAL = "external"


class RateType:
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    FIXED = "fixed"


# ---------------------------------------------------------------------------
# Input / request dataclasses
# ---------------------------------------------------------------------------

@dataclass
class RentalLineInput:
    """Input for a single rental line (order or contract)."""
    category_id: str
    quantity: int
    planned_start: str          # ISO-8601 string
    planned_end: str            # ISO-8601 string
    rate_type: str              # RateType constant
    rate_amount: int            # minor currency units
    rental_type: str            # RentalType constant
    asset_id: str | None = None   # assigned later


@dataclass
class CreateRentalOrderInput:
    """Input for the create-rental-order activity."""
    requester_id: str
    rental_type: str            # RentalType constant
    lines: list[RentalLineInput] = field(default_factory=list)
    created_by: str | None = None
    notes: str | None = None
    idempotency_key: str | None = None  # workflow_id; drives deterministic entity ID


@dataclass
class TransitionOrderInput:
    """Input for transitioning an order to a new status."""
    order_entity_id: str
    new_status: str             # OrderStatus constant
    actor_id: str | None = None
    reason: str | None = None


@dataclass
class AssignAssetInput:
    """Assign a specific asset to an order line."""
    order_line_entity_id: str
    asset_id: str
    actor_id: str | None = None


@dataclass
class ConvertOrderInput:
    """Convert an approved order into a contract."""
    order_entity_id: str
    actor_id: str | None = None


@dataclass
class CheckoutLineInput:
    """Check out a contract line item."""
    contract_line_entity_id: str
    actual_start: str           # ISO-8601 string
    actor_id: str | None = None


@dataclass
class ReturnLineInput:
    """Return a checked-out contract line item."""
    contract_line_entity_id: str
    actual_end: str             # ISO-8601 string
    actor_id: str | None = None


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------

@dataclass
class RentalOrderResult:
    order_entity_id: str
    version_id: str
    status: str
    success: bool = True
    error: str | None = None


@dataclass
class RentalContractResult:
    contract_entity_id: str
    version_id: str
    status: str
    order_entity_id: str
    success: bool = True
    error: str | None = None


@dataclass
class RentalLineResult:
    line_entity_id: str
    version_id: str
    status: str
    success: bool = True
    error: str | None = None
    block_reason: str | None = None   # set when checkout is blocked


# ---------------------------------------------------------------------------
# Operational-flow domain models (transfer / inspection / maintenance / invoice)
#
# Restored after PR #30's order-to-contract rewrite dropped these symbols,
# orphaning activities/rental_operations.py and its tests (issue #57).
# These are additive and do not overlap the order/contract types above.
# ---------------------------------------------------------------------------

class AvailabilityImpact:
    """Severity values for maintenance work-order availability impact."""
    SOFT_DOWN = "soft_down"
    HARD_DOWN = "hard_down"

    ALL = frozenset({SOFT_DOWN, HARD_DOWN})


class AssetStatus(str, Enum):
    AVAILABLE = "available"
    ON_RENT = "on_rent"
    RETURNED = "returned"
    IN_TRANSIT = "in_transit"
    INSPECTION_HOLD = "inspection_hold"
    MAINTENANCE = "maintenance"
    UNAVAILABLE = "unavailable"
    RETIRED = "retired"


TRANSFERABLE_STATUSES: frozenset[AssetStatus] = frozenset({AssetStatus.AVAILABLE})
MAINTENANCE_OPENABLE_STATUSES: frozenset[AssetStatus] = frozenset(
    {AssetStatus.AVAILABLE, AssetStatus.INSPECTION_HOLD, AssetStatus.RETURNED}
)


class InspectionType(str, Enum):
    CHECKOUT = "checkout"
    RETURN = "return"
    SERVICE = "service"


class InspectionResult(str, Enum):
    PASS = "pass"
    FAIL = "fail"


class InvoiceStatus(str, Enum):
    DRAFT = "draft"
    PENDING = "pending"
    SENT = "sent"
    PAID = "paid"
    VOID = "void"


@dataclass
class TransferRequest:
    asset_id: str
    origin_branch_id: str
    destination_branch_id: str
    requested_by: str
    sourcing_decision_id: str | None = None
    requested_ship_date: str | None = None
    expected_receive_date: str | None = None
    asset_scope: str | None = None
    internal_cost: float | None = None
    transfer_exception_reason: str | None = None
    # Cross-project fields (optional; None for branch-only transfers)
    origin_project_id: str | None = None
    destination_project_id: str | None = None


@dataclass
class TransferResult:
    transfer_id: str
    asset_id: str
    status: str  # "requested" | "approved" | "in_transit" | "received" | "blocked"
    blocked: bool = False
    blocked_reason: str | None = None
    sourcing_decision_id: str | None = None
    requested_ship_date: str | None = None
    expected_receive_date: str | None = None
    asset_scope: str | None = None
    internal_cost: float | None = None
    exceptions: list[str] = field(default_factory=list)
    origin_project_id: str | None = None
    destination_project_id: str | None = None


@dataclass
class MilestoneSignal:
    actor_id: str
    notes: str | None = None


@dataclass
class InspectionRequest:
    asset_id: str
    inspection_type: InspectionType
    inspector_id: str


@dataclass
class InspectionResultSignal:
    outcome: InspectionResult
    notes: str | None = None
    open_maintenance: bool = False  # if fail, immediately open maintenance


@dataclass
class InspectionSummary:
    inspection_id: str
    asset_id: str
    outcome: str
    final_asset_status: str
    maintenance_triggered: bool = False


@dataclass
class MaintenanceRequest:
    asset_id: str
    maintenance_type: str  # e.g. "preventive", "corrective", "emergency"
    technician_id: str
    notes: str | None = None
    availability_impact: str | None = None   # AvailabilityImpact.SOFT_DOWN | HARD_DOWN
    blocking_reason: str | None = None       # human-readable reason for the down state
    expected_return_at: str | None = None    # ISO-8601; expected asset return to service


@dataclass
class MaintenanceCompleteSignal:
    technician_id: str
    resolution_notes: str | None = None
    outcome: str = "completed"
    cost_summary: str | None = None


@dataclass
class MaintenanceSummary:
    maintenance_record_id: str
    asset_id: str
    status: str  # "open" | "completed" | "blocked"
    blocked: bool = False
    blocked_reason: str | None = None
    downtime_minutes: float | None = None
    final_asset_status: str | None = None
    down_severity: str | None = None    # derived from availability_impact on the record
    down_reason: str | None = None     # derived from blocking_reason on the record


# ---------------------------------------------------------------------------
# Maintenance costing / invoice-from-work-order models
# ---------------------------------------------------------------------------

class MaintenanceCostLineType(str, Enum):
    LABOR = "labor"
    PARTS = "parts"
    FEES = "fees"


@dataclass
class MaintenanceCostLine:
    """A single itemized cost line on a maintenance work order."""
    line_type: str          # MaintenanceCostLineType value
    description: str
    quantity: float
    unit_cost: float        # internal cost per unit
    sell_amount: float      # customer-facing sell price per unit (0 for internal-only)
    is_taxable: bool = False
    tax_rate: float = 0.0   # e.g. 0.10 for 10%
    notes: str | None = None
    line_id: str | None = None  # caller-supplied idempotency key; two lines with distinct line_ids are always separate rows


@dataclass
class MaintenanceCostingRequest:
    """Request to add cost lines and roll up totals on a maintenance work order."""
    maintenance_record_id: str
    cost_lines: list[dict]  # list of MaintenanceCostLine dicts
    is_customer_billable: bool = False
    billing_account_id: str | None = None
    created_by: str = "system"


@dataclass
class MaintenanceCostingSummary:
    """Result of costing a maintenance work order."""
    maintenance_record_id: str
    cost_line_count: int
    internal_subtotal: float    # sum of (quantity * unit_cost) across all lines
    sell_subtotal: float        # sum of (quantity * sell_amount) across all lines
    tax_total: float            # sum of taxable sell lines * tax_rate
    sell_total: float           # sell_subtotal + tax_total
    is_customer_billable: bool = False
    billing_account_id: str | None = None


@dataclass
class MaintenanceInvoiceRequest:
    """Request to generate a draft invoice from a completed billable work order."""
    maintenance_record_id: str
    billing_account_id: str
    work_order_status: str      # must be "completed" to generate an invoice
    sell_subtotal: float
    tax_total: float
    sell_total: float
    created_by: str = "system"


@dataclass
class MaintenanceInvoiceSummary:
    """Result of generating (or idempotently finding) an invoice from a work order."""
    invoice_id: str
    maintenance_record_id: str
    billing_account_id: str
    status: str                 # "draft" | "existing" | "blocked"
    sell_subtotal: float
    tax_total: float
    sell_total: float
    already_existed: bool = False
    blocked: bool = False
    blocked_reason: str | None = None


@dataclass
class InvoiceRequest:
    contract_id: str
    billing_period_start: str  # ISO-8601 date string
    billing_period_end: str
    line_items: list[dict] = field(default_factory=list)
    customer_id: str | None = None
    billing_account_id: str | None = None
    job_site_id: str | None = None
    contract_status: str = "active"
    billing_holds: list[str] = field(default_factory=list)
    created_by: str = "system"
    transaction_currency_code: str = "USD"
    reporting_currency_code: str = "USD"
    fx_rate_applied: float = 1.0
    fx_rate_effective_at: str | None = None


@dataclass
class InvoiceSummary:
    invoice_id: str
    contract_id: str
    status: str
    subtotal: float
    tax: float
    total: float
    blocked: bool = False
    billing_exceptions: list[dict] = field(default_factory=list)
    customer_id: str | None = None
    billing_account_id: str | None = None
    job_site_id: str | None = None
    transaction_currency_code: str = "USD"
    reporting_currency_code: str = "USD"
    fx_rate_applied: float = 1.0
    fx_rate_effective_at: str | None = None


# ---------------------------------------------------------------------------
# Preventative maintenance trigger models
# ---------------------------------------------------------------------------

class PMTriggerType:
    """Trigger families for preventative-maintenance policies."""

    METER = "meter"
    RENTAL_COUNT = "rental_count"
    TIME_INTERVAL = "time_interval"

    ALL = frozenset({METER, RENTAL_COUNT, TIME_INTERVAL})


@dataclass
class PMPolicyConfig:
    """Resolved (effective) PM policy for a single asset + trigger type.

    Mirrors the ``v_pm_policy_effective`` view columns.  Category-level
    defaults are merged into asset-level rows before this dataclass is
    populated, so consumers always work with asset-scoped values.
    """

    policy_id: str
    asset_id: str
    trigger_type: str          # PMTriggerType value
    threshold: float | None = None    # hours / count threshold (meter, rental_count)
    interval_days: int | None = None  # period in days (time_interval)
    lead_window_days: int = 0            # days / count before due to surface pre_due
    label: str | None = None


@dataclass
class PMEvaluationResult:
    """Outcome of evaluating one PM policy for one asset."""

    policy_id: str
    asset_id: str
    trigger_type: str
    is_due: bool
    is_pre_due: bool
    fingerprint: str       # stable idempotency key for this due event
    reason: str | None = None


@dataclass
class PMEvaluatorInput:
    """Input for the PMEvaluatorWorkflow periodic run."""

    tenant_id: str
    evaluation_timestamp: str | None = None  # ISO-8601; defaults to workflow.now()


@dataclass
class PMEvaluatorSummary:
    """Summary returned by PMEvaluatorWorkflow.run()."""

    tenant_id: str
    total_policies_scoped: int = 0
    due_count: int = 0
    pre_due_count: int = 0
    work_orders_created: int = 0
    work_orders_skipped_duplicate: int = 0
    status: str = "succeeded"
