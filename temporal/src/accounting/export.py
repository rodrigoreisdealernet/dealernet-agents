"""Accounting export — Xero/Sage CSV mapping and export-only manifest generation.

Supported export modes
----------------------
- ``xero``        → Xero manual journal CSV v1 (importable via Xero > Accounting > Manual Journals)
- ``sage``        → Sage Intacct GL journal CSV v1 (importable via Sage Intacct > GL > Journals)
- ``export_only`` → Canonical Dealernet ledger CSV for accountant hand-off (no provider-specific schema)

Format versions are explicit strings so that drift in a provider's import template can be
detected without scanning CSV content.  Any schema change requires a new version key.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

# Supported format version strings — stored in accounting_export_config.format_version and
# accounting_export_runs.format_version so version drift is auditable.
XERO_CSV_V1 = "xero_csv_v1"
SAGE_INTACCT_GL_CSV_V1 = "sage_intacct_gl_csv_v1"
EXPORT_ONLY_V1 = "export_only_v1"

ExportMode = Literal["xero", "sage", "export_only"]
FormatVersion = Literal["xero_csv_v1", "sage_intacct_gl_csv_v1", "export_only_v1"]

_MODE_TO_FORMAT_VERSION: dict[ExportMode, FormatVersion] = {
    "xero": XERO_CSV_V1,
    "sage": SAGE_INTACCT_GL_CSV_V1,
    "export_only": EXPORT_ONLY_V1,
}

# Xero manual journal CSV columns (Xero CSV import format v1)
_XERO_HEADERS = [
    "*Narration",
    "*Date",
    "*AccountCode",
    "*Description",
    "*TaxType",
    "*Amount",
    "Reference",
    "TrackingName1",
    "TrackingOption1",
]

# Sage Intacct GL journal CSV columns
_SAGE_GL_HEADERS = [
    "JOURNALSYMBOL",
    "BATCH_DATE",
    "BATCH_TITLE",
    "ACCOUNTNO",
    "TR_TYPE",
    "TRX_AMOUNT",
    "CURRENCY",
    "DESCRIPTION",
    "REFERENCE",
]

# Canonical export-only CSV columns (extended Dealernet GL format)
_EXPORT_ONLY_HEADERS = [
    "Posted At",
    "Basis",
    "Document Type",
    "Document Number",
    "GL Account Code",
    "GL Account Name",
    "Counter Account Code",
    "Counter Account Name",
    "Debit",
    "Credit",
    "Source Amount",
    "Currency",
    "Sync Status",
    "Export Status",
    "Customer ID",
    "Billing Account ID",
    "Branch ID",
]


@dataclass
class ExportManifest:
    """Metadata record returned alongside the CSV payload."""

    export_mode: ExportMode
    format_version: FormatVersion
    period_start: date
    period_end: date
    basis: str
    row_count: int
    filename: str
    account_code_map: dict[str, str] = field(default_factory=dict)
    tax_code_map: dict[str, str] = field(default_factory=dict)


@dataclass
class ExportPackage:
    """Container for the CSV text and its manifest."""

    csv_text: str
    manifest: ExportManifest


def _format_date_iso(value: Any) -> str:
    """Return an ISO-8601 date string (YYYY-MM-DD) from a date/datetime/string value."""
    if isinstance(value, date):
        return value.isoformat()[:10]
    text = str(value or "")
    return text[:10] if text else ""


def _resolve_account_code(code: str, account_code_map: dict[str, str]) -> str:
    return account_code_map.get(code, code)


def _resolve_tax_type(tax_code: str, tax_code_map: dict[str, str]) -> str:
    return tax_code_map.get(tax_code, tax_code)


def _csv_escape(value: Any) -> str:
    """Prevent CSV formula injection by prefixing with a single quote when needed.

    Numeric-looking strings (e.g. ``-1200.00``) that start with ``-`` or ``+`` are
    safe and must not be prefixed — only non-numeric leading characters are guarded.
    """
    text = str(value) if value is not None else ""
    if not text:
        return text
    first = text[0]
    if first in ("=", "@"):
        return f"'{text}"
    if first in ("+", "-"):
        # Only guard when the rest of the string is not a valid number
        try:
            float(text)
        except ValueError:
            return f"'{text}"
    return text


def _write_csv(headers: list[str], rows: list[list[Any]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(headers)
    for row in rows:
        writer.writerow([_csv_escape(cell) for cell in row])
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Xero manual journal CSV v1
# ---------------------------------------------------------------------------


def build_xero_csv(
    ledger_rows: list[dict[str, Any]],
    *,
    account_code_map: dict[str, str] | None = None,
    tax_code_map: dict[str, str] | None = None,
    narration_prefix: str = "Dealernet rental export",
) -> str:
    """Map GL rows to Xero manual journal CSV format (xero_csv_v1).

    Xero manual journals use a signed-amount model: positive = debit, negative = credit.
    Each GL entry produces two lines (debit + credit) in the Xero CSV.
    The ``*Narration`` and ``*Date`` columns repeat on every line for the same journal.
    """
    acc_map = account_code_map or {}
    tax_map = tax_code_map or {}
    rows: list[list[Any]] = []

    for entry in ledger_rows:
        posted_at = _format_date_iso(entry.get("posted_at", ""))
        doc_number = str(entry.get("source_document_number") or "")
        narration = f"{narration_prefix} — {doc_number}" if doc_number else narration_prefix
        currency = str(entry.get("currency_code") or "USD")
        gl_code = _resolve_account_code(str(entry.get("gl_account_code") or ""), acc_map)
        counter_code = _resolve_account_code(str(entry.get("counter_account_code") or ""), acc_map)
        description = str(entry.get("gl_account_name") or "")
        counter_description = str(entry.get("counter_account_name") or "")
        tax_type = _resolve_tax_type("", tax_map) or "NONE"
        debit = float(entry.get("debit_amount") or 0)
        credit = float(entry.get("credit_amount") or 0)
        branch_id = str(entry.get("branch_id") or "")

        # Debit line (positive amount)
        if debit > 0:
            rows.append([
                narration,
                posted_at,
                gl_code,
                description,
                tax_type,
                f"{debit:.2f}",
                doc_number,
                "Branch" if branch_id else "",
                branch_id,
            ])

        # Credit line (negative amount)
        if credit > 0 and counter_code:
            rows.append([
                narration,
                posted_at,
                counter_code,
                counter_description or description,
                tax_type,
                f"{-credit:.2f}",
                doc_number,
                "Branch" if branch_id else "",
                branch_id,
            ])

    return _write_csv(_XERO_HEADERS, rows)


# ---------------------------------------------------------------------------
# Sage Intacct GL journal CSV v1
# ---------------------------------------------------------------------------


def build_sage_csv(
    ledger_rows: list[dict[str, Any]],
    *,
    account_code_map: dict[str, str] | None = None,
    journal_symbol: str = "DIA",
    batch_title_prefix: str = "Dealernet rental export",
) -> str:
    """Map GL rows to Sage Intacct GL journal CSV format (sage_intacct_gl_csv_v1).

    Sage Intacct uses separate TR_TYPE values ('debit' / 'credit') and positive amounts.
    Each GL entry produces two lines (debit + credit sides).
    """
    acc_map = account_code_map or {}
    rows: list[list[Any]] = []

    for entry in ledger_rows:
        posted_at = _format_date_iso(entry.get("posted_at", ""))
        doc_number = str(entry.get("source_document_number") or "")
        batch_title = f"{batch_title_prefix} — {doc_number}" if doc_number else batch_title_prefix
        currency = str(entry.get("currency_code") or "USD")
        gl_code = _resolve_account_code(str(entry.get("gl_account_code") or ""), acc_map)
        counter_code = _resolve_account_code(str(entry.get("counter_account_code") or ""), acc_map)
        description = str(entry.get("gl_account_name") or "")
        counter_description = str(entry.get("counter_account_name") or "")
        debit = float(entry.get("debit_amount") or 0)
        credit = float(entry.get("credit_amount") or 0)

        if debit > 0:
            rows.append([
                journal_symbol,
                posted_at,
                batch_title,
                gl_code,
                "debit",
                f"{debit:.2f}",
                currency,
                description,
                doc_number,
            ])

        if credit > 0 and counter_code:
            rows.append([
                journal_symbol,
                posted_at,
                batch_title,
                counter_code,
                "credit",
                f"{credit:.2f}",
                currency,
                counter_description or description,
                doc_number,
            ])

    return _write_csv(_SAGE_GL_HEADERS, rows)


# ---------------------------------------------------------------------------
# Export-only canonical CSV v1
# ---------------------------------------------------------------------------


def build_export_only_csv(ledger_rows: list[dict[str, Any]]) -> str:
    """Build canonical Dealernet ledger CSV for accountant hand-off (export_only_v1)."""
    rows: list[list[Any]] = []
    for entry in ledger_rows:
        rows.append([
            _format_date_iso(entry.get("posted_at", "")),
            entry.get("basis", ""),
            entry.get("source_document_type", ""),
            entry.get("source_document_number", ""),
            entry.get("gl_account_code", ""),
            entry.get("gl_account_name", ""),
            entry.get("counter_account_code", "") or "",
            entry.get("counter_account_name", "") or "",
            f"{float(entry.get('debit_amount') or 0):.2f}",
            f"{float(entry.get('credit_amount') or 0):.2f}",
            f"{float(entry.get('source_amount') or 0):.2f}",
            entry.get("currency_code", "USD"),
            entry.get("sync_status", ""),
            entry.get("export_status", ""),
            entry.get("customer_id", "") or "",
            entry.get("billing_account_id", "") or "",
            entry.get("branch_id", "") or "",
        ])
    return _write_csv(_EXPORT_ONLY_HEADERS, rows)


# ---------------------------------------------------------------------------
# Package builder — dispatches to the right formatter
# ---------------------------------------------------------------------------


def build_export_package(
    ledger_rows: list[dict[str, Any]],
    export_mode: ExportMode,
    period_start: date,
    period_end: date,
    basis: str = "all",
    *,
    account_code_map: dict[str, str] | None = None,
    tax_code_map: dict[str, str] | None = None,
) -> ExportPackage:
    """Build an export package for the given export mode.

    Parameters
    ----------
    ledger_rows:
        Rows from ``accounting_get_general_ledger`` or an equivalent query.
    export_mode:
        ``"xero"``, ``"sage"``, or ``"export_only"``.
    period_start / period_end:
        Inclusive date bounds of the export period (used only in the manifest).
    basis:
        ``"accrual"``, ``"cash"``, or ``"all"`` (for the manifest).
    account_code_map / tax_code_map:
        Optional remapping dicts from the tenant's ``accounting_export_config``.
    """
    acc_map = account_code_map or {}
    t_map = tax_code_map or {}
    fmt_version = _MODE_TO_FORMAT_VERSION[export_mode]

    if export_mode == "xero":
        csv_text = build_xero_csv(ledger_rows, account_code_map=acc_map, tax_code_map=t_map)
    elif export_mode == "sage":
        csv_text = build_sage_csv(ledger_rows, account_code_map=acc_map)
    else:
        csv_text = build_export_only_csv(ledger_rows)

    # Count data rows (excluding the header) using CSV reader to handle embedded newlines
    data_rows = list(csv.reader(io.StringIO(csv_text)))
    row_count = max(0, len(data_rows) - 1) if data_rows else 0

    period_str = f"{period_start.isoformat()}-{period_end.isoformat()}"
    filename = f"dia-accounting-{export_mode}-{period_str}.csv"

    manifest = ExportManifest(
        export_mode=export_mode,
        format_version=fmt_version,
        period_start=period_start,
        period_end=period_end,
        basis=basis,
        row_count=row_count,
        filename=filename,
        account_code_map=acc_map,
        tax_code_map=t_map,
    )

    return ExportPackage(csv_text=csv_text, manifest=manifest)
