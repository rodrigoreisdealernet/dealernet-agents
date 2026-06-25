"""Accounting posting activities for auto-ledger entries.

Produces deterministic, idempotent journal entries (accrual and cash basis) from
source financial events: invoice issued/void, payment applied/refund, fee/credit.

All write operations use the ``post_journal_entry`` Supabase RPC which enforces
uniqueness on (source_event_id, posting_basis) to prevent duplicate postings on
Temporal retries.

GL account codes used by default posting rules
(override per tenant via accounting_posting_rules table):

  1100 – Accounts Receivable
  4000 – Rental Revenue
  4100 – Fee Revenue
  2200 – Tax Payable
  1000 – Cash / Bank
  2300 – Deferred Revenue  (cash-basis holding account)
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any

from temporalio import activity

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Default GL account codes (can be overridden per tenant)
# ---------------------------------------------------------------------------

_AR          = ("1100", "Accounts Receivable")
_REVENUE     = ("4000", "Rental Revenue")
_FEE_REVENUE = ("4100", "Fee Revenue")
_TAX_PAYABLE = ("2200", "Tax Payable")
_CASH        = ("1000", "Cash / Bank")
_DEFERRED    = ("2300", "Deferred Revenue")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _idempotent_event_id(seed: str) -> str:
    """Deterministic UUIDv5 from *seed* — stable across retries."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, seed))


def _lines_for_invoice_issued_accrual(
    subtotal: float,
    tax: float,
    currency: str,
) -> list[dict[str, Any]]:
    """Accrual: recognise revenue and tax liability on invoice issue."""
    total = round(subtotal + tax, 4)
    lines: list[dict[str, Any]] = [
        {
            "sequence": 1,
            "side": "debit",
            "account_code": _AR[0],
            "account_name": _AR[1],
            "amount": total,
            "description": "Invoice issued — AR debit",
        },
    ]
    if tax and tax > 0:
        lines += [
            {
                "sequence": 2,
                "side": "credit",
                "account_code": _REVENUE[0],
                "account_name": _REVENUE[1],
                "amount": round(subtotal, 4),
                "description": "Invoice issued — Revenue credit",
            },
            {
                "sequence": 3,
                "side": "credit",
                "account_code": _TAX_PAYABLE[0],
                "account_name": _TAX_PAYABLE[1],
                "amount": round(tax, 4),
                "description": "Invoice issued — Tax Payable credit",
            },
        ]
    else:
        lines.append(
            {
                "sequence": 2,
                "side": "credit",
                "account_code": _REVENUE[0],
                "account_name": _REVENUE[1],
                "amount": total,
                "description": "Invoice issued — Revenue credit",
            }
        )
    return lines


def _lines_for_invoice_issued_cash(
    subtotal: float,
    tax: float,
    currency: str,
) -> list[dict[str, Any]]:
    """Cash basis: invoice issue moves to deferred revenue (not yet recognised)."""
    total = round(subtotal + tax, 4)
    return [
        {
            "sequence": 1,
            "side": "debit",
            "account_code": _AR[0],
            "account_name": _AR[1],
            "amount": total,
            "description": "Invoice issued (cash) — AR debit",
        },
        {
            "sequence": 2,
            "side": "credit",
            "account_code": _DEFERRED[0],
            "account_name": _DEFERRED[1],
            "amount": total,
            "description": "Invoice issued (cash) — Deferred Revenue credit",
        },
    ]


def _lines_for_payment_applied_accrual(
    amount: float,
    currency: str,
) -> list[dict[str, Any]]:
    """Accrual: payment clears AR and posts to cash."""
    return [
        {
            "sequence": 1,
            "side": "debit",
            "account_code": _CASH[0],
            "account_name": _CASH[1],
            "amount": round(amount, 4),
            "description": "Payment applied — Cash debit",
        },
        {
            "sequence": 2,
            "side": "credit",
            "account_code": _AR[0],
            "account_name": _AR[1],
            "amount": round(amount, 4),
            "description": "Payment applied — AR credit",
        },
    ]


def _lines_for_payment_applied_cash(
    amount: float,
    subtotal: float,
    tax: float,
    currency: str,
) -> list[dict[str, Any]]:
    """Cash basis: recognise revenue (and tax) in proportion to the cash actually
    received — never the full invoice.

    Booked against the Deferred Revenue parked at invoice-issue time:

      DR Cash             (amount)      cash received
      CR Accounts Recv.   (amount)      clear the receivable for cash received
      DR Deferred Revenue (recognised)  release the now-earned portion
      CR Revenue          (rev_portion) recognised revenue
      CR Tax Payable      (tax_portion) recognised tax            [only if tax > 0]

    ``recognised`` is the cash received, capped at the invoice total so an
    overpayment never recognises more revenue than was invoiced, split between
    revenue and tax in the invoice's ratio. Every branch is internally balanced
    (DB CHECK enforces total_debit = total_credit), and revenue now tracks cash
    collected rather than the whole invoice — the prior version recognised the
    full invoice on any partial payment.
    """
    amount = round(amount, 4)
    total = round((subtotal or 0.0) + (tax or 0.0), 4)
    # Cash that is recognisable now — never more than the invoice total.
    recognised = round(min(amount, total), 4) if total > 0 else amount
    if total > 0 and tax and tax > 0:
        tax_portion = round(recognised * (tax / total), 4)
        rev_portion = round(recognised - tax_portion, 4)  # remainder keeps it balanced
    else:
        tax_portion = 0.0
        rev_portion = recognised

    lines: list[dict[str, Any]] = [
        {
            "sequence": 1,
            "side": "debit",
            "account_code": _CASH[0],
            "account_name": _CASH[1],
            "amount": amount,
            "description": "Payment applied (cash) — Cash debit",
        },
        {
            "sequence": 2,
            "side": "credit",
            "account_code": _AR[0],
            "account_name": _AR[1],
            "amount": amount,
            "description": "Payment applied (cash) — AR cleared",
        },
        {
            "sequence": 3,
            "side": "debit",
            "account_code": _DEFERRED[0],
            "account_name": _DEFERRED[1],
            "amount": recognised,
            "description": "Payment applied (cash) — Deferred Revenue released",
        },
        {
            "sequence": 4,
            "side": "credit",
            "account_code": _REVENUE[0],
            "account_name": _REVENUE[1],
            "amount": rev_portion,
            "description": "Payment applied (cash) — Revenue recognised",
        },
    ]
    if tax_portion > 0:
        lines.append(
            {
                "sequence": 5,
                "side": "credit",
                "account_code": _TAX_PAYABLE[0],
                "account_name": _TAX_PAYABLE[1],
                "amount": tax_portion,
                "description": "Payment applied (cash) — Tax Payable recognised",
            }
        )
    return lines


def _lines_for_fee_charged(
    amount: float,
    currency: str,
) -> list[dict[str, Any]]:
    """Fee charged: DR AR / CR Fee Revenue (same for accrual and cash)."""
    return [
        {
            "sequence": 1,
            "side": "debit",
            "account_code": _AR[0],
            "account_name": _AR[1],
            "amount": round(amount, 4),
            "description": "Fee charged — AR debit",
        },
        {
            "sequence": 2,
            "side": "credit",
            "account_code": _FEE_REVENUE[0],
            "account_name": _FEE_REVENUE[1],
            "amount": round(amount, 4),
            "description": "Fee charged — Fee Revenue credit",
        },
    ]


def _reversed_lines(
    original_lines: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Swap debit/credit on each line to produce compensating reversal lines."""
    return [
        {
            **line,
            "side": "credit" if line["side"] == "debit" else "debit",
            "description": f"Reversal — {line.get('description', '')}",
        }
        for line in original_lines
    ]


# ---------------------------------------------------------------------------
# Dataclasses for activity input / output
# ---------------------------------------------------------------------------

@dataclass
class PostingRequest:
    """Common fields for every posting activity."""
    tenant_id: str
    source_event_id: str
    source_event_type: str
    source_record_id: str | None
    posting_date: str            # ISO date string YYYY-MM-DD
    currency_code: str
    posting_basis: str           # 'accrual' or 'cash'
    branch_id: str | None = None
    actor_id: str | None = None
    actor_type: str = "workflow"
    audit_metadata: dict[str, Any] | None = None


@dataclass
class InvoicePostingRequest(PostingRequest):
    subtotal: float = 0.0
    tax: float = 0.0


@dataclass
class PaymentPostingRequest(PostingRequest):
    amount: float = 0.0
    # subtotal / tax only needed for cash-basis revenue recognition
    subtotal: float | None = None
    tax: float | None = None


@dataclass
class FeePostingRequest(PostingRequest):
    amount: float = 0.0


@dataclass
class ReversalRequest:
    tenant_id: str
    original_source_event_id: str
    posting_basis: str
    reversal_source_event_id: str
    posting_date: str
    actor_id: str | None = None
    actor_type: str = "workflow"
    audit_metadata: dict[str, Any] | None = None


@dataclass
class PostingResult:
    journal_entry_id: str
    source_event_id: str
    posting_basis: str
    is_duplicate: bool = False


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------

@activity.defn
def post_invoice_issued(req: InvoicePostingRequest) -> PostingResult:
    """Create accrual or cash-basis journal entry for an issued invoice."""
    if req.posting_basis == "accrual":
        lines = _lines_for_invoice_issued_accrual(req.subtotal, req.tax, req.currency_code)
    else:
        lines = _lines_for_invoice_issued_cash(req.subtotal, req.tax, req.currency_code)

    logger.info(
        "post_invoice_issued",
        extra={
            "source_event_id": req.source_event_id,
            "posting_basis": req.posting_basis,
            "subtotal": req.subtotal,
            "tax": req.tax,
        },
    )
    return _call_post_journal_entry(req, "invoice_issued", lines)


@activity.defn
def post_invoice_void(req: InvoicePostingRequest) -> PostingResult:
    """Create reversing journal entry for a voided invoice."""
    if req.posting_basis == "accrual":
        original_lines = _lines_for_invoice_issued_accrual(
            req.subtotal, req.tax, req.currency_code
        )
    else:
        original_lines = _lines_for_invoice_issued_cash(
            req.subtotal, req.tax, req.currency_code
        )
    lines = _reversed_lines(original_lines)

    logger.info(
        "post_invoice_void",
        extra={
            "source_event_id": req.source_event_id,
            "posting_basis": req.posting_basis,
        },
    )
    return _call_post_journal_entry(req, "invoice_void", lines, is_reversal=True)


@activity.defn
def post_payment_applied(req: PaymentPostingRequest) -> PostingResult:
    """Create journal entry for a payment applied against an invoice."""
    if req.posting_basis == "accrual":
        lines = _lines_for_payment_applied_accrual(req.amount, req.currency_code)
    else:
        lines = _lines_for_payment_applied_cash(
            req.amount,
            req.subtotal or 0.0,
            req.tax or 0.0,
            req.currency_code,
        )

    logger.info(
        "post_payment_applied",
        extra={
            "source_event_id": req.source_event_id,
            "posting_basis": req.posting_basis,
            "amount": req.amount,
        },
    )
    return _call_post_journal_entry(req, "payment_applied", lines)


@activity.defn
def post_payment_refund(req: PaymentPostingRequest) -> PostingResult:
    """Create reversing journal entry for a payment refund."""
    if req.posting_basis == "accrual":
        original_lines = _lines_for_payment_applied_accrual(req.amount, req.currency_code)
    else:
        original_lines = _lines_for_payment_applied_cash(
            req.amount,
            req.subtotal or 0.0,
            req.tax or 0.0,
            req.currency_code,
        )
    lines = _reversed_lines(original_lines)

    logger.info(
        "post_payment_refund",
        extra={
            "source_event_id": req.source_event_id,
            "posting_basis": req.posting_basis,
            "amount": req.amount,
        },
    )
    return _call_post_journal_entry(req, "payment_refund", lines, is_reversal=True)


@activity.defn
def post_fee_charged(req: FeePostingRequest) -> PostingResult:
    """Create journal entry for a fee charged (accrual and cash treated equally)."""
    lines = _lines_for_fee_charged(req.amount, req.currency_code)

    logger.info(
        "post_fee_charged",
        extra={
            "source_event_id": req.source_event_id,
            "posting_basis": req.posting_basis,
            "amount": req.amount,
        },
    )
    return _call_post_journal_entry(req, "fee_charged", lines)


@activity.defn
def post_credit_applied(req: FeePostingRequest) -> PostingResult:
    """Create journal entry for a credit applied against an account."""
    # Credit: DR Revenue / CR AR (reduces AR and reverses earned revenue)
    lines = _reversed_lines(_lines_for_fee_charged(req.amount, req.currency_code))
    # Override account names for credit context
    for line in lines:
        if line["account_code"] == _AR[0]:
            line["description"] = "Credit applied — AR credit"
        elif line["account_code"] == _FEE_REVENUE[0]:
            line["description"] = "Credit applied — Fee Revenue reversal"

    logger.info(
        "post_credit_applied",
        extra={
            "source_event_id": req.source_event_id,
            "posting_basis": req.posting_basis,
            "amount": req.amount,
        },
    )
    return _call_post_journal_entry(req, "credit_applied", lines, is_reversal=True)


@activity.defn
def post_reversal_entry(req: ReversalRequest) -> PostingResult:
    """Fetch lines from the original entry and post a compensating reversal.

    This activity is used when the caller has the original entry's event id
    but not the original amounts (e.g., a generic void/cancel signal).
    The original entry lines are fetched from the DB and swapped debit/credit.
    Returns a stub result when the original entry cannot be found (idempotent).
    """
    from . import rental_operations as _ro  # lazy import: shared client, avoids cycle

    logger.info(
        "post_reversal_entry",
        extra={
            "original_source_event_id": req.original_source_event_id,
            "reversal_source_event_id": req.reversal_source_event_id,
            "posting_basis": req.posting_basis,
        },
    )
    client = _ro._get_rental_operations_persistence_client()
    originals = client.select(
        "journal_entries",
        columns="id,tenant_id,branch_id,currency_code",
        filters={
            "source_event_id": req.original_source_event_id,
            "posting_basis": req.posting_basis,
        },
        limit=1,
    )
    if not originals:
        raise ValueError(
            "post_reversal_entry: no original entry for "
            f"{req.original_source_event_id}/{req.posting_basis}"
        )
    original = originals[0]
    original_id = str(original["id"])

    original_lines = client.select(
        "journal_entry_lines",
        columns="line_sequence,side,account_code,account_name,amount,description",
        filters={"journal_entry_id": original_id},
        order_by="line_sequence",
    )
    reversed_lines = [
        {
            "sequence": ln["line_sequence"],
            "side": "credit" if ln["side"] == "debit" else "debit",
            "account_code": ln["account_code"],
            "account_name": ln["account_name"],
            "amount": float(ln["amount"]),
            "description": f"Reversal — {ln.get('description', '')}",
        }
        for ln in original_lines
    ]

    posting_req = PostingRequest(
        tenant_id=req.tenant_id,
        source_event_id=req.reversal_source_event_id,
        source_event_type="reversal",
        source_record_id=None,
        posting_date=req.posting_date,
        currency_code=original.get("currency_code") or "USD",
        posting_basis=req.posting_basis,
        branch_id=original.get("branch_id"),
        actor_id=req.actor_id,
        actor_type=req.actor_type,
        audit_metadata=req.audit_metadata,
    )
    return _call_post_journal_entry(
        posting_req,
        "reversal",
        reversed_lines,
        is_reversal=True,
        reverses_entry_id=original_id,
    )


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _call_post_journal_entry(
    req: PostingRequest,
    event_type: str,
    lines: list[dict[str, Any]],
    *,
    is_reversal: bool = False,
    reverses_entry_id: str | None = None,
) -> PostingResult:
    """Post the journal entry via the ``post_journal_entry`` Supabase RPC.

    The RPC enforces idempotency on (source_event_id, posting_basis): a repeat
    call returns the existing entry id with ``r_is_duplicate = true`` instead of
    inserting again, so Temporal retries (and concurrent fire) are safe. The
    service-role PostgREST client is shared with the other activity modules.
    """
    from . import rental_operations as _ro  # lazy import: shared client, avoids cycle

    client = _ro._get_rental_operations_persistence_client()
    payload = {
        "p_tenant_id":         req.tenant_id,
        "p_branch_id":         req.branch_id,
        "p_source_event_id":   req.source_event_id,
        "p_source_event_type": event_type,
        "p_source_record_id":  req.source_record_id,
        "p_posting_basis":     req.posting_basis,
        "p_posting_date":      req.posting_date,
        "p_currency_code":     req.currency_code,
        "p_lines":             lines,
        "p_is_reversal":       is_reversal,
        "p_reverses_entry_id": reverses_entry_id,
        "p_actor_id":          req.actor_id,
        "p_actor_type":        req.actor_type,
        "p_audit_metadata":    req.audit_metadata or {},
    }
    rows = client.rpc("post_journal_entry", payload)
    if not rows:
        raise RuntimeError(
            "post_journal_entry returned no row for "
            f"{req.source_event_id}/{req.posting_basis}"
        )
    row = rows[0]
    entry_id = str(row["r_journal_entry_id"])
    is_duplicate = bool(row.get("r_is_duplicate", False))
    logger.info(
        "_call_post_journal_entry",
        extra={
            "journal_entry_id": entry_id,
            "source_event_id": req.source_event_id,
            "event_type": event_type,
            "posting_basis": req.posting_basis,
            "is_reversal": is_reversal,
            "is_duplicate": is_duplicate,
            "line_count": len(lines),
        },
    )
    return PostingResult(
        journal_entry_id=entry_id,
        source_event_id=req.source_event_id,
        posting_basis=req.posting_basis,
        is_duplicate=is_duplicate,
    )
