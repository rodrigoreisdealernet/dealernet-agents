"""Temporal activities for the billing-contact and payment update approval flow.

All writes to billing_update_request are gated behind human approval.  No
payment-method or billing-contact change is applied autonomously — only the
status transition to 'applied' is recorded here after an explicit approval
decision.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from temporalio import activity

from . import ops_revrec

_BILLING_UPDATE_REQUESTER = "billing-update-workflow"
_BILLING_UPDATE_OPERATING_MODEL_TAGS = [
    "rental-customer-portal-user:t5",
    "rental-customer-portal-user:t7",
]


@activity.defn
def ops_load_pending_billing_update_requests(tenant_id: str) -> list[dict[str, Any]]:
    """Return all pending/under_review billing update requests for the tenant."""
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    if not tenant_id:
        raise ValueError("tenant_id is required to load billing update requests")
    rows = client.select(
        "billing_update_request",
        filters={"tenant_id": tenant_id, "status": "pending"},
        limit=200,
    )
    return [dict(r) for r in (rows or [])]


@activity.defn
def ops_mark_billing_update_under_review(
    request_id: str,
    run_id: str,
) -> bool:
    """Transition a pending request to under_review and stamp the audit log."""
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    if not request_id:
        raise ValueError("request_id is required")
    audit_entry = {
        "event": "under_review",
        "ts": datetime.now(UTC).isoformat(),
        "run_id": run_id,
        "requester": _BILLING_UPDATE_REQUESTER,
        "operating_model_tags": _BILLING_UPDATE_OPERATING_MODEL_TAGS,
    }
    rows = client.select(
        "billing_update_request",
        filters={"id": request_id, "status": "pending"},
        limit=1,
    )
    if not rows:
        return False
    existing_log = list(rows[0].get("audit_log") or [])
    existing_log.append(audit_entry)
    client.update(
        "billing_update_request",
        {"status": "under_review", "audit_log": existing_log},
        filters={"id": request_id},
    )
    return True


@activity.defn
def ops_record_billing_update_decision(
    request_id: str,
    decision: str,
    reviewer_id: str,
    reviewer_name: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Persist an approve or reject decision with reviewer identity.

    Nothing is auto-applied — the 'approved' status flags the request for a
    subsequent gated ops_apply_billing_update call.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    if not request_id:
        raise ValueError("request_id is required")
    if decision not in ("approve", "reject"):
        raise ValueError(f"decision must be 'approve' or 'reject', got {decision!r}")
    if not reviewer_id:
        raise ValueError("reviewer_id is required")

    rows = client.select(
        "billing_update_request",
        filters={"id": request_id},
        limit=1,
    )
    if not rows:
        raise ValueError(f"billing_update_request not found: {request_id}")
    row = rows[0]
    current_status = str(row.get("status") or "")
    if current_status not in ("pending", "under_review"):
        raise ValueError(
            f"Request {request_id} is not reviewable (status={current_status})"
        )

    _DECISION_EVENT: dict[str, str] = {"approve": "approved", "reject": "rejected"}
    new_status = "approved" if decision == "approve" else "rejected"
    reviewed_at = datetime.now(UTC).isoformat()
    audit_entry = {
        "event": _DECISION_EVENT.get(decision, decision),
        "ts": reviewed_at,
        "reviewer_id": reviewer_id,
        "reviewer_name": reviewer_name,
        "note": note,
    }
    existing_log = list(row.get("audit_log") or [])
    existing_log.append(audit_entry)
    client.update(
        "billing_update_request",
        {
            "status": new_status,
            "reviewed_at": reviewed_at,
            "reviewed_by": reviewer_id,
            "review_note": note,
            "audit_log": existing_log,
        },
        filters={"id": request_id},
    )
    return {
        "request_id": request_id,
        "status": new_status,
        "reviewed_at": reviewed_at,
        "reviewer_id": reviewer_id,
    }


@activity.defn
def ops_apply_billing_update(
    request_id: str,
    applied_by: str,
) -> dict[str, Any]:
    """Gated write: transition an approved billing update request to 'applied'.

    Nothing is autonomously applied to the billing contact or payment records.
    The 'applied' status marks that a human has confirmed the change was made,
    or that a downstream billing process has consumed the requested_fields.
    """
    client = ops_revrec._get_ops_persistence_client()  # noqa: SLF001
    if not request_id:
        raise ValueError("request_id is required")
    if not applied_by:
        raise ValueError("applied_by is required")

    rows = client.select(
        "billing_update_request",
        filters={"id": request_id},
        limit=1,
    )
    if not rows:
        raise ValueError(f"billing_update_request not found: {request_id}")
    row = rows[0]
    current_status = str(row.get("status") or "")
    if current_status != "approved":
        raise ValueError(
            f"Request {request_id} must be approved before applying "
            f"(status={current_status})"
        )

    applied_at = datetime.now(UTC).isoformat()
    audit_entry = {
        "event": "applied",
        "ts": applied_at,
        "applied_by": applied_by,
        "requester": _BILLING_UPDATE_REQUESTER,
    }
    existing_log = list(row.get("audit_log") or [])
    existing_log.append(audit_entry)
    client.update(
        "billing_update_request",
        {
            "status": "applied",
            "applied_at": applied_at,
            "applied_by": applied_by,
            "audit_log": existing_log,
        },
        filters={"id": request_id},
    )
    return {
        "request_id": request_id,
        "billing_account_id": str(row.get("billing_account_id") or ""),
        "request_type": str(row.get("request_type") or ""),
        "applied_at": applied_at,
        "applied_by": applied_by,
    }


__all__ = [
    "ops_apply_billing_update",
    "ops_load_pending_billing_update_requests",
    "ops_mark_billing_update_under_review",
    "ops_record_billing_update_decision",
]
