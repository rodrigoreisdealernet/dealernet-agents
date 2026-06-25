import { useEffect, useMemo, useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useAuth } from '@/auth/AuthContext';
import { canViewGeneralLedger, type AppRole } from '@/auth/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type LedgerBasis = 'all' | 'accrual' | 'cash';

interface GeneralLedgerRow {
  id: string;
  posted_at: string;
  basis: 'accrual' | 'cash';
  customer_id: string | null;
  billing_account_id: string | null;
  branch_id: string | null;
  gl_account_code: string;
  gl_account_name: string;
  counter_account_code: string | null;
  counter_account_name: string | null;
  source_document_type: string;
  source_document_id: string;
  source_document_number: string;
  source_amount: number;
  debit_amount: number;
  credit_amount: number;
  currency_code: string;
  sync_status: string;
  export_status: string;
  source_document_path: string;
}

interface EntityOption {
  id: string;
  label: string;
}

const PAGE_SIZE = 100;

export const Route = createFileRoute('/accounting/general-ledger')({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error || !canViewGeneralLedger(asAppRole(data.session?.user?.app_metadata?.role))) {
      throw redirect({ to: '/' });
    }
  },
  component: GeneralLedgerPage,
});

function toNumeric(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString();
}

function formatCurrency(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function csvEscape(value: unknown): string {
  const text = String(value ?? '');
  const formulaSafeText = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  if (formulaSafeText.includes(',') || formulaSafeText.includes('"') || formulaSafeText.includes('\n')) {
    return `"${formulaSafeText.replace(/"/g, '""')}"`;
  }
  return formulaSafeText;
}

interface LabelMaps {
  customer: Map<string, string>;
  billingAccount: Map<string, string>;
  branch: Map<string, string>;
}

function resolveLabelOrFallback(id: string | null, labelMap?: Map<string, string>): string {
  if (id) {
    return (labelMap?.get(id) ?? id);
  }
  return '—';
}

export function buildGeneralLedgerCsv(rows: GeneralLedgerRow[], labelMaps?: LabelMaps): string {
  const headers = [
    'Posted At',
    'Basis',
    'Document Type',
    'Document Number',
    'Customer',
    'Billing Account',
    'Location',
    'GL Account',
    'Counter Account',
    'Source Amount',
    'Debit',
    'Credit',
    'Currency',
    'Sync Status',
    'Export Status',
    'Drill Down Path',
  ];
  const lines = rows.map((row) => [
    row.posted_at,
    row.basis,
    row.source_document_type,
    row.source_document_number,
    resolveLabelOrFallback(row.customer_id, labelMaps?.customer),
    resolveLabelOrFallback(row.billing_account_id, labelMaps?.billingAccount),
    resolveLabelOrFallback(row.branch_id, labelMaps?.branch),
    `${row.gl_account_code} ${row.gl_account_name}`,
    `${row.counter_account_code || ''} ${row.counter_account_name || ''}`.trim(),
    row.source_amount.toFixed(2),
    row.debit_amount.toFixed(2),
    row.credit_amount.toFixed(2),
    row.currency_code,
    row.sync_status,
    row.export_status,
    row.source_document_path,
  ]);

  return [headers, ...lines].map((line) => line.map(csvEscape).join(',')).join('\n');
}

async function fetchEntityOptions(entityType: string, fallbackLabel: string): Promise<EntityOption[]> {
  const { data, error } = await supabase
    .from('entities')
    .select('id, entity_versions!inner(data, is_current)')
    .eq('entity_type', entityType)
    .eq('entity_versions.is_current', true)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    throw error;
  }

  return ((data || []) as Array<{ id: string; entity_versions?: Array<{ data?: Record<string, unknown> }> }>).map((row) => {
    const versionData = row.entity_versions?.[0]?.data || {};
    const label =
      (typeof versionData.name === 'string' && versionData.name)
      || (typeof versionData.account_number === 'string' && versionData.account_number)
      || fallbackLabel;

    return { id: row.id, label };
  });
}

async function fetchGeneralLedger(filters: {
  startDate: string;
  endDate: string;
  customerId: string;
  billingAccountId: string;
  branchId: string;
  glCode: string;
  basis: LedgerBasis;
}, pagination: {
  limit: number;
  offset: number;
}): Promise<GeneralLedgerRow[]> {
  const { data, error } = await supabase.rpc('accounting_get_general_ledger', {
    p_start_date: filters.startDate || null,
    p_end_date: filters.endDate || null,
    p_customer_id: filters.customerId || null,
    p_billing_account_id: filters.billingAccountId || null,
    p_branch_id: filters.branchId || null,
    p_gl_account_code: filters.glCode || null,
    p_basis: filters.basis === 'all' ? null : filters.basis,
    p_limit: pagination.limit,
    p_offset: pagination.offset,
  });

  if (error) {
    throw error;
  }

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    posted_at: String(row.posted_at || ''),
    basis: String(row.basis || 'accrual') === 'cash' ? 'cash' : 'accrual',
    customer_id: row.customer_id ? String(row.customer_id) : null,
    billing_account_id: row.billing_account_id ? String(row.billing_account_id) : null,
    branch_id: row.branch_id ? String(row.branch_id) : null,
    gl_account_code: String(row.gl_account_code || ''),
    gl_account_name: String(row.gl_account_name || ''),
    counter_account_code: row.counter_account_code ? String(row.counter_account_code) : null,
    counter_account_name: row.counter_account_name ? String(row.counter_account_name) : null,
    source_document_type: String(row.source_document_type || ''),
    source_document_id: String(row.source_document_id || ''),
    source_document_number: String(row.source_document_number || ''),
    source_amount: toNumeric(row.source_amount),
    debit_amount: toNumeric(row.debit_amount),
    credit_amount: toNumeric(row.credit_amount),
    currency_code: String(row.currency_code || 'USD'),
    sync_status: String(row.sync_status || ''),
    export_status: String(row.export_status || ''),
    source_document_path: String(row.source_document_path || ''),
  }));
}

async function fetchGeneralLedgerExportRows(filters: {
  startDate: string;
  endDate: string;
  customerId: string;
  billingAccountId: string;
  branchId: string;
  glCode: string;
  basis: LedgerBasis;
}): Promise<GeneralLedgerRow[]> {
  const rows: GeneralLedgerRow[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const pageRows = await fetchGeneralLedger(filters, {
      limit: PAGE_SIZE,
      offset,
    });
    rows.push(...pageRows);
    hasMore = pageRows.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }

  return rows;
}

function asAppRole(value: unknown): AppRole | undefined {
  if (value === 'admin' || value === 'branch_manager' || value === 'field_operator' || value === 'read_only') {
    return value;
  }
  return undefined;
}

function GeneralLedgerPage() {
  return <GeneralLedgerScreen />;
}

export function GeneralLedgerScreen() {
  const { profile } = useAuth();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [billingAccountId, setBillingAccountId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [glCode, setGlCode] = useState('');
  const [basis, setBasis] = useState<LedgerBasis>('all');
  const [page, setPage] = useState(0);
  const [exportMessage, setExportMessage] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [isProviderExporting, setIsProviderExporting] = useState(false);
  const canAccessGeneralLedger = canViewGeneralLedger(profile?.role);

  const filters = useMemo(
    () => ({
      startDate,
      endDate,
      customerId,
      billingAccountId,
      branchId,
      glCode: glCode.trim(),
      basis,
    }),
    [startDate, endDate, customerId, billingAccountId, branchId, glCode, basis]
  );

  const ledgerQuery = useQuery({
    queryKey: ['accounting-general-ledger', filters, page],
    queryFn: () => fetchGeneralLedger(filters, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled: canAccessGeneralLedger,
  });

  const customersQuery = useQuery({
    queryKey: ['accounting-general-ledger', 'customers'],
    queryFn: () => fetchEntityOptions('customer', 'Customer'),
    enabled: canAccessGeneralLedger,
  });
  const billingAccountsQuery = useQuery({
    queryKey: ['accounting-general-ledger', 'billing_accounts'],
    queryFn: () => fetchEntityOptions('billing_account', 'Billing Account'),
    enabled: canAccessGeneralLedger,
  });
  const branchesQuery = useQuery({
    queryKey: ['accounting-general-ledger', 'branches'],
    queryFn: () => fetchEntityOptions('branch', 'Branch'),
    enabled: canAccessGeneralLedger,
  });

  const rows = ledgerQuery.data || [];
  const hasFilters = Boolean(startDate || endDate || customerId || billingAccountId || branchId || glCode || basis !== 'all');
  const customerLabels = useMemo(
    () => new Map((customersQuery.data || []).map((customer) => [customer.id, customer.label])),
    [customersQuery.data]
  );
  const billingAccountLabels = useMemo(
    () => new Map((billingAccountsQuery.data || []).map((account) => [account.id, account.label])),
    [billingAccountsQuery.data]
  );
  const branchLabels = useMemo(
    () => new Map((branchesQuery.data || []).map((branch) => [branch.id, branch.label])),
    [branchesQuery.data]
  );

  const canPageBack = page > 0;
  const canPageForward = rows.length === PAGE_SIZE;

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const exportRows = await fetchGeneralLedgerExportRows(filters);
      const csv = buildGeneralLedgerCsv(exportRows, {
        customer: customerLabels,
        billingAccount: billingAccountLabels,
        branch: branchLabels,
      });
      const anchor = document.createElement('a');
      anchor.download = `general-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      if (typeof URL.createObjectURL === 'function') {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        anchor.href = url;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        anchor.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
        anchor.click();
      }
      document.body.removeChild(anchor);
      setExportMessage(`Download initiated for ${exportRows.length} ledger row${exportRows.length === 1 ? '' : 's'} from the active filtered result set.`);
    } catch {
      setExportMessage('Unable to export the active filtered result set. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleProviderExport = async () => {
    if (!startDate || !endDate) {
      setExportMessage('Please select a start date and end date before generating a provider export.');
      return;
    }
    setIsProviderExporting(true);
    setExportMessage('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setExportMessage('Not authenticated. Please sign in and try again.');
        return;
      }
      const opsApiBase = (import.meta.env.VITE_OPS_API_BASE as string | undefined) ?? '';
      const resp = await fetch(`${opsApiBase}/api/ops/accounting/export/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({
          period_start: startDate,
          period_end: endDate,
          basis: basis === 'all' ? 'all' : basis,
        }),
      });
      if (resp.status === 404) {
        setExportMessage('No export mode configured. An admin must set up accounting export in Accounting > Export Configuration.');
        return;
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        setExportMessage(`Export failed (${resp.status}): ${body}`);
        return;
      }
      const csvText = await resp.text();
      const filename = resp.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
        ?? `dia-accounting-export-${startDate}-${endDate}.csv`;
      const exportMode = resp.headers.get('X-Export-Mode') ?? 'export_only';
      const rowCount = resp.headers.get('X-Export-Row-Count') ?? '0';
      const anchor = document.createElement('a');
      anchor.download = filename;
      document.body.appendChild(anchor);
      if (typeof URL.createObjectURL === 'function') {
        const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        anchor.href = url;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        anchor.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csvText)}`;
        anchor.click();
      }
      document.body.removeChild(anchor);
      setExportMessage(`Provider export (${exportMode}) downloaded: ${rowCount} rows for ${startDate} – ${endDate}.`);
    } catch (err) {
      console.error('Provider export failed:', err);
      setExportMessage('Provider export failed. Check your export configuration and try again.');
    } finally {
      setIsProviderExporting(false);
    }
  };

  useEffect(() => {
    setPage(0);
    setExportMessage('');
  }, [startDate, endDate, customerId, billingAccountId, branchId, glCode, basis]);

  if (!canAccessGeneralLedger) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>Your role does not have permission to view the general ledger.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6" data-testid="general-ledger-screen">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Accounting · General Ledger</h1>
        <p className="text-sm text-muted-foreground">
          Read-only ledger projection over posted accounting entries. Filter by date, customer, billing account, location, GL account, and basis.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Use filter controls to narrow the itemized ledger before drill-down or export.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="ledger-start-date">Start date</Label>
            <Input id="ledger-start-date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ledger-end-date">End date</Label>
            <Input id="ledger-end-date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ledger-customer">Customer</Label>
            <select
              id="ledger-customer"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
            >
              <option value="">All customers</option>
              {(customersQuery.data || []).map((customer) => (
                <option key={customer.id} value={customer.id}>{customer.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ledger-billing-account">Billing account</Label>
            <select
              id="ledger-billing-account"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={billingAccountId}
              onChange={(event) => setBillingAccountId(event.target.value)}
            >
              <option value="">All billing accounts</option>
              {(billingAccountsQuery.data || []).map((account) => (
                <option key={account.id} value={account.id}>{account.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ledger-branch">Location</Label>
            <select
              id="ledger-branch"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">All locations</option>
              {(branchesQuery.data || []).map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ledger-gl-code">GL account code</Label>
            <Input id="ledger-gl-code" value={glCode} onChange={(event) => setGlCode(event.target.value)} placeholder="e.g. 4000-RENT" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ledger-basis">Basis</Label>
            <select
              id="ledger-basis"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={basis}
              onChange={(event) => setBasis(event.target.value as LedgerBasis)}
            >
              <option value="all">All</option>
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
          </div>
          <div className="space-y-2 md:col-span-4">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void handleExport()} disabled={rows.length === 0 || isExporting}>
                Export CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleProviderExport()}
                disabled={!startDate || !endDate || isProviderExporting}
                title="Generate a provider-compatible export (Xero/Sage/export-only) using the configured export mode"
              >
                {isProviderExporting ? 'Generating…' : 'Provider export'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {ledgerQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Unable to load general ledger rows</AlertTitle>
          <AlertDescription>Check posted accounting data and try again.</AlertDescription>
        </Alert>
      )}

      {exportMessage && (
        <Alert>
          <AlertTitle>Export ready</AlertTitle>
          <AlertDescription>{exportMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ledger entries</CardTitle>
          <CardDescription>
            Itemized rows include source document, counter account, basis, amounts, and sync/export status.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ledgerQuery.isLoading && <p className="text-sm text-muted-foreground">Loading ledger rows…</p>}
          {!ledgerQuery.isLoading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {hasFilters ? 'No ledger rows match these filters.' : 'No posted ledger rows available yet.'}
            </p>
          )}
          {!ledgerQuery.isLoading && rows.length > 0 && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Basis</TableHead>
                    <TableHead>Document</TableHead>
                    <TableHead>GL account</TableHead>
                    <TableHead>Counter account</TableHead>
                    <TableHead>Source amount</TableHead>
                    <TableHead>Debit</TableHead>
                    <TableHead>Credit</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Drill-down</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} data-testid={`ledger-row-${row.id}`}>
                      <TableCell>{formatDate(row.posted_at)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{row.basis}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <p className="font-medium">{row.source_document_type.toUpperCase()} · {row.source_document_number}</p>
                          <p className="text-xs text-muted-foreground">
                            customer: {customerLabels.get(row.customer_id || '') || '—'} · billing:{' '}
                            {billingAccountLabels.get(row.billing_account_id || '') || '—'} · location:{' '}
                            {branchLabels.get(row.branch_id || '') || '—'}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>{row.gl_account_code} · {row.gl_account_name}</TableCell>
                      <TableCell>{row.counter_account_code || '—'} {row.counter_account_name || ''}</TableCell>
                      <TableCell>{formatCurrency(row.source_amount, row.currency_code)}</TableCell>
                      <TableCell>{formatCurrency(row.debit_amount, row.currency_code)}</TableCell>
                      <TableCell>{formatCurrency(row.credit_amount, row.currency_code)}</TableCell>
                      <TableCell>
                        <div className="space-y-1 text-xs">
                          <p>Sync: {row.sync_status}</p>
                          <p>Export: {row.export_status}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <a className="text-primary underline" href={row.source_document_path}>
                          Open source
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Page {page + 1}</p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={!canPageBack}>
                    Previous
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => current + 1)} disabled={!canPageForward}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
