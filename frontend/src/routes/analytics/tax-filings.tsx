import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';

export const Route = createFileRoute('/analytics/tax-filings')({
  component: TaxFilingsPage,
});

interface TaxFilingSummaryRow {
  filing_period_start: string;
  filing_period_end: string;
  jurisdiction_code: string;
  jurisdiction_name: string | null;
  taxable_amount: number;
  exempt_amount: number;
  collected_tax_amount: number;
  refunded_tax_amount: number;
  tax_event_count: number;
}

interface TaxFilingExportRow {
  export_row_key: string;
  filing_period_start: string;
  filing_period_end: string;
  jurisdiction_code: string;
  jurisdiction_name: string | null;
  source_event_id: string;
  event_type: 'invoice_finalized' | 'credit' | 'refund' | 'void';
  snapshot_effective_at: string;
  taxable_amount: number;
  exempt_amount: number;
  collected_tax_amount: number;
  signed_collected_tax_amount: number;
  refunded_tax_amount: number;
}

function TaxFilingsPage() {
  return <TaxFilingsScreen />;
}

function toNumberOrZero(value: unknown) {
  return Number(value ?? 0);
}

function toEventType(value: unknown): TaxFilingExportRow['event_type'] {
  if (value === 'invoice_finalized' || value === 'credit' || value === 'refund' || value === 'void') {
    return value;
  }
  throw new Error(`Unexpected tax filing event_type: ${String(value)}`);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function toCsvValue(value: string | number | null) {
  if (value == null) {
    return '';
  }

  const stringValue = String(value);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function buildTaxFilingCsv(rows: TaxFilingExportRow[]) {
  const columns = [
    'export_row_key',
    'filing_period_start',
    'filing_period_end',
    'jurisdiction_code',
    'jurisdiction_name',
    'source_event_id',
    'event_type',
    'snapshot_effective_at',
    'taxable_amount',
    'exempt_amount',
    'collected_tax_amount',
    'signed_collected_tax_amount',
    'refunded_tax_amount',
  ] as const;

  const body = rows.map((row) =>
    columns
      .map((column) => toCsvValue(row[column] as string | number | null))
      .join(',')
  );

  return [columns.join(','), ...body].join('\n');
}

async function fetchTaxFilingSummaryRows(): Promise<TaxFilingSummaryRow[]> {
  const pageSize = 1000;
  const rows: Record<string, unknown>[] = [];
  let pageStart = 0;
  let hasMore = true;

  while (hasMore) {
    const pageEnd = pageStart + pageSize - 1;
    const { data, error } = await supabase
      .from('v_invoice_tax_filing_period_jurisdiction_summary')
      .select('*')
      .order('filing_period_start', { ascending: false })
      .order('jurisdiction_code', { ascending: true })
      .range(pageStart, pageEnd);

    if (error) {
      throw error;
    }

    const pageRows = data ?? [];
    rows.push(...pageRows);
    hasMore = pageRows.length === pageSize;
    if (hasMore) {
      pageStart += pageSize;
    }
  }

  return rows.map((row) => ({
    filing_period_start: String(row.filing_period_start ?? ''),
    filing_period_end: String(row.filing_period_end ?? ''),
    jurisdiction_code: String(row.jurisdiction_code ?? ''),
    jurisdiction_name: row.jurisdiction_name != null ? String(row.jurisdiction_name) : null,
    taxable_amount: toNumberOrZero(row.taxable_amount),
    exempt_amount: toNumberOrZero(row.exempt_amount),
    collected_tax_amount: toNumberOrZero(row.collected_tax_amount),
    refunded_tax_amount: toNumberOrZero(row.refunded_tax_amount),
    tax_event_count: toNumberOrZero(row.tax_event_count),
  }));
}

async function fetchTaxFilingExportRows(): Promise<TaxFilingExportRow[]> {
  const pageSize = 1000;
  const rows: Record<string, unknown>[] = [];
  let pageStart = 0;
  let hasMore = true;

  while (hasMore) {
    const pageEnd = pageStart + pageSize - 1;
    const { data, error } = await supabase
      .from('v_invoice_tax_filing_export_rows')
      .select('*')
      .order('filing_period_start', { ascending: false })
      .order('jurisdiction_code', { ascending: true })
      .order('source_event_id', { ascending: true })
      .range(pageStart, pageEnd);

    if (error) {
      throw error;
    }

    const pageRows = data ?? [];
    rows.push(...pageRows);
    hasMore = pageRows.length === pageSize;
    if (hasMore) {
      pageStart += pageSize;
    }
  }

  return rows.map((row) => ({
    export_row_key: String(row.export_row_key ?? ''),
    filing_period_start: String(row.filing_period_start ?? ''),
    filing_period_end: String(row.filing_period_end ?? ''),
    jurisdiction_code: String(row.jurisdiction_code ?? ''),
    jurisdiction_name: row.jurisdiction_name != null ? String(row.jurisdiction_name) : null,
    source_event_id: String(row.source_event_id ?? ''),
    event_type: toEventType(row.event_type),
    snapshot_effective_at: String(row.snapshot_effective_at ?? ''),
    taxable_amount: toNumberOrZero(row.taxable_amount),
    exempt_amount: toNumberOrZero(row.exempt_amount),
    collected_tax_amount: toNumberOrZero(row.collected_tax_amount),
    signed_collected_tax_amount: toNumberOrZero(row.signed_collected_tax_amount),
    refunded_tax_amount: toNumberOrZero(row.refunded_tax_amount),
  }));
}

export function TaxFilingsScreen() {
  const summaryQuery = useQuery({
    queryKey: ['tax-filing-summary'],
    queryFn: fetchTaxFilingSummaryRows,
  });

  const exportQuery = useQuery({
    queryKey: ['tax-filing-export-rows'],
    queryFn: fetchTaxFilingExportRows,
  });

  const [filingPeriodStart, setFilingPeriodStart] = useState('');
  const [jurisdictionFilter, setJurisdictionFilter] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState<'all' | TaxFilingExportRow['event_type']>('all');

  const summaryRows = useMemo(() => summaryQuery.data ?? [], [summaryQuery.data]);
  const exportRows = useMemo(() => exportQuery.data ?? [], [exportQuery.data]);

  const filingPeriods = useMemo(
    () => Array.from(new Set(summaryRows.map((row) => row.filing_period_start))).sort((left, right) => right.localeCompare(left)),
    [summaryRows]
  );

  const filteredSummaryRows = useMemo(() => {
    const jurisdiction = jurisdictionFilter.trim().toLowerCase();
    return summaryRows.filter((row) => {
      if (filingPeriodStart && row.filing_period_start !== filingPeriodStart) {
        return false;
      }

      if (!jurisdiction) {
        return true;
      }

      return row.jurisdiction_code.toLowerCase().includes(jurisdiction)
        || (row.jurisdiction_name ?? '').toLowerCase().includes(jurisdiction);
    });
  }, [summaryRows, filingPeriodStart, jurisdictionFilter]);

  const filteredExportRows = useMemo(() => {
    const jurisdiction = jurisdictionFilter.trim().toLowerCase();
    return exportRows.filter((row) => {
      if (filingPeriodStart && row.filing_period_start !== filingPeriodStart) {
        return false;
      }

      if (eventTypeFilter !== 'all' && row.event_type !== eventTypeFilter) {
        return false;
      }

      if (!jurisdiction) {
        return true;
      }

      return row.jurisdiction_code.toLowerCase().includes(jurisdiction)
        || (row.jurisdiction_name ?? '').toLowerCase().includes(jurisdiction);
    });
  }, [exportRows, filingPeriodStart, jurisdictionFilter, eventTypeFilter]);

  const totalCollected = useMemo(
    () => filteredSummaryRows.reduce((total, row) => total + row.collected_tax_amount, 0),
    [filteredSummaryRows]
  );
  const totalRefunded = useMemo(
    () => filteredSummaryRows.reduce((total, row) => total + row.refunded_tax_amount, 0),
    [filteredSummaryRows]
  );

  if (summaryQuery.isLoading || exportQuery.isLoading) {
    return <div data-testid="tax-filing-loading">Loading tax filing summaries…</div>;
  }

  if (summaryQuery.isError || exportQuery.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load tax filing data</AlertTitle>
        <AlertDescription>Confirm authenticated access to tax filing snapshot views and refresh.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6" data-testid="tax-filing-screen">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sales Tax Filing</h1>
        <p className="text-sm text-muted-foreground">
          Inspect multi-jurisdiction tax snapshots by filing period and export deterministic filing rows.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filing Filters</CardTitle>
          <CardDescription>Filter filing artifacts by filing month, jurisdiction, and event type.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="tax-filing-period">Filing Month</Label>
            <select
              id="tax-filing-period"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={filingPeriodStart}
              onChange={(event) => setFilingPeriodStart(event.target.value)}
            >
              <option value="">All filing months</option>
              {filingPeriods.map((periodStart) => (
                <option key={periodStart} value={periodStart}>
                  {periodStart}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax-jurisdiction-filter">Jurisdiction</Label>
            <Input
              id="tax-jurisdiction-filter"
              placeholder="Filter by code or name"
              value={jurisdictionFilter}
              onChange={(event) => setJurisdictionFilter(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax-event-type-filter">Event Type</Label>
            <select
              id="tax-event-type-filter"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={eventTypeFilter}
              onChange={(event) => setEventTypeFilter(event.target.value as typeof eventTypeFilter)}
            >
              <option value="all">All events</option>
              <option value="invoice_finalized">invoice_finalized</option>
              <option value="credit">credit</option>
              <option value="refund">refund</option>
              <option value="void">void</option>
            </select>
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              className="w-full"
              disabled={filteredExportRows.length === 0}
              onClick={() => {
                const csv = buildTaxFilingCsv(filteredExportRows);
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const objectUrl = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = objectUrl;
                const filingPeriodLabel = filingPeriodStart ? filingPeriodStart.slice(0, 7) : 'all-periods';
                link.download = `tax-filing-export-${filingPeriodLabel}.csv`;
                link.click();
                URL.revokeObjectURL(objectUrl);
              }}
            >
              Export Filing CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Jurisdictions in scope</CardDescription>
            <CardTitle>{filteredSummaryRows.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {filteredSummaryRows.reduce((total, row) => total + row.tax_event_count, 0)} tax events
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Collected tax</CardDescription>
            <CardTitle>{formatCurrency(totalCollected)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Signed total before refunds</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Refunded / reversed tax</CardDescription>
            <CardTitle>{formatCurrency(totalRefunded)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Offsets from credit/refund/void events</CardContent>
        </Card>
      </div>

      <Card data-testid="tax-filing-summary-table">
        <CardHeader>
          <CardTitle>Filing period summary by jurisdiction</CardTitle>
          <CardDescription>Persisted snapshot summary rollups for filing.</CardDescription>
        </CardHeader>
        <CardContent>
          {filteredSummaryRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No jurisdiction summaries match the current filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Filing Month</th>
                    <th className="p-2">Jurisdiction</th>
                    <th className="p-2">Taxable</th>
                    <th className="p-2">Exempt</th>
                    <th className="p-2">Collected</th>
                    <th className="p-2">Refunded</th>
                    <th className="p-2">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSummaryRows.map((row) => (
                    <tr
                      key={`${row.filing_period_start}:${row.jurisdiction_code}`}
                      className="border-b"
                      data-testid={`tax-summary-row-${row.filing_period_start}-${row.jurisdiction_code}`}
                    >
                      <td className="p-2">{row.filing_period_start}</td>
                      <td className="p-2">
                        <div className="font-medium">{row.jurisdiction_code}</div>
                        {row.jurisdiction_name && <div className="text-xs text-muted-foreground">{row.jurisdiction_name}</div>}
                      </td>
                      <td className="p-2">{formatCurrency(row.taxable_amount)}</td>
                      <td className="p-2">{formatCurrency(row.exempt_amount)}</td>
                      <td className="p-2">{formatCurrency(row.collected_tax_amount)}</td>
                      <td className="p-2">{formatCurrency(row.refunded_tax_amount)}</td>
                      <td className="p-2">{row.tax_event_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="tax-filing-export-preview">
        <CardHeader>
          <CardTitle>Deterministic export preview</CardTitle>
          <CardDescription>Filtered export rows preserve signed tax amounts and stable row keys.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {filteredExportRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No filing export rows match the current filters.</p>
          ) : filteredExportRows.slice(0, 12).map((row) => (
            <div key={row.export_row_key} className="rounded-md border p-3 text-sm" data-testid={`tax-export-row-${row.export_row_key}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">{row.jurisdiction_code} · {row.source_event_id}</div>
                  <div className="text-xs text-muted-foreground">{row.filing_period_start} · {row.snapshot_effective_at}</div>
                </div>
                <Badge variant={row.event_type === 'invoice_finalized' ? 'secondary' : 'outline'}>{row.event_type}</Badge>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Signed tax: {formatCurrency(row.signed_collected_tax_amount)} · Refunded: {formatCurrency(row.refunded_tax_amount)}
              </div>
            </div>
          ))}
          {filteredExportRows.length > 12 && (
            <p className="text-xs text-muted-foreground">Showing 12 of {filteredExportRows.length} filtered export rows.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
