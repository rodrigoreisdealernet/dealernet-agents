/**
 * AI Reporting — Multi-Dimensional Filter Contract
 *
 * Single module that owns the canonical filter shape, URL search-param
 * normalisation, and TanStack Query key generation for the AI reporting
 * dashboard.  Both chart and table views consume the same parsed filter
 * object so their result sets cannot diverge.
 *
 * Filter dimensions (all map directly to URL search params):
 *   scopeType  — 'company' | 'region' | 'branch'
 *   scopeId    — free string; empty means "all" for the chosen scope level
 *   categoryId — asset category; empty means "all categories"
 *   itemType   — document / entity type (e.g. 'invoice'); empty means "all"
 *   start      — ISO date string (YYYY-MM-DD); default last 90 days
 *   end        — ISO date string (YYYY-MM-DD); default today
 *   view       — 'chart' | 'table'
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeType = 'company' | 'region' | 'branch';
export type ViewMode = 'chart' | 'table';

/** Canonical filter state carried by URL search params. */
export interface AiReportingFilters {
  scopeType: ScopeType;
  scopeId: string;
  categoryId: string;
  itemType: string;
  start: string;
  end: string;
  view: ViewMode;
}

/** Default date window: last 90 days. */
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readScopeType(value: unknown): ScopeType {
  if (value === 'region' || value === 'branch') return value;
  return 'company';
}

function readViewMode(value: unknown): ViewMode {
  if (value === 'table') return 'table';
  return 'chart';
}

function readString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const t = value.trim();
  return t.length > 0 ? t : fallback;
}

function readDateParam(value: unknown, fallback: string): string {
  const s = readString(value);
  return ISO_DATE_RE.test(s) ? s : fallback;
}

// ---------------------------------------------------------------------------
// URL search param normalisation (used by TanStack Router validateSearch)
// ---------------------------------------------------------------------------

/**
 * Normalises raw URL search params into a well-typed AiReportingFilters
 * object.  Safe to call with any untrusted input — every field has a
 * meaningful default.
 */
export function parseAiReportingSearch(
  search: Record<string, unknown>,
): AiReportingFilters {
  return {
    scopeType: readScopeType(search.scopeType),
    scopeId: readString(search.scopeId),
    categoryId: readString(search.categoryId),
    itemType: readString(search.itemType),
    start: readDateParam(search.start, defaultStart()),
    end: readDateParam(search.end, defaultEnd()),
    view: readViewMode(search.view),
  };
}

// ---------------------------------------------------------------------------
// TanStack Query key factory
// ---------------------------------------------------------------------------

/**
 * Returns a stable query key for the given filter state so that chart and
 * table views always share the same cache entry.
 */
export function aiReportingQueryKey(filters: AiReportingFilters): readonly unknown[] {
  return [
    'ai-reporting',
    filters.scopeType,
    filters.scopeId,
    filters.categoryId,
    filters.itemType,
    filters.start,
    filters.end,
  ] as const;
}

// ---------------------------------------------------------------------------
// Row-level filter predicate
// ---------------------------------------------------------------------------

export interface AiReportingRow {
  source_entity_id: string;
  source_entity_type: string;
  document_number: string;
  document_status: string;
  document_date: string;
  period_start: string | null;
  period_end: string | null;
  originating_scope_id: string | null;
  originating_scope_name: string | null;
  branch_scope_id: string | null;
  branch_scope_name: string | null;
  region_scope_id: string | null;
  region_scope_name: string | null;
  company_scope_id: string | null;
  company_scope_name: string | null;
  transaction_currency_code: string;
  reporting_currency_code: string;
  transaction_total_amount: number;
  reporting_total_amount: number;
  /** Optional asset category dimension — populated when the underlying view
   *  joins to asset data.  Falls back to empty string. */
  asset_category_id?: string | null;
  /** Human-readable category name when the view exposes it. */
  asset_category_name?: string | null;
}

function scopeIdForRow(row: AiReportingRow, scopeType: ScopeType): string {
  switch (scopeType) {
    case 'branch': return row.branch_scope_id ?? '';
    case 'region': return row.region_scope_id ?? '';
    case 'company': return row.company_scope_id ?? '';
  }
}

/**
 * Returns true when a row passes all active filter dimensions.
 * An empty string in scopeId/categoryId/itemType means "all" — no filtering
 * on that dimension.
 */
export function rowMatchesFilters(
  row: AiReportingRow,
  filters: AiReportingFilters,
): boolean {
  // Org scope
  if (filters.scopeId) {
    const rowScope = scopeIdForRow(row, filters.scopeType);
    if (rowScope !== filters.scopeId) return false;
  }

  // Asset category
  if (filters.categoryId) {
    const rowCat = row.asset_category_id ?? '';
    if (rowCat !== filters.categoryId) return false;
  }

  // Document / entity type
  if (filters.itemType) {
    if (row.source_entity_type !== filters.itemType) return false;
  }

  // Date window (document_date)
  if (filters.start && row.document_date < filters.start) return false;
  if (filters.end && row.document_date > filters.end) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Aggregation helpers for chart data
// ---------------------------------------------------------------------------

export interface ScopeSummary {
  scopeId: string;
  scopeName: string;
  documentCount: number;
  reportingTotal: number;
  currencies: string[];
}

function scopeNameForRow(row: AiReportingRow, scopeType: ScopeType): string {
  switch (scopeType) {
    case 'branch': return row.branch_scope_name ?? row.branch_scope_id ?? '';
    case 'region': return row.region_scope_name ?? row.region_scope_id ?? '';
    case 'company': return row.company_scope_name ?? row.company_scope_id ?? '';
  }
}

/**
 * Aggregates a filtered row set into per-scope summaries used by both the
 * chart and the drilldown panel.
 */
export function buildScopeSummaries(
  rows: AiReportingRow[],
  scopeType: ScopeType,
): ScopeSummary[] {
  const map = new Map<string, ScopeSummary>();

  for (const row of rows) {
    const id = scopeIdForRow(row, scopeType);
    const name = scopeNameForRow(row, scopeType);
    const key = id || '__unscoped__';

    let entry = map.get(key);
    if (!entry) {
      entry = {
        scopeId: id,
        scopeName: name || 'Unknown',
        documentCount: 0,
        reportingTotal: 0,
        currencies: [],
      };
      map.set(key, entry);
    }

    entry.documentCount += 1;
    entry.reportingTotal += row.reporting_total_amount;

    if (!entry.currencies.includes(row.reporting_currency_code)) {
      entry.currencies.push(row.reporting_currency_code);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.reportingTotal - a.reportingTotal);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Rounds to two decimal places (avoids floating-point drift in totals). */
export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
