"""Tests for accounting posting activities and workflow.

Coverage:
- Invoice issued (accrual + cash): balanced entries, correct accounts
- Invoice void (accrual + cash): reversed lines, balanced entries
- Payment applied (accrual + cash): correct accounts, balanced
- Payment refund (accrual + cash): reversed lines, balanced
- Fee charged: DR AR / CR Fee Revenue, both bases
- Credit applied: reversed fee lines, both bases
- Idempotency: repeated calls return same journal_entry_id
- Reversal activity: produces non-empty result with correct basis
- Workflow: all event types route to correct activity; dict output contains results list

Workflow tests mock temporalio.workflow.execute_activity so no Temporal test
server download is required (following the pattern in test_rental_workflows.py).
"""
from __future__ import annotations

import contextlib
import uuid as _uuid

import pytest
from temporal.src.activities import accounting as acct
from temporal.src.activities import rental_operations as _ro
from temporal.src.workflows.accounting import AccountingPostingWorkflow
from temporalio.testing import ActivityEnvironment

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def env() -> ActivityEnvironment:
    return ActivityEnvironment()


class _FakeAcctClient:
    """In-memory PostgREST double mirroring the post_journal_entry RPC.

    Enforces the same idempotency key (source_event_id, posting_basis) and the
    same balanced-entry invariant the DB CHECK constraint enforces, so activity
    tests actually exercise the posting path rather than a no-op stub.
    """

    def __init__(self) -> None:
        self.journal_entries: list[dict] = []
        self.journal_entry_lines: list[dict] = []
        self.rpc_calls: list[tuple[str, dict]] = []

    def select(self, resource, *, columns="*", filters=None, order_by=None,
               descending=False, limit=None):
        rows = list(getattr(self, resource, []))
        for key, value in (filters or {}).items():
            rows = [r for r in rows if str(r.get(key)) == str(value)]
        if order_by:
            rows = sorted(rows, key=lambda r: r.get(order_by), reverse=descending)
        if limit is not None:
            rows = rows[:limit]
        return [dict(r) for r in rows]

    def rpc(self, function_name, payload):
        assert function_name == "post_journal_entry", function_name
        self.rpc_calls.append((function_name, dict(payload)))
        key = (payload["p_source_event_id"], payload["p_posting_basis"])
        for entry in self.journal_entries:
            if (entry["source_event_id"], entry["posting_basis"]) == key:
                return [{"r_journal_entry_id": entry["id"], "r_is_duplicate": True}]
        lines = payload["p_lines"]
        debit = round(sum(float(ln["amount"]) for ln in lines if ln["side"] == "debit"), 4)
        credit = round(sum(float(ln["amount"]) for ln in lines if ln["side"] == "credit"), 4)
        assert debit == credit, f"post_journal_entry: unbalanced ({debit} != {credit})"
        entry_id = str(_uuid.uuid4())
        self.journal_entries.append({
            "id": entry_id,
            "tenant_id": payload["p_tenant_id"],
            "branch_id": payload["p_branch_id"],
            "currency_code": payload["p_currency_code"],
            "source_event_id": payload["p_source_event_id"],
            "posting_basis": payload["p_posting_basis"],
            "total_debit": debit,
            "total_credit": credit,
        })
        for ln in lines:
            self.journal_entry_lines.append({
                "journal_entry_id": entry_id,
                "line_sequence": ln["sequence"],
                "side": ln["side"],
                "account_code": ln["account_code"],
                "account_name": ln["account_name"],
                "amount": float(ln["amount"]),
                "description": ln.get("description", ""),
            })
        return [{"r_journal_entry_id": entry_id, "r_is_duplicate": False}]

    def seed_entry(self, source_event_id, posting_basis, lines, *, entry_id=None):
        """Directly seed a posted entry + lines (for reversal tests)."""
        entry_id = entry_id or str(_uuid.uuid4())
        self.journal_entries.append({
            "id": entry_id, "tenant_id": "tenant-a", "branch_id": None,
            "currency_code": "USD", "source_event_id": source_event_id,
            "posting_basis": posting_basis, "total_debit": 0, "total_credit": 0,
        })
        for ln in lines:
            self.journal_entry_lines.append({"journal_entry_id": entry_id, **ln})
        return entry_id


@pytest.fixture(autouse=True)
def fake_acct_client(monkeypatch) -> _FakeAcctClient:
    """Route the accounting activities' shared PostgREST client to an in-memory
    double for every test (workflow tests that patch execute_activity ignore it)."""
    client = _FakeAcctClient()
    monkeypatch.setattr(
        _ro, "_get_rental_operations_persistence_client", lambda: client
    )
    return client


# ---------------------------------------------------------------------------
# Balance helper
# ---------------------------------------------------------------------------

def _balance(lines: list[dict]) -> tuple[float, float]:
    """Return (total_debit, total_credit) from a lines list."""
    debit  = sum(ln["amount"] for ln in lines if ln["side"] == "debit")
    credit = sum(ln["amount"] for ln in lines if ln["side"] == "credit")
    return round(debit, 4), round(credit, 4)


# ---------------------------------------------------------------------------
# Line-generation unit tests (pure Python, no Temporal)
# ---------------------------------------------------------------------------

class TestInvoiceIssuedLines:
    def test_accrual_balanced_with_tax(self):
        lines = acct._lines_for_invoice_issued_accrual(100.0, 8.0, "USD")
        d, c = _balance(lines)
        assert d == c == 108.0

    def test_accrual_ar_is_total(self):
        lines = acct._lines_for_invoice_issued_accrual(100.0, 8.0, "USD")
        ar = next(ln for ln in lines if ln["account_code"] == acct._AR[0] and ln["side"] == "debit")
        assert ar["amount"] == 108.0

    def test_accrual_revenue_and_tax_credits(self):
        lines = acct._lines_for_invoice_issued_accrual(100.0, 8.0, "USD")
        rev   = [ln for ln in lines if ln["account_code"] == acct._REVENUE[0] and ln["side"] == "credit"]
        tax   = [ln for ln in lines if ln["account_code"] == acct._TAX_PAYABLE[0] and ln["side"] == "credit"]
        assert len(rev) == 1 and rev[0]["amount"] == 100.0
        assert len(tax) == 1 and tax[0]["amount"] == 8.0

    def test_accrual_no_tax_uses_single_revenue_line(self):
        lines = acct._lines_for_invoice_issued_accrual(200.0, 0.0, "USD")
        d, c = _balance(lines)
        assert d == c == 200.0
        tax_lines = [ln for ln in lines if ln["account_code"] == acct._TAX_PAYABLE[0]]
        assert not tax_lines

    def test_cash_balanced(self):
        lines = acct._lines_for_invoice_issued_cash(100.0, 8.0, "USD")
        d, c = _balance(lines)
        assert d == c == 108.0

    def test_cash_uses_deferred_account(self):
        lines = acct._lines_for_invoice_issued_cash(100.0, 8.0, "USD")
        deferred = [ln for ln in lines if ln["account_code"] == acct._DEFERRED[0]]
        assert len(deferred) == 1 and deferred[0]["side"] == "credit"

    def test_cash_no_revenue_account(self):
        lines = acct._lines_for_invoice_issued_cash(100.0, 8.0, "USD")
        rev_lines = [ln for ln in lines if ln["account_code"] == acct._REVENUE[0]]
        assert not rev_lines


class TestPaymentAppliedLines:
    def test_accrual_balanced(self):
        lines = acct._lines_for_payment_applied_accrual(100.0, "USD")
        d, c = _balance(lines)
        assert d == c == 100.0

    def test_accrual_cash_debit_ar_credit(self):
        lines = acct._lines_for_payment_applied_accrual(100.0, "USD")
        cash = next(ln for ln in lines if ln["account_code"] == acct._CASH[0])
        ar   = next(ln for ln in lines if ln["account_code"] == acct._AR[0])
        assert cash["side"] == "debit"
        assert ar["side"] == "credit"

    def test_cash_balanced_with_tax(self):
        lines = acct._lines_for_payment_applied_cash(108.0, 100.0, 8.0, "USD")
        d, c = _balance(lines)
        assert d == c

    def test_cash_revenue_recognised(self):
        lines = acct._lines_for_payment_applied_cash(108.0, 100.0, 8.0, "USD")
        rev = [ln for ln in lines if ln["account_code"] == acct._REVENUE[0] and ln["side"] == "credit"]
        assert rev and rev[0]["amount"] == 100.0

    def test_cash_partial_payment_recognises_proportionally(self):
        # $50 cash against a $108 invoice (subtotal 100 + tax 8) must recognise
        # revenue+tax of only the $50 received — not the full $108 invoice.
        lines = acct._lines_for_payment_applied_cash(50.0, 100.0, 8.0, "USD")
        d, c = _balance(lines)
        assert d == c, "partial cash payment entry must balance"
        rev = next(ln for ln in lines if ln["account_code"] == acct._REVENUE[0])
        tax = next(ln for ln in lines if ln["account_code"] == acct._TAX_PAYABLE[0])
        assert round(rev["amount"] + tax["amount"], 2) == 50.0
        assert rev["amount"] < 100.0  # NOT the full invoice's revenue
        # AR is cleared by the cash actually received.
        ar = next(ln for ln in lines if ln["account_code"] == acct._AR[0])
        assert ar["side"] == "credit" and ar["amount"] == 50.0

    def test_cash_overpayment_caps_recognition_at_invoice_total(self):
        # $150 cash on a $108 invoice recognises at most the $108 invoiced.
        lines = acct._lines_for_payment_applied_cash(150.0, 100.0, 8.0, "USD")
        d, c = _balance(lines)
        assert d == c
        rev = next(ln for ln in lines if ln["account_code"] == acct._REVENUE[0])
        tax = next(ln for ln in lines if ln["account_code"] == acct._TAX_PAYABLE[0])
        assert round(rev["amount"] + tax["amount"], 2) == 108.0


class TestFeeChargedLines:
    def test_balanced(self):
        lines = acct._lines_for_fee_charged(50.0, "USD")
        d, c = _balance(lines)
        assert d == c == 50.0

    def test_dr_ar_cr_fee(self):
        lines = acct._lines_for_fee_charged(50.0, "USD")
        ar  = next(ln for ln in lines if ln["account_code"] == acct._AR[0])
        fee = next(ln for ln in lines if ln["account_code"] == acct._FEE_REVENUE[0])
        assert ar["side"] == "debit"
        assert fee["side"] == "credit"


class TestReversedLines:
    def test_sides_flipped(self):
        original = acct._lines_for_fee_charged(50.0, "USD")
        rev = acct._reversed_lines(original)
        for orig, rev_ln in zip(original, rev, strict=False):
            assert rev_ln["side"] != orig["side"]

    def test_amounts_preserved(self):
        original = acct._lines_for_fee_charged(50.0, "USD")
        rev = acct._reversed_lines(original)
        orig_total = sum(ln["amount"] for ln in original)
        rev_total  = sum(ln["amount"] for ln in rev)
        assert orig_total == rev_total

    def test_reversed_entries_balanced(self):
        original = acct._lines_for_invoice_issued_accrual(100.0, 8.0, "USD")
        rev = acct._reversed_lines(original)
        d, c = _balance(rev)
        assert d == c


# ---------------------------------------------------------------------------
# Activity tests (via ActivityEnvironment)
# ---------------------------------------------------------------------------

def _invoice_req(basis: str, subtotal: float = 100.0, tax: float = 8.0) -> acct.InvoicePostingRequest:
    return acct.InvoicePostingRequest(
        tenant_id="tenant-a",
        source_event_id=f"evt-inv-issued-{basis}",
        source_event_type="invoice_issued",
        source_record_id="inv-001",
        posting_date="2026-06-10",
        currency_code="USD",
        posting_basis=basis,
        subtotal=subtotal,
        tax=tax,
    )


def _payment_req(basis: str, amount: float = 108.0) -> acct.PaymentPostingRequest:
    return acct.PaymentPostingRequest(
        tenant_id="tenant-a",
        source_event_id=f"evt-pay-applied-{basis}",
        source_event_type="payment_applied",
        source_record_id="pay-001",
        posting_date="2026-06-10",
        currency_code="USD",
        posting_basis=basis,
        amount=amount,
        subtotal=100.0,
        tax=8.0,
    )


def _fee_req(basis: str, amount: float = 25.0) -> acct.FeePostingRequest:
    return acct.FeePostingRequest(
        tenant_id="tenant-a",
        source_event_id=f"evt-fee-{basis}",
        source_event_type="fee_charged",
        source_record_id="fee-001",
        posting_date="2026-06-10",
        currency_code="USD",
        posting_basis=basis,
        amount=amount,
    )


class TestPostInvoiceIssuedActivity:
    def test_returns_posting_result_accrual(self, env):
        req = _invoice_req("accrual")
        res = env.run(acct.post_invoice_issued, req)
        assert isinstance(res, acct.PostingResult)
        assert res.posting_basis == "accrual"
        assert res.source_event_id == req.source_event_id
        assert res.journal_entry_id

    def test_returns_posting_result_cash(self, env):
        req = _invoice_req("cash")
        res = env.run(acct.post_invoice_issued, req)
        assert res.posting_basis == "cash"

    def test_idempotent_same_id(self, env):
        req = _invoice_req("accrual")
        r1 = env.run(acct.post_invoice_issued, req)
        r2 = env.run(acct.post_invoice_issued, req)
        assert r1.journal_entry_id == r2.journal_entry_id


class TestPostInvoiceVoidActivity:
    def test_accrual_void_returns_result(self, env):
        req = _invoice_req("accrual")
        req.source_event_id = "evt-inv-void-accrual"
        req.source_event_type = "invoice_void"
        res = env.run(acct.post_invoice_void, req)
        assert res.posting_basis == "accrual"
        assert res.journal_entry_id

    def test_cash_void_returns_result(self, env):
        req = _invoice_req("cash")
        req.source_event_id = "evt-inv-void-cash"
        req.source_event_type = "invoice_void"
        res = env.run(acct.post_invoice_void, req)
        assert res.posting_basis == "cash"

    def test_void_is_different_entry_from_issue(self, env):
        issue_req = _invoice_req("accrual")
        void_req  = _invoice_req("accrual")
        void_req.source_event_id  = "evt-inv-void-accrual-diff"
        void_req.source_event_type = "invoice_void"
        r_issue = env.run(acct.post_invoice_issued, issue_req)
        r_void  = env.run(acct.post_invoice_void,   void_req)
        assert r_issue.journal_entry_id != r_void.journal_entry_id


class TestPostPaymentAppliedActivity:
    def test_accrual(self, env):
        res = env.run(acct.post_payment_applied, _payment_req("accrual"))
        assert res.posting_basis == "accrual"

    def test_cash(self, env):
        res = env.run(acct.post_payment_applied, _payment_req("cash"))
        assert res.posting_basis == "cash"

    def test_idempotent(self, env):
        req = _payment_req("accrual")
        r1 = env.run(acct.post_payment_applied, req)
        r2 = env.run(acct.post_payment_applied, req)
        assert r1.journal_entry_id == r2.journal_entry_id


class TestPostPaymentRefundActivity:
    def test_accrual_refund(self, env):
        req = _payment_req("accrual")
        req.source_event_id = "evt-pay-refund-accrual"
        req.source_event_type = "payment_refund"
        res = env.run(acct.post_payment_refund, req)
        assert res.posting_basis == "accrual"

    def test_cash_refund(self, env):
        req = _payment_req("cash")
        req.source_event_id = "evt-pay-refund-cash"
        req.source_event_type = "payment_refund"
        res = env.run(acct.post_payment_refund, req)
        assert res.posting_basis == "cash"


class TestPostFeeChargedActivity:
    def test_accrual(self, env):
        res = env.run(acct.post_fee_charged, _fee_req("accrual"))
        assert res.posting_basis == "accrual"
        assert res.journal_entry_id

    def test_cash(self, env):
        res = env.run(acct.post_fee_charged, _fee_req("cash"))
        assert res.posting_basis == "cash"


class TestPostCreditAppliedActivity:
    def test_accrual(self, env):
        req = _fee_req("accrual")
        req.source_event_id   = "evt-credit-accrual"
        req.source_event_type = "credit_applied"
        res = env.run(acct.post_credit_applied, req)
        assert res.posting_basis == "accrual"

    def test_cash(self, env):
        req = _fee_req("cash")
        req.source_event_id   = "evt-credit-cash"
        req.source_event_type = "credit_applied"
        res = env.run(acct.post_credit_applied, req)
        assert res.posting_basis == "cash"


class TestPostReversalEntryActivity:
    _ORIG_LINES = [
        {"line_sequence": 1, "side": "debit", "account_code": "1100",
         "account_name": "AR", "amount": 108.0, "description": "AR debit"},
        {"line_sequence": 2, "side": "credit", "account_code": "4000",
         "account_name": "Revenue", "amount": 108.0, "description": "Revenue credit"},
    ]

    def test_returns_result(self, env, fake_acct_client):
        fake_acct_client.seed_entry("evt-original", "accrual", self._ORIG_LINES)
        req = acct.ReversalRequest(
            tenant_id="tenant-a",
            original_source_event_id="evt-original",
            posting_basis="accrual",
            reversal_source_event_id="evt-reversal",
            posting_date="2026-06-10",
        )
        res = env.run(acct.post_reversal_entry, req)
        assert res.posting_basis == "accrual"
        assert res.journal_entry_id
        # The reversal must be posted as a real entry that flips the original sides.
        posted = fake_acct_client.select(
            "journal_entry_lines", filters={"journal_entry_id": res.journal_entry_id}
        )
        assert {ln["side"] for ln in posted} == {"debit", "credit"}
        ar = next(ln for ln in posted if ln["account_code"] == "1100")
        assert ar["side"] == "credit"  # original AR debit -> reversed to credit

    def test_idempotent(self, env, fake_acct_client):
        fake_acct_client.seed_entry("evt-original-idem", "cash", self._ORIG_LINES)
        req = acct.ReversalRequest(
            tenant_id="tenant-a",
            original_source_event_id="evt-original-idem",
            posting_basis="cash",
            reversal_source_event_id="evt-reversal-idem",
            posting_date="2026-06-10",
        )
        r1 = env.run(acct.post_reversal_entry, req)
        r2 = env.run(acct.post_reversal_entry, req)
        assert r1.journal_entry_id == r2.journal_entry_id
        assert r2.is_duplicate is True


# ---------------------------------------------------------------------------
# Workflow tests
# ---------------------------------------------------------------------------

def _workflow_request(event_type: str, **kwargs) -> dict:
    base = {
        "tenant_id": "tenant-a",
        "source_event_id": f"evt-wf-{event_type}",
        "source_event_type": event_type,
        "source_record_id": "rec-001",
        "posting_date": "2026-06-10",
        "currency_code": "USD",
        "posting_bases": ["accrual", "cash"],
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# Helpers for workflow tests (mock execute_activity like test_rental_workflows.py)
# ---------------------------------------------------------------------------

def _make_fake_execute_activity() -> tuple[list[str], callable]:
    """Return (calls_log, fake_execute_activity) suitable for patching."""
    calls: list[str] = []

    async def fake_execute_activity(fn_or_str, *pos_args, **kw):
        fn_name = getattr(fn_or_str, "__name__", str(fn_or_str))
        calls.append(fn_name)
        args = kw.get("args", list(pos_args))
        req = args[0] if args else None
        basis = getattr(req, "posting_basis", "accrual") if req else "accrual"
        event_id = getattr(req, "source_event_id", "stub-event-id") if req else "stub-event-id"
        return acct.PostingResult(
            journal_entry_id=acct._idempotent_event_id(f"{event_id}:{basis}"),
            source_event_id=event_id,
            posting_basis=basis,
            is_duplicate=False,
        )

    return calls, fake_execute_activity


def _patch_workflow(fake_execute_activity: callable) -> contextlib.AbstractContextManager:
    """Return a combined context manager that patches workflow primitives."""
    from unittest.mock import MagicMock


    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    return contextlib.ExitStack()  # assembled in each test with individual patches


@pytest.mark.asyncio
async def test_workflow_invoice_issued():
    """Invoice issued → two PostingResult entries (accrual + cash)."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("invoice_issued", subtotal=100.0, tax=8.0)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert result["source_event_id"] == req["source_event_id"]
    assert len(result["results"]) == 2
    bases = {r["posting_basis"] for r in result["results"]}
    assert bases == {"accrual", "cash"}
    assert "post_invoice_issued" in calls


@pytest.mark.asyncio
async def test_workflow_invoice_void():
    """Invoice void → two PostingResult entries."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("invoice_void", subtotal=100.0, tax=8.0)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert len(result["results"]) == 2
    assert "post_invoice_void" in calls


@pytest.mark.asyncio
async def test_workflow_payment_applied():
    """Payment applied → two PostingResult entries."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("payment_applied", amount=108.0, subtotal=100.0, tax=8.0)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert len(result["results"]) == 2
    assert "post_payment_applied" in calls


@pytest.mark.asyncio
async def test_workflow_payment_refund():
    """Payment refund → two PostingResult entries."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("payment_refund", amount=108.0, subtotal=100.0, tax=8.0)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert len(result["results"]) == 2
    assert "post_payment_refund" in calls


@pytest.mark.asyncio
async def test_workflow_fee_charged():
    """Fee charged → two PostingResult entries."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("fee_charged", amount=25.0)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert len(result["results"]) == 2
    assert "post_fee_charged" in calls


@pytest.mark.asyncio
async def test_workflow_credit_applied():
    """Credit applied → two PostingResult entries."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("credit_applied", amount=25.0)

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert len(result["results"]) == 2
    assert "post_credit_applied" in calls


@pytest.mark.asyncio
async def test_workflow_single_basis():
    """Caller may restrict to a single basis via posting_bases list."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    calls, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("invoice_issued", subtotal=100.0, tax=8.0)
    req["posting_bases"] = ["accrual"]

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
    ):
        result = await wf.run(req)

    assert len(result["results"]) == 1
    assert result["results"][0]["posting_basis"] == "accrual"


@pytest.mark.asyncio
async def test_workflow_unsupported_event_type():
    """Unknown event_type should raise ValueError."""
    import contextlib
    from unittest.mock import MagicMock, patch

    import temporalio.workflow as tw_mod

    _, fake_exec = _make_fake_execute_activity()
    fake_unsafe = MagicMock()
    fake_unsafe.imports_passed_through.return_value = contextlib.nullcontext()

    wf = AccountingPostingWorkflow()
    req = _workflow_request("bad_event_type")

    with (
        patch.object(tw_mod, "execute_activity", side_effect=fake_exec),
        patch.object(tw_mod, "timedelta", side_effect=lambda **kw: __import__("datetime").timedelta(**kw)),
        patch.object(tw_mod, "unsafe", fake_unsafe),
        pytest.raises(ValueError, match="Unsupported accounting event_type"),
    ):
        await wf.run(req)
