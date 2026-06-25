/**
 * AI Reporting — Multi-Dimensional Filters + Charts / Tables
 *
 * Route: /analytics/ai-reporting
 *
 * Features
 * ─────────
 * • Multi-dimensional filter bar: org scope (company / region / branch),
 *   asset category, document type, and date window.
 * • Filter state is canonical in URL search params so any view is
 *   bookmarkable and survives refresh/navigation.
 * • The same filtered result set powers both the Chart view (bar chart by
 *   scope) and the Table view (per-document rows) — no separate aggregation
 *   path exists in the client.
 * • Drilldown: clicking a scope bar or summary row narrows the filter to
 *   that scope and switches to the Table view, keeping totals consistent.
 * • Accessible loading / empty / error states mirror existing analytics
 *   screens.
 * • Export: the filtered result set can be downloaded as CSV, XLSX, or PDF
 *   without re-fetching (ADR-0044).
 *
 * Dependencies
 * ────────────
 * • Reads from v_enterprise_financial_reporting_lines (the reporting semantic
 *   layer view established by #580).  categoryId filter maps to asset_category_id
 *   when the view exposes it; the column is optional and falls back gracefully.
 * • No second aggregation path is created; all filtering and aggregation
 *   derives from the single filtered AiReportingRow array.
 */

import { useCallback, useMemo, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, BarChart3, Table2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { supabase } from '@/data/supabase';
import {
  aiReportingQueryKey,
  buildScopeSummaries,
  formatUSD,
  parseAiReportingSearch,
  rowMatchesFilters,
  type AiReportingFilters,
  type AiReportingRow,
  type ScopeSummary,
  type ScopeType,
} from '@/lib/reporting/ai-reporting-filters';
import {
  buildReportCsv,
  buildReportXlsxBlob,
  reportExportFilename,
  triggerBlobDownload,
  triggerReportPdfPrint,
  MAX_EXPORT_ROWS,
  type ReportPayload,
} from '@/lib/reporting/ai-report-export';

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/analytics/ai-reporting')({
  validateSearch: parseAiReportingSearch,
  component: AiReportingPage,
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchAiReportingRows(): Promise<AiReportingRow[]> {
  const { data, error } = await supabase
    .from('v_enterprise_financial_reporting_lines')
    .select('*')
    .order('document_date', { ascending: false })
    .limit(500);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    source_entity_id: String(row.source_entity_id ?? ''),
    source_entity_type: String(row.source_entity_type ?? ''),
    document_number: String(row.document_number ?? ''),
    document_status: String(row.document_status ?? ''),
    document_date: String(row.document_date ?? ''),
    period_start: row.period_start != null ? String(row.period_start) : null,
    period_end: row.period_end != null ? String(row.period_end) : null,
    originating_scope_id: row.originating_scope_id != null ? String(row.originating_scope_id) : null,
    originating_scope_name: row.originating_scope_name != null ? String(row.originating_scope_name) : null,
    branch_scope_id: row.branch_scope_id != null ? String(row.branch_scope_id) : null,
    branch_scope_name: row.branch_scope_name != null ? String(row.branch_scope_name) : null,
    region_scope_id: row.region_scope_id != null ? String(row.region_scope_id) : null,
    region_scope_name: row.region_scope_name != null ? String(row.region_scope_name) : null,
    company_scope_id: row.company_scope_id != null ? String(row.company_scope_id) : null,
    company_scope_name: row.company_scope_name != null ? String(row.company_scope_name) : null,
    transaction_currency_code: String(row.transaction_currency_code ?? 'USD'),
    reporting_currency_code: String(row.reporting_currency_code ?? 'USD'),
    transaction_total_amount: Number(row.transaction_total_amount ?? 0),
    reporting_total_amount: Number(row.reporting_total_amount ?? 0),
    asset_category_id: row.asset_category_id != null ? String(row.asset_category_id) : null,
    asset_category_name:
      (row as unknown as { asset_category_name?: string | null }).asset_category_name ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Label helpers — map raw backend tokens to operator-readable strings
// ---------------------------------------------------------------------------

/** UUID v4 pattern — used to detect non-humanisable identifiers. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Static labels for known document entity types. */
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  rental_contract: 'Rental contract',
  rental_order: 'Rental order',
};

/**
 * Converts a raw backend token (snake_case or UUID) to a human-readable label.
 * Known types use their canonical label; unknown tokens are sentence-cased.
 */
function humanizeDocumentType(token: string): string {
  if (DOCUMENT_TYPE_LABELS[token]) return DOCUMENT_TYPE_LABELS[token];
  // Sentence-case unknown slug tokens; leave UUIDs unchanged.
  const s = token.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Converts an asset category identifier to an operator-readable label.
 * Prefers an explicit name when available; falls back to sentence-casing
 * slug identifiers.  UUID-shaped values are returned as-is.
 */
function humanizeCategoryLabel(id: string): string {
  // UUIDs: return as-is — no safe transformation exists.
  if (UUID_REGEX.test(id)) return id;
  const s = id.replace(/[-_]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface FilterBarProps {
  filters: AiReportingFilters;
  rows: AiReportingRow[];
  onFiltersChange: (next: Partial<AiReportingFilters>) => void;
}

/** Derives unique scope-id/name pairs for the scope dropdown. */
function deriveScopeOptions(
  rows: AiReportingRow[],
  scopeType: ScopeType,
): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const id =
      scopeType === 'branch'
        ? (row.branch_scope_id ?? '')
        : scopeType === 'region'
          ? (row.region_scope_id ?? '')
          : (row.company_scope_id ?? '');
    const name =
      scopeType === 'branch'
        ? (row.branch_scope_name ?? id)
        : scopeType === 'region'
          ? (row.region_scope_name ?? id)
          : (row.company_scope_name ?? id);
    if (id && !seen.has(id)) seen.set(id, name);
  }
  return Array.from(seen.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function deriveItemTypeOptions(rows: AiReportingRow[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (row.source_entity_type && !seen.has(row.source_entity_type)) {
      seen.set(row.source_entity_type, humanizeDocumentType(row.source_entity_type));
    }
  }
  return Array.from(seen.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function deriveCategoryOptions(rows: AiReportingRow[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (row.asset_category_id && !seen.has(row.asset_category_id)) {
      const label = row.asset_category_name?.trim()
        ? row.asset_category_name.trim()
        : humanizeCategoryLabel(row.asset_category_id);
      seen.set(row.asset_category_id, label);
    }
  }
  return Array.from(seen.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function FilterBar({ filters, rows, onFiltersChange }: FilterBarProps) {
  const scopeOptions = useMemo(() => deriveScopeOptions(rows, filters.scopeType), [rows, filters.scopeType]);
  const itemTypeOptions = useMemo(() => deriveItemTypeOptions(rows), [rows]);
  const categoryOptions = useMemo(() => deriveCategoryOptions(rows), [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report Filters</CardTitle>
        <CardDescription>
          Filter by org scope, asset category, document type, and date window.
          Filter state is saved in the URL — bookmark this page to restore the same view.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Scope type */}
          <div className="space-y-1">
            <Label htmlFor="ai-report-scope-type">Scope Level</Label>
            <select
              id="ai-report-scope-type"
              aria-label="Scope Level"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filters.scopeType}
              onChange={(e) => {
                onFiltersChange({ scopeType: e.target.value as ScopeType, scopeId: '' });
              }}
            >
              <option value="company">Company</option>
              <option value="region">Region</option>
              <option value="branch">Branch</option>
            </select>
          </div>

          {/* Scope ID */}
          <div className="space-y-1">
            <Label htmlFor="ai-report-scope-id">Org Scope</Label>
            <select
              id="ai-report-scope-id"
              aria-label="Org Scope"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filters.scopeId}
              onChange={(e) => onFiltersChange({ scopeId: e.target.value })}
            >
              <option value="">All</option>
              {scopeOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.name}
                </option>
              ))}
            </select>
          </div>

          {/* Asset category */}
          <div className="space-y-1">
            <Label htmlFor="ai-report-category">Asset Category</Label>
            <select
              id="ai-report-category"
              aria-label="Asset Category"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filters.categoryId}
              onChange={(e) => onFiltersChange({ categoryId: e.target.value })}
            >
              <option value="">All Categories</option>
              {categoryOptions.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>

          {/* Document / item type */}
          <div className="space-y-1">
            <Label htmlFor="ai-report-item-type">Document Type</Label>
            <select
              id="ai-report-item-type"
              aria-label="Document Type"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={filters.itemType}
              onChange={(e) => onFiltersChange({ itemType: e.target.value })}
            >
              <option value="">All Types</option>
              {itemTypeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date range */}
          <div className="space-y-1">
            <Label htmlFor="ai-report-start">Period Start</Label>
            <Input
              id="ai-report-start"
              aria-label="Period Start"
              type="date"
              value={filters.start}
              onChange={(e) => onFiltersChange({ start: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-report-end">Period End</Label>
            <Input
              id="ai-report-end"
              aria-label="Period End"
              type="date"
              value={filters.end}
              onChange={(e) => onFiltersChange({ end: e.target.value })}
            />
          </div>

          {/* View toggle */}
          <div className="space-y-1 lg:col-span-2">
            <Label>View</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={filters.view === 'chart' ? 'default' : 'outline'}
                size="sm"
                onClick={() => onFiltersChange({ view: 'chart' })}
              >
                <BarChart3 className="mr-1 h-4 w-4" aria-hidden />
                Chart
              </Button>
              <Button
                type="button"
                variant={filters.view === 'table' ? 'default' : 'outline'}
                size="sm"
                onClick={() => onFiltersChange({ view: 'table' })}
              >
                <Table2 className="mr-1 h-4 w-4" aria-hidden />
                Table
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary KPI strip
// ---------------------------------------------------------------------------

interface KpiStripProps {
  filteredRows: AiReportingRow[];
  totalRows: number;
}

function KpiStrip({ filteredRows, totalRows }: KpiStripProps) {
  const total = useMemo(
    () => filteredRows.reduce((acc, r) => acc + r.reporting_total_amount, 0),
    [filteredRows],
  );

  return (
    <div
      className="grid grid-cols-2 gap-4 sm:grid-cols-3"
      data-testid="ai-report-kpi-strip"
    >
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Matched Documents</CardDescription>
          <CardTitle className="text-2xl" data-testid="ai-report-kpi-count">
            {filteredRows.length.toLocaleString()}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {totalRows} total in window
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Reporting Total (USD)</CardDescription>
          <CardTitle className="text-2xl" data-testid="ai-report-kpi-total">
            {formatUSD(total)}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Sum of reporting_total_amount across matched rows
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Scope Segments</CardDescription>
          <CardTitle className="text-2xl" data-testid="ai-report-kpi-segments">
            {new Set(filteredRows.map((r) => r.company_scope_id ?? '')).size}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Distinct companies in result set
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart view
// ---------------------------------------------------------------------------

interface ChartBarProps {
  summary: ScopeSummary;
  maxTotal: number;
  onDrilldown: (summary: ScopeSummary) => void;
}

function ChartBar({ summary, maxTotal, onDrilldown }: ChartBarProps) {
  const pct = maxTotal > 0 ? (summary.reportingTotal / maxTotal) * 100 : 0;
  return (
    <div
      className="space-y-1"
      data-testid={`ai-report-chart-bar-${summary.scopeId}`}
    >
      <div className="flex items-center justify-between text-sm">
        <button
          className="font-medium hover:underline focus-visible:underline truncate max-w-[60%] text-left"
          aria-label={`Drilldown: ${summary.scopeName}`}
          onClick={() => onDrilldown(summary)}
        >
          {summary.scopeName}
        </button>
        <span className="text-muted-foreground tabular-nums">
          {formatUSD(summary.reportingTotal)}
          {' '}
          <span className="text-xs">({summary.documentCount})</span>
        </span>
      </div>
      <div
        className="h-3 w-full rounded bg-muted overflow-hidden"
        role="meter"
        aria-label={`${summary.scopeName}: ${formatUSD(summary.reportingTotal)}`}
        aria-valuenow={summary.reportingTotal}
        aria-valuemin={0}
        aria-valuemax={maxTotal}
      >
        <div
          className="h-full rounded bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

interface ChartViewProps {
  filteredRows: AiReportingRow[];
  filters: AiReportingFilters;
  onDrilldown: (summary: ScopeSummary) => void;
}

function ChartView({ filteredRows, filters, onDrilldown }: ChartViewProps) {
  const summaries = useMemo(
    () => buildScopeSummaries(filteredRows, filters.scopeType),
    [filteredRows, filters.scopeType],
  );
  const maxTotal = useMemo(
    () => summaries.reduce((m, s) => Math.max(m, s.reportingTotal), 0),
    [summaries],
  );

  if (summaries.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed p-8 text-center text-muted-foreground"
        data-testid="ai-report-empty-chart"
        role="status"
      >
        No data found for the selected filters. Try adjusting your filters or date range.
      </div>
    );
  }

  return (
    <Card data-testid="ai-report-chart">
      <CardHeader>
        <CardTitle>
          Revenue by{' '}
          {filters.scopeType === 'branch'
            ? 'Branch'
            : filters.scopeType === 'region'
              ? 'Region'
              : 'Company'}
        </CardTitle>
        <CardDescription>
          Click a row to drilldown into its documents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summaries.map((s) => (
          <ChartBar
            key={s.scopeId}
            summary={s}
            maxTotal={maxTotal}
            onDrilldown={onDrilldown}
          />
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------

interface TableViewProps {
  filteredRows: AiReportingRow[];
}

function TableView({ filteredRows }: TableViewProps) {
  if (filteredRows.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed p-8 text-center text-muted-foreground"
        data-testid="ai-report-empty-table"
        role="status"
      >
        No data matches the current filters. Adjust the scope, category, type,
        or date range to see results.
      </div>
    );
  }

  return (
    <Card data-testid="ai-report-table">
      <CardHeader>
        <CardTitle>Document Detail</CardTitle>
        <CardDescription>
          {filteredRows.length} document{filteredRows.length !== 1 ? 's' : ''} match the active filters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document #</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Region</TableHead>
              <TableHead className="text-right">Reporting Total</TableHead>
              <TableHead>Currency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row) => (
              <TableRow
                key={row.source_entity_id}
                data-testid={`ai-report-row-${row.source_entity_id}`}
              >
                <TableCell className="font-mono text-sm">
                  {row.document_number || row.source_entity_id}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{humanizeDocumentType(row.source_entity_type)}</Badge>
                </TableCell>
                <TableCell>{row.document_status}</TableCell>
                <TableCell>{row.document_date}</TableCell>
                <TableCell>{row.branch_scope_name ?? '—'}</TableCell>
                <TableCell>{row.region_scope_name ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUSD(row.reporting_total_amount)}
                </TableCell>
                <TableCell>{row.reporting_currency_code}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Export helper — converts filtered rows to a portable ReportPayload
// ---------------------------------------------------------------------------

function filteredRowsToReportPayload(
  filteredRows: AiReportingRow[],
  filters: AiReportingFilters,
): ReportPayload {
  const columns = [
    { key: 'document_number', label: 'Document #', format: 'text' as const },
    { key: 'source_entity_type', label: 'Type', format: 'text' as const },
    { key: 'document_status', label: 'Status', format: 'text' as const },
    { key: 'document_date', label: 'Date', format: 'date' as const },
    { key: 'branch_scope_name', label: 'Branch', format: 'text' as const },
    { key: 'region_scope_name', label: 'Region', format: 'text' as const },
    { key: 'reporting_total_amount', label: 'Reporting Total', format: 'currency' as const },
    { key: 'reporting_currency_code', label: 'Currency', format: 'text' as const },
  ];

  const rows = filteredRows.slice(0, MAX_EXPORT_ROWS).map((r) => ({
    document_number: r.document_number || r.source_entity_id,
    source_entity_type: r.source_entity_type,
    document_status: r.document_status,
    document_date: r.document_date,
    branch_scope_name: r.branch_scope_name ?? '',
    region_scope_name: r.region_scope_name ?? '',
    reporting_total_amount: r.reporting_total_amount,
    reporting_currency_code: r.reporting_currency_code,
  }));

  const activeFilters: Record<string, string> = {};
  if (filters.scopeType) activeFilters.scope_type = filters.scopeType;
  if (filters.scopeId) activeFilters.scope_id = filters.scopeId;
  if (filters.categoryId) activeFilters.category = filters.categoryId;
  if (filters.itemType) activeFilters.item_type = filters.itemType;
  if (filters.start) activeFilters.start = filters.start;
  if (filters.end) activeFilters.end = filters.end;

  return {
    question: 'AI Reporting export',
    generatedAt: new Date().toISOString(),
    filters: activeFilters,
    columns,
    rows,
    truncated: filteredRows.length > MAX_EXPORT_ROWS,
    totalRowCount: filteredRows.length,
  };
}

// ---------------------------------------------------------------------------
// Root screen component (exported for testing)
// ---------------------------------------------------------------------------

export interface AiReportingScreenProps {
  filters: AiReportingFilters;
  onFiltersChange: (next: Partial<AiReportingFilters>) => void;
}

export function AiReportingScreen({
  filters,
  onFiltersChange,
}: AiReportingScreenProps) {
  const query = useQuery({
    queryKey: aiReportingQueryKey(filters),
    queryFn: fetchAiReportingRows,
    staleTime: 30_000,
  });

  const [isExportingXlsx, setIsExportingXlsx] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const allRows = useMemo(() => query.data ?? [], [query.data]);

  const filteredRows = useMemo(
    () => allRows.filter((row) => rowMatchesFilters(row, filters)),
    [allRows, filters],
  );

  const handleDrilldown = useCallback(
    (summary: ScopeSummary) => {
      onFiltersChange({ scopeId: summary.scopeId, view: 'table' });
    },
    [onFiltersChange],
  );

  const handleExportCsv = useCallback(() => {
    const payload = filteredRowsToReportPayload(filteredRows, filters);
    try {
      const csv = buildReportCsv(payload);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      triggerBlobDownload(blob, reportExportFilename(payload, 'csv'));
      const rowCount = Math.min(filteredRows.length, MAX_EXPORT_ROWS);
      setExportMessage(`CSV download started — ${rowCount} row${rowCount === 1 ? '' : 's'}.`);
    } catch {
      setExportMessage('CSV export failed. Please try again.');
    }
  }, [filteredRows, filters]);

  const handleExportXlsx = useCallback(async () => {
    const payload = filteredRowsToReportPayload(filteredRows, filters);
    setIsExportingXlsx(true);
    try {
      const blob = buildReportXlsxBlob(payload);
      triggerBlobDownload(blob, reportExportFilename(payload, 'xlsx'));
      const rowCount = Math.min(filteredRows.length, MAX_EXPORT_ROWS);
      setExportMessage(`Excel download started — ${rowCount} row${rowCount === 1 ? '' : 's'}.`);
    } catch {
      setExportMessage('Excel export failed. Please try again.');
    } finally {
      setIsExportingXlsx(false);
    }
  }, [filteredRows, filters]);

  const handleExportPdf = useCallback(() => {
    triggerReportPdfPrint();
    setExportMessage('Print / Save PDF dialog opened.');
  }, []);

  return (
    <div className="space-y-6 print:p-0">
      <div className="space-y-1 print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">AI Reporting</h1>
        <p className="text-sm text-muted-foreground">
          Multi-dimensional filters over the rental reporting dataset.
          Filter selections are bookmarkable via URL.
        </p>
      </div>

      <FilterBar
        filters={filters}
        rows={allRows}
        onFiltersChange={onFiltersChange}
      />

      {query.isError && (
        <Alert variant="destructive" data-testid="ai-report-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Unable to load reporting data</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error
              ? query.error.message
              : 'An unexpected error occurred. Please try again.'}
          </AlertDescription>
        </Alert>
      )}

      {query.isLoading && (
        filters.view === 'chart' ? (
          <div
            className="rounded-lg border border-dashed p-8 text-center text-muted-foreground"
            aria-busy="true"
            aria-live="polite"
            data-testid="ai-report-loading"
            role="status"
          >
            Loading chart data...
          </div>
        ) : (
          <div
            className="space-y-3"
            aria-busy="true"
            aria-label="Loading reporting data"
            data-testid="ai-report-loading"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        )
      )}

      {query.isSuccess && (
        <>
          <KpiStrip filteredRows={filteredRows} totalRows={allRows.length} />

          <div className="flex flex-wrap items-center justify-end gap-2 print:hidden" data-testid="ai-report-export-toolbar">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              data-testid="export-csv-btn"
            >
              Export CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleExportXlsx()}
              disabled={isExportingXlsx}
              data-testid="export-xlsx-btn"
            >
              {isExportingXlsx ? 'Building…' : 'Export Excel'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleExportPdf}
              data-testid="export-pdf-btn"
            >
              Print / Save PDF
            </Button>
          </div>

          {exportMessage && (
            <Alert className="print:hidden" data-testid="export-message">
              <AlertDescription>{exportMessage}</AlertDescription>
            </Alert>
          )}

          {filters.view === 'chart' ? (
            <ChartView
              filteredRows={filteredRows}
              filters={filters}
              onDrilldown={handleDrilldown}
            />
          ) : (
            <TableView filteredRows={filteredRows} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route page wrapper — owns URL ↔ state sync
// ---------------------------------------------------------------------------

export function AiReportingPage() {
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const handleFiltersChange = useCallback(
    (next: Partial<AiReportingFilters>) => {
      void navigate({
        search: (prev) => parseAiReportingSearch({ ...prev, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <AiReportingScreen
      filters={filters}
      onFiltersChange={handleFiltersChange}
    />
  );
}
