"""Tests for the BillingUpdateApprovalWorkflow and supporting activities.

Covers:
  - Authorization checks on state transitions
  - Approval and rejection signal handling
  - Timeout / escalation path
  - Audit-record assembly
  - Guard against autonomous application
"""
from __future__ import annotations

import asyncio
import logging
from unittest.mock import MagicMock, patch

import pytest
import temporalio.workflow as tw_mod
from temporal.src.workflows.ops.billing_update import (
    ApproveBillingUpdateSignal,
    BillingUpdateApprovalWorkflow,
    BillingUpdateApprovalWorkflowInput,
    RejectBillingUpdateSignal,
)

# Maximum poll iterations for the simulated approval signal in tests.
_MAX_APPROVAL_WAIT_ITERATIONS = 200


def _mock_workflow_info() -> MagicMock:
    """Return a mock object that satisfies workflow.info().workflow_id."""
    info = MagicMock()
    info.workflow_id = "test-billing-update-workflow"
    return info


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------

def _build_harness(
    *,
    pending_requests: list[dict],
    decisions_to_inject: list[tuple[str, str]] | None = None,
):
    """
    pending_requests  – list of request dicts as returned by
                        ops_load_pending_billing_update_requests
    decisions_to_inject – optional list of (request_id, 'approve'|'reject')
                          pairs whose decisions are pre-loaded before wait_condition
                          is evaluated, simulating fast approval signals.
    """
    state: dict = {
        "marked_under_review": [],
        "decisions": [],
        "applied": [],
    }

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        args = kw.get("args", list(pos_args))
        if fn_name == "ops_load_pending_billing_update_requests":
            return pending_requests
        if fn_name == "ops_mark_billing_update_under_review":
            state["marked_under_review"].append(args[0])
            return True
        if fn_name == "ops_record_billing_update_decision":
            state["decisions"].append(
                {"request_id": args[0], "decision": args[1], "reviewer_id": args[2]}
            )
            return {"request_id": args[0], "status": "approved" if args[1] == "approve" else "rejected"}
        if fn_name == "ops_apply_billing_update":
            state["applied"].append({"request_id": args[0], "applied_by": args[1]})
            return {"request_id": args[0], "applied_at": "2026-01-01T00:00:00Z"}
        raise AssertionError(f"Unexpected activity: {fn_name}")

    async def fake_wait_condition(cond_fn, *, timeout=None):
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out waiting for decision signal")

    return state, fake_execute_activity, fake_wait_condition


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_billing_update_workflow_empty_queue_returns_zero_counts():
    """When there are no pending requests the workflow returns a clean summary."""
    state, fake_execute, fake_wait = _build_harness(pending_requests=[])

    wf = BillingUpdateApprovalWorkflow()
    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait),
        patch.object(tw_mod, "info", return_value=_mock_workflow_info()),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        result = await wf.run(BillingUpdateApprovalWorkflowInput(tenant_id="tenant-a"))

    assert result["total_requests"] == 0
    assert result["approved_requests"] == 0
    assert result["rejected_requests"] == 0
    assert result["timed_out_requests"] == 0
    assert result["applied_requests"] == 0
    assert result["auto_apply"] is False
    assert result["status"] == "succeeded"
    assert state["marked_under_review"] == []
    assert state["applied"] == []


@pytest.mark.asyncio
async def test_billing_update_workflow_approve_signal_applies_change():
    """Approve signal transitions request to applied; gated apply activity is called."""
    req_id = "req-0001-0000-0000-0000-000000000001"
    pending = [{"id": req_id, "request_type": "billing_contact", "tenant_id": "tenant-a"}]

    state, fake_execute, _ = _build_harness(pending_requests=pending)
    applied_calls: list[str] = []

    # Custom wait_condition that injects the approve signal before returning
    async def fake_wait_condition_approve(cond_fn, *, timeout=None):
        # Simulate signal delivery by pre-populating the decision dict
        decision_key = f"billing_update:{req_id}"
        wf._decisions[decision_key] = {  # type: ignore[attr-defined]
            "decision": "approve",
            "reviewer": {
                "reviewer_id": "credit.manager@example.com",
                "reviewer_name": "Credit Manager",
                "note": "Verified billing contact change",
            },
        }
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    wf = BillingUpdateApprovalWorkflow()

    async def tracking_execute(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        if fn_name == "ops_apply_billing_update":
            applied_calls.append(kw.get("args", list(pos_args))[0])
        return await fake_execute(fn_or_str, *pos_args, **kw)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=tracking_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_approve),
        patch.object(tw_mod, "info", return_value=_mock_workflow_info()),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        result = await wf.run(BillingUpdateApprovalWorkflowInput(tenant_id="tenant-a"))

    assert result["approved_requests"] == 1
    assert result["rejected_requests"] == 0
    assert result["applied_requests"] == 1
    assert result["timed_out_requests"] == 0
    assert req_id in applied_calls, "ops_apply_billing_update must be called after approval"

    approval_decision = next(d for d in state["decisions"] if d["request_id"] == req_id)
    assert approval_decision["decision"] == "approve"
    assert approval_decision["reviewer_id"] == "credit.manager@example.com"

    # Guard: auto_apply flag must remain False
    assert result["auto_apply"] is False


@pytest.mark.asyncio
async def test_billing_update_workflow_reject_signal_does_not_apply_change():
    """Reject signal records the rejection; ops_apply_billing_update is NOT called."""
    req_id = "req-0002-0000-0000-0000-000000000001"
    pending = [{"id": req_id, "request_type": "payment_detail", "tenant_id": "tenant-a"}]

    state, fake_execute, _ = _build_harness(pending_requests=pending)

    async def fake_wait_condition_reject(cond_fn, *, timeout=None):
        decision_key = f"billing_update:{req_id}"
        wf._decisions[decision_key] = {  # type: ignore[attr-defined]
            "decision": "reject",
            "reviewer": {
                "reviewer_id": "branch.manager@example.com",
                "reviewer_name": "Branch Manager",
                "note": "Insufficient identity verification",
            },
        }
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    wf = BillingUpdateApprovalWorkflow()

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_reject),
        patch.object(tw_mod, "info", return_value=_mock_workflow_info()),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        result = await wf.run(BillingUpdateApprovalWorkflowInput(tenant_id="tenant-a"))

    assert result["rejected_requests"] == 1
    assert result["approved_requests"] == 0
    assert result["applied_requests"] == 0

    # Guard: apply activity must NOT have been called on rejection
    assert state["applied"] == [], "ops_apply_billing_update must not be called on rejection"

    rejection = next(d for d in state["decisions"] if d["request_id"] == req_id)
    assert rejection["decision"] == "reject"


@pytest.mark.asyncio
async def test_billing_update_workflow_timeout_leaves_request_under_review():
    """When no signal arrives the request is left under_review for manual follow-up."""
    req_id = "req-0003-0000-0000-0000-000000000001"
    pending = [{"id": req_id, "request_type": "billing_contact", "tenant_id": "tenant-a"}]

    state, fake_execute, _ = _build_harness(pending_requests=pending)

    # wait_condition always times out — no signal delivered
    async def fake_wait_condition_timeout(cond_fn, *, timeout=None):
        raise TimeoutError("deliberate timeout")

    wf = BillingUpdateApprovalWorkflow()

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_condition_timeout),
        patch.object(tw_mod, "info", return_value=_mock_workflow_info()),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        result = await wf.run(
            BillingUpdateApprovalWorkflowInput(
                tenant_id="tenant-a", approval_timeout_seconds=1
            )
        )

    assert result["timed_out_requests"] == 1
    assert result["approved_requests"] == 0
    assert result["applied_requests"] == 0
    # Under-review transition was still called (before timeout)
    assert req_id in state["marked_under_review"]
    # Apply was never called
    assert state["applied"] == []


@pytest.mark.asyncio
async def test_billing_update_workflow_multiple_requests_mixed_decisions():
    """Multiple requests with mixed approve/reject/timeout outcomes."""
    req_approve = "req-0004-0000-0000-0000-000000000001"
    req_reject  = "req-0004-0000-0000-0000-000000000002"
    pending = [
        {"id": req_approve, "request_type": "billing_contact", "tenant_id": "tenant-a"},
        {"id": req_reject,  "request_type": "payment_detail",  "tenant_id": "tenant-a"},
    ]

    state, fake_execute, _ = _build_harness(pending_requests=pending)

    inject_order: list[str] = []

    async def fake_wait_mixed(cond_fn, *, timeout=None):
        # Inject decisions one at a time as wait_condition is called per request
        if len(inject_order) == 0:
            wf._decisions[f"billing_update:{req_approve}"] = {  # type: ignore[attr-defined]
                "decision": "approve",
                "reviewer": {"reviewer_id": "admin@example.com"},
            }
        elif len(inject_order) == 1:
            wf._decisions[f"billing_update:{req_reject}"] = {  # type: ignore[attr-defined]
                "decision": "reject",
                "reviewer": {"reviewer_id": "admin@example.com", "note": "No matching account"},
            }
        inject_order.append("called")
        for _ in range(_MAX_APPROVAL_WAIT_ITERATIONS):
            if cond_fn():
                return
            await asyncio.sleep(0)
        raise TimeoutError("timed out")

    wf = BillingUpdateApprovalWorkflow()

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_execute),
        patch.object(tw_mod, "wait_condition", side_effect=fake_wait_mixed),
        patch.object(tw_mod, "info", return_value=_mock_workflow_info()),
        patch.object(tw_mod, "logger", logging.getLogger("test")),
    ):
        result = await wf.run(BillingUpdateApprovalWorkflowInput(tenant_id="tenant-a"))

    assert result["total_requests"] == 2
    assert result["approved_requests"] == 1
    assert result["rejected_requests"] == 1
    assert result["applied_requests"] == 1
    assert result["timed_out_requests"] == 0

    applied_ids = [a["request_id"] for a in state["applied"]]
    assert req_approve in applied_ids
    assert req_reject not in applied_ids


# ---------------------------------------------------------------------------
# Activity-level tests (unit – no Temporal runtime needed)
# ---------------------------------------------------------------------------

class TestOpsRecordBillingUpdateDecisionActivity:
    """Unit tests for the ops_record_billing_update_decision activity."""

    def test_raises_on_invalid_decision(self):
        from temporal.src.activities.ops_billing_update import ops_record_billing_update_decision

        with pytest.raises(ValueError, match="decision must be 'approve' or 'reject'"):
            # Invoke the underlying function directly (not via Temporal executor)
            import inspect
            fn = ops_record_billing_update_decision
            # Unwrap @activity.defn to get the original callable
            wrapped = getattr(fn, "__wrapped__", fn)
            if inspect.iscoroutinefunction(wrapped):
                import asyncio
                asyncio.run(wrapped("req-id", "invalidate", "reviewer@example.com"))
            else:
                wrapped("req-id", "invalidate", "reviewer@example.com")

    def test_raises_on_blank_reviewer_id(self):
        from temporal.src.activities.ops_billing_update import ops_record_billing_update_decision

        with pytest.raises(ValueError, match="reviewer_id is required"):
            wrapped = getattr(ops_record_billing_update_decision, "__wrapped__", ops_record_billing_update_decision)
            import inspect
            if inspect.iscoroutinefunction(wrapped):
                asyncio.run(wrapped("req-id", "approve", ""))
            else:
                wrapped("req-id", "approve", "")

    def test_raises_on_blank_request_id(self):
        from temporal.src.activities.ops_billing_update import ops_record_billing_update_decision

        with pytest.raises(ValueError, match="request_id is required"):
            wrapped = getattr(ops_record_billing_update_decision, "__wrapped__", ops_record_billing_update_decision)
            import inspect
            if inspect.iscoroutinefunction(wrapped):
                asyncio.run(wrapped("", "approve", "reviewer@example.com"))
            else:
                wrapped("", "approve", "reviewer@example.com")


class TestOpsApplyBillingUpdateActivity:
    """Guard: ops_apply_billing_update refuses to apply non-approved requests."""

    def test_raises_if_not_approved(self):
        from unittest.mock import MagicMock
        from unittest.mock import patch as mpatch

        from temporal.src.activities.ops_billing_update import ops_apply_billing_update

        mock_client = MagicMock()
        mock_client.select.return_value = [{"id": "req-1", "status": "rejected"}]

        with mpatch(
            "temporal.src.activities.ops_billing_update.ops_revrec._get_ops_persistence_client",
            return_value=mock_client,
        ):
            wrapped = getattr(ops_apply_billing_update, "__wrapped__", ops_apply_billing_update)
            import inspect
            with pytest.raises(ValueError, match="must be approved"):
                if inspect.iscoroutinefunction(wrapped):
                    asyncio.run(wrapped("req-1", "admin@example.com"))
                else:
                    wrapped("req-1", "admin@example.com")

    def test_raises_on_blank_applied_by(self):
        from temporal.src.activities.ops_billing_update import ops_apply_billing_update

        with pytest.raises(ValueError, match="applied_by is required"):
            wrapped = getattr(ops_apply_billing_update, "__wrapped__", ops_apply_billing_update)
            import inspect
            if inspect.iscoroutinefunction(wrapped):
                asyncio.run(wrapped("req-1", ""))
            else:
                wrapped("req-1", "")


class TestOpsBillingUpdateAuditAssembly:
    """Tests for audit-log assembly in decision and apply activities."""

    def _build_mock_client(self, initial_status: str, initial_log: list | None = None):
        from unittest.mock import MagicMock
        mock_client = MagicMock()
        mock_client.select.return_value = [{
            "id": "req-audit-1",
            "status": initial_status,
            "audit_log": initial_log or [{"event": "submitted", "ts": "2026-01-01T00:00:00Z"}],
            "billing_account_id": "ba-001",
            "request_type": "billing_contact",
        }]
        updated_rows: list[dict] = []
        mock_client.update.side_effect = lambda table, data, **kw: updated_rows.append(dict(data))
        return mock_client, updated_rows

    def test_decision_appends_audit_entry(self):
        from unittest.mock import patch as mpatch

        from temporal.src.activities.ops_billing_update import ops_record_billing_update_decision

        mock_client, updated = self._build_mock_client("under_review")

        with mpatch(
            "temporal.src.activities.ops_billing_update.ops_revrec._get_ops_persistence_client",
            return_value=mock_client,
        ):
            wrapped = getattr(ops_record_billing_update_decision, "__wrapped__", ops_record_billing_update_decision)
            import inspect
            if inspect.iscoroutinefunction(wrapped):
                asyncio.run(wrapped("req-audit-1", "approve", "reviewer@example.com", "Reviewer Name", "LGTM"))
            else:
                wrapped("req-audit-1", "approve", "reviewer@example.com", "Reviewer Name", "LGTM")

        assert len(updated) == 1
        audit_log = updated[0]["audit_log"]
        assert len(audit_log) == 2
        last_entry = audit_log[-1]
        assert last_entry["event"] == "approved"
        assert last_entry["reviewer_id"] == "reviewer@example.com"
        assert last_entry["note"] == "LGTM"

    def test_apply_appends_applied_audit_entry(self):
        from unittest.mock import patch as mpatch

        from temporal.src.activities.ops_billing_update import ops_apply_billing_update

        mock_client, updated = self._build_mock_client(
            "approved",
            [{"event": "submitted"}, {"event": "approved"}],
        )

        with mpatch(
            "temporal.src.activities.ops_billing_update.ops_revrec._get_ops_persistence_client",
            return_value=mock_client,
        ):
            wrapped = getattr(ops_apply_billing_update, "__wrapped__", ops_apply_billing_update)
            import inspect
            if inspect.iscoroutinefunction(wrapped):
                asyncio.run(wrapped("req-audit-1", "admin@example.com"))
            else:
                wrapped("req-audit-1", "admin@example.com")

        assert len(updated) == 1
        audit_log = updated[0]["audit_log"]
        assert len(audit_log) == 3
        last_entry = audit_log[-1]
        assert last_entry["event"] == "applied"
        assert last_entry["applied_by"] == "admin@example.com"
        assert updated[0]["status"] == "applied"


# ---------------------------------------------------------------------------
# Signal dataclass tests
# ---------------------------------------------------------------------------

def test_approve_billing_update_signal_required_fields():
    sig = ApproveBillingUpdateSignal(
        request_id="req-sig-1",
        reviewer_id="reviewer@example.com",
    )
    assert sig.request_id == "req-sig-1"
    assert sig.reviewer_id == "reviewer@example.com"
    assert sig.reviewer_name is None
    assert sig.note is None


def test_reject_billing_update_signal_required_fields():
    sig = RejectBillingUpdateSignal(
        request_id="req-sig-2",
        reviewer_id="reviewer@example.com",
        note="Rejected: insufficient details",
    )
    assert sig.request_id == "req-sig-2"
    assert sig.note == "Rejected: insufficient details"


def test_workflow_input_defaults():
    inp = BillingUpdateApprovalWorkflowInput(tenant_id="tenant-x")
    assert inp.tenant_id == "tenant-x"
    assert inp.approval_timeout_seconds == 300
