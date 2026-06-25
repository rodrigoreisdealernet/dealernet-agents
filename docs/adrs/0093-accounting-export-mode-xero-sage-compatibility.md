# ADR-0093: Accounting export mode — Xero/Sage CSV compatibility + standalone export-only operating mode

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Factory Architect / Product Owner / Copilot
- **Supersedes / Superseded by:** —

## Context

Issue #578 (child of #437) requires that posted accounting data from the Wynne rental ERP can be
exported for downstream import into Xero or Sage Intacct, and that this export path works
independently of any live provider OAuth connection.

The parent accounting epic has already shipped:

- `accounting_posted_ledger_entries` — immutable GL posting store
- `invoice_tax_snapshots` / `tax_filing_period_summaries` — period-bounded tax data
- `accounting_get_general_ledger()` — tenant-scoped, finance-role–gated RPC

This story is about **compatibility/export packaging**: mapping those outputs into
provider-importable formats and providing a reliable export-only operating mode, **not** a direct
live sync to Xero or Sage APIs.

### Forces

- No browser-held provider credentials.
- No direct Xero/Sage OAuth or background provider-write workflow in this story.
- Export behaviour must stay tenant-scoped, auditable, and additive to the parent accounting model.
- Export format contracts drift over time (Xero CSV schema, Sage Intacct import schema), so
  mapping/versioning must be explicit and testable.
- A standalone `export_only` mode must work for tenants that have no third-party accounting system
  (accountant hand-off, CSV-only workflow).

## Decision

We implement a **tenant-configurable accounting export mode** (`xero`, `sage`, or `export_only`)
backed by:

1. `accounting_export_config` — one active row per tenant recording the export mode, format
   version, and optional GL/tax code remapping profiles.
2. `accounting_export_runs` — append-only audit log of every export run (who triggered it, period
   covered, row count, artifact status, format version).
3. A pure-Python export module (`temporal/src/accounting/export.py`) that maps
   `accounting_posted_ledger_entries` rows into:
   - **Xero manual journal CSV** — `*Narration`, `*Date`, `*AccountCode`, `*Description`,
     `*TaxType`, `*Amount`, `Reference` header layout (Xero CSV import format v1).
   - **Sage Intacct GL journal CSV** — `JOURNALSYMBOL`, `BATCH_DATE`, `BATCH_TITLE`,
     `ACCOUNTNO`, `TR_TYPE`, `TRX_AMOUNT`, `CURRENCY`, `DESCRIPTION`, `REFERENCE` layout
     (Sage Intacct GL journal import format).
   - **Export-only CSV** — canonical Wynne ledger CSV (same layout as the existing GL export in
     the frontend, extended with audit metadata) for accountant hand-off.
4. `POST /api/ops/accounting/export/configure` — admin endpoint to save export mode config.
5. `POST /api/ops/accounting/export/trigger` — operator endpoint to generate a period-bounded
   export package; persists an `accounting_export_runs` audit row and returns the CSV payload.
6. `GET /api/ops/accounting/export/runs` — operator endpoint to list export run history.
7. A frontend admin configuration surface (`/accounting/export-config`) and an operator export
   trigger integrated into the existing General Ledger screen.

Format version strings (`xero_csv_v1`, `sage_intacct_gl_csv_v1`, `export_only_v1`) are stored
in both `accounting_export_config` and `accounting_export_runs` so format drift is detectable
without scanning the CSV content.

## Consequences

- Tenants without a live Xero/Sage connection gain a supported export path immediately.
- The export module is stateless and pure-Python; no Temporal workflow needed for this story.
  A future story can wrap it in a Temporal activity if background processing or retry semantics
  are required.
- Format drift risk is mitigated by the explicit `format_version` column; any schema change to a
  provider's import template requires a new version string and new mapping logic, preventing silent
  breakage.
- The `accounting_export_runs` table gives full auditability (actor, period, row count, status)
  without storing the CSV payload in Postgres (the CSV is streamed from the API response).
- Direct Xero/Sage OAuth write-back remains out of scope. If later needed, it should follow the
  ADR-0037 connector framework as a separate story.
- RLS keeps export config and run records strictly tenant-scoped; only `admin` can configure,
  `admin` and `branch_manager` can trigger exports.

## Alternatives considered

- **Store CSV artifact in Supabase storage** — rejected for v1 to avoid blob storage dependency;
  the API streams the CSV directly and the audit row captures metadata. A follow-on story can
  add artifact storage if long-term retrieval is required.
- **Single unified CSV format** — rejected; Xero and Sage Intacct have incompatible import
  schemas (different column names, DR/CR encoding, tax rate handling). A single format would
  require the accountant to remap every time.
- **Temporal activity** — not needed for a synchronous, stateless CSV generation path. Added
  complexity without benefit for v1; keep as a possible follow-on.

## Evidence

- `supabase/migrations/20260617220000_accounting_export_config.sql` — schema
- `supabase/tests/accounting_export_config.sql` — SQL regression tests
- `temporal/src/accounting/export.py` — mapping module
- `temporal/tests/test_accounting_export.py` — unit tests
- `temporal/src/ops_api/app.py` — `/api/ops/accounting/export/*` endpoints
- `frontend/src/routes/accounting/export-config.tsx` — admin configuration UI
- `frontend/src/routes/accounting/general-ledger.tsx` — operator export trigger
- Closes #578 (child of #437)
