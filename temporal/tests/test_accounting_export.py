"""Unit tests for temporal.src.accounting.export.

Covers:
- build_xero_csv: header format, debit/credit sign convention, account code remapping
- build_sage_csv: header format, TR_TYPE separation, account code remapping
- build_export_only_csv: header format, field mapping
- build_export_package: correct dispatcher, manifest fields, formula-injection guard
"""
from __future__ import annotations

import csv
import io
from datetime import date

import pytest

from temporal.src.accounting.export import (
    EXPORT_ONLY_V1,
    SAGE_INTACCT_GL_CSV_V1,
    XERO_CSV_V1,
    ExportManifest,
    ExportPackage,
    build_export_only_csv,
    build_export_package,
    build_sage_csv,
    build_xero_csv,
)


def _parse_csv(text: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text))
    return list(reader)


def _sample_entry(
    *,
    gl_code: str = "4000-RENT",
    gl_name: str = "Rental Revenue",
    counter_code: str = "1200-AR",
    counter_name: str = "Accounts Receivable",
    debit: float = 1200.0,
    credit: float = 0.0,
    posted_at: str = "2026-06-15T10:00:00Z",
    doc_number: str = "INV-1001",
    doc_type: str = "invoice",
    currency: str = "USD",
    basis: str = "accrual",
    branch_id: str | None = "branch-1",
) -> dict:
    return {
        "gl_account_code": gl_code,
        "gl_account_name": gl_name,
        "counter_account_code": counter_code,
        "counter_account_name": counter_name,
        "debit_amount": debit,
        "credit_amount": credit,
        "source_amount": debit or credit,
        "posted_at": posted_at,
        "source_document_number": doc_number,
        "source_document_type": doc_type,
        "currency_code": currency,
        "basis": basis,
        "sync_status": "synced",
        "export_status": "queued",
        "customer_id": "cust-1",
        "billing_account_id": "bill-1",
        "branch_id": branch_id,
    }


# ---------------------------------------------------------------------------
# build_xero_csv
# ---------------------------------------------------------------------------


def test_xero_csv_headers() -> None:
    csv_text = build_xero_csv([])
    rows = _parse_csv(csv_text)
    assert rows == []  # no data rows
    header_line = csv_text.splitlines()[0]
    assert "*Narration" in header_line
    assert "*AccountCode" in header_line
    assert "*Amount" in header_line


def test_xero_csv_debit_entry_positive_amount() -> None:
    entry = _sample_entry(debit=1200.0, credit=0.0, counter_code="")
    rows = _parse_csv(build_xero_csv([entry]))
    debit_row = next((r for r in rows if float(r["*Amount"]) > 0), None)
    assert debit_row is not None
    assert float(debit_row["*Amount"]) == pytest.approx(1200.0)
    assert debit_row["*AccountCode"] == "4000-RENT"


def test_xero_csv_credit_entry_negative_amount() -> None:
    entry = _sample_entry(debit=1200.0, credit=1200.0, counter_code="1200-AR")
    rows = _parse_csv(build_xero_csv([entry]))
    credit_row = next((r for r in rows if float(r["*Amount"]) < 0), None)
    assert credit_row is not None
    assert float(credit_row["*Amount"]) == pytest.approx(-1200.0)
    assert credit_row["*AccountCode"] == "1200-AR"


def test_xero_csv_account_code_remapping() -> None:
    entry = _sample_entry(gl_code="4000-RENT", credit=0.0)
    rows = _parse_csv(build_xero_csv([entry], account_code_map={"4000-RENT": "200"}))
    assert rows[0]["*AccountCode"] == "200"


def test_xero_csv_narration_contains_document_number() -> None:
    entry = _sample_entry(doc_number="INV-9999")
    rows = _parse_csv(build_xero_csv([entry]))
    assert "INV-9999" in rows[0]["*Narration"]


def test_xero_csv_no_credit_row_when_no_counter_code() -> None:
    entry = _sample_entry(debit=500.0, credit=500.0, counter_code="")
    rows = _parse_csv(build_xero_csv([entry]))
    # Only the debit line should be emitted (counter code is empty)
    assert len(rows) == 1


def test_xero_csv_formula_injection_guard() -> None:
    entry = _sample_entry(doc_number="=SUM(A1:A10)")
    rows = _parse_csv(build_xero_csv([entry]))
    ref_value = rows[0]["Reference"]
    assert not ref_value.startswith("=")


# ---------------------------------------------------------------------------
# build_sage_csv
# ---------------------------------------------------------------------------


def test_sage_csv_headers() -> None:
    csv_text = build_sage_csv([])
    header_line = csv_text.splitlines()[0]
    assert "JOURNALSYMBOL" in header_line
    assert "TR_TYPE" in header_line
    assert "TRX_AMOUNT" in header_line


def test_sage_csv_debit_line() -> None:
    entry = _sample_entry(debit=800.0, credit=0.0, counter_code="")
    rows = _parse_csv(build_sage_csv([entry]))
    assert rows[0]["TR_TYPE"] == "debit"
    assert float(rows[0]["TRX_AMOUNT"]) == pytest.approx(800.0)
    assert rows[0]["ACCOUNTNO"] == "4000-RENT"


def test_sage_csv_credit_line() -> None:
    entry = _sample_entry(debit=800.0, credit=800.0, counter_code="1200-AR")
    rows = _parse_csv(build_sage_csv([entry]))
    credit_row = next(r for r in rows if r["TR_TYPE"] == "credit")
    assert float(credit_row["TRX_AMOUNT"]) == pytest.approx(800.0)
    assert credit_row["ACCOUNTNO"] == "1200-AR"


def test_sage_csv_account_code_remapping() -> None:
    entry = _sample_entry(gl_code="4000-RENT", credit=0.0)
    rows = _parse_csv(build_sage_csv([entry], account_code_map={"4000-RENT": "4000"}))
    assert rows[0]["ACCOUNTNO"] == "4000"


def test_sage_csv_custom_journal_symbol() -> None:
    entry = _sample_entry()
    rows = _parse_csv(build_sage_csv([entry], journal_symbol="WYNNQ1"))
    assert rows[0]["JOURNALSYMBOL"] == "WYNNQ1"


def test_sage_csv_currency_propagated() -> None:
    entry = _sample_entry(currency="CAD", debit=500.0, credit=0.0, counter_code="")
    rows = _parse_csv(build_sage_csv([entry]))
    assert rows[0]["CURRENCY"] == "CAD"


# ---------------------------------------------------------------------------
# build_export_only_csv
# ---------------------------------------------------------------------------


def test_export_only_csv_headers() -> None:
    csv_text = build_export_only_csv([])
    header_line = csv_text.splitlines()[0]
    assert "Posted At" in header_line
    assert "GL Account Code" in header_line
    assert "Debit" in header_line
    assert "Credit" in header_line


def test_export_only_csv_row_values() -> None:
    entry = _sample_entry(debit=1200.0, credit=0.0)
    rows = _parse_csv(build_export_only_csv([entry]))
    assert rows[0]["GL Account Code"] == "4000-RENT"
    assert float(rows[0]["Debit"]) == pytest.approx(1200.0)
    assert float(rows[0]["Credit"]) == pytest.approx(0.0)
    assert rows[0]["Currency"] == "USD"


def test_export_only_csv_formula_injection_guard() -> None:
    entry = _sample_entry(doc_number="+DANGEROUS()")
    rows = _parse_csv(build_export_only_csv([entry]))
    doc_val = rows[0]["Document Number"]
    assert not doc_val.startswith("+")


# ---------------------------------------------------------------------------
# build_export_package dispatcher
# ---------------------------------------------------------------------------


def test_build_export_package_xero_format_version() -> None:
    pkg = build_export_package(
        [],
        "xero",
        date(2026, 6, 1),
        date(2026, 6, 30),
    )
    assert isinstance(pkg, ExportPackage)
    assert pkg.manifest.format_version == XERO_CSV_V1
    assert pkg.manifest.export_mode == "xero"
    assert "xero_csv_v1" in pkg.manifest.format_version


def test_build_export_package_sage_format_version() -> None:
    pkg = build_export_package(
        [],
        "sage",
        date(2026, 6, 1),
        date(2026, 6, 30),
    )
    assert pkg.manifest.format_version == SAGE_INTACCT_GL_CSV_V1
    assert pkg.manifest.export_mode == "sage"


def test_build_export_package_export_only_format_version() -> None:
    pkg = build_export_package(
        [],
        "export_only",
        date(2026, 6, 1),
        date(2026, 6, 30),
    )
    assert pkg.manifest.format_version == EXPORT_ONLY_V1


def test_build_export_package_manifest_fields() -> None:
    start = date(2026, 6, 1)
    end = date(2026, 6, 30)
    pkg = build_export_package(
        [_sample_entry()],
        "export_only",
        start,
        end,
        basis="accrual",
    )
    assert pkg.manifest.period_start == start
    assert pkg.manifest.period_end == end
    assert pkg.manifest.basis == "accrual"
    assert "export_only" in pkg.manifest.filename
    assert pkg.manifest.row_count > 0


def test_build_export_package_row_count_matches_data() -> None:
    entries = [_sample_entry(doc_number=f"INV-{i}", credit=0.0, counter_code="") for i in range(5)]
    pkg = build_export_package(entries, "export_only", date(2026, 6, 1), date(2026, 6, 30))
    assert pkg.manifest.row_count == 5


def test_build_export_package_row_count_xero_debit_and_credit_lines() -> None:
    # Each entry with both debit and credit produces two Xero lines
    entries = [_sample_entry(debit=1200.0, credit=1200.0, counter_code="1200-AR") for _ in range(3)]
    pkg = build_export_package(entries, "xero", date(2026, 6, 1), date(2026, 6, 30))
    assert pkg.manifest.row_count == 6  # 3 entries × 2 lines each


def test_build_export_package_empty_rows_produce_header_only_csv() -> None:
    pkg = build_export_package([], "xero", date(2026, 6, 1), date(2026, 6, 30))
    lines = [l for l in pkg.csv_text.splitlines() if l.strip()]
    assert len(lines) == 1  # header only


def test_build_export_package_passes_account_code_map_to_xero() -> None:
    entry = _sample_entry(gl_code="4000-RENT", credit=0.0, counter_code="")
    pkg = build_export_package(
        [entry],
        "xero",
        date(2026, 6, 1),
        date(2026, 6, 30),
        account_code_map={"4000-RENT": "200"},
    )
    rows = _parse_csv(pkg.csv_text)
    assert rows[0]["*AccountCode"] == "200"


def test_build_export_package_passes_account_code_map_to_sage() -> None:
    entry = _sample_entry(gl_code="4000-RENT", credit=0.0, counter_code="")
    pkg = build_export_package(
        [entry],
        "sage",
        date(2026, 6, 1),
        date(2026, 6, 30),
        account_code_map={"4000-RENT": "4000"},
    )
    rows = _parse_csv(pkg.csv_text)
    assert rows[0]["ACCOUNTNO"] == "4000"


def test_build_export_package_filename_contains_period() -> None:
    pkg = build_export_package([], "xero", date(2026, 4, 1), date(2026, 4, 30))
    assert "2026-04-01" in pkg.manifest.filename
    assert "2026-04-30" in pkg.manifest.filename


def test_build_export_package_invalid_mode_raises() -> None:
    with pytest.raises(KeyError):
        build_export_package([], "invalid_mode", date(2026, 1, 1), date(2026, 1, 31))  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# API endpoint route/auth/overflow tests
# ---------------------------------------------------------------------------

from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient
from temporal.src.ops_api.app import Principal, _LEDGER_FETCH_LIMIT, create_app

_BEARER_PREFIX = "Bearer"


class _FakeAccountingClient:
    """Minimal Supabase stub for accounting export endpoint tests."""

    def __init__(
        self,
        *,
        principal: Principal,
        export_config: dict[str, Any] | None = None,
        ledger_rows: list[dict[str, Any]] | None = None,
        tenant_id: str = "tenant-acct-id",
    ) -> None:
        self._principal = principal
        self._export_config = export_config
        self._ledger_rows = ledger_rows or []
        self._tenant_id = tenant_id
        self.recorded_runs: list[dict[str, Any]] = []
        self.upsert_calls: list[dict[str, Any]] = []
        self.captured_ledger_paths: list[str] = []

    async def authenticate_user(self, *, user_jwt: str) -> Principal:
        return self._principal

    async def get_tenant_id_by_key(self, *, tenant_key: str) -> str | None:
        if tenant_key != self._principal.tenant:
            return None
        return self._tenant_id

    async def _request_json(
        self,
        *,
        method: str,
        url: str | None = None,
        path: str | None = None,
        headers: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        effective_path = path or (url or "")
        if "accounting_export_config" in effective_path and method == "GET":
            return [self._export_config] if self._export_config else []
        if "accounting_posted_ledger_entries" in effective_path and method == "GET":
            self.captured_ledger_paths.append(effective_path)
            return self._ledger_rows
        if "accounting_record_export_run" in effective_path and method == "POST":
            self.recorded_runs.append(body or {})
            return {"id": "run-1"}
        if "accounting_upsert_export_config" in effective_path and method == "POST":
            self.upsert_calls.append(body or {})
            return {"id": "cfg-1", "export_mode": (body or {}).get("p_export_mode")}
        return None


def _make_accounting_client(*, role: str, tenant: str = "acct-tenant") -> tuple[TestClient, _FakeAccountingClient]:
    principal = Principal(sub="user-1", name="Test User", role=role, tenant=tenant, can_operate=True)
    config = {
        "id": "cfg-1",
        "export_mode": "export_only",
        "format_version": "export_only_v1",
        "account_code_map": {},
        "tax_code_map": {},
    }
    supabase = _FakeAccountingClient(principal=principal, export_config=config)

    class _FakeTemporalClient:
        async def run_branch_morning_brief(self, **kwargs: Any) -> Any:  # pragma: no cover
            return {}

    app = create_app(supabase_client=supabase, temporal_client=_FakeTemporalClient())  # type: ignore[arg-type]
    return TestClient(app), supabase


def _auth() -> dict[str, str]:
    return {"Authorization": f"{_BEARER_PREFIX} test-token"}


# — auth gate: field_operator must be denied for trigger —

def test_trigger_export_denies_field_operator() -> None:
    client, _ = _make_accounting_client(role="field_operator")
    resp = client.post(
        "/api/ops/accounting/export/trigger",
        headers=_auth(),
        json={"period_start": "2026-06-01", "period_end": "2026-06-30"},
    )
    assert resp.status_code == 403


def test_trigger_export_denies_read_only() -> None:
    client, _ = _make_accounting_client(role="read_only")
    resp = client.post(
        "/api/ops/accounting/export/trigger",
        headers=_auth(),
        json={"period_start": "2026-06-01", "period_end": "2026-06-30"},
    )
    assert resp.status_code == 403


def test_trigger_export_allows_branch_manager() -> None:
    client, _ = _make_accounting_client(role="branch_manager")
    resp = client.post(
        "/api/ops/accounting/export/trigger",
        headers=_auth(),
        json={"period_start": "2026-06-01", "period_end": "2026-06-30"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")


def test_trigger_export_allows_admin() -> None:
    client, _ = _make_accounting_client(role="admin")
    resp = client.post(
        "/api/ops/accounting/export/trigger",
        headers=_auth(),
        json={"period_start": "2026-06-01", "period_end": "2026-06-30"},
    )
    assert resp.status_code == 200


# — auth gate: field_operator must be denied for runs listing —

def test_list_runs_denies_field_operator() -> None:
    client, _ = _make_accounting_client(role="field_operator")
    resp = client.get("/api/ops/accounting/export/runs", headers=_auth())
    assert resp.status_code == 403


def test_list_runs_allows_branch_manager() -> None:
    client, _ = _make_accounting_client(role="branch_manager")
    resp = client.get("/api/ops/accounting/export/runs", headers=_auth())
    assert resp.status_code == 200
    assert "runs" in resp.json()


# — overflow guard: exactly at cap returns 422 —

def test_trigger_export_overflow_guard_raises_422() -> None:
    principal = Principal(sub="u1", name="Admin", role="admin", tenant="t1", can_operate=True)
    overflow_rows: list[dict[str, Any]] = [
        {
            "gl_account_code": "4000-RENT",
            "gl_account_name": "Revenue",
            "counter_account_code": "",
            "counter_account_name": "",
            "debit_amount": 100.0,
            "credit_amount": 0.0,
            "source_amount": 100.0,
            "posted_at": "2026-06-01T00:00:00Z",
            "source_document_number": f"INV-{i}",
            "source_document_type": "invoice",
            "currency_code": "USD",
            "basis": "accrual",
            "sync_status": "synced",
            "export_status": "queued",
            "customer_id": "cust-1",
            "billing_account_id": "bill-1",
            "branch_id": "branch-1",
        }
        for i in range(_LEDGER_FETCH_LIMIT)
    ]
    config = {
        "id": "cfg-1",
        "export_mode": "export_only",
        "format_version": "export_only_v1",
        "account_code_map": {},
        "tax_code_map": {},
    }
    supabase = _FakeAccountingClient(principal=principal, export_config=config, ledger_rows=overflow_rows)

    class _FakeTemporalClient:
        async def run_branch_morning_brief(self, **kwargs: Any) -> Any:  # pragma: no cover
            return {}

    app = create_app(supabase_client=supabase, temporal_client=_FakeTemporalClient())  # type: ignore[arg-type]
    tclient = TestClient(app)
    resp = tclient.post(
        "/api/ops/accounting/export/trigger",
        headers=_auth(),
        json={"period_start": "2026-01-01", "period_end": "2026-12-31"},
    )
    assert resp.status_code == 422
    assert "fetch limit" in resp.json()["detail"].lower() or "row" in resp.json()["detail"].lower()


def test_trigger_export_below_cap_succeeds() -> None:
    principal = Principal(sub="u1", name="Admin", role="admin", tenant="t1", can_operate=True)
    rows: list[dict[str, Any]] = [
        {
            "gl_account_code": "4000-RENT",
            "gl_account_name": "Revenue",
            "counter_account_code": "",
            "counter_account_name": "",
            "debit_amount": 100.0,
            "credit_amount": 0.0,
            "source_amount": 100.0,
            "posted_at": "2026-06-01T00:00:00Z",
            "source_document_number": f"INV-{i}",
            "source_document_type": "invoice",
            "currency_code": "USD",
            "basis": "accrual",
            "sync_status": "synced",
            "export_status": "queued",
            "customer_id": "cust-1",
            "billing_account_id": "bill-1",
            "branch_id": "branch-1",
        }
        for i in range(_LEDGER_FETCH_LIMIT - 1)
    ]
    config = {
        "id": "cfg-1",
        "export_mode": "export_only",
        "format_version": "export_only_v1",
        "account_code_map": {},
        "tax_code_map": {},
    }
    supabase = _FakeAccountingClient(principal=principal, export_config=config, ledger_rows=rows)

    class _FakeTemporalClient:
        async def run_branch_morning_brief(self, **kwargs: Any) -> Any:  # pragma: no cover
            return {}

    app = create_app(supabase_client=supabase, temporal_client=_FakeTemporalClient())  # type: ignore[arg-type]
    tclient = TestClient(app)
    resp = tclient.post(
        "/api/ops/accounting/export/trigger",
        headers=_auth(),
        json={"period_start": "2026-06-01", "period_end": "2026-06-30"},
    )
    assert resp.status_code == 200


# — URL encoding regression: '+' in UTC offset must be percent-encoded —

def test_trigger_export_period_end_timestamp_is_percent_encoded() -> None:
    """Regression: the UTC '+00:00' timezone offset in the end-of-day timestamp must be
    percent-encoded as '%2B' so PostgREST does not interpret the raw '+' as a space.
    This test captures the actual path sent to the Supabase stub and fails on the
    old unencoded code path."""
    client, supabase = _make_accounting_client(role="admin")
    resp = client.post(
        "/api/ops/accounting/export/trigger",
        json={"period_start": "2026-06-01", "period_end": "2026-06-30"},
        headers=_auth(),
    )
    assert resp.status_code == 200
    assert len(supabase.captured_ledger_paths) == 1, "expected exactly one ledger fetch"
    ledger_path = supabase.captured_ledger_paths[0]
    # Parse the query string robustly — parse_qs percent-decodes values, so we check the
    # raw query string directly for the encoded '+' rather than inspecting decoded values.
    parsed = urlparse(ledger_path)
    raw_query = parsed.query
    # Confirm the lte filter is present in the raw query string
    assert "posted_at=lte." in raw_query, "lte filter missing from ledger fetch path"
    # The raw query string must contain '%2B' (encoded '+') and must NOT contain a bare '+'
    # in the lte timestamp value; a bare '+' would be decoded as a space by PostgREST.
    lte_filter = next(
        (p for p in raw_query.split("&") if p.startswith("posted_at=lte.")),
        None,
    )
    assert lte_filter is not None, "posted_at=lte. parameter not found in ledger query string"
    lte_value = lte_filter[len("posted_at=lte."):]
    assert "+" not in lte_value, (
        "raw '+' in lte timestamp is decoded as a space by PostgREST; must use %2B"
    )
    assert "%2B" in lte_value, "expected percent-encoded UTC offset '%2B' in lte timestamp"
