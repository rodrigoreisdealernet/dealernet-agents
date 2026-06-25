import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthContext';
import { canWrite } from '@/auth/types';
import { supabase } from '@/data/supabase';
import {
  formatLocalizedCurrency,
  formatLocalizedDate,
  formatLocalizedDateTime,
  formatLocalizedNumber,
  resolveLocalePolicy,
  type ScopeLocaleConfig,
} from '@/lib/localePolicy';

type PaymentMethod = 'card' | 'ach';

interface EntityVersionRow {
  data: Record<string, unknown>;
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const errorRecord = error as { message?: string; code?: string; status?: number; statusCode?: number };
  const message = String(errorRecord.message || '').toLowerCase();
  const code = String(errorRecord.code || '').toLowerCase();
  const status = Number(errorRecord.status || errorRecord.statusCode || 0);
  return (
    status === 401 ||
    status === 403 ||
    code === '42501' ||
    message.includes('permission') ||
    message.includes('forbidden') ||
    message.includes('not allowed')
  );
}

function getTodayUtcTimestamp(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

interface EntityRow {
  id: string;
  created_at: string;
  entity_versions?: EntityVersionRow[];
}

interface PortalFinancialEntityRpcRow {
  entity_type: string;
  id: string;
  created_at: string;
  data: Record<string, unknown>;
}

interface PortalInvoice {
  id: string;
  createdAt: string;
  invoiceNumber: string;
  status: string;
  invoiceDate: string;
  dueDate: string;
  total: number;
  openBalance: number | null;
  customerId: string;
  billingAccountId: string;
  contractId: string;
  jobSiteId: string;
  branchId: string;
  branchLabel: string;
  branchFilterKey: string;
  transactionCurrencyCode: string;
  transactionCurrencyExplicit: boolean;
  reportingCurrencyCode: string;
  fxRateApplied: number;
  fxRateEffectiveAt: string;
  billingSourceSyncedAt: string;
  arSourceSyncedAt: string;
}

interface PaymentRecord {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  method: PaymentMethod;
  amount: number;
  createdAt: string;
  currencyCode: string;
}

interface ProjectAllocationLine {
  id: string;
  projectContextId: string;
  costCode: string;
  lineStatus: string;
  approvalEventType: string;
  signatureCaptured: boolean;
  equipmentCost: number;
  currencyCode: string;
  assetId: string;
  categoryId: string;
  contractId: string;
  eventDate: string;
}

interface PortalContract {
  id: string;
  createdAt: string;
  contractNumber: string;
  status: string;
  customerId: string;
  billingAccountId: string;
  jobSiteId: string;
  branchId: string;
  rentalSourceSyncedAt: string;
}

interface PortalContractLine {
  id: string;
  contractId: string;
  assetId: string;
  status: string;
  rateType: string;
  rateAmount: number;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string;
  actualEnd: string;
}

interface PortalAsset {
  id: string;
  name: string;
  branchId: string;
  branchName: string;
}

interface PortalInvoiceDocument {
  id: string;
  invoiceId: string;
  contractId: string;
  title: string;
  downloadUrl: string | null;
  mimeType: string;
}

interface RecordedPayment {
  id: string;
  invoiceId: string;
  amount: number;
  status: string;
}

type AgingBucket = 'current' | 'overdue' | '120+';

const PAYABLE_STATUSES = new Set(['pending', 'sent']);
const NON_APPLIED_PAYMENT_STATUSES = new Set(['void', 'failed', 'cancelled', 'reversed']);
const AGING_BUCKETS: AgingBucket[] = ['current', 'overdue', '120+'];
const CURRENCY_EPSILON = 0.0001;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const PORTAL_FINANCIALS_MAX_PAYMENT_HISTORY_ENTRIES = 25;
const PORTAL_FINANCIALS_PAYMENT_HISTORY_STORAGE_KEY = 'portal-financials-payment-history';

interface LocaleScopeRow {
  id: string;
  created_at: string;
  entity_versions?: EntityVersionRow[];
}

interface FinancialsCopy {
  pageTitle: string;
  pageDescription: string;
  paymentPanelTitle: string;
  paymentMethods: {
    card: string;
    ach: string;
  };
  taxLabel: string;
}

const FINANCIALS_COPY: Record<string, FinancialsCopy> = {
  'en-US': {
    pageTitle: 'Customer Portal · Invoices & Payments',
    pageDescription:
      'Review outstanding balances, project-level equipment allocations, and collect online payments with card or ACH.',
    paymentPanelTitle: 'Pay Online (Card / ACH)',
    paymentMethods: { card: 'Card', ach: 'ACH' },
    taxLabel: 'Sales tax',
  },
  'en-GB': {
    pageTitle: 'Customer Portal · Invoices & Payments',
    pageDescription:
      'Review outstanding balances, project-level equipment allocations, and collect online payments with card or bank transfer.',
    paymentPanelTitle: 'Pay Online (Card / BACS)',
    paymentMethods: { card: 'Card', ach: 'Bank transfer' },
    taxLabel: 'VAT',
  },
};

function normalizeCurrencyCode(value: unknown): string {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'USD';
}

function normalizeIdList(...values: Array<unknown>): string[] {
  return Array.from(
    new Set(
      values.flatMap((value) => {
        if (typeof value === 'string') {
          const trimmed = value.trim();
          return trimmed ? [trimmed] : [];
        }
        if (!Array.isArray(value)) {
          return [];
        }
        return value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean);
      })
    )
  );
}

function getTimestampString(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function isTimestampOlderThan(value: string, days: number, todayUtcTimestamp: number): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return todayUtcTimestamp - parsed >= days * DAY_IN_MS;
}

function resolveDocumentDownloadUrl(data: Record<string, unknown>): string | null {
  const directUrl =
    getString(data, 'download_url')
    || getString(data, 'document_url')
    || getString(data, 'public_url')
    || getString(data, 'file_url')
    || getString(data, 'url');
  if (directUrl) {
    return directUrl;
  }

  const storageRef = getString(data, 'storage_ref');
  if (!storageRef) {
    return null;
  }
  if (/^(https?:)?\/\//i.test(storageRef) || storageRef.startsWith('/')) {
    return storageRef;
  }

  const bucketName = getString(data, 'bucket_name') || getString(data, 'document_bucket');
  if (!bucketName) {
    return null;
  }
  return supabase.storage.from(bucketName).getPublicUrl(storageRef).data.publicUrl;
}

export const Route = createFileRoute('/rental/portal-financials')({
  component: PortalFinancialsPage,
});

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

function mapScopeLocaleConfig(rows: LocaleScopeRow[] | null | undefined, explicitScopeId?: string): ScopeLocaleConfig | null {
  const target = (rows || []).find((row) => row.id === explicitScopeId)
    || (rows || []).find((row) => {
      const data = row.entity_versions?.[0]?.data;
      return Boolean(
        data
        && (
          typeof data.locale_code === 'string'
          || typeof data.tax_region_code === 'string'
          || typeof data.timezone === 'string'
          || typeof data.currency_code === 'string'
          || typeof data.currency_minor_unit === 'number'
        )
      );
    });
  const data = target?.entity_versions?.[0]?.data || {};
  const currencyMetadata =
    typeof data.currency_metadata === 'object' && data.currency_metadata !== null
      ? (data.currency_metadata as Record<string, unknown>)
      : {};
  const fromDataMinorUnit = data.currency_minor_unit;
  const fromCurrencyMetadataMinorUnit = currencyMetadata.currency_minor_unit;
  const currencyMinorUnit =
    typeof fromDataMinorUnit === 'number'
      ? fromDataMinorUnit
      : typeof fromCurrencyMetadataMinorUnit === 'number'
        ? fromCurrencyMetadataMinorUnit
        : null;
  return {
    localeCode: getString(data, 'locale_code') || getString(currencyMetadata, 'locale_code') || null,
    taxRegionCode: getString(data, 'tax_region_code') || getString(currencyMetadata, 'tax_region_code') || null,
    timezone: getString(data, 'timezone') || getString(currencyMetadata, 'timezone') || null,
    currencyCode: getString(data, 'currency_code') || getString(currencyMetadata, 'currency_code') || null,
    currencyMinorUnit,
  };
}

interface SourceScopeStatus {
  isPortalScoped: boolean;
  customerIds: string[];
  billingAccountIds: string[];
  jobSiteIds: string[];
  contractIds: string[];
}

function getCopy(localeCode: string): FinancialsCopy {
  const normalized = localeCode.toLowerCase();
  return FINANCIALS_COPY[normalized === 'en-gb' ? 'en-GB' : 'en-US'];
}

function formatCurrency(
  value: number,
  localePolicy: ReturnType<typeof resolveLocalePolicy>,
  currencyCode?: string
): string {
  return formatLocalizedCurrency(value, {
    ...localePolicy,
    currencyCode: normalizeCurrencyCode(currencyCode || localePolicy.currencyCode),
  });
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatCalendarDate(
  value: string,
  localePolicy: ReturnType<typeof resolveLocalePolicy>,
  fallback = 'Unavailable'
): string {
  const parsed = parseUtcDateOnly(value);
  if (!parsed) {
    return fallback;
  }
  return new Intl.DateTimeFormat(localePolicy.localeCode, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(parsed);
}

function isPaymentRecord(value: unknown): value is PaymentRecord {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as PaymentRecord).id === 'string'
    && typeof (value as PaymentRecord).invoiceId === 'string'
    && typeof (value as PaymentRecord).invoiceNumber === 'string'
    && ((value as PaymentRecord).method === 'card' || (value as PaymentRecord).method === 'ach')
    && typeof (value as PaymentRecord).amount === 'number'
    && Number.isFinite((value as PaymentRecord).amount)
    && typeof (value as PaymentRecord).createdAt === 'string'
    && typeof (value as PaymentRecord).currencyCode === 'string'
  );
}

function mapCurrentEntityRows(rows: EntityRow[] | null | undefined): EntityRow[] {
  return (rows || []).filter((row) => Array.isArray(row.entity_versions) && row.entity_versions.length > 0);
}

function mapInvoices(rows: EntityRow[] | null | undefined): PortalInvoice[] {
  return mapCurrentEntityRows(rows).map((row) => {
    const data = row.entity_versions?.[0]?.data || {};
    const transactionCurrencyRaw = getString(data, 'transaction_currency_code');
    const transactionCurrencyExplicit = transactionCurrencyRaw.trim().length > 0;
    const transactionCurrencyCode = normalizeCurrencyCode(transactionCurrencyExplicit ? transactionCurrencyRaw : 'USD');
    const reportingCurrencyCode = normalizeCurrencyCode(getString(data, 'reporting_currency_code', transactionCurrencyCode));
    const fxRateCandidate = getNumber(data, 'fx_rate_applied');
    const fxRateApplied = fxRateCandidate > 0 ? fxRateCandidate : transactionCurrencyCode === reportingCurrencyCode ? 1 : 0;
    const dueDate =
      getString(data, 'due_date') ||
      getString(data, 'payment_due_date') ||
      getString(data, 'due_at') ||
      getString(data, 'invoice_due_date');
    const openBalance =
      getOptionalNumber(data, 'open_balance') ??
      getOptionalNumber(data, 'balance_due') ??
      getOptionalNumber(data, 'amount_due') ??
      getOptionalNumber(data, 'outstanding_balance');
    const branchId =
      getString(data, 'branch_id') || getString(data, 'location_id') || getString(data, 'branch_location_id');
    const branchLabel =
      getString(data, 'branch_name') ||
      getString(data, 'location_name') ||
      getString(data, 'branch_location_name') ||
      branchId ||
      'Unassigned';
    const branchFilterKey = branchId || branchLabel;
    return {
      id: row.id,
      createdAt: row.created_at,
      invoiceNumber: getString(data, 'invoice_number', `INV-${row.id.slice(0, 8)}`),
      status: getString(data, 'status', 'pending'),
      invoiceDate: getString(data, 'invoice_date', ''),
      dueDate,
      total: getNumber(data, 'total'),
      openBalance: openBalance === null ? null : roundCurrency(Math.max(0, openBalance)),
      customerId: getString(data, 'customer_id'),
      billingAccountId: getString(data, 'billing_account_id'),
      contractId: getString(data, 'contract_id'),
      jobSiteId: getString(data, 'job_site_id'),
      branchId,
      branchLabel,
      branchFilterKey,
      transactionCurrencyCode,
      transactionCurrencyExplicit,
      reportingCurrencyCode,
      fxRateApplied,
      fxRateEffectiveAt: getString(data, 'fx_rate_effective_at'),
      billingSourceSyncedAt: getTimestampString(data, ['billing_source_synced_at', 'billing_synced_at', 'billing_freshness_at']),
      arSourceSyncedAt: getTimestampString(data, ['ar_source_synced_at', 'open_balance_synced_at', 'ar_freshness_at', 'balance_freshness_at']),
    };
  });
}

function mapPayments(rows: EntityRow[] | null | undefined): RecordedPayment[] {
  return mapCurrentEntityRows(rows).map((row) => {
    const data = row.entity_versions?.[0]?.data || {};
    return {
      id: row.id,
      invoiceId: getString(data, 'invoice_id'),
      amount: roundCurrency(Math.max(0, getNumber(data, 'amount'))),
      status: getString(data, 'status', 'posted').toLowerCase(),
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

function getAgingBucket(invoice: PortalInvoice, outstandingBalance: number, todayUtcTimestamp: number): AgingBucket {
  if (outstandingBalance <= CURRENCY_EPSILON) {
    return 'current';
  }
  const dueDate = parseUtcDateOnly(invoice.dueDate);
  if (!dueDate) {
    return 'current';
  }
  const daysPastDue = Math.floor((todayUtcTimestamp - dueDate.getTime()) / DAY_IN_MS);
  if (daysPastDue >= 120) {
    return '120+';
  }
  if (daysPastDue > 0) {
    return 'overdue';
  }
  return 'current';
}

function mapProjectAllocationLines(rows: EntityRow[] | null | undefined): ProjectAllocationLine[] {
  return mapCurrentEntityRows(rows).map((row) => {
    const data = row.entity_versions?.[0]?.data || {};
    const fieldEvidence =
      typeof data.field_evidence === 'object' && data.field_evidence !== null
        ? (data.field_evidence as Record<string, unknown>)
        : {};
    const lineStatus = getString(data, 'status', 'pending');
    const actualEnd = getString(data, 'actual_end');
    const actualStart = getString(data, 'actual_start');
    const plannedStart = getString(data, 'planned_start');
    let eventDate: string;
    // Prioritise the most operationally relevant date for each status:
    // returned → actual return date; checked_out → actual delivery date;
    // otherwise (pending/draft) → planned start as the next expected event.
    if (lineStatus === 'returned') {
      eventDate = actualEnd || actualStart || plannedStart || row.created_at;
    } else if (lineStatus === 'checked_out') {
      eventDate = actualStart || plannedStart || row.created_at;
    } else {
      eventDate = plannedStart || row.created_at;
    }
    return {
      id: row.id,
      projectContextId:
        getString(data, 'project_context_id') || getString(data, 'project_id') || getString(data, 'job_site_id') || 'Unassigned',
      costCode: getString(data, 'cost_code', 'Unassigned'),
      lineStatus,
      approvalEventType: getString(fieldEvidence, 'approval_event_type', 'delivery'),
      signatureCaptured: Boolean(getString(fieldEvidence, 'signature')),
      equipmentCost:
        getNumber(data, 'allocated_equipment_cost') || getNumber(data, 'equipment_cost') || getNumber(data, 'rate_amount'),
      currencyCode: normalizeCurrencyCode(
        getString(data, 'transaction_currency_code') || getString(data, 'reporting_currency_code') || getString(data, 'currency_code', 'USD')
      ),
      assetId: getString(data, 'asset_id'),
      // Contract lines store category under 'category_id' in newer seeds and
      // 'asset_category_id' in older/migrated records; check both for compatibility.
      categoryId: getString(data, 'category_id') || getString(data, 'asset_category_id'),
      contractId: getString(data, 'contract_id'),
      eventDate,
    };
  });
}

function mapContracts(rows: EntityRow[] | null | undefined): PortalContract[] {
  return mapCurrentEntityRows(rows).map((row) => {
    const data = row.entity_versions?.[0]?.data || {};
    return {
      id: row.id,
      createdAt: row.created_at,
      contractNumber: getString(data, 'contract_number', `RC-${row.id.slice(0, 8)}`),
      status: getString(data, 'status', 'draft'),
      customerId: getString(data, 'customer_id'),
      billingAccountId: getString(data, 'billing_account_id'),
      jobSiteId: getString(data, 'job_site_id'),
      branchId: getString(data, 'branch_id'),
      rentalSourceSyncedAt: getTimestampString(data, ['rental_source_synced_at', 'source_updated_at', 'data_freshness_at']),
    };
  });
}

function mapContractLines(rows: EntityRow[] | null | undefined): PortalContractLine[] {
  return mapCurrentEntityRows(rows).map((row) => {
    const data = row.entity_versions?.[0]?.data || {};
    return {
      id: row.id,
      contractId: getString(data, 'contract_id'),
      assetId: getString(data, 'asset_id'),
      status: getString(data, 'status', 'pending'),
      rateType: getString(data, 'rate_type', 'rate'),
      rateAmount: getNumber(data, 'rate_amount'),
      plannedStart: getString(data, 'planned_start'),
      plannedEnd: getString(data, 'planned_end'),
      actualStart: getString(data, 'actual_start'),
      actualEnd: getString(data, 'actual_end'),
    };
  });
}

function mapAssets(rows: EntityRow[] | null | undefined): PortalAsset[] {
  return mapCurrentEntityRows(rows).map((row) => {
    const data = row.entity_versions?.[0]?.data || {};
    return {
      id: row.id,
      name: getString(data, 'name', `Asset ${row.id.slice(0, 8).toUpperCase()}`),
      branchId: getString(data, 'branch_id'),
      branchName: getString(data, 'branch_name'),
    };
  });
}

function mapCategories(rows: EntityRow[] | null | undefined): Map<string, string> {
  const categoryMap = new Map<string, string>();
  for (const row of mapCurrentEntityRows(rows)) {
    const data = row.entity_versions?.[0]?.data || {};
    // Newer category records use 'name'; older seeds may store it as 'category_name'.
    const name = getString(data, 'name') || getString(data, 'category_name');
    if (name) {
      categoryMap.set(row.id, name);
    }
  }
  return categoryMap;
}

function mapInvoiceDocuments(rows: EntityRow[] | null | undefined): PortalInvoiceDocument[] {
  return mapCurrentEntityRows(rows)
    .map((row) => {
      const data = row.entity_versions?.[0]?.data || {};
      return {
        id: row.id,
        invoiceId: getString(data, 'invoice_id'),
        contractId: getString(data, 'contract_id'),
        title: getString(data, 'title', 'Invoice document'),
        downloadUrl: resolveDocumentDownloadUrl(data),
        mimeType: getString(data, 'mime_type', 'application/pdf'),
      };
    })
    .filter((document) => document.invoiceId || document.contractId);
}

function formatOperationalStatus(line: ProjectAllocationLine): string {
  if (line.lineStatus === 'returned') {
    return line.signatureCaptured ? 'Off-rent complete · signed' : 'Off-rent complete · signature missing';
  }
  if (line.lineStatus === 'checked_out') {
    return line.signatureCaptured ? 'Delivered/on rent · signed' : 'Delivered/on rent · signature missing';
  }
  if (line.approvalEventType === 'requisition') {
    return line.signatureCaptured ? 'Requisition approved · signed' : 'Requisition pending signature';
  }
  return line.signatureCaptured ? 'Delivery approved · signed' : 'Delivery pending signature';
}

async function fetchCurrentEntityRows(entityType: string, limit = 100): Promise<EntityRow[]> {
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

  return (data || []) as EntityRow[];
}

function mapPortalFinancialEntityRowsByType(
  rows: PortalFinancialEntityRpcRow[] | null | undefined
): Partial<Record<string, EntityRow[]>> {
  return (rows || []).reduce<Partial<Record<string, EntityRow[]>>>((groupedRows, row) => {
    const entityRows = groupedRows[row.entity_type] || [];
    entityRows.push({
      id: row.id,
      created_at: row.created_at,
      entity_versions: [{ data: row.data }],
    });
    groupedRows[row.entity_type] = entityRows;
    return groupedRows;
  }, {});
}

async function fetchPortalFinancialEntityRows(): Promise<PortalFinancialEntityRpcRow[]> {
  const { data, error } = await supabase.rpc('portal_get_financial_entities');

  if (error) {
    throw error;
  }

  return (data || []) as PortalFinancialEntityRpcRow[];
}

function PortalFinancialsPage() {
  return <PortalFinancialsScreen />;
}

interface PortalFinancialsScreenProps {
  todayUtcTimestampOverride?: number;
}

export function PortalFinancialsScreen(props?: PortalFinancialsScreenProps) {
  const { todayUtcTimestampOverride } = props ?? {};
  const { profile } = useAuth();
  const [selectedBucket, setSelectedBucket] = useState<AgingBucket>('current');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [selectedBillingAccountId, setSelectedBillingAccountId] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [balanceOverrides, setBalanceOverrides] = useState<Record<string, number>>({});
  const [paymentHistory, setPaymentHistory] = useState<PaymentRecord[]>([]);
  const [paymentError, setPaymentError] = useState('');
  const [paymentMessage, setPaymentMessage] = useState('');
  const portalScope = useMemo<SourceScopeStatus>(() => {
    const customerIds = normalizeIdList(profile?.customerId);
    const billingAccountIds = normalizeIdList(profile?.billingAccountId, profile?.billingAccountIds);
    const jobSiteIds = normalizeIdList(profile?.jobSiteId, profile?.jobSiteIds);
    const contractIds = normalizeIdList(profile?.contractId, profile?.contractIds);
    return {
      isPortalScoped: customerIds.length > 0 || billingAccountIds.length > 0 || jobSiteIds.length > 0 || contractIds.length > 0,
      customerIds,
      billingAccountIds,
      jobSiteIds,
      contractIds,
    };
  }, [profile]);
  const portalFinancialsQuery = useQuery({
    queryKey: ['portal-financials', 'portal-read-model', profile?.id || 'anonymous'],
    queryFn: fetchPortalFinancialEntityRows,
    enabled: portalScope.isPortalScoped,
    refetchInterval: 30_000,
  });

  const invoicesQuery = useQuery({
    queryKey: ['portal-financials', 'invoices'],
    queryFn: () => fetchCurrentEntityRows('invoice'),
    enabled: !portalScope.isPortalScoped,
    refetchInterval: 30_000,
  });

  const customersQuery = useQuery({
    queryKey: ['portal-financials', 'customers'],
    queryFn: () => fetchCurrentEntityRows('customer', 200),
    enabled: !portalScope.isPortalScoped,
  });

  const billingAccountsQuery = useQuery({
    queryKey: ['portal-financials', 'billing-accounts'],
    queryFn: () => fetchCurrentEntityRows('billing_account', 200),
    enabled: !portalScope.isPortalScoped,
  });
  const paymentsQuery = useQuery({
    queryKey: ['portal-financials', 'payments'],
    queryFn: () => fetchCurrentEntityRows('payment', 500),
    enabled: !portalScope.isPortalScoped,
    refetchInterval: 30_000,
  });
  const projectLinesQuery = useQuery({
    queryKey: ['portal-financials', 'project-lines'],
    queryFn: () => fetchCurrentEntityRows('rental_contract_line', 500),
    enabled: !portalScope.isPortalScoped,
  });
  const contractsQuery = useQuery({
    queryKey: ['portal-financials', 'contracts'],
    queryFn: () => fetchCurrentEntityRows('rental_contract', 300),
    enabled: !portalScope.isPortalScoped,
  });
  const assetsQuery = useQuery({
    queryKey: ['portal-financials', 'assets'],
    queryFn: () => fetchCurrentEntityRows('asset', 500),
    enabled: !portalScope.isPortalScoped,
  });
  const categoriesQuery = useQuery({
    queryKey: ['portal-financials', 'asset-categories'],
    queryFn: () => fetchCurrentEntityRows('asset_category', 200),
    enabled: !portalScope.isPortalScoped,
  });
  const documentsQuery = useQuery({
    queryKey: ['portal-financials', 'documents'],
    queryFn: () => fetchCurrentEntityRows('document', 500),
    enabled: !portalScope.isPortalScoped,
  });
  const jobSitesQuery = useQuery({
    queryKey: ['portal-financials', 'job-sites'],
    queryFn: () => fetchCurrentEntityRows('job_site', 300),
    enabled: !portalScope.isPortalScoped,
  });
  const branchScopeQuery = useQuery({
    queryKey: ['portal-financials', 'scope', 'branch'],
    queryFn: () => fetchCurrentEntityRows('branch', 200),
    enabled: !portalScope.isPortalScoped,
  });
  const regionScopeQuery = useQuery({
    queryKey: ['portal-financials', 'scope', 'region'],
    queryFn: () => fetchCurrentEntityRows('region', 200),
    enabled: !portalScope.isPortalScoped,
  });
  const companyScopeQuery = useQuery({
    queryKey: ['portal-financials', 'scope', 'company'],
    queryFn: () => fetchCurrentEntityRows('company', 50),
    enabled: !portalScope.isPortalScoped,
  });
  const portalEntityRowsByType = useMemo(
    () => mapPortalFinancialEntityRowsByType(portalFinancialsQuery.data),
    [portalFinancialsQuery.data]
  );
  const invoiceRows = portalScope.isPortalScoped ? portalEntityRowsByType.invoice : invoicesQuery.data;
  const customerRows = portalScope.isPortalScoped ? portalEntityRowsByType.customer : customersQuery.data;
  const billingAccountRows = portalScope.isPortalScoped ? portalEntityRowsByType.billing_account : billingAccountsQuery.data;
  const paymentRows = portalScope.isPortalScoped ? portalEntityRowsByType.payment : paymentsQuery.data;
  const contractLineRows = portalScope.isPortalScoped ? portalEntityRowsByType.rental_contract_line : projectLinesQuery.data;
  const contractRows = portalScope.isPortalScoped ? portalEntityRowsByType.rental_contract : contractsQuery.data;
  const assetRows = portalScope.isPortalScoped ? portalEntityRowsByType.asset : assetsQuery.data;
  const categoryRows = portalScope.isPortalScoped ? portalEntityRowsByType.asset_category : categoriesQuery.data;
  const documentRows = portalScope.isPortalScoped ? portalEntityRowsByType.document : documentsQuery.data;
  const jobSiteRows = portalScope.isPortalScoped ? portalEntityRowsByType.job_site : jobSitesQuery.data;

  const invoices = useMemo(() => mapInvoices(invoiceRows), [invoiceRows]);
  const payments = useMemo(() => mapPayments(paymentRows), [paymentRows]);
  const allocationLines = useMemo(() => mapProjectAllocationLines(contractLineRows), [contractLineRows]);
  const contracts = useMemo(() => mapContracts(contractRows), [contractRows]);
  const contractLines = useMemo(() => mapContractLines(contractLineRows), [contractLineRows]);
  const assets = useMemo(() => mapAssets(assetRows), [assetRows]);
  const categoryMap = useMemo(() => mapCategories(categoryRows), [categoryRows]);
  const invoiceDocuments = useMemo(() => mapInvoiceDocuments(documentRows), [documentRows]);
  const canRecordPayments = canWrite(profile?.role);
  const localePolicy = useMemo(
    () =>
      resolveLocalePolicy({
        userOverride: profile
          ? {
            localeCode: profile.localeCode,
            taxRegionCode: profile.taxRegionCode,
            timezone: profile.timezone,
            currencyCode: profile.currencyCode,
            currencyMinorUnit: profile.currencyMinorUnit,
          }
          : null,
        branch: mapScopeLocaleConfig(branchScopeQuery.data, profile?.branchId),
        region: mapScopeLocaleConfig(regionScopeQuery.data, profile?.regionId),
        company: mapScopeLocaleConfig(companyScopeQuery.data, profile?.companyId),
      }),
    [profile, branchScopeQuery.data, regionScopeQuery.data, companyScopeQuery.data]
  );
  const copy = useMemo(() => getCopy(localePolicy.localeCode), [localePolicy.localeCode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const storedHistory = window.sessionStorage.getItem(PORTAL_FINANCIALS_PAYMENT_HISTORY_STORAGE_KEY);
      if (!storedHistory) {
        return;
      }
      const parsed = JSON.parse(storedHistory);
      if (!Array.isArray(parsed)) {
        return;
      }
      setPaymentHistory(parsed.filter(isPaymentRecord));
    } catch {
      window.sessionStorage.removeItem(PORTAL_FINANCIALS_PAYMENT_HISTORY_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.sessionStorage.setItem(
      PORTAL_FINANCIALS_PAYMENT_HISTORY_STORAGE_KEY,
      JSON.stringify(paymentHistory.slice(0, PORTAL_FINANCIALS_MAX_PAYMENT_HISTORY_ENTRIES))
    );
  }, [paymentHistory]);

  const customerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of mapCurrentEntityRows(customerRows)) {
      const data = row.entity_versions?.[0]?.data || {};
      map.set(row.id, getString(data, 'name', 'Customer'));
    }
    return map;
  }, [customerRows]);

  const billingAccountNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of mapCurrentEntityRows(billingAccountRows)) {
      const data = row.entity_versions?.[0]?.data || {};
      map.set(row.id, getString(data, 'name', getString(data, 'account_number', 'Billing Account')));
    }
    return map;
  }, [billingAccountRows]);
  const jobSiteNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of mapCurrentEntityRows(jobSiteRows)) {
      const data = row.entity_versions?.[0]?.data || {};
      map.set(row.id, getString(data, 'name', row.id));
    }
    return map;
  }, [jobSiteRows]);
  const branchNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of mapCurrentEntityRows(branchScopeQuery.data)) {
      const data = row.entity_versions?.[0]?.data || {};
      map.set(row.id, getString(data, 'name', row.id));
    }
    return map;
  }, [branchScopeQuery.data]);
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const contractNumberMap = useMemo(
    () => new Map(contracts.map((c) => [c.id, c.contractNumber])),
    [contracts]
  );
  const projectAllocationGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        totalCost: number;
        currencyCode: string;
        signedCount: number;
        lineCount: number;
        costCodes: Map<string, { totalCost: number; lines: ProjectAllocationLine[] }>;
      }
    >();
    for (const line of allocationLines) {
      const projectLabel = jobSiteNames.get(line.projectContextId) || line.projectContextId;
      const groupKey = `${projectLabel}::${line.currencyCode}`;
      const projectGroup = groups.get(groupKey) || {
        totalCost: 0,
        currencyCode: line.currencyCode,
        signedCount: 0,
        lineCount: 0,
        costCodes: new Map<string, { totalCost: number; lines: ProjectAllocationLine[] }>(),
      };
      projectGroup.totalCost = roundCurrency(projectGroup.totalCost + line.equipmentCost);
      projectGroup.lineCount += 1;
      if (line.signatureCaptured) {
        projectGroup.signedCount += 1;
      }
      const costCodeGroup = projectGroup.costCodes.get(line.costCode) || { totalCost: 0, lines: [] };
      costCodeGroup.totalCost = roundCurrency(costCodeGroup.totalCost + line.equipmentCost);
      costCodeGroup.lines.push(line);
      projectGroup.costCodes.set(line.costCode, costCodeGroup);
      groups.set(groupKey, projectGroup);
    }
    return Array.from(groups.entries()).map(([groupKey, group]) => {
      const [projectLabel] = groupKey.split('::');
      return {
        projectLabel,
        currencyCode: group.currencyCode,
        totalCost: group.totalCost,
        signedCount: group.signedCount,
        lineCount: group.lineCount,
        costCodes: Array.from(group.costCodes.entries()).map(([costCode, value]) => ({ costCode, ...value })),
      };
    });
  }, [allocationLines, jobSiteNames]);

  const paymentsByInvoice = useMemo(() => {
    const map = new Map<string, number>();
    for (const payment of payments) {
      if (!payment.invoiceId || NON_APPLIED_PAYMENT_STATUSES.has(payment.status)) {
        continue;
      }
      map.set(payment.invoiceId, roundCurrency((map.get(payment.invoiceId) || 0) + payment.amount));
    }
    return map;
  }, [payments]);

  const invoiceOutstanding = useCallback(
    (invoice: PortalInvoice): number => {
      if (typeof balanceOverrides[invoice.id] === 'number') {
        return balanceOverrides[invoice.id];
      }
      const paid = paymentsByInvoice.get(invoice.id) || 0;
      const baseOutstanding =
        invoice.openBalance !== null
          ? invoice.openBalance
          : PAYABLE_STATUSES.has(invoice.status.toLowerCase())
            ? invoice.total
            : 0;
      return roundCurrency(Math.max(0, baseOutstanding - paid));
    },
    [balanceOverrides, paymentsByInvoice]
  );
  const invoiceDisplayCurrencyCode = useCallback(
    (invoice: PortalInvoice) => (invoice.transactionCurrencyExplicit ? invoice.transactionCurrencyCode : localePolicy.currencyCode),
    [localePolicy.currencyCode]
  );
  const todayUtcTimestamp = todayUtcTimestampOverride ?? getTodayUtcTimestamp();

  const openInvoices = useMemo(
    () => invoices.filter((invoice) => invoiceOutstanding(invoice) > 0),
    [invoices, invoiceOutstanding]
  );
  const outstandingBalance = useMemo(
    () => roundCurrency(openInvoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0)),
    [openInvoices, invoiceOutstanding]
  );

  const statuses = useMemo(
    () => Array.from(new Set(invoices.map((invoice) => invoice.status))).sort((a, b) => a.localeCompare(b)),
    [invoices]
  );

  const branchOptions = useMemo(
    () =>
      Array.from(
        new Map(
          invoices
            .filter((invoice) => invoice.branchFilterKey)
            .map((invoice) => [invoice.branchFilterKey, { id: invoice.branchFilterKey, label: invoice.branchLabel }])
        ).values()
      ),
    [invoices]
  );
  const primaryReportingCurrencyCode = useMemo(
    () => openInvoices[0]?.reportingCurrencyCode || invoices[0]?.reportingCurrencyCode || 'USD',
    [openInvoices, invoices]
  );

  const totalAllocatedEquipmentCost = useMemo(
    () => roundCurrency(allocationLines.reduce((sum, line) => sum + line.equipmentCost, 0)),
    [allocationLines]
  );

  const outstandingBalanceByReportingCurrency = useMemo(
    () => {
      const rollups = new Map<string, number>();
      for (const invoice of openInvoices) {
        const outstanding = invoiceOutstanding(invoice);
        const reportingAmount =
          invoice.reportingCurrencyCode === invoice.transactionCurrencyCode
            ? outstanding
            : roundCurrency(outstanding * (invoice.fxRateApplied || 0));
        rollups.set(
          invoice.reportingCurrencyCode,
          roundCurrency((rollups.get(invoice.reportingCurrencyCode) || 0) + reportingAmount)
        );
      }
      return Array.from(rollups.entries()).map(([currencyCode, amount]) => ({ currencyCode, amount }));
    },
    [openInvoices, invoiceOutstanding]
  );
  const hasExplicitTransactionCurrency = useMemo(
    () => openInvoices.some((invoice) => invoice.transactionCurrencyExplicit),
    [openInvoices]
  );

  const filteredInvoices = useMemo(() => {
    return openInvoices.filter((invoice) => {
      if (selectedBranchId && invoice.branchFilterKey !== selectedBranchId) {
        return false;
      }
      if (selectedCustomerId && invoice.customerId !== selectedCustomerId) {
        return false;
      }
      if (selectedBillingAccountId && invoice.billingAccountId !== selectedBillingAccountId) {
        return false;
      }
      if (selectedStatus && invoice.status !== selectedStatus) {
        return false;
      }
      return true;
    });
  }, [openInvoices, selectedBranchId, selectedCustomerId, selectedBillingAccountId, selectedStatus]);

  const bucketedInvoices = useMemo(() => {
    const bucketMap: Record<AgingBucket, PortalInvoice[]> = {
      current: [],
      overdue: [],
      '120+': [],
    };
    for (const invoice of filteredInvoices) {
      bucketMap[getAgingBucket(invoice, invoiceOutstanding(invoice), todayUtcTimestamp)].push(invoice);
    }
    return bucketMap;
  }, [filteredInvoices, invoiceOutstanding, todayUtcTimestamp]);

  const selectedBucketInvoices = bucketedInvoices[selectedBucket];

  const bucketRollups = useMemo(() => {
    return AGING_BUCKETS.map((bucket) => {
      const rollupByCurrency = new Map<string, number>();
      for (const invoice of bucketedInvoices[bucket]) {
        const outstanding = invoiceOutstanding(invoice);
        rollupByCurrency.set(
          invoice.transactionCurrencyCode,
          roundCurrency((rollupByCurrency.get(invoice.transactionCurrencyCode) || 0) + outstanding)
        );
      }
      return {
        bucket,
        count: bucketedInvoices[bucket].length,
        byCurrency: Array.from(rollupByCurrency.entries()).map(([currencyCode, amount]) => ({ currencyCode, amount })),
      };
    });
  }, [bucketedInvoices, invoiceOutstanding]);

  useEffect(() => {
    if (selectedInvoiceId && selectedBucketInvoices.some((invoice) => invoice.id === selectedInvoiceId)) {
      return;
    }
    const nextInvoice = selectedBucketInvoices[0]?.id || '';
    setSelectedInvoiceId(nextInvoice);
  }, [selectedBucketInvoices, selectedInvoiceId]);

  useEffect(() => {
    if (!selectedInvoiceId) {
      setPaymentAmount('');
      return;
    }
    const invoice = selectedBucketInvoices.find((bucketInvoice) => bucketInvoice.id === selectedInvoiceId);
    if (!invoice) {
      return;
    }
    setPaymentAmount(invoiceOutstanding(invoice).toFixed(2));
  }, [selectedInvoiceId, selectedBucketInvoices, invoiceOutstanding]);

  const selectedInvoice = useMemo(
    () => selectedBucketInvoices.find((invoice) => invoice.id === selectedInvoiceId),
    [selectedBucketInvoices, selectedInvoiceId]
  );

  const hasError =
    portalFinancialsQuery.isError
    || invoicesQuery.isError
    || customersQuery.isError
    || billingAccountsQuery.isError
    || paymentsQuery.isError
    || projectLinesQuery.isError
    || contractsQuery.isError
    || assetsQuery.isError
    || documentsQuery.isError
    || jobSitesQuery.isError
    || branchScopeQuery.isError
    || regionScopeQuery.isError
    || companyScopeQuery.isError;
  const isLoading =
    portalFinancialsQuery.isLoading
    || invoicesQuery.isLoading
    || customersQuery.isLoading
    || billingAccountsQuery.isLoading
    || paymentsQuery.isLoading
    || projectLinesQuery.isLoading
    || contractsQuery.isLoading
    || assetsQuery.isLoading
    || documentsQuery.isLoading
    || jobSitesQuery.isLoading
    || branchScopeQuery.isLoading
    || regionScopeQuery.isLoading
    || companyScopeQuery.isLoading;
  const isBlocked = [
    portalFinancialsQuery.error,
    invoicesQuery.error,
    customersQuery.error,
    billingAccountsQuery.error,
    paymentsQuery.error,
    projectLinesQuery.error,
    contractsQuery.error,
    assetsQuery.error,
    documentsQuery.error,
    jobSitesQuery.error,
    branchScopeQuery.error,
    regionScopeQuery.error,
    companyScopeQuery.error,
  ]
    .filter(Boolean)
    .some((error) => isPermissionError(error));
  const authorizedContracts = useMemo(() => {
    if (!portalScope.isPortalScoped) {
      return [];
    }
    return contracts.filter((contract) => {
      if (portalScope.customerIds.length > 0 && !portalScope.customerIds.includes(contract.customerId)) {
        return false;
      }
      if (portalScope.billingAccountIds.length > 0 && !portalScope.billingAccountIds.includes(contract.billingAccountId)) {
        return false;
      }
      if (portalScope.jobSiteIds.length > 0 && !portalScope.jobSiteIds.includes(contract.jobSiteId)) {
        return false;
      }
      if (portalScope.contractIds.length > 0 && !portalScope.contractIds.includes(contract.id)) {
        return false;
      }
      return true;
    });
  }, [contracts, portalScope]);
  const authorizedContractIds = useMemo(
    () => new Set(authorizedContracts.map((contract) => contract.id)),
    [authorizedContracts]
  );
  const authorizedLines = useMemo(
    () => contractLines.filter((line) => authorizedContractIds.has(line.contractId)),
    [authorizedContractIds, contractLines]
  );
  const activeContracts = useMemo(
    () => authorizedContracts.filter((contract) => contract.status.toLowerCase() === 'active'),
    [authorizedContracts]
  );
  const activeContractIds = useMemo(
    () => new Set(activeContracts.map((contract) => contract.id)),
    [activeContracts]
  );
  const portalLinesByContract = useMemo(() => {
    const map = new Map<string, PortalContractLine[]>();
    for (const line of authorizedLines) {
      if (!activeContractIds.has(line.contractId)) {
        continue;
      }
      const contractGroup = map.get(line.contractId) || [];
      contractGroup.push(line);
      map.set(line.contractId, contractGroup);
    }
    return map;
  }, [activeContractIds, authorizedLines]);
  const authorizedInvoices = useMemo(() => {
    if (!portalScope.isPortalScoped) {
      return [];
    }
    return invoices.filter((invoice) => {
      if (portalScope.customerIds.length > 0 && !portalScope.customerIds.includes(invoice.customerId)) {
        return false;
      }
      if (portalScope.billingAccountIds.length > 0 && !portalScope.billingAccountIds.includes(invoice.billingAccountId)) {
        return false;
      }
      if (portalScope.jobSiteIds.length > 0 && !portalScope.jobSiteIds.includes(invoice.jobSiteId)) {
        return false;
      }
      if (portalScope.contractIds.length > 0 && !portalScope.contractIds.includes(invoice.contractId)) {
        return false;
      }
      return true;
    });
  }, [invoices, portalScope]);
  const documentsByInvoice = useMemo(() => {
    const map = new Map<string, PortalInvoiceDocument[]>();
    for (const document of invoiceDocuments) {
      if (!document.invoiceId) {
        continue;
      }
      const docs = map.get(document.invoiceId) || [];
      docs.push(document);
      map.set(document.invoiceId, docs);
    }
    return map;
  }, [invoiceDocuments]);
  const portalOutstandingBalanceByReportingCurrency = useMemo(() => {
    const rollups = new Map<string, number>();
    for (const invoice of authorizedInvoices) {
      if (invoice.openBalance === null) {
        continue;
      }
      const reportingAmount =
        invoice.reportingCurrencyCode === invoice.transactionCurrencyCode
          ? invoice.openBalance
          : roundCurrency(invoice.openBalance * (invoice.fxRateApplied || 0));
      rollups.set(
        invoice.reportingCurrencyCode,
        roundCurrency((rollups.get(invoice.reportingCurrencyCode) || 0) + reportingAmount)
      );
    }
    return Array.from(rollups.entries()).map(([currencyCode, amount]) => ({ currencyCode, amount }));
  }, [authorizedInvoices]);
  const portalSourceExceptions = useMemo(() => {
    if (!portalScope.isPortalScoped) {
      return [];
    }
    const exceptions: string[] = [];
    for (const contract of activeContracts) {
      const contractLinesForScope = portalLinesByContract.get(contract.id) || [];
      if (!contract.rentalSourceSyncedAt) {
        exceptions.push(`${contract.contractNumber}: missing rental source freshness timestamp`);
      } else if (isTimestampOlderThan(contract.rentalSourceSyncedAt, 7, todayUtcTimestamp)) {
        exceptions.push(`${contract.contractNumber}: rental source stale since ${contract.rentalSourceSyncedAt}`);
      }
      if (contractLinesForScope.length === 0) {
        exceptions.push(`${contract.contractNumber}: no active equipment lines returned from the rental source`);
      }
      if (contract.jobSiteId && !jobSiteNames.get(contract.jobSiteId)) {
        exceptions.push(`${contract.contractNumber}: project location missing from source data`);
      }
      for (const line of contractLinesForScope) {
        const assetName = assetMap.get(line.assetId)?.name || line.assetId || 'equipment item';
        if (line.rateAmount <= 0) {
          exceptions.push(`${contract.contractNumber}: rate unavailable for ${assetName}`);
        }
        if (line.status.toLowerCase() === 'checked_out' && !line.plannedEnd && !line.actualEnd) {
          exceptions.push(`${contract.contractNumber}: due-back date unavailable for ${assetName}`);
        }
      }
    }
    for (const invoice of authorizedInvoices) {
      if (!invoice.dueDate) {
        exceptions.push(`${invoice.invoiceNumber}: missing due date from AR source`);
      }
      if (invoice.openBalance === null) {
        exceptions.push(`${invoice.invoiceNumber}: missing open balance from AR source`);
      }
      if (!invoice.billingSourceSyncedAt) {
        exceptions.push(`${invoice.invoiceNumber}: missing billing source freshness timestamp`);
      } else if (isTimestampOlderThan(invoice.billingSourceSyncedAt, 7, todayUtcTimestamp)) {
        exceptions.push(`${invoice.invoiceNumber}: billing source stale since ${invoice.billingSourceSyncedAt}`);
      }
      if (!invoice.arSourceSyncedAt) {
        exceptions.push(`${invoice.invoiceNumber}: missing AR source freshness timestamp`);
      } else if (isTimestampOlderThan(invoice.arSourceSyncedAt, 7, todayUtcTimestamp)) {
        exceptions.push(`${invoice.invoiceNumber}: AR source stale since ${invoice.arSourceSyncedAt}`);
      }
      const documents = documentsByInvoice.get(invoice.id) || [];
      if (documents.length === 0) {
        exceptions.push(`${invoice.invoiceNumber}: invoice document unavailable`);
      } else if (documents.every((document) => !document.downloadUrl)) {
        exceptions.push(`${invoice.invoiceNumber}: invoice document download is delayed`);
      }
    }
    return Array.from(new Set(exceptions));
  }, [
    activeContracts,
    assetMap,
    authorizedInvoices,
    documentsByInvoice,
    jobSiteNames,
    portalLinesByContract,
    portalScope.isPortalScoped,
    todayUtcTimestamp,
  ]);
  const portalCopy = useMemo(
    () => ({
      pageTitle: 'Customer Portal · Rentals & Invoices',
      pageDescription:
        'Review authorized on-rent equipment, due-back dates, invoice documents, and outstanding balances in one read-only flow.',
    }),
    []
  );


  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPaymentError('');
    setPaymentMessage('');
    if (!canRecordPayments) {
      setPaymentError('Your role can view portal financials but cannot record payments.');
      return;
    }

    if (!selectedInvoice) {
      setPaymentError('Select an outstanding invoice before submitting payment.');
      return;
    }

    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentError('Enter a valid payment amount greater than zero.');
      return;
    }

    const outstanding = invoiceOutstanding(selectedInvoice);
    const selectedCurrencyCode = invoiceDisplayCurrencyCode(selectedInvoice);
    if (amount - outstanding > CURRENCY_EPSILON) {
      setPaymentError(`Payment cannot exceed outstanding balance of ${formatCurrency(outstanding, localePolicy, selectedCurrencyCode)}.`);
      return;
    }

    try {
      const roundedAmount = roundCurrency(amount);
      const createdAt = new Date().toISOString();
      const { error } = await supabase.rpc('create_entity_with_version', {
        p_entity_type: 'payment',
        p_data: {
          invoice_id: selectedInvoice.id,
          invoice_number: selectedInvoice.invoiceNumber,
          amount: roundedAmount,
          status: 'posted',
          method: paymentMethod,
          paid_at: createdAt,
          currency_code: selectedCurrencyCode,
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      const nextOutstanding = roundCurrency(Math.max(0, outstanding - roundedAmount));
      setBalanceOverrides((previous) => ({
        ...previous,
        [selectedInvoice.id]: nextOutstanding,
      }));
      setPaymentHistory((previous) => [
        {
          id: `${selectedInvoice.id}-${createdAt}`,
          invoiceId: selectedInvoice.id,
          invoiceNumber: selectedInvoice.invoiceNumber,
          method: paymentMethod,
          amount: roundedAmount,
          createdAt,
          currencyCode: selectedCurrencyCode,
        },
        ...previous,
      ]);
      setSelectedInvoiceId('');
      setPaymentMessage(
        `Payment recorded via ${paymentMethod.toUpperCase()} for ${formatCurrency(roundedAmount, localePolicy, selectedCurrencyCode)}.`
      );
      void paymentsQuery.refetch();
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : 'Unable to record payment right now.');
    }
  };

  if (portalScope.isPortalScoped) {
    return (
      <div className="space-y-6" data-testid="portal-financials-screen">
        <div className="space-y-3">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Operating-model tags</p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">rental-customer-portal-user:t1</Badge>
              <Badge variant="secondary">rental-customer-portal-user:t4</Badge>
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{portalCopy.pageTitle}</h1>
            <p className="text-sm text-muted-foreground">{portalCopy.pageDescription}</p>
            <p className="text-xs text-muted-foreground">
              Authorized scope · Customers: {portalScope.customerIds.length} · Billing accounts: {portalScope.billingAccountIds.length}
              {' '}· Projects: {portalScope.jobSiteIds.length}
            </p>
          </div>
        </div>

        {isBlocked && (
          <Alert variant="destructive">
            <AlertTitle>Access blocked for portal self-service data</AlertTitle>
            <AlertDescription>Your current session cannot read one or more authorized rental, invoice, or document sources.</AlertDescription>
          </Alert>
        )}

        {hasError && !isBlocked && (
          <Alert variant="destructive">
            <AlertTitle>Unable to load portal self-service data</AlertTitle>
            <AlertDescription>Refresh the page and confirm contract, equipment, invoice, and document access for the authorized account scope.</AlertDescription>
          </Alert>
        )}

        {portalSourceExceptions.length > 0 && (
          <Alert data-testid="portal-source-exceptions">
            <AlertTitle>Missing or stale source exceptions</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {portalSourceExceptions.map((exception) => (
                  <li key={exception}>{exception}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Active contracts</CardDescription>
              <CardTitle>{formatLocalizedNumber(activeContracts.length, localePolicy)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">Authorized rental contracts currently in-flight for this customer/account context.</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>On-rent equipment</CardDescription>
              <CardTitle>{formatLocalizedNumber(authorizedLines.filter((line) => line.status.toLowerCase() === 'checked_out').length, localePolicy)}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">Current checked-out equipment visible to the signed-in account/project scope.</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Outstanding balance</CardDescription>
              <CardTitle>
                {portalOutstandingBalanceByReportingCurrency[0]
                  ? formatCurrency(
                    portalOutstandingBalanceByReportingCurrency[0].amount,
                    localePolicy,
                    portalOutstandingBalanceByReportingCurrency[0].currencyCode
                  )
                  : 'Source delayed'}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              {portalOutstandingBalanceByReportingCurrency.length > 1
                ? portalOutstandingBalanceByReportingCurrency.map((rollup) => `${rollup.currencyCode}: ${formatCurrency(rollup.amount, localePolicy, rollup.currencyCode)}`).join(' · ')
                : 'Only authoritative balances with fresh-enough source data are totalled here.'}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Invoice documents</CardDescription>
              <CardTitle>
                {formatLocalizedNumber(
                  authorizedInvoices.filter((invoice) => (documentsByInvoice.get(invoice.id) || []).some((document) => Boolean(document.downloadUrl))).length,
                  localePolicy
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">Current invoice files ready for direct customer download.</CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>On-rent visibility</CardTitle>
            <CardDescription>Contracts, equipment, locations, rates, and due-back detail for the authorized account/project context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isLoading && <p className="text-sm text-muted-foreground">Loading active rental visibility…</p>}
            {!isLoading && activeContracts.length === 0 && (
              <p className="text-sm text-muted-foreground">No active contracts are currently visible for this customer/account scope.</p>
            )}
            {!isLoading && activeContracts.map((contract) => {
              const lines = portalLinesByContract.get(contract.id) || [];
              const contractLabel = contract.contractNumber;
              const branchLabel = branchNames.get(contract.branchId) || contract.branchId || 'Unassigned branch';
              const jobSiteLabel = jobSiteNames.get(contract.jobSiteId) || contract.jobSiteId || 'Project location unavailable';
              return (
                <div key={contract.id} className="rounded-md border p-4 space-y-3" data-testid={`portal-contract-${contract.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{contractLabel}</p>
                      <p className="text-sm text-muted-foreground">
                        Billing Account: {billingAccountNames.get(contract.billingAccountId) || 'Billing Account'} · Location: {jobSiteLabel}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{contract.status.toUpperCase()}</Badge>
                      <a href={`/portal/schedule/${contract.id}`} className="text-sm font-medium text-primary underline underline-offset-4">
                        Open contract detail
                      </a>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Branch: {branchLabel} · Rental source: {contract.rentalSourceSyncedAt || 'freshness unavailable'}
                  </p>
                  <div className="space-y-2">
                    {lines.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No equipment lines were returned for this contract.</p>
                    ) : (
                      lines.map((line) => {
                        const asset = assetMap.get(line.assetId);
                        const dueBack = line.plannedEnd || line.actualEnd;
                        return (
                          <div key={line.id} className="rounded-sm bg-muted/40 p-3 space-y-1" data-testid={`portal-contract-line-${line.id}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="font-medium">{asset?.name || line.assetId || 'Equipment item'}</p>
                              <Badge variant={line.status.toLowerCase() === 'checked_out' ? 'secondary' : 'outline'}>
                                {line.status.toLowerCase() === 'checked_out' ? 'ON RENT' : line.status.toUpperCase()}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              Rate: {line.rateAmount > 0 ? `${formatCurrency(line.rateAmount, localePolicy)} / ${line.rateType}` : 'Unavailable'} · Due back:{' '}
                              {dueBack ? formatCalendarDate(dueBack, localePolicy) : 'Unavailable'}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              Project: {jobSiteLabel} · Started:{' '}
                              {line.actualStart
                                ? formatCalendarDate(line.actualStart, localePolicy)
                                : line.plannedStart
                                  ? formatCalendarDate(line.plannedStart, localePolicy)
                                  : 'Unavailable'}
                            </p>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invoices & balances</CardTitle>
            <CardDescription>Current invoice documents and outstanding balances in the same self-service flow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading && <p className="text-sm text-muted-foreground">Loading customer invoices…</p>}
            {!isLoading && authorizedInvoices.length === 0 && (
              <p className="text-sm text-muted-foreground">No invoices are currently visible for this customer/account scope.</p>
            )}
            {!isLoading && authorizedInvoices.map((invoice) => {
              const invoiceDocumentsForScope = documentsByInvoice.get(invoice.id) || [];
              const customerName = customerNames.get(invoice.customerId) || 'Customer';
              const billingName = billingAccountNames.get(invoice.billingAccountId) || 'Billing Account';
              const contractLabel = activeContracts.find((contract) => contract.id === invoice.contractId)?.contractNumber || invoice.contractId || 'Contract unavailable';
              return (
                <div key={invoice.id} className="rounded-md border p-3 space-y-2" data-testid={`portal-invoice-${invoice.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{invoice.invoiceNumber}</p>
                    <Badge variant="outline">{invoice.status.toUpperCase()}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Customer: {customerName} · Billing Account: {billingName}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Contract: {contractLabel} · Project: {jobSiteNames.get(invoice.jobSiteId) || invoice.jobSiteId || 'Unavailable'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Invoice Date:{' '}
                    {invoice.invoiceDate
                      ? formatCalendarDate(invoice.invoiceDate, localePolicy)
                      : 'Unavailable'}
                    {' '}· Due:{' '}
                    {invoice.dueDate
                      ? formatCalendarDate(invoice.dueDate, localePolicy)
                      : 'Unavailable'}
                  </p>
                  <p className="text-sm font-medium">
                    Outstanding:{' '}
                    {invoice.openBalance === null
                      ? 'Source delayed'
                      : formatCurrency(invoice.openBalance, localePolicy, invoiceDisplayCurrencyCode(invoice))}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {invoiceDocumentsForScope.length === 0 && (
                      <Badge variant="secondary">Document unavailable</Badge>
                    )}
                    {invoiceDocumentsForScope.map((document) => (
                      document.downloadUrl ? (
                        <a
                          key={document.id}
                          href={document.downloadUrl}
                          className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Download {document.title}
                        </a>
                      ) : (
                        <Badge key={document.id} variant="secondary">Download delayed</Badge>
                      )
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="portal-financials-screen">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.pageTitle}</h1>
        <p className="text-sm text-muted-foreground">

          {copy.pageDescription}
        </p>
        <p className="text-xs text-muted-foreground">
          {copy.taxLabel}: {localePolicy.taxRegionCode} · Locale: {localePolicy.localeCode} · Timezone: {localePolicy.timezone}

        </p>
      </div>

      {isBlocked && (
        <Alert variant="destructive">
          <AlertTitle>Access blocked for billing data</AlertTitle>
          <AlertDescription>
            Your current role cannot read one or more billing sources for this screen. Contact an admin or branch manager for access.
          </AlertDescription>
        </Alert>
      )}

      {hasError && !isBlocked && (
        <Alert variant="destructive">
          <AlertTitle>Unable to load portal billing data</AlertTitle>
          <AlertDescription>
            Refresh the page and confirm invoice, customer, billing-account, and payment data access.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Outstanding Balance</CardDescription>
            <CardTitle>
              {hasExplicitTransactionCurrency
                ? formatCurrency(
                  outstandingBalanceByReportingCurrency[0]?.amount || 0,
                  localePolicy,
                  outstandingBalanceByReportingCurrency[0]?.currencyCode || localePolicy.currencyCode
                )
                : formatCurrency(outstandingBalance, localePolicy)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Includes pending and sent invoices available for portal payment.
            {outstandingBalanceByReportingCurrency.length > 1 && (
              <ul className="mt-2 space-y-1">
                {outstandingBalanceByReportingCurrency.map((rollup) => (
                  <li key={rollup.currencyCode}>
                    {rollup.currencyCode}: {formatCurrency(rollup.amount, localePolicy, rollup.currencyCode)}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">

            <CardDescription>Open Invoices (filtered)</CardDescription>
            <CardTitle>{formatLocalizedNumber(filteredInvoices.length, localePolicy)}</CardTitle>

          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Invoices with non-zero balance in the selected scope.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Payments This Session</CardDescription>
            <CardTitle>{formatLocalizedNumber(paymentHistory.length, localePolicy)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Demo payment activity captured during this session.
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Allocated Equipment Cost</CardDescription>
            <CardTitle>{formatCurrency(totalAllocatedEquipmentCost, localePolicy, primaryReportingCurrencyCode)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Project-level cost context from contract-line allocations.</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>AR Aging Filters</CardTitle>
          <CardDescription>Filter by branch/location, customer, billing account, and invoice status.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="ar-filter-branch">Branch / Location</Label>
            <select
              id="ar-filter-branch"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={selectedBranchId}
              onChange={(event) => setSelectedBranchId(event.target.value)}
            >
              <option value="">All branches</option>
              {branchOptions.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-filter-customer">Customer</Label>
            <select
              id="ar-filter-customer"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={selectedCustomerId}
              onChange={(event) => setSelectedCustomerId(event.target.value)}
            >
              <option value="">All customers</option>
              {Array.from(customerNames.entries()).map(([customerId, customerName]) => (
                <option key={customerId} value={customerId}>
                  {customerName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-filter-billing-account">Billing Account</Label>
            <select
              id="ar-filter-billing-account"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={selectedBillingAccountId}
              onChange={(event) => setSelectedBillingAccountId(event.target.value)}
            >
              <option value="">All billing accounts</option>
              {Array.from(billingAccountNames.entries()).map(([billingAccountId, accountName]) => (
                <option key={billingAccountId} value={billingAccountId}>
                  {accountName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ar-filter-status">Invoice Status</Label>
            <select
              id="ar-filter-status"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={selectedStatus}
              onChange={(event) => setSelectedStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        {bucketRollups.map((bucketRollup) => (
          <Card
            key={bucketRollup.bucket}
            data-testid={`aging-bucket-${bucketRollup.bucket}`}
            className={selectedBucket === bucketRollup.bucket ? 'border-primary' : undefined}
          >
            <CardHeader className="pb-2">
              <CardDescription>{bucketRollup.bucket === '120+' ? '120+ Days' : bucketRollup.bucket.toUpperCase()}</CardDescription>
              <CardTitle>{bucketRollup.count}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              {bucketRollup.byCurrency.length === 0 ? (
                <p>No balance</p>
              ) : (
                <ul className="space-y-1">
                  {bucketRollup.byCurrency.map((currencyRollup) => (
                    <li key={currencyRollup.currencyCode}>
                      {currencyRollup.currencyCode}: {formatCurrency(currencyRollup.amount, localePolicy, currencyRollup.currencyCode)}
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="outline" size="sm" onClick={() => setSelectedBucket(bucketRollup.bucket)}>
                View invoices
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Project Equipment Cost Allocation</CardTitle>
          <CardDescription>Visibility of project/cost-code allocations and signature-backed operational status.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading project allocation data…</p>}
          {!isLoading && projectAllocationGroups.length === 0 && (
            <p className="text-sm text-muted-foreground">No project allocations are currently available.</p>
          )}
          {!isLoading &&
            projectAllocationGroups.map((group) => (
              <div key={`${group.projectLabel}-${group.currencyCode}`} className="rounded-md border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {group.projectLabel} · {group.currencyCode}
                  </p>
                  <Badge variant="outline">{formatCurrency(group.totalCost, localePolicy, group.currencyCode)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Signed events: {group.signedCount}/{group.lineCount}
                </p>
                <div className="space-y-2">
                  {group.costCodes.map((costCodeGroup) => (
                    <div key={costCodeGroup.costCode} className="rounded-sm bg-muted/40 p-2 space-y-1">
                      <p className="text-sm font-medium">
                        Cost code: {costCodeGroup.costCode} · {formatCurrency(costCodeGroup.totalCost, localePolicy, group.currencyCode)}
                      </p>
                      {costCodeGroup.lines.map((line) => (
                        <div key={line.id} className="text-xs space-y-0.5">
                          <p data-testid={`allocation-line-${line.id}-identity`}>
                            <span className="font-medium">
                              {assetMap.get(line.assetId)?.name ||
                                categoryMap.get(line.categoryId) ||
                                'Equipment'}
                            </span>
                            {contractNumberMap.get(line.contractId) && (
                              <span className="text-muted-foreground"> · {contractNumberMap.get(line.contractId)}</span>
                            )}
                            {line.eventDate && (
                              <span className="text-muted-foreground"> · {formatCalendarDate(line.eventDate, localePolicy)}</span>
                            )}
                          </p>
                          <p className="text-muted-foreground">{formatOperationalStatus(line)}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Invoices</CardTitle>
            <CardDescription>
              {selectedBucket === '120+' ? '120+ day overdue invoices' : `${selectedBucket.charAt(0).toUpperCase()}${selectedBucket.slice(1)} invoices`} in
              the selected scope.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading && <p className="text-sm text-muted-foreground">Loading portal invoices…</p>}
            {!isLoading && openInvoices.length === 0 && (
              <p className="text-sm text-muted-foreground">No invoices found for portal payment.</p>
            )}
            {!isLoading && openInvoices.length > 0 && selectedBucketInvoices.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {selectedBucket === 'overdue' || selectedBucket === '120+'
                  ? 'No overdue balance in this bucket for the selected filters.'
                  : 'No current balance in this bucket for the selected filters.'}
              </p>
            )}
            {!isLoading &&
              selectedBucketInvoices.map((invoice) => {
                const outstanding = invoiceOutstanding(invoice);
                const customerName = customerNames.get(invoice.customerId) || 'Customer';
                const billingName = billingAccountNames.get(invoice.billingAccountId) || 'Billing Account';
                const isOpen = outstanding > 0;
                const bucket = getAgingBucket(invoice, outstanding, todayUtcTimestamp);
                return (
                  <div
                    key={invoice.id}
                    className="rounded-md border p-3 space-y-1"
                    data-testid={`portal-invoice-${invoice.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{invoice.invoiceNumber}</p>
                      <div className="flex items-center gap-2">
                        <Badge variant={isOpen ? 'outline' : 'secondary'}>
                          {isOpen ? invoice.status.toUpperCase() : 'PAID'}
                        </Badge>
                        <Badge variant={bucket === 'current' ? 'secondary' : 'destructive'}>
                          {bucket === '120+' ? '120+' : bucket.toUpperCase()}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Customer: {customerName} · Billing Account: {billingName}
                    </p>
                    <p className="text-sm text-muted-foreground">

                      Branch/Location: {invoice.branchLabel} · Invoice Date:{' '}
                      {invoice.invoiceDate
                        ? formatLocalizedDate(invoice.invoiceDate, localePolicy, {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                        }) || invoice.invoiceDate
                        : 'N/A'}{' '}
                      · Due:{' '}
                      {invoice.dueDate
                        ? formatLocalizedDate(invoice.dueDate, localePolicy, {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                        }) || invoice.dueDate
                        : 'N/A'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Total: {formatCurrency(invoice.total, localePolicy, invoiceDisplayCurrencyCode(invoice))}

                    </p>
                    <p className="text-sm font-medium">
                      Outstanding: {formatCurrency(outstanding, localePolicy, invoiceDisplayCurrencyCode(invoice))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Reporting ({invoice.reportingCurrencyCode}):{' '}
                      {formatCurrency(
                        invoice.reportingCurrencyCode === invoice.transactionCurrencyCode
                          ? outstanding
                          : roundCurrency(outstanding * (invoice.fxRateApplied || 0)),
                        localePolicy,
                        invoice.reportingCurrencyCode
                      )}
                    </p>
                  </div>
                );
              })}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{copy.paymentPanelTitle}</CardTitle>
            <CardDescription>Capture a payment against an open invoice balance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canRecordPayments && (
              <Alert>
                <AlertTitle>Payment actions disabled</AlertTitle>
                <AlertDescription>Read-only and field roles can review balances and allocations but cannot post payments.</AlertDescription>
              </Alert>
            )}
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="portal-invoice-select">Invoice</Label>
                <select
                  id="portal-invoice-select"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                  value={selectedInvoiceId}
                  onChange={(event) => setSelectedInvoiceId(event.target.value)}
                  disabled={!canRecordPayments}
                >
                  <option value="">Select an invoice</option>
                  {selectedBucketInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoiceNumber} · {formatCurrency(invoiceOutstanding(invoice), localePolicy, invoiceDisplayCurrencyCode(invoice))}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="portal-payment-method">Payment Method</Label>
                <select
                  id="portal-payment-method"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
                  disabled={!canRecordPayments}
                >
                  <option value="card">{copy.paymentMethods.card}</option>
                  <option value="ach">{copy.paymentMethods.ach}</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="portal-payment-amount">Amount</Label>
                <Input
                  id="portal-payment-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                  disabled={!canRecordPayments}
                />
              </div>

              <Button type="submit" className="w-full" disabled={selectedBucketInvoices.length === 0 || !canRecordPayments}>
                Pay Invoice
              </Button>
            </form>

            {paymentError && (
              <Alert variant="destructive">
                <AlertTitle>Payment failed</AlertTitle>
                <AlertDescription>{paymentError}</AlertDescription>
              </Alert>
            )}

            {paymentMessage && (
              <Alert>
                <AlertTitle>Payment recorded</AlertTitle>
                <AlertDescription>{paymentMessage}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Payment History</p>
              {paymentHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">No payments captured yet in this session.</p>
              ) : (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {paymentHistory.slice(0, 5).map((payment) => (
                    <li key={payment.id}>
                      {payment.invoiceNumber} · {payment.method.toUpperCase()} · {formatCurrency(payment.amount, localePolicy, payment.currencyCode)} ·{' '}
                      {formatLocalizedDateTime(payment.createdAt, localePolicy)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
