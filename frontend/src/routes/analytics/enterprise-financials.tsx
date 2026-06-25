import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';

export const Route = createFileRoute('/analytics/enterprise-financials')({
  component: EnterpriseFinancialReportingPage,
});

export interface EnterpriseFinancialReportingRow {
  source_entity_id: string;
  source_record_id: string | null;
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
  fx_rate_used: number | null;
  fx_rate_source: string | null;
  fx_rate_effective_at: string | null;
}

export interface ExternalRentalReportingRow {
  reporting_line_id: string;
  contract_line_id: string;
  contract_id: string | null;
  order_line_id: string | null;
  asset_id: string | null;
  asset_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
  reporting_date: string | null;
  invoice_count: number;
  invoice_reference: string | null;
  contract_line_status: string;
  rental_type: string;
  asset_ownership_type: string | null;
  fulfillment_model: 'owned_fleet_external_rental' | 'third_party_rerental';
  customer_revenue_reporting_amount: number;
  vendor_obligation_reporting_amount: number;
  gross_margin_reporting_amount: number;
  utilization_uplift_minutes: number;
  asset_calendar_minutes: number;
  utilization_uplift_pct: number;
  rerent_status_key: string | null;
  rerent_status_label: string | null;
  vendor_ref: string | null;
  vendor_reference_updated_at: string | null;
  obligation_reference_status: string;
  reporting_currency_code: string;
  formula_reference: string;
}

interface CurrentEntityVersionRow {
  data: Record<string, unknown>;
}

interface CurrentEntityRow {
  id: string;
  created_at: string;
  entity_versions?: CurrentEntityVersionRow[];
}

interface BillingControlPackData {
  invoices: CurrentEntityRow[];
  customers: CurrentEntityRow[];
  billingAccounts: CurrentEntityRow[];
  contracts: CurrentEntityRow[];
  jobSites: CurrentEntityRow[];
}

interface BillingControlInvoice {
  id: string;
  createdAt: string;
  invoiceNumber: string;
  status: string;
  invoiceDate: string;
  dueDate: string;
  total: number;
  openBalance: number | null;
  customerName: string;
  billingAccountName: string;
  contractLabel: string;
  jobSiteLabel: string;
  branchLabel: string;
  transactionCurrencyCode: string;
  reportingCurrencyCode: string;
  billingExceptionCategory: string;
  billingExceptionReason: string;
  disputeStatus: string;
  disputeReason: string;
  disputeRecommendation: string;
  branchClarificationStatus: string;
  branchClarificationNote: string;
  billingSourceSyncedAt: string;
  arSourceSyncedAt: string;
}

type ScopeType = 'company' | 'region' | 'branch';
type DrilldownScopeType = ScopeType | 'entity';
type AgingBucket = 'current' | 'overdue' | '120+';

type ScopeSummary = {
  scopeId: string;
  scopeName: string;
  documentCount: number;
  branchCount: number;
  entityCount: number;
  reportingTotalAmount: number;
  transactionCurrencyCodes: string[];
};

type DrilldownSelection = {
  scopeType: DrilldownScopeType;
  scopeId: string;
  label: string;
};

function EnterpriseFinancialReportingPage() {
  return <EnterpriseFinancialReportingScreen />;
}

function getCurrentEntityData(row: CurrentEntityRow): Record<string, unknown> {
  return row.entity_versions?.[0]?.data ?? {};
}

function getString(data: Record<string, unknown>, key: string, fallback = ''): string {
  const value = data[key];
  return typeof value === 'string' ? value : fallback;
}

function getNumber(data: Record<string, unknown>, key: string): number {
  const value = data[key];
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

function getOptionalNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeCurrencyCode(value: unknown): string {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'USD';
}

async function fetchReportingRows(): Promise<EnterpriseFinancialReportingRow[]> {
  const { data, error } = await supabase
    .from('v_enterprise_financial_reporting_lines')
    .select('*')
    .order('document_date', { ascending: false })
    .limit(500);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    source_entity_id: String(row.source_entity_id ?? ''),
    source_record_id: row.source_record_id != null ? String(row.source_record_id) : null,
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
    fx_rate_used: row.fx_rate_used != null ? Number(row.fx_rate_used) : null,
    fx_rate_source: row.fx_rate_source != null ? String(row.fx_rate_source) : null,
    fx_rate_effective_at: row.fx_rate_effective_at != null ? String(row.fx_rate_effective_at) : null,
  }));
}

async function fetchExternalRentalReportingRows(): Promise<ExternalRentalReportingRow[]> {
  const { data, error } = await supabase
    .from('v_external_rental_reporting_lines')
    .select('*')
    .order('reporting_date', { ascending: false })
    .limit(500);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    reporting_line_id: String(row.reporting_line_id ?? ''),
    contract_line_id: String(row.contract_line_id ?? ''),
    contract_id: row.contract_id != null ? String(row.contract_id) : null,
    order_line_id: row.order_line_id != null ? String(row.order_line_id) : null,
    asset_id: row.asset_id != null ? String(row.asset_id) : null,
    asset_name: row.asset_name != null ? String(row.asset_name) : null,
    branch_id: row.branch_id != null ? String(row.branch_id) : null,
    branch_name: row.branch_name != null ? String(row.branch_name) : null,
    reporting_date: row.reporting_date != null ? String(row.reporting_date) : null,
    invoice_count: Number(row.invoice_count ?? 0),
    invoice_reference: row.invoice_reference != null ? String(row.invoice_reference) : null,
    contract_line_status: String(row.contract_line_status ?? ''),
    rental_type: String(row.rental_type ?? ''),
    asset_ownership_type: row.asset_ownership_type != null ? String(row.asset_ownership_type) : null,
    fulfillment_model:
      row.fulfillment_model === 'third_party_rerental'
        ? 'third_party_rerental'
        : 'owned_fleet_external_rental',
    customer_revenue_reporting_amount: Number(row.customer_revenue_reporting_amount ?? 0),
    vendor_obligation_reporting_amount: Number(row.vendor_obligation_reporting_amount ?? 0),
    gross_margin_reporting_amount: Number(row.gross_margin_reporting_amount ?? 0),
    utilization_uplift_minutes: Number(row.utilization_uplift_minutes ?? 0),
    asset_calendar_minutes: Number(row.asset_calendar_minutes ?? 0),
    utilization_uplift_pct: Number(row.utilization_uplift_pct ?? 0),
    rerent_status_key: row.rerent_status_key != null ? String(row.rerent_status_key) : null,
    rerent_status_label: row.rerent_status_label != null ? String(row.rerent_status_label) : null,
    vendor_ref: row.vendor_ref != null ? String(row.vendor_ref) : null,
    vendor_reference_updated_at:
      row.vendor_reference_updated_at != null ? String(row.vendor_reference_updated_at) : null,
    obligation_reference_status: String(row.obligation_reference_status ?? 'not_applicable'),
    reporting_currency_code: String(row.reporting_currency_code ?? 'USD'),
    formula_reference: String(row.formula_reference ?? ''),
  }));
}

async function fetchCurrentEntityRows(entityType: string, limit = 500): Promise<CurrentEntityRow[]> {
  const { data, error } = await supabase
    .from('entities')
    .select('id, created_at, entity_versions!inner(data, is_current)')
    .eq('entity_type', entityType)
    .eq('entity_versions.is_current', true)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return (data ?? []) as CurrentEntityRow[];
}

async function fetchBillingControlPackData(): Promise<BillingControlPackData> {
  const [invoices, customers, billingAccounts, contracts, jobSites] = await Promise.all([
    fetchCurrentEntityRows('invoice'),
    fetchCurrentEntityRows('customer'),
    fetchCurrentEntityRows('billing_account'),
    fetchCurrentEntityRows('rental_contract'),
    fetchCurrentEntityRows('job_site'),
  ]);

  return {
    invoices,
    customers,
    billingAccounts,
    contracts,
    jobSites,
  };
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatCurrency(amount: number, currencyCode: string) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

function aggregateByScope(
  rows: EnterpriseFinancialReportingRow[],
  scopeType: ScopeType
): ScopeSummary[] {
  const map = new Map<string, ScopeSummary & { currencies: Set<string>; branches: Set<string>; entities: Set<string> }>();

  for (const row of rows) {
    const scopeId = row[`${scopeType}_scope_id` as const];
    const scopeName = row[`${scopeType}_scope_name` as const];
    if (!scopeId || !scopeName) {
      continue;
    }

    const existing = map.get(scopeId) || {
      scopeId,
      scopeName,
      documentCount: 0,
      branchCount: 0,
      entityCount: 0,
      reportingTotalAmount: 0,
      currencies: new Set<string>(),
      branches: new Set<string>(),
      entities: new Set<string>(),
      transactionCurrencyCodes: [],
    };

    existing.documentCount += 1;
    existing.reportingTotalAmount = roundCurrency(existing.reportingTotalAmount + row.reporting_total_amount);
    existing.currencies.add(row.transaction_currency_code);
    if (row.branch_scope_id) {
      existing.branches.add(row.branch_scope_id);
    }
    existing.entities.add(row.source_entity_id);
    map.set(scopeId, existing);
  }

  return Array.from(map.values())
    .map((summary) => ({
      scopeId: summary.scopeId,
      scopeName: summary.scopeName,
      documentCount: summary.documentCount,
      branchCount: summary.branches.size,
      entityCount: summary.entities.size,
      reportingTotalAmount: summary.reportingTotalAmount,
      transactionCurrencyCodes: Array.from(summary.currencies.values()).sort(),
    }))
    .sort((left, right) => right.reportingTotalAmount - left.reportingTotalAmount || left.scopeName.localeCompare(right.scopeName));
}

function buildEntityLabelMap(rows: CurrentEntityRow[], preferredKeys: string[]): Map<string, string> {
  return new Map(
    rows.map((row) => {
      const data = getCurrentEntityData(row);
      const label = preferredKeys.map((key) => getString(data, key)).find(Boolean) || row.id;
      return [row.id, label];
    })
  );
}

function getScopeOptions(rows: EnterpriseFinancialReportingRow[], scopeType: ScopeType) {
  const options = new Map<string, string>();
  for (const row of rows) {
    const scopeId = row[`${scopeType}_scope_id` as const];
    const scopeName = row[`${scopeType}_scope_name` as const];
    if (scopeId && scopeName) {
      options.set(scopeId, scopeName);
    }
  }

  return Array.from(options.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mapBillingControlInvoices(controlPackData: BillingControlPackData | undefined): BillingControlInvoice[] {
  if (!controlPackData) {
    return [];
  }

  const customerLabels = buildEntityLabelMap(controlPackData.customers, ['name', 'customer_number']);
  const billingAccountLabels = buildEntityLabelMap(controlPackData.billingAccounts, ['name', 'account_number']);
  const contractLabels = buildEntityLabelMap(controlPackData.contracts, ['contract_number', 'name']);
  const jobSiteLabels = buildEntityLabelMap(controlPackData.jobSites, ['name', 'job_site_number']);

  return controlPackData.invoices.map((row) => {
    const data = getCurrentEntityData(row);
    const transactionCurrencyCode = normalizeCurrencyCode(getString(data, 'transaction_currency_code', 'USD'));
    const reportingCurrencyCode = normalizeCurrencyCode(
      getString(data, 'reporting_currency_code', transactionCurrencyCode)
    );

    return {
      id: row.id,
      createdAt: row.created_at,
      invoiceNumber: getString(data, 'invoice_number', `INV-${row.id.slice(0, 8)}`),
      status: getString(data, 'status', 'draft'),
      invoiceDate: getString(data, 'invoice_date'),
      dueDate:
        getString(data, 'due_date')
        || getString(data, 'payment_due_date')
        || getString(data, 'due_at')
        || getString(data, 'invoice_due_date'),
      total: getNumber(data, 'total'),
      openBalance:
        getOptionalNumber(data, 'open_balance')
        ?? getOptionalNumber(data, 'balance_due')
        ?? getOptionalNumber(data, 'amount_due')
        ?? getOptionalNumber(data, 'outstanding_balance'),
      customerName:
        customerLabels.get(getString(data, 'customer_id'))
        || getString(data, 'customer_name')
        || getString(data, 'customer_id', 'Unassigned customer'),
      billingAccountName:
        billingAccountLabels.get(getString(data, 'billing_account_id'))
        || getString(data, 'billing_account_name')
        || getString(data, 'billing_account_id', 'Unassigned billing account'),
      contractLabel:
        contractLabels.get(getString(data, 'contract_id'))
        || getString(data, 'contract_number')
        || getString(data, 'contract_id', 'No contract linked'),
      jobSiteLabel:
        jobSiteLabels.get(getString(data, 'job_site_id'))
        || getString(data, 'job_site_name')
        || getString(data, 'job_site_id', 'No job site linked'),
      branchLabel:
        getString(data, 'branch_name')
        || getString(data, 'location_name')
        || getString(data, 'branch_id')
        || getString(data, 'location_id', 'Unassigned branch'),
      transactionCurrencyCode,
      reportingCurrencyCode,
      billingExceptionCategory:
        getString(data, 'billing_exception_type')
        || getString(data, 'billing_exception_category')
        || 'billing_exception',
      billingExceptionReason: getString(data, 'billing_exception_reason'),
      disputeStatus: getString(data, 'dispute_status'),
      disputeReason:
        getString(data, 'dispute_reason')
        || getString(data, 'customer_dispute_reason')
        || getString(data, 'dispute_summary'),
      disputeRecommendation: getString(data, 'dispute_recommendation'),
      branchClarificationStatus: getString(data, 'branch_clarification_status'),
      branchClarificationNote: getString(data, 'branch_clarification_note'),
      billingSourceSyncedAt: getString(data, 'billing_source_synced_at'),
      arSourceSyncedAt: getString(data, 'ar_source_synced_at'),
    };
  });
}

function parseUtcDateOnly(value: string): Date | null {
  if (!value) {
    return null;
  }
  const datePartMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (datePartMatch) {
    const [, year, month, day] = datePartMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function formatBucketLabel(bucket: AgingBucket): string {
  switch (bucket) {
    case '120+':
      return '120+ days';
    case 'overdue':
      return '1-119 days overdue';
    default:
      return 'Current';
  }
}

function getAgingBucket(invoice: BillingControlInvoice, todayUtcTimestamp: number): AgingBucket {
  if ((invoice.openBalance ?? 0) <= 0.0001) {
    return 'current';
  }
  const dueDate = parseUtcDateOnly(invoice.dueDate);
  if (!dueDate) {
    return 'current';
  }
  const dayInMs = 24 * 60 * 60 * 1000;
  const daysPastDue = Math.floor((todayUtcTimestamp - dueDate.getTime()) / dayInMs);
  if (daysPastDue >= 120) {
    return '120+';
  }
  if (daysPastDue > 0) {
    return 'overdue';
  }
  return 'current';
}

function getCurrencyTotals(invoices: BillingControlInvoice[]) {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    const amount = roundCurrency(Math.max(invoice.openBalance ?? 0, 0));
    if (amount <= 0) {
      continue;
    }
    const currencyCode = invoice.reportingCurrencyCode || invoice.transactionCurrencyCode || 'USD';
    totals.set(currencyCode, roundCurrency((totals.get(currencyCode) || 0) + amount));
  }
  return Array.from(totals.entries())
    .map(([currencyCode, amount]) => ({ currencyCode, amount }))
    .sort((left, right) => right.amount - left.amount || left.currencyCode.localeCompare(right.currencyCode));
}

function isTimestampOlderThan(timestamp: string, maxAgeDays: number): boolean {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return (Date.now() - parsed.getTime()) > maxAgeDays * 24 * 60 * 60 * 1000;
}

function buildBillingControlPackCsv(args: {
  invoices: BillingControlInvoice[];
  sourceExceptions: string[];
  dsoDays: number | null;
  todayUtcTimestamp: number;
}) {
  const lines = [
    ['section', 'label', 'value'],
    ['summary', 'open_dispute_cases', String(args.invoices.filter((invoice) => invoice.disputeStatus || invoice.disputeReason).length)],
    ['summary', 'billing_anomalies', String(args.invoices.filter((invoice) => invoice.billingExceptionReason).length)],
    ['summary', 'dso_days', args.dsoDays === null ? 'unavailable' : args.dsoDays.toFixed(1)],
    ['summary', 'source_exceptions', String(args.sourceExceptions.length)],
  ];

  for (const bucket of ['current', 'overdue', '120+'] as AgingBucket[]) {
    const totals = getCurrencyTotals(
      args.invoices.filter((invoice) => getAgingBucket(invoice, args.todayUtcTimestamp) === bucket)
    );
    if (totals.length === 0) {
      lines.push(['aging_bucket', bucket, '0']);
      continue;
    }
    for (const total of totals) {
      lines.push(['aging_bucket', bucket, `${total.currencyCode} ${total.amount.toFixed(2)}`]);
    }
  }

  for (const exception of args.sourceExceptions) {
    lines.push(['source_exception', 'detail', exception]);
  }

  return lines
    .map((line) => line.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function filterRows(
  rows: EnterpriseFinancialReportingRow[],
  scopeType: ScopeType,
  scopeId: string,
  documentType: string,
  periodStart: string,
  periodEnd: string
) {
  return rows.filter((row) => {
    const scopeField = `${scopeType}_scope_id` as const;
    if (scopeId && row[scopeField] !== scopeId) {
      return false;
    }

    if (documentType !== 'all' && row.source_entity_type !== documentType) {
      return false;
    }

    if (periodStart && row.document_date < periodStart) {
      return false;
    }

    if (periodEnd && row.document_date > periodEnd) {
      return false;
    }

    return true;
  });
}

function matchesDrilldown(row: EnterpriseFinancialReportingRow, selection: DrilldownSelection | null) {
  if (!selection) {
    return true;
  }

  switch (selection.scopeType) {
    case 'company':
      return row.company_scope_id === selection.scopeId;
    case 'region':
      return row.region_scope_id === selection.scopeId;
    case 'branch':
      return row.branch_scope_id === selection.scopeId;
    case 'entity':
      return row.source_entity_id === selection.scopeId;
    default:
      return true;
  }
}

export function EnterpriseFinancialReportingScreen() {
  const reportingQuery = useQuery({
    queryKey: ['enterprise-financial-reporting'],
    queryFn: fetchReportingRows,
  });
  const externalRentalQuery = useQuery({
    queryKey: ['enterprise-financial-reporting', 'external-rentals'],
    queryFn: fetchExternalRentalReportingRows,
  });
  const controlPackQuery = useQuery({
    queryKey: ['enterprise-financial-reporting', 'billing-control-pack'],
    queryFn: fetchBillingControlPackData,
  });

  const [scopeType, setScopeType] = useState<ScopeType>('company');
  const [scopeId, setScopeId] = useState('');
  const [documentType, setDocumentType] = useState('invoice');
  const [periodStart, setPeriodStart] = useState('2026-04-01');
  const [periodEnd, setPeriodEnd] = useState('2026-12-31');
  const [drilldown, setDrilldown] = useState<DrilldownSelection | null>(null);
  const [controlPackExportMessage, setControlPackExportMessage] = useState('');

  const rows = useMemo(() => reportingQuery.data ?? [], [reportingQuery.data]);
  const externalRentalRows = useMemo(() => externalRentalQuery.data ?? [], [externalRentalQuery.data]);
  const scopeOptions = useMemo(() => getScopeOptions(rows, scopeType), [rows, scopeType]);
  const scopeFilteredRows = useMemo(
    () => filterRows(rows, scopeType, scopeId, 'all', periodStart, periodEnd),
    [rows, scopeType, scopeId, periodStart, periodEnd]
  );
  const filteredRows = useMemo(
    () => filterRows(rows, scopeType, scopeId, documentType, periodStart, periodEnd),
    [rows, scopeType, scopeId, documentType, periodStart, periodEnd]
  );
  const externalRentalFilteredRows = useMemo(() => {
    const visibleBranchIds = new Set(scopeFilteredRows.map((row) => row.branch_scope_id).filter(Boolean));
    return externalRentalRows.filter((row) => {
      if (periodStart && row.reporting_date && row.reporting_date < periodStart) {
        return false;
      }
      if (periodEnd && row.reporting_date && row.reporting_date > periodEnd) {
        return false;
      }
      if (visibleBranchIds.size > 0 && row.branch_id && !visibleBranchIds.has(row.branch_id)) {
        return false;
      }
      return true;
    });
  }, [externalRentalRows, periodEnd, periodStart, scopeFilteredRows]);

  const companySummaries = useMemo(() => aggregateByScope(filteredRows, 'company'), [filteredRows]);
  const regionSummaries = useMemo(() => aggregateByScope(filteredRows, 'region'), [filteredRows]);
  const branchSummaries = useMemo(() => aggregateByScope(filteredRows, 'branch'), [filteredRows]);

  useEffect(() => {
    if (scopeId && scopeOptions.some((option) => option.id === scopeId)) {
      return;
    }
    setScopeId('');
  }, [scopeId, scopeOptions]);

  useEffect(() => {
    if (drilldown && filteredRows.some((row) => matchesDrilldown(row, drilldown))) {
      return;
    }

    // Default to the first region row so the demo path opens on consolidated
    // reporting and immediately exposes the region -> branch drill-down flow.
    const nextRegion = regionSummaries[0];
    if (nextRegion) {
      setDrilldown({ scopeType: 'region', scopeId: nextRegion.scopeId, label: nextRegion.scopeName });
      return;
    }

    const nextCompany = companySummaries[0];
    if (nextCompany) {
      setDrilldown({ scopeType: 'company', scopeId: nextCompany.scopeId, label: nextCompany.scopeName });
      return;
    }

    setDrilldown(null);
  }, [companySummaries, filteredRows, drilldown, regionSummaries]);

  const drilldownRows = useMemo(
    () => filteredRows.filter((row) => matchesDrilldown(row, drilldown)),
    [filteredRows, drilldown]
  );

  const reportingCurrencyTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of filteredRows) {
      totals.set(
        row.reporting_currency_code,
        roundCurrency((totals.get(row.reporting_currency_code) || 0) + row.reporting_total_amount)
      );
    }
    return Array.from(totals.entries())
      .map(([currencyCode, amount]) => ({ currencyCode, amount }))
      .sort((left, right) => right.amount - left.amount);
  }, [filteredRows]);
  const ownedExternalRentalRows = useMemo(
    () => externalRentalFilteredRows.filter((row) => row.fulfillment_model === 'owned_fleet_external_rental'),
    [externalRentalFilteredRows]
  );
  const thirdPartyRerentalRows = useMemo(
    () => externalRentalFilteredRows.filter((row) => row.fulfillment_model === 'third_party_rerental'),
    [externalRentalFilteredRows]
  );
  const ownedExternalRentalRevenue = useMemo(
    () => roundCurrency(ownedExternalRentalRows.reduce((sum, row) => sum + row.customer_revenue_reporting_amount, 0)),
    [ownedExternalRentalRows]
  );
  const thirdPartyVendorObligations = useMemo(
    () => roundCurrency(thirdPartyRerentalRows.reduce((sum, row) => sum + row.vendor_obligation_reporting_amount, 0)),
    [thirdPartyRerentalRows]
  );
  const thirdPartyMargin = useMemo(
    () => roundCurrency(thirdPartyRerentalRows.reduce((sum, row) => sum + row.gross_margin_reporting_amount, 0)),
    [thirdPartyRerentalRows]
  );
  const ownedUtilizationMinutes = useMemo(
    () => roundCurrency(ownedExternalRentalRows.reduce((sum, row) => sum + row.utilization_uplift_minutes, 0)),
    [ownedExternalRentalRows]
  );
  const ownedUtilizationPct = useMemo(() => {
    const calendarByAsset = new Map<string, number>();
    for (const row of ownedExternalRentalRows) {
      if (!row.asset_id || row.asset_calendar_minutes <= 0) {
        continue;
      }
      calendarByAsset.set(row.asset_id, Math.max(calendarByAsset.get(row.asset_id) || 0, row.asset_calendar_minutes));
    }
    const totalCalendarMinutes = Array.from(calendarByAsset.values()).reduce((sum, value) => sum + value, 0);
    if (totalCalendarMinutes <= 0) {
      return 0;
    }
    return roundCurrency((ownedUtilizationMinutes / totalCalendarMinutes) * 100);
  }, [ownedExternalRentalRows, ownedUtilizationMinutes]);
  const externalRentalDisplayCurrency = externalRentalFilteredRows[0]?.reporting_currency_code || 'USD';
  const externalRentalRowsForDisplay = useMemo(
    () => externalRentalFilteredRows.slice(0, 8),
    [externalRentalFilteredRows]
  );

  const entityOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const row of drilldownRows) {
      options.set(row.source_entity_id, row.document_number);
    }
    return Array.from(options.entries()).map(([id, label]) => ({ id, label }));
  }, [drilldownRows]);
  const billingControlInvoices = useMemo(
    () => mapBillingControlInvoices(controlPackQuery.data),
    [controlPackQuery.data]
  );
  const billingAnomalies = useMemo(
    () => billingControlInvoices.filter((invoice) => invoice.billingExceptionReason),
    [billingControlInvoices]
  );
  const disputeCases = useMemo(
    () => billingControlInvoices.filter(
      (invoice) =>
        invoice.disputeStatus
        || invoice.disputeReason
        || invoice.disputeRecommendation
        || invoice.branchClarificationStatus
        || invoice.branchClarificationNote
    ),
    [billingControlInvoices]
  );
  const sourceExceptions = useMemo(() => {
    const exceptions: string[] = [];
    for (const invoice of billingControlInvoices) {
      if (!invoice.dueDate) {
        exceptions.push(`${invoice.invoiceNumber}: missing due date from AR source`);
      }
      if (invoice.openBalance === null) {
        exceptions.push(`${invoice.invoiceNumber}: missing open balance from AR source`);
      }
      if (!invoice.billingSourceSyncedAt) {
        exceptions.push(`${invoice.invoiceNumber}: missing billing source freshness timestamp`);
      } else if (isTimestampOlderThan(invoice.billingSourceSyncedAt, 7)) {
        exceptions.push(`${invoice.invoiceNumber}: billing source stale since ${invoice.billingSourceSyncedAt}`);
      }
      if (!invoice.arSourceSyncedAt) {
        exceptions.push(`${invoice.invoiceNumber}: missing AR source freshness timestamp`);
      } else if (isTimestampOlderThan(invoice.arSourceSyncedAt, 7)) {
        exceptions.push(`${invoice.invoiceNumber}: AR source stale since ${invoice.arSourceSyncedAt}`);
      }
    }
    return exceptions;
  }, [billingControlInvoices]);
  const todayUtcTimestamp = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const agingBuckets = useMemo(
    () => (['current', 'overdue', '120+'] as AgingBucket[]).map((bucket) => ({
      bucket,
      label: formatBucketLabel(bucket),
      totals: getCurrencyTotals(
        billingControlInvoices.filter((invoice) => getAgingBucket(invoice, todayUtcTimestamp) === bucket)
      ),
    })),
    [billingControlInvoices, todayUtcTimestamp]
  );
  const dsoDays = useMemo(() => {
    const openReceivables = billingControlInvoices.reduce(
      (sum, invoice) => sum + Math.max(invoice.openBalance ?? 0, 0),
      0
    );
    const now = new Date();
    const lastNinetyDaysStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 90);
    const trailingSales = billingControlInvoices.reduce((sum, invoice) => {
      const invoiceDate = parseUtcDateOnly(invoice.invoiceDate);
      if (!invoiceDate || invoiceDate.getTime() < lastNinetyDaysStart) {
        return sum;
      }
      return sum + Math.max(invoice.total, 0);
    }, 0);
    if (trailingSales <= 0) {
      return null;
    }
    return roundCurrency((openReceivables / trailingSales) * 90);
  }, [billingControlInvoices]);

  if (reportingQuery.isLoading) {
    return <div data-testid="enterprise-reporting-loading">Loading enterprise financial reporting…</div>;
  }

  if (reportingQuery.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load enterprise financial reporting</AlertTitle>
        <AlertDescription>Confirm authenticated access to the shared reporting views and refresh the page.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6" data-testid="enterprise-financial-reporting-screen">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Enterprise Financial Reporting</h1>
        <p className="text-sm text-muted-foreground">
          Consolidated company and region reporting with branch and per-document drill-down from the shared enterprise reporting dataset.
        </p>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">credit-billing-analyst:t3</Badge>
          <Badge variant="secondary">credit-billing-analyst:t6</Badge>
          <Badge variant="secondary">credit-billing-analyst:t7</Badge>
        </div>
      </div>

      <Alert>
        <AlertTitle>Billing control pack stays human-approved</AlertTitle>
        <AlertDescription>
          Invoice release, credits, and dispute dispositions stay with the analyst. Missing or stale billing/AR inputs are surfaced explicitly before the weekly pack is trusted.
        </AlertDescription>
      </Alert>

      <Card data-testid="billing-control-pack">
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Billing exception, dispute, and DSO control pack</CardTitle>
              <CardDescription>
                Auto-assembled from current invoice, contract, billing-account, customer, and AR source rows without creating a parallel finance model.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={billingControlInvoices.length === 0}
              onClick={() => {
                const csv = buildBillingControlPackCsv({
                  invoices: billingControlInvoices,
                  sourceExceptions,
                  dsoDays,
                  todayUtcTimestamp,
                });
                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const objectUrl = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = objectUrl;
                link.download = `billing-control-pack-${new Date().toISOString().slice(0, 10)}.csv`;
                link.click();
                URL.revokeObjectURL(objectUrl);
                setControlPackExportMessage('Weekly DSO control pack CSV download started.');
              }}
            >
              Export Weekly DSO Pack
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {controlPackExportMessage && (
            <p className="text-sm text-muted-foreground">{controlPackExportMessage}</p>
          )}
          {controlPackQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading billing control-pack source rows…</p>
          ) : controlPackQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Unable to load billing control-pack inputs</AlertTitle>
              <AlertDescription>Confirm access to invoice and related entity sources, then refresh the page.</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Likely billing anomalies</CardDescription>
                    <CardTitle>{billingAnomalies.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Pre-audit queue for rate, duration, charge, or cycle exceptions before release.
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Open dispute cases</CardDescription>
                    <CardTitle>{disputeCases.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Source-backed customer billing cases awaiting analyst disposition.
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>DSO estimate</CardDescription>
                    <CardTitle>{dsoDays === null ? 'Unavailable' : `${dsoDays.toFixed(1)} days`}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Trailing 90-day invoice sales versus current open receivables from the shared source rows.
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardDescription>Missing/stale source exceptions</CardDescription>
                    <CardTitle>{sourceExceptions.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Control-pack confidence is reduced until every exception is resolved.
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 xl:grid-cols-3">
                <Card data-testid="billing-anomaly-review">
                  <CardHeader>
                    <CardTitle>Batch anomaly review</CardTitle>
                    <CardDescription>Review exception-tagged invoices before customer-facing release.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {billingAnomalies.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No billing anomalies were surfaced from the current invoice source rows.</p>
                    ) : billingAnomalies.map((invoice) => (
                      <div key={invoice.id} className="rounded-lg border p-3" data-testid={`billing-anomaly-${invoice.id}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">{invoice.invoiceNumber}</div>
                          <Badge variant="outline">{invoice.billingExceptionCategory.replace(/_/g, ' ')}</Badge>
                        </div>
                        <p className="mt-2 text-sm">{invoice.billingExceptionReason}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Customer: {invoice.customerName} · Billing Account: {invoice.billingAccountName} · Contract: {invoice.contractLabel} · Job Site: {invoice.jobSiteLabel} · Branch: {invoice.branchLabel}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Invoice status: {invoice.status || 'unknown'} · Human approval required before release.
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card data-testid="billing-dispute-cases">
                  <CardHeader>
                    <CardTitle>Billing dispute case view</CardTitle>
                    <CardDescription>Preserve branch, contract, and customer context for analyst-ready case work.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {disputeCases.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No dispute-ready invoices were identified from the shared source rows.</p>
                    ) : disputeCases.map((invoice) => (
                      <div key={invoice.id} className="rounded-lg border p-3" data-testid={`billing-dispute-${invoice.id}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium">{invoice.invoiceNumber}</div>
                          <Badge variant="secondary">{invoice.disputeStatus || 'needs_review'}</Badge>
                        </div>
                        <p className="mt-2 text-sm">{invoice.disputeReason || 'Customer dispute reason not provided in the source rows.'}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Recommendation: {invoice.disputeRecommendation || 'Await branch clarification before proposing credits or rejection.'}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Branch context: {invoice.branchLabel} · Clarification: {invoice.branchClarificationStatus || 'pending'}{invoice.branchClarificationNote ? ` · ${invoice.branchClarificationNote}` : ''}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Contract: {invoice.contractLabel} · Customer: {invoice.customerName} · Billing Account: {invoice.billingAccountName}
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card data-testid="dso-control-pack">
                  <CardHeader>
                    <CardTitle>Weekly DSO and AR-aging pack</CardTitle>
                    <CardDescription>Automatically collated KPI and bucket totals with explicit freshness exceptions.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {agingBuckets.map((bucket) => (
                      <div key={bucket.bucket} className="rounded-lg border p-3" data-testid={`billing-control-bucket-${bucket.bucket}`}>
                        <div className="font-medium">{bucket.label}</div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {bucket.totals.length === 0
                            ? 'No open balance'
                            : bucket.totals.map((total) => `${total.currencyCode}: ${formatCurrency(total.amount, total.currencyCode)}`).join(' · ')}
                        </div>
                      </div>
                    ))}
                    <div className="rounded-lg border border-dashed p-3">
                      <div className="font-medium">Source exceptions</div>
                      {sourceExceptions.length === 0 ? (
                        <p className="mt-1 text-sm text-muted-foreground">No stale or missing billing / AR inputs were detected in the current pack.</p>
                      ) : (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                          {sourceExceptions.map((exception) => (
                            <li key={exception}>{exception}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="external-rental-report">
        <CardHeader>
          <CardTitle>External-rental revenue and vendor obligations</CardTitle>
          <CardDescription>
            Canonical contract-line, invoice-line, and re-rent status reporting that separates owned-fleet external rentals from third-party rerental fulfillment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {externalRentalQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading external-rental reporting lines…</p>
          ) : externalRentalQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Unable to load external-rental reporting</AlertTitle>
              <AlertDescription>Confirm access to the shared external-rental reporting view and refresh the page.</AlertDescription>
            </Alert>
          ) : externalRentalFilteredRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No external-rental or third-party rerental rows matched the current scope and reporting period filters.
            </p>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <Card data-testid="external-rental-owned-revenue">
                  <CardHeader className="pb-2">
                    <CardDescription>Owned-fleet external-rental revenue</CardDescription>
                    <CardTitle>{formatCurrency(ownedExternalRentalRevenue, externalRentalDisplayCurrency)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Revenue invoiced for owned assets rented externally without mixing in rerental fulfillment.
                  </CardContent>
                </Card>
                <Card data-testid="external-rental-owned-utilization">
                  <CardHeader className="pb-2">
                    <CardDescription>Owned-fleet utilization uplift</CardDescription>
                    <CardTitle>{`${ownedUtilizationPct.toFixed(1)}%`}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {`${Math.round(ownedUtilizationMinutes / 60)} hours of external-rental use from the owned fleet.`}
                  </CardContent>
                </Card>
                <Card data-testid="external-rental-vendor-obligations">
                  <CardHeader className="pb-2">
                    <CardDescription>Third-party vendor obligations</CardDescription>
                    <CardTitle>{formatCurrency(thirdPartyVendorObligations, externalRentalDisplayCurrency)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Accrued rerental obligation from contract-line rate, elapsed usage, and vendor-side reference capture.
                  </CardContent>
                </Card>
                <Card data-testid="external-rental-margin">
                  <CardHeader className="pb-2">
                    <CardDescription>Estimated rerental margin</CardDescription>
                    <CardTitle>{formatCurrency(thirdPartyMargin, externalRentalDisplayCurrency)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Customer revenue less accrued third-party rerental obligation for fulfilled external demand.
                  </CardContent>
                </Card>
              </div>

              <div className="space-y-3">
                {externalRentalRowsForDisplay.map((row) => (
                  <div
                    key={row.reporting_line_id}
                    className="rounded-lg border p-3"
                    data-testid={`external-rental-row-${row.reporting_line_id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">
                        {row.invoice_reference || row.contract_id || row.contract_line_id}
                      </div>
                      <Badge variant={row.fulfillment_model === 'third_party_rerental' ? 'secondary' : 'outline'}>
                        {row.fulfillment_model === 'third_party_rerental'
                          ? 'Third-party rerental fulfillment'
                          : 'Owned-fleet external rental'}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm">
                      Revenue: {formatCurrency(row.customer_revenue_reporting_amount, row.reporting_currency_code)}
                      {row.fulfillment_model === 'third_party_rerental'
                        ? ` · Obligation: ${formatCurrency(row.vendor_obligation_reporting_amount, row.reporting_currency_code)} · Margin: ${formatCurrency(row.gross_margin_reporting_amount, row.reporting_currency_code)}`
                        : ` · Utilization uplift: ${row.utilization_uplift_pct.toFixed(1)}%`}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Branch: {row.branch_name || 'Unassigned branch'}
                      {row.asset_name ? ` · Asset: ${row.asset_name}` : ''}
                      {row.reporting_date ? ` · Reporting date: ${row.reporting_date}` : ''}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Vendor reference: {row.vendor_ref || row.obligation_reference_status.replace(/_/g, ' ')}
                      {row.rerent_status_label ? ` · Rerent status: ${row.rerent_status_label}` : ''}
                    </p>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  {externalRentalFilteredRows[0]?.formula_reference}
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Report Filters</CardTitle>
          <CardDescription>Filter by org scope, reporting period, and covered document type without changing the underlying dataset.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="enterprise-scope-type">Scope Level</Label>
            <select
              id="enterprise-scope-type"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={scopeType}
              onChange={(event) => setScopeType(event.target.value as ScopeType)}
            >
              <option value="company">Company</option>
              <option value="region">Region</option>
              <option value="branch">Branch</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="enterprise-scope">Org Scope</Label>
            <select
              id="enterprise-scope"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={scopeId}
              onChange={(event) => setScopeId(event.target.value)}
            >
              <option value="">All {scopeType}s</option>
              {scopeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="enterprise-document-type">Document Type</Label>
            <select
              id="enterprise-document-type"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
            >
              <option value="all">All covered docs</option>
              <option value="invoice">Invoices</option>
              <option value="rental_contract">Contracts</option>
              <option value="rental_order">Orders</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="enterprise-period-start">Period Start</Label>
            <Input
              id="enterprise-period-start"
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="enterprise-period-end">Period End</Label>
            <Input
              id="enterprise-period-end"
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Documents Covered</CardDescription>
            <CardTitle>{filteredRows.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {documentType === 'all' ? 'Orders, contracts, and invoices' : `${documentType.replace('_', ' ')} records`}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Regions Covered</CardDescription>
            <CardTitle>{regionSummaries.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {branchSummaries.length} branches represented in the current filter set.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Reporting Currency Rollups</CardDescription>
            <CardTitle>{reportingCurrencyTotals[0] ? formatCurrency(reportingCurrencyTotals[0].amount, reportingCurrencyTotals[0].currencyCode) : '—'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            {reportingCurrencyTotals.map((rollup) => (
              <div key={rollup.currencyCode}>
                {rollup.currencyCode}: {formatCurrency(rollup.amount, rollup.currencyCode)}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Source Currencies Preserved</CardDescription>
            <CardTitle>{new Set(filteredRows.map((row) => row.transaction_currency_code)).size}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {Array.from(new Set(filteredRows.map((row) => row.transaction_currency_code))).sort().map((currencyCode) => (
              <Badge key={currencyCode} variant="secondary">{currencyCode}</Badge>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card data-testid="enterprise-company-summary">
          <CardHeader>
            <CardTitle>Company Summary</CardTitle>
            <CardDescription>Consolidated rollups in reporting currency with source-currency preservation badges.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {companySummaries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No company-level results match the current filters.</p>
            ) : companySummaries.map((summary) => (
              <button
                key={summary.scopeId}
                type="button"
                className="w-full rounded-lg border p-3 text-left hover:border-primary"
                onClick={() => setDrilldown({ scopeType: 'company', scopeId: summary.scopeId, label: summary.scopeName })}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{summary.scopeName}</div>
                    <div className="text-xs text-muted-foreground">{summary.documentCount} documents · {summary.branchCount} branches</div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium">{formatCurrency(summary.reportingTotalAmount, 'USD')}</div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {summary.transactionCurrencyCodes.map((currencyCode) => (
                        <Badge key={currencyCode} variant="outline">{currencyCode}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card data-testid="enterprise-region-summary">
          <CardHeader>
            <CardTitle>Region Summary</CardTitle>
            <CardDescription>Use region rows as the consolidated-to-branch drill-down entry point for the demo path.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {regionSummaries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No region-level results match the current filters.</p>
            ) : regionSummaries.map((summary) => (
              <button
                key={summary.scopeId}
                type="button"
                className="w-full rounded-lg border p-3 text-left hover:border-primary"
                onClick={() => setDrilldown({ scopeType: 'region', scopeId: summary.scopeId, label: summary.scopeName })}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{summary.scopeName}</div>
                    <div className="text-xs text-muted-foreground">{summary.documentCount} documents · {summary.entityCount} source records</div>
                  </div>
                  <div className="text-right font-medium">{formatCurrency(summary.reportingTotalAmount, 'USD')}</div>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr,1.4fr]">
        <Card data-testid="enterprise-branch-drilldown">
          <CardHeader>
            <CardTitle>Branch Drill-Down</CardTitle>
            <CardDescription>
              {drilldown ? `Current context: ${drilldown.label}` : 'Choose a company or region summary to inspect branch detail.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {aggregateByScope(drilldownRows, 'branch').length === 0 ? (
              <p className="text-sm text-muted-foreground">No branch detail matches the selected consolidated context.</p>
            ) : aggregateByScope(drilldownRows, 'branch').map((summary) => (
              <button
                key={summary.scopeId}
                type="button"
                className="w-full rounded-lg border p-3 text-left hover:border-primary"
                onClick={() => setDrilldown({ scopeType: 'branch', scopeId: summary.scopeId, label: summary.scopeName })}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{summary.scopeName}</div>
                    <div className="text-xs text-muted-foreground">{summary.documentCount} documents · {summary.entityCount} source records</div>
                  </div>
                  <div className="text-right font-medium">{formatCurrency(summary.reportingTotalAmount, 'USD')}</div>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card data-testid="enterprise-entity-detail">
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>Per-Entity Detail</CardTitle>
                <CardDescription>Every row preserves the source document, origin branch, transaction currency, and reporting-currency rollup.</CardDescription>
              </div>
              {entityOptions.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const nextEntity = entityOptions[0];
                    if (nextEntity) {
                      setDrilldown({ scopeType: 'entity', scopeId: nextEntity.id, label: nextEntity.label });
                    }
                  }}
                >
                  Focus first entity
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {drilldownRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No detail rows match the selected filters.</p>
            ) : drilldownRows.map((row) => (
              <div key={row.source_entity_id} className="rounded-lg border p-3" data-testid={`enterprise-report-row-${row.source_entity_id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{row.document_number}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.company_scope_name} · {row.region_scope_name} · {row.branch_scope_name}
                    </div>
                  </div>
                  <Badge variant="outline">{row.document_status}</Badge>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <div className="text-sm">
                    <div>Transaction Amount</div>
                    <div className="font-medium">
                      {formatCurrency(row.transaction_total_amount, row.transaction_currency_code)} ({row.transaction_currency_code})
                    </div>
                  </div>
                  <div className="text-sm">
                    <div>Reporting Amount</div>
                    <div className="font-medium">
                      {formatCurrency(row.reporting_total_amount, row.reporting_currency_code)} ({row.reporting_currency_code})
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{row.source_entity_type}</Badge>
                  <span>Date: {row.document_date}</span>
                  {row.fx_rate_used != null && <span>FX: {row.fx_rate_used.toFixed(4)} ({row.fx_rate_source})</span>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
