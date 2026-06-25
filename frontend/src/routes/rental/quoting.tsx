/**
 * Staff Quote Builder
 *
 * Staff-facing route for creating and editing rental quote drafts.  Persists
 * to the canonical rental-order/rental-order-line entity model via the
 * staff_save_quote_order RPC.
 *
 * URL: /rental/quoting
 * URL: /rental/quoting?order_id=<uuid>   — re-open an existing draft for edit
 * Access: admin / branch_manager (enforced at the RPC level)
 *
 * Features:
 *  - Customer, billing account, job-site context fields
 *  - Quote expiration date
 *  - Internal/external notes
 *  - Multiple line items: category, asset, branch, date-range, quantity, rate
 *  - Price / rate display toggle (rate = per-unit daily, price = total amount)
 *  - Per-line server-side availability check (rental_quote_availability RPC)
 *  - Saves draft via staff_save_quote_order → rental_order + rental_order_line
 *  - Re-open existing draft by passing ?order_id= query param
 *
 * Pricing-preview panel (fee/tax engine)
 *  - Server-computed pricing breakdown per the first line via
 *    staff_quote_pricing_preview RPC (staff_quote_save_draft preserved as
 *    a single-line pricing snapshot utility)
 */

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  Calculator,
  RefreshCw,
  Save,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Lock,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Info,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useAuthCapabilities } from '@/auth/AuthContext';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/rental/quoting')({
  validateSearch: (search: Record<string, unknown>) => ({
    order_id: typeof search.order_id === 'string' ? search.order_id : undefined,
    asset_id: typeof search.asset_id === 'string' ? search.asset_id : undefined,
    branch_id: typeof search.branch_id === 'string' ? search.branch_id : undefined,
    category_id: typeof search.category_id === 'string' ? search.category_id : undefined,
    planned_start: typeof search.planned_start === 'string' ? search.planned_start
      : typeof search.start_date === 'string' ? search.start_date : undefined,
    planned_end: typeof search.planned_end === 'string' ? search.planned_end
      : typeof search.end_date === 'string' ? search.end_date : undefined,
  }),
  component: QuoteBuilderPage,
});

export function QuoteBuilderPage() {
  const { canWrite } = useAuthCapabilities();
  const { order_id, asset_id, branch_id, category_id, planned_start, planned_end } = Route.useSearch();

  if (!canWrite) {
    return (
      <div className="p-6 max-w-xl mx-auto" data-testid="quote-builder-access-denied">
        <Alert variant="destructive">
          <Lock className="h-4 w-4" />
          <AlertTitle>Access Denied</AlertTitle>
          <AlertDescription>
            Quote Builder is available to admin and branch manager users only.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const prefillLine = (!order_id && (asset_id || branch_id || category_id || planned_start || planned_end))
    ? { assetId: asset_id, branchId: branch_id, categoryId: category_id, startDate: planned_start, endDate: planned_end }
    : undefined;

  return <QuoteBuilderScreen initialOrderId={order_id} prefillLine={prefillLine} />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeLine = {
  preset_id: string;
  name: string;
  fee_type: 'percent' | 'flat';
  rate: number;
  amount: number;
  scope: string;
};

export type TaxLine = {
  preset_id: string;
  name: string;
  rate: number;
  amount: number;
  scope: string;
};

export type PricingBreakdown = {
  base_amount: number;
  fee_lines: FeeLine[];
  fees_total: number;
  subtotal: number;
  tax_lines: TaxLine[];
  tax_total: number;
  grand_total: number;
  preset_snapshot: Record<string, unknown>;
};

/** A single line item in the quote builder. */
export type QuoteLine = {
  /** Stable client-side key for React rendering (never sent to the server). */
  clientId: string;
  /** Entity ID of the rental_order_line when the line has already been saved. */
  lineId: string | null;
  kitId: string;
  categoryId: string;
  assetId: string;
  branchId: string;
  startDate: string;
  endDate: string;
  quantity: string;
  dailyRate: string;
  rateType: string;
  name: string;
};

export type DisplayRateMode = 'rate' | 'price';

export type LineAvailabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'available'; availableQty: number }
  | { status: 'unavailable'; reason: string; shortageQty: number }
  | { status: 'error' };

type PricingState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; breakdown: PricingBreakdown; stale: boolean }
  | { status: 'error'; message: string };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; orderId: string; orderNumber: string; savedAt: Date }
  | { status: 'error'; message: string };

type LookupOption = {
  id: string;
  label: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/**
 * Returns a date offset from today as YYYY-MM-DD using **local** calendar
 * parts.  Using `toISOString().slice(0, 10)` would truncate to UTC midnight,
 * which shifts the displayed date by one day for staff in UTC+ timezones.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function offsetDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Normalises a raw quantity string to a safe integer ≥ 1.  Ensures preview
 * and save calculations never diverge on boundary values (zero, negative, NaN).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function normalizeQty(raw: string): number {
  return Math.max(1, parseInt(raw, 10) || 1);
}

/** Computes the number of rental days between two YYYY-MM-DD strings. */
function computeDays(start: string, end: string): number {
  const startMs = Date.UTC(
    parseInt(start.slice(0, 4), 10),
    parseInt(start.slice(5, 7), 10) - 1,
    parseInt(start.slice(8, 10), 10),
  );
  const endMs = Date.UTC(
    parseInt(end.slice(0, 4), 10),
    parseInt(end.slice(5, 7), 10) - 1,
    parseInt(end.slice(8, 10), 10),
  );
  return Math.max(1, Math.round((endMs - startMs) / 86_400_000));
}

/** Computes the base rental amount for a single line (rate × days × qty). */
// eslint-disable-next-line react-refresh/only-export-components
export function lineBaseAmount(line: QuoteLine): number | null {
  const rate = parseFloat(line.dailyRate);
  if (isNaN(rate) || rate <= 0) return null;
  if (!line.startDate || !line.endDate || line.startDate >= line.endDate) return null;
  const days = computeDays(line.startDate, line.endDate);
  const qty = normalizeQty(line.quantity);
  return Math.round(rate * days * qty * 100) / 100;
}

let _clientIdCounter = 0;
function nextClientId(): string {
  return `line-${++_clientIdCounter}`;
}

function emptyLine(): QuoteLine {
  return {
    clientId: nextClientId(),
    lineId: null,
    kitId: '',
    categoryId: '',
    assetId: '',
    branchId: '',
    startDate: offsetDaysStr(1),   // default: tomorrow
    endDate: offsetDaysStr(8),     // default: 7-day rental period
    quantity: '1',
    dailyRate: '',
    rateType: 'daily',
    name: '',
  };
}

function buildLookupLabel(
  data: Record<string, unknown>,
  keys: string[],
  fallbackPrefix: string,
  id: string,
): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return `${fallbackPrefix} ${id.slice(0, 8)}`;
}

async function fetchLookupOptions(
  entityType: string,
  labelKeys: string[],
  fallbackPrefix: string,
): Promise<LookupOption[]> {
  const { data, error } = await supabase
    .from('entities')
    .select('id, entity_versions!inner(data)')
    .eq('entity_type', entityType)
    .eq('entity_versions.is_current', true)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return [];

  const rows = (data ?? []) as Array<{ id: string; entity_versions?: Array<{ data?: Record<string, unknown> }> }>;
  return rows.map((row) => {
    const currentData = row.entity_versions?.[0]?.data ?? {};
    return {
      id: row.id,
      label: buildLookupLabel(currentData, labelKeys, fallbackPrefix, row.id),
    };
  });
}

// ---------------------------------------------------------------------------
// Line row component
// ---------------------------------------------------------------------------

interface QuoteLineRowProps {
  line: QuoteLine;
  index: number;
  displayRateMode: DisplayRateMode;
  availability: LineAvailabilityState;
  kitOptions: LookupOption[];
  categoryOptions: LookupOption[];
  branchOptions: LookupOption[];
  assetOptions: LookupOption[];
  onChange: (updated: QuoteLine) => void;
  onRemove: () => void;
  onCheckAvailability: () => void;
}

function QuoteLineRow({
  line,
  index,
  displayRateMode,
  availability,
  kitOptions,
  categoryOptions,
  branchOptions,
  assetOptions,
  onChange,
  onRemove,
  onCheckAvailability,
}: QuoteLineRowProps) {
  const amount = lineBaseAmount(line);
  const canCheck =
    !!((line.kitId || line.categoryId) && line.branchId && line.startDate && line.endDate && line.startDate < line.endDate);

  return (
    <Card data-testid={`line-row-${index}`} className="relative">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-muted-foreground">Line {index + 1}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={`btn-remove-line-${index}`}
            onClick={onRemove}
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            aria-label={`Remove line ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-kit`} className="text-xs">Kit / Bundle</Label>
            <select
              id={`line-${index}-kit`}
              data-testid={`input-line-${index}-kit`}
              value={line.kitId}
              onChange={(e) =>
                onChange({
                  ...line,
                  kitId: e.target.value.trim(),
                  categoryId: e.target.value.trim() ? '' : line.categoryId,
                  assetId: e.target.value.trim() ? '' : line.assetId,
                })
              }
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
            >
              <option value="">No kit (line-level item)</option>
              {kitOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {line.kitId && (
              <p className="text-[11px] text-muted-foreground" data-testid={`line-${index}-kit-id`}>
                ID: {line.kitId}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-category`} className="text-xs">Category</Label>
            <select
              id={`line-${index}-category`}
              data-testid={`input-line-${index}-category`}
              value={line.categoryId}
              onChange={(e) => onChange({ ...line, categoryId: e.target.value.trim() })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
            >
              <option value="">Select category…</option>
              {line.categoryId && !categoryOptions.some((opt) => opt.id === line.categoryId) && (
                <option value={line.categoryId}>Current selection ({line.categoryId.slice(0, 8)})</option>
              )}
              {categoryOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {line.categoryId && (
              <p className="text-[11px] text-muted-foreground" data-testid={`line-${index}-category-id`}>
                ID: {line.categoryId}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-branch`} className="text-xs">Branch</Label>
            <select
              id={`line-${index}-branch`}
              data-testid={`input-line-${index}-branch`}
              value={line.branchId}
              onChange={(e) => onChange({ ...line, branchId: e.target.value.trim() })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
            >
              <option value="">Select branch…</option>
              {line.branchId && !branchOptions.some((opt) => opt.id === line.branchId) && (
                <option value={line.branchId}>Current selection ({line.branchId.slice(0, 8)})</option>
              )}
              {branchOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {line.branchId && (
              <p className="text-[11px] text-muted-foreground" data-testid={`line-${index}-branch-id`}>
                ID: {line.branchId}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-asset`} className="text-xs">Asset</Label>
            <select
              id={`line-${index}-asset`}
              data-testid={`input-line-${index}-asset`}
              value={line.assetId}
              onChange={(e) => onChange({ ...line, assetId: e.target.value.trim() })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
            >
              <option value="">Select asset (optional)…</option>
              {line.assetId && !assetOptions.some((opt) => opt.id === line.assetId) && (
                <option value={line.assetId}>Current selection ({line.assetId.slice(0, 8)})</option>
              )}
              {assetOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {line.assetId && (
              <p className="text-[11px] text-muted-foreground" data-testid={`line-${index}-asset-id`}>
                ID: {line.assetId}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-name`} className="text-xs">Description</Label>
            <Input
              id={`line-${index}-name`}
              data-testid={`input-line-${index}-name`}
              placeholder="Optional label"
              value={line.name}
              onChange={(e) => onChange({ ...line, name: e.target.value })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-start`} className="text-xs">Start Date</Label>
            <Input
              id={`line-${index}-start`}
              data-testid={`input-line-${index}-start`}
              type="date"
              value={line.startDate}
              onChange={(e) => onChange({ ...line, startDate: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-end`} className="text-xs">End Date</Label>
            <Input
              id={`line-${index}-end`}
              data-testid={`input-line-${index}-end`}
              type="date"
              value={line.endDate}
              onChange={(e) => onChange({ ...line, endDate: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-qty`} className="text-xs">Qty</Label>
            <Input
              id={`line-${index}-qty`}
              data-testid={`input-line-${index}-quantity`}
              type="number"
              min={1}
              value={line.quantity}
              onChange={(e) => onChange({ ...line, quantity: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`line-${index}-rate`} className="text-xs">Daily Rate (USD)</Label>
            <Input
              id={`line-${index}-rate`}
              data-testid={`input-line-${index}-rate`}
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={line.dailyRate}
              onChange={(e) => onChange({ ...line, dailyRate: e.target.value })}
            />
          </div>
        </div>

        {/* Display: rate vs total based on toggle */}
        {amount !== null && (
          <div className="flex items-center gap-4 text-sm">
            {displayRateMode === 'rate' ? (
              <span data-testid={`line-${index}-rate-display`} className="text-muted-foreground">
                {fmtCurrency(parseFloat(line.dailyRate))}/day ×{' '}
                {computeDays(line.startDate, line.endDate)} days ×{' '}
                {normalizeQty(line.quantity)} unit{normalizeQty(line.quantity) !== 1 ? 's' : ''}
              </span>
            ) : (
              <span data-testid={`line-${index}-price-display`} className="font-medium">
                Total: {fmtCurrency(amount)}
              </span>
            )}
          </div>
        )}

        {/* Availability */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={`btn-check-availability-${index}`}
            disabled={!canCheck || availability.status === 'loading'}
            onClick={onCheckAvailability}
            className="h-7 text-xs px-2"
          >
            {availability.status === 'loading' ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Info className="h-3 w-3 mr-1" />
            )}
            Check Availability
          </Button>

          {availability.status === 'available' && (
            <Badge
              variant="outline"
              className="text-green-700 border-green-300 text-xs"
              data-testid={`availability-available-${index}`}
            >
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Available ({availability.availableQty})
            </Badge>
          )}
          {availability.status === 'unavailable' && (
            <Badge
              variant="destructive"
              className="text-xs"
              data-testid={`availability-unavailable-${index}`}
            >
              <AlertCircle className="h-3 w-3 mr-1" />
              Unavailable — {availability.reason ?? 'shortage'} (need {availability.shortageQty} more)
            </Badge>
          )}
          {availability.status === 'error' && (
            <Badge variant="secondary" className="text-xs" data-testid={`availability-error-${index}`}>
              Availability check failed
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main screen component
// ---------------------------------------------------------------------------

export function QuoteBuilderScreen({ initialOrderId, prefillLine }: {
  initialOrderId?: string;
  prefillLine?: { assetId?: string; branchId?: string; categoryId?: string; startDate?: string; endDate?: string };
} = {}) {
  // ── Order header ──────────────────────────────────────────────────────────
  const [orderId, setOrderId] = useState<string | null>(initialOrderId ?? null);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [billingAccountId, setBillingAccountId] = useState('');
  const [jobSiteId, setJobSiteId] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [externalNotes, setExternalNotes] = useState('');
  const [customerOptions, setCustomerOptions] = useState<LookupOption[]>([]);
  const [billingAccountOptions, setBillingAccountOptions] = useState<LookupOption[]>([]);
  const [jobSiteOptions, setJobSiteOptions] = useState<LookupOption[]>([]);
  const [kitOptions, setKitOptions] = useState<LookupOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<LookupOption[]>([]);
  const [branchOptions, setBranchOptions] = useState<LookupOption[]>([]);
  const [assetOptions, setAssetOptions] = useState<LookupOption[]>([]);

  // ── Display mode ──────────────────────────────────────────────────────────
  const [displayRateMode, setDisplayRateMode] = useState<DisplayRateMode>('rate');

  // ── Line items ────────────────────────────────────────────────────────────
  const [lines, setLines] = useState<QuoteLine[]>(() => {
    if (prefillLine && !initialOrderId) {
      const base = emptyLine();
      return [{
        ...base,
        assetId: prefillLine.assetId ?? base.assetId,
        branchId: prefillLine.branchId ?? base.branchId,
        categoryId: prefillLine.categoryId ?? base.categoryId,
        startDate: prefillLine.startDate ?? base.startDate,
        endDate: prefillLine.endDate ?? base.endDate,
      }];
    }
    return [emptyLine()];
  });
  const [cancelledLineIds, setCancelledLineIds] = useState<string[]>([]);
  const [lineAvailability, setLineAvailability] = useState<Record<string, LineAvailabilityState>>({});

  // ── Pricing preview (first-line fee/tax engine) ───────────────────────────
  const [pricing, setPricing] = useState<PricingState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  // ── Save state ────────────────────────────────────────────────────────────
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    async function loadLookups() {
      const [
        customers,
        billingAccounts,
        jobSites,
        kits,
        categories,
        branches,
        assets,
      ] = await Promise.all([
        fetchLookupOptions('customer', ['name'], 'Customer'),
        fetchLookupOptions('billing_account', ['name', 'account_name', 'account_number'], 'Billing Account'),
        fetchLookupOptions('job_site', ['name', 'address'], 'Job Site'),
        fetchLookupOptions('inventory_kit', ['name'], 'Kit'),
        fetchLookupOptions('asset_category', ['name'], 'Category'),
        fetchLookupOptions('branch', ['name', 'code'], 'Branch'),
        fetchLookupOptions('asset', ['name', 'asset_tag', 'serial_number', 'identifier'], 'Asset'),
      ]);

      if (cancelled) return;
      setCustomerOptions(customers);
      setBillingAccountOptions(billingAccounts);
      setJobSiteOptions(jobSites);
      setKitOptions(kits);
      setCategoryOptions(categories);
      setBranchOptions(branches);
      setAssetOptions(assets);
    }

    loadLookups();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load existing order when initialOrderId is provided ──────────────────
  useEffect(() => {
    if (!initialOrderId) return;

    async function loadOrder() {
      const { data: orderRows, error: orderErr } = await supabase
        .from('entities')
        .select('*, entity_versions(*)')
        .eq('id', initialOrderId!)
        .eq('entity_type', 'rental_order')
        .single();

      if (orderErr || !orderRows) return;

      const versions = (orderRows as Record<string, unknown>).entity_versions as unknown[];
      const currentVersion = (versions ?? []).find(
        (v) => (v as Record<string, unknown>).is_current,
      ) as Record<string, unknown> | undefined;
      const data = (currentVersion?.data ?? {}) as Record<string, unknown>;

      setCustomerId(String(data.customer_id ?? ''));
      setBillingAccountId(String(data.billing_account_id ?? ''));
      setJobSiteId(String(data.job_site_id ?? ''));
      setExpirationDate(String(data.expiration_date ?? ''));
      setInternalNotes(String(data.internal_notes ?? ''));
      setExternalNotes(String(data.external_notes ?? ''));
      setDisplayRateMode((data.display_rate_mode as DisplayRateMode) ?? 'rate');
      setOrderNumber(String(data.order_number ?? ''));

      // Load order lines
      const { data: lineRows, error: lineErr } = await supabase
        .from('entities')
        .select('*, entity_versions(*)')
        .eq('entity_type', 'rental_order_line')
        .filter('entity_versions.data->>order_id', 'eq', initialOrderId!);

      if (lineErr || !lineRows) return;

      const loaded: QuoteLine[] = ((lineRows as unknown[]) ?? [])
        .flatMap<QuoteLine>((row) => {
          const r = row as Record<string, unknown>;
          const versions2 = (r.entity_versions as unknown[]) ?? [];
          const cv = versions2.find((v) => (v as Record<string, unknown>).is_current) as
            | Record<string, unknown>
            | undefined;
          const d = (cv?.data ?? {}) as Record<string, unknown>;
          if (d.status === 'cancelled') return [];
          return [{
            clientId: nextClientId(),
            lineId: String(r.id ?? ''),
            kitId: String(d.kit_id ?? ''),
            categoryId: String(d.category_id ?? ''),
            assetId: String(d.asset_id ?? ''),
            branchId: String(d.branch_id ?? ''),
            startDate: String(d.planned_start ?? offsetDaysStr(1)),
            endDate: String(d.planned_end ?? offsetDaysStr(8)),
            quantity: String(d.quantity ?? '1'),
            dailyRate: String(d.daily_rate ?? ''),
            rateType: String(d.rate_type ?? 'daily'),
            name: String(d.name ?? ''),
          } satisfies QuoteLine];
        });

      if (loaded.length > 0) setLines(loaded);
    }

    loadOrder();
  }, [initialOrderId]);

  // ── Mark pricing stale when first-line inputs change ─────────────────────
  const firstLine = lines[0];
  useEffect(() => {
    setPricing((prev) => (prev.status === 'ready' ? { ...prev, stale: true } : prev));
  }, [
    firstLine?.categoryId,
    firstLine?.branchId,
    firstLine?.startDate,
    firstLine?.endDate,
    firstLine?.dailyRate,
    firstLine?.quantity,
  ]);

  // ── First-line base amount for pricing preview ────────────────────────────
  const firstLineBase = useCallback((): number | null => {
    return firstLine ? lineBaseAmount(firstLine) : null;
  }, [firstLine]);

  // ── Pricing preview (first line) ─────────────────────────────────────────
  const fetchPricing = useCallback(async () => {
    const base = firstLineBase();
    if (base === null) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPricing({ status: 'loading' });

    const { data, error } = await supabase.rpc('staff_quote_pricing_preview', {
      p_base_amount: base,
      p_category_id: firstLine?.categoryId || null,
      p_branch_id: firstLine?.branchId || null,
    });

    if (controller.signal.aborted) return;

    if (error || !data || data.length === 0) {
      setPricing({ status: 'error', message: error?.message ?? 'No pricing data returned' });
      return;
    }

    const row = data[0] as {
      base_amount: number;
      fee_lines: FeeLine[];
      fees_total: number;
      subtotal: number;
      tax_lines: TaxLine[];
      tax_total: number;
      grand_total: number;
      preset_snapshot: Record<string, unknown>;
    };

    setPricing({
      status: 'ready',
      breakdown: {
        base_amount: row.base_amount,
        fee_lines: row.fee_lines ?? [],
        fees_total: row.fees_total,
        subtotal: row.subtotal,
        tax_lines: row.tax_lines ?? [],
        tax_total: row.tax_total,
        grand_total: row.grand_total,
        preset_snapshot: row.preset_snapshot ?? {},
      },
      stale: false,
    });
  }, [firstLineBase, firstLine?.categoryId, firstLine?.branchId]);

  // ── Per-line availability check ───────────────────────────────────────────
  const checkLineAvailability = useCallback(async (line: QuoteLine) => {
    if ((!line.kitId && !line.categoryId) || !line.branchId || !line.startDate || !line.endDate) return;

    setLineAvailability((prev) => ({ ...prev, [line.clientId]: { status: 'loading' } }));

    const { data, error } = line.kitId
      ? await supabase.rpc('rental_kit_availability', {
          p_kit_id: line.kitId,
          p_branch_id: line.branchId || null,
          p_quantity: normalizeQty(line.quantity),
          p_start_date: line.startDate || null,
          p_end_date: line.endDate || null,
        })
      : await supabase.rpc('rental_quote_availability', {
          p_asset_category_id: line.categoryId || null,
          p_branch_id: line.branchId || null,
          p_asset_id: line.assetId || null,
          p_quantity: normalizeQty(line.quantity),
          p_start_date: line.startDate || null,
          p_end_date: line.endDate || null,
        });

    if (error || !data || data.length === 0) {
      setLineAvailability((prev) => ({ ...prev, [line.clientId]: { status: 'error' } }));
      return;
    }

    const row = data[0] as {
      is_available: boolean;
      available_quantity: number;
      shortage_quantity: number;
      shortage_reason: string | null;
    };

    if (row.is_available) {
      setLineAvailability((prev) => ({
        ...prev,
        [line.clientId]: { status: 'available', availableQty: row.available_quantity },
      }));
    } else {
      setLineAvailability((prev) => ({
        ...prev,
        [line.clientId]: {
          status: 'unavailable',
          reason: row.shortage_reason ?? 'insufficient_quantity',
          shortageQty: row.shortage_quantity,
        },
      }));
    }
  }, []);

  // ── Line mutations ────────────────────────────────────────────────────────
  const addLine = useCallback(() => {
    setLines((prev) => [...prev, emptyLine()]);
  }, []);

  const updateLine = useCallback((index: number, updated: QuoteLine) => {
    setLines((prev) => prev.map((l, i) => (i === index ? updated : l)));
  }, []);

  const removeLine = useCallback((index: number) => {
    setLines((prev) => {
      const removed = prev[index];
      if (removed?.lineId) {
        setCancelledLineIds((ids) => [...ids, removed.lineId!]);
      }
      const next = prev.filter((_, i) => i !== index);
      return next.length === 0 ? [emptyLine()] : next;
    });
  }, []);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setSave({ status: 'saving' });

      const rpcLines = lines
        .filter((l) => l.categoryId || l.kitId)
        .map((l) => ({
          line_id: l.lineId ?? null,
          kit_id: l.kitId || null,
          category_id: l.categoryId || null,
          asset_id: l.assetId || null,
          branch_id: l.branchId || null,
          start_date: l.startDate || null,
          end_date: l.endDate || null,
          quantity: normalizeQty(l.quantity),
          daily_rate: parseFloat(l.dailyRate) || null,
          rate_type: l.rateType || 'daily',
          name: l.name || null,
        }));

      const { data, error } = await supabase.rpc('staff_save_quote_order', {
        p_order_id: orderId ?? null,
        p_customer_id: customerId || null,
        p_billing_account_id: billingAccountId || null,
        p_job_site_id: jobSiteId || null,
        p_expiration_date: expirationDate || null,
        p_display_rate_mode: displayRateMode,
        p_internal_notes: internalNotes || null,
        p_external_notes: externalNotes || null,
        p_lines: rpcLines,
        p_cancel_line_ids: cancelledLineIds,
      });

      if (error || !data || data.length === 0) {
        setSave({ status: 'error', message: error?.message ?? 'Save failed' });
        return;
      }

      const row = data[0] as { order_id: string; order_number: string; saved_lines: unknown };
      const savedLines = (row.saved_lines as Array<{ line_id: string; category_id: string; kit_id?: string }>) ?? [];

      // Sync back line IDs so subsequent saves are updates, not re-creates.
      setLines((prev) =>
        prev.map((l, i) => ({
          ...l,
          lineId: savedLines[i]?.line_id ?? l.lineId,
        })),
      );
      setCancelledLineIds([]);
      setOrderId(row.order_id);
      setOrderNumber(row.order_number);
      setSave({
        status: 'saved',
        orderId: row.order_id,
        orderNumber: row.order_number,
        savedAt: new Date(),
      });
    },
    [
      orderId,
      customerId,
      billingAccountId,
      jobSiteId,
      expirationDate,
      displayRateMode,
      internalNotes,
      externalNotes,
      lines,
      cancelledLineIds,
    ],
  );

  // ── Derived ───────────────────────────────────────────────────────────────
  const firstBase = firstLineBase();
  const canPreview = firstBase !== null;
  const hasUnavailableLines = Object.values(lineAvailability).some((a) => a.status === 'unavailable');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" data-testid="quote-builder-screen">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Calculator className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-xl font-semibold">
            Quote Builder
            {orderNumber && (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                #{orderNumber}
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            Create or edit a rental quote draft — saves as a rental order for later conversion
          </p>
        </div>
      </div>

      {/* ── Order details ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quote Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="qb-customer">Customer</Label>
              <select
                id="qb-customer"
                data-testid="input-customer-id"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value.trim())}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
              >
                <option value="">Select customer…</option>
                {customerId && !customerOptions.some((opt) => opt.id === customerId) && (
                  <option value={customerId}>Current selection ({customerId.slice(0, 8)})</option>
                )}
                {customerOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {customerId && (
                <p className="text-[11px] text-muted-foreground" data-testid="selected-customer-id">
                  ID: {customerId}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qb-billing">Billing Account</Label>
              <select
                id="qb-billing"
                data-testid="input-billing-account-id"
                value={billingAccountId}
                onChange={(e) => setBillingAccountId(e.target.value.trim())}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
              >
                <option value="">Select billing account…</option>
                {billingAccountId && !billingAccountOptions.some((opt) => opt.id === billingAccountId) && (
                  <option value={billingAccountId}>Current selection ({billingAccountId.slice(0, 8)})</option>
                )}
                {billingAccountOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {billingAccountId && (
                <p className="text-[11px] text-muted-foreground" data-testid="selected-billing-account-id">
                  ID: {billingAccountId}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qb-jobsite">Job Site</Label>
              <select
                id="qb-jobsite"
                data-testid="input-job-site-id"
                value={jobSiteId}
                onChange={(e) => setJobSiteId(e.target.value.trim())}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
              >
                <option value="">Select job site…</option>
                {jobSiteId && !jobSiteOptions.some((opt) => opt.id === jobSiteId) && (
                  <option value={jobSiteId}>Current selection ({jobSiteId.slice(0, 8)})</option>
                )}
                {jobSiteOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {jobSiteId && (
                <p className="text-[11px] text-muted-foreground" data-testid="selected-job-site-id">
                  ID: {jobSiteId}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="qb-expiration">Expiration Date</Label>
              <Input
                id="qb-expiration"
                data-testid="input-expiration-date"
                type="date"
                value={expirationDate}
                onChange={(e) => setExpirationDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="qb-internal-notes">Internal Notes</Label>
              <Textarea
                id="qb-internal-notes"
                data-testid="input-internal-notes"
                placeholder="Staff-only notes (not shown to customer)"
                value={internalNotes}
                onChange={(e) => setInternalNotes(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qb-external-notes">Customer Notes</Label>
              <Textarea
                id="qb-external-notes"
                data-testid="input-external-notes"
                placeholder="Notes shown to customer on the quote"
                value={externalNotes}
                onChange={(e) => setExternalNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Line items ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-base">Line Items</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="btn-toggle-rate-mode"
            onClick={() => setDisplayRateMode((m) => (m === 'rate' ? 'price' : 'rate'))}
            className="h-8 text-xs gap-1"
            title={`Switch to ${displayRateMode === 'rate' ? 'price (total)' : 'rate (per day)'} display`}
          >
            {displayRateMode === 'rate' ? (
              <ToggleLeft className="h-4 w-4" />
            ) : (
              <ToggleRight className="h-4 w-4" />
            )}
            <span data-testid="rate-mode-label">
              {displayRateMode === 'rate' ? 'Show Rate' : 'Show Price'}
            </span>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasUnavailableLines && (
            <Alert variant="destructive" data-testid="unavailable-lines-warning">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Availability Warning</AlertTitle>
              <AlertDescription>
                One or more line items have unavailable inventory for the requested dates.
                This draft can be saved, but the quote cannot be converted until availability is
                resolved.
              </AlertDescription>
            </Alert>
          )}

          {lines.map((line, index) => (
            <QuoteLineRow
              key={line.clientId}
              line={line}
              index={index}
              displayRateMode={displayRateMode}
              availability={lineAvailability[line.clientId] ?? { status: 'idle' }}
              kitOptions={kitOptions}
              categoryOptions={categoryOptions}
              branchOptions={branchOptions}
              assetOptions={assetOptions}
              onChange={(updated) => updateLine(index, updated)}
              onRemove={() => removeLine(index)}
              onCheckAvailability={() => checkLineAvailability(line)}
            />
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="btn-add-line"
            onClick={addLine}
            className="w-full gap-1"
          >
            <Plus className="h-4 w-4" />
            Add Line Item
          </Button>
        </CardContent>
      </Card>

      {/* ── Fee/tax pricing preview (first line) ──────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pricing Preview (Line 1)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Server-side fee and tax preset resolution for the first line item.
          </p>
          <Button
            type="button"
            data-testid="btn-preview-pricing"
            disabled={!canPreview || pricing.status === 'loading'}
            onClick={fetchPricing}
            className="w-full sm:w-auto"
            variant="outline"
            size="sm"
          >
            {pricing.status === 'loading' ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Calculating…
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                {pricing.status === 'ready' && pricing.stale ? 'Recalculate Pricing' : 'Preview Pricing'}
              </>
            )}
          </Button>

          {pricing.status === 'error' && (
            <Alert variant="destructive" data-testid="pricing-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Pricing Error</AlertTitle>
              <AlertDescription>{pricing.message}</AlertDescription>
            </Alert>
          )}

          {pricing.status === 'ready' && (
            <div data-testid="pricing-breakdown" className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Breakdown
                </span>
                {pricing.stale && (
                  <Badge variant="secondary" data-testid="stale-badge" className="text-xs">
                    Stale — recalculate to update
                  </Badge>
                )}
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Rental base</span>
                <span data-testid="line-base-amount">{fmtCurrency(pricing.breakdown.base_amount)}</span>
              </div>

              {pricing.breakdown.fee_lines.map((line) => (
                <div
                  key={line.preset_id}
                  className="flex justify-between text-sm"
                  data-testid={`fee-line-${line.preset_id}`}
                >
                  <span className="text-muted-foreground">
                    {line.name}
                    {line.fee_type === 'percent' && (
                      <span className="ml-1 text-xs">({fmtRate(line.rate)})</span>
                    )}
                  </span>
                  <span>{fmtCurrency(line.amount)}</span>
                </div>
              ))}

              <Separator />

              <div className="flex justify-between text-sm font-medium">
                <span>Subtotal</span>
                <span data-testid="line-subtotal">{fmtCurrency(pricing.breakdown.subtotal)}</span>
              </div>

              {pricing.breakdown.tax_lines.map((line) => (
                <div
                  key={line.preset_id}
                  className="flex justify-between text-sm"
                  data-testid={`tax-line-${line.preset_id}`}
                >
                  <span className="text-muted-foreground">
                    {line.name}
                    <span className="ml-1 text-xs">({fmtRate(line.rate)})</span>
                  </span>
                  <span>{fmtCurrency(line.amount)}</span>
                </div>
              ))}

              <Separator />

              <div className="flex justify-between font-semibold text-base">
                <span>Grand Total</span>
                <span data-testid="line-grand-total">{fmtCurrency(pricing.breakdown.grand_total)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Save ──────────────────────────────────────────────────────────────── */}
      <form onSubmit={handleSave}>
        <Button
          type="submit"
          data-testid="btn-save-draft"
          disabled={save.status === 'saving'}
          className="w-full sm:w-auto"
        >
          {save.status === 'saving' ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Save Quote Draft
            </>
          )}
        </Button>
      </form>

      {save.status === 'saved' && (
        <Alert data-testid="save-success">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Quote Draft Saved</AlertTitle>
          <AlertDescription>
            Order:{' '}
            <code data-testid="saved-order-number">{save.orderNumber}</code>
            {' ('}
            <code data-testid="saved-order-id">{save.orderId}</code>
            {') — saved at '}
            {save.savedAt.toLocaleTimeString()}
          </AlertDescription>
        </Alert>
      )}

      {save.status === 'error' && (
        <Alert variant="destructive" data-testid="save-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Save Failed</AlertTitle>
          <AlertDescription>{save.message}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
