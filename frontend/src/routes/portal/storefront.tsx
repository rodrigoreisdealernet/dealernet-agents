/**
 * Customer-Facing Storefront – Date-Range Availability + Live Quote
 *
 * Standalone, no-chrome route accessible without staff authentication.
 * URL: /portal/storefront
 *
 * The root layout auth guard is bypassed for all /portal/* routes.
 * Data is fetched via security-definer RPCs that enforce anon-safe access
 * (see migration 20260609010000_storefront_availability_quote.sql).
 *
 * Features:
 *  - Date-range picker (start / end)
 *  - Category and branch filters
 *  - Equipment grid with live quote breakdown (base rate + env fee + tax)
 *  - "Request Quote" form per item with contact details
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CalendarDays, ChevronDown, Truck, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  CommercialDocument,
  type CommercialDocumentModel,
} from '@/components/documents/CommercialDocument';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/portal/storefront')({
  component: StorefrontPage,
});

function StorefrontPage() {
  return <StorefrontScreen />;
}

// ---------------------------------------------------------------------------
// Session persistence key for quote confirmations
// ---------------------------------------------------------------------------

const STOREFRONT_QUOTE_KEY = 'storefront_quote_confirmation';

type StoredConfirmation = {
  quoteId: string;
  assetName: string;
  startDate: string;
  endDate: string;
  branchId?: string;
  branchName?: string;
  categoryId?: string;
  categoryName?: string;
};

type StorefrontInitialState = {
  startDate: string;
  endDate: string;
  categoryFilter: string;
  branchFilter: string;
  storedConfirmation: StoredConfirmation | null;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorefrontAsset = {
  entity_id: string;
  name: string;
  make: string | null;
  year: string | null;
  identifier: string | null;
  image_url: string | null;
  description: string | null;
  daily_rate: number | null;
  weekly_rate: number | null;
  monthly_rate: number | null;
  asset_category_id: string | null;
  asset_category_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
  is_available: boolean;
  conflict_reason: string | null;
};

export type QuoteBreakdown = {
  days: number;
  rateType: 'daily' | 'weekly' | 'monthly';
  periodsLabel: string;
  baseAmount: number;
  envFee: number;
  taxAmount: number;
  total: number;
};

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; quoteId: string }
  | { status: 'error'; message: string };

function formatDocumentDate(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function buildStorefrontQuoteDocumentModel({
  asset,
  startDate,
  endDate,
  quote,
  quoteId,
  contactName,
  contactEmail,
  contactPhone,
  companyName,
  notes,
}: {
  asset: StorefrontAsset;
  startDate: string;
  endDate: string;
  quote: QuoteBreakdown;
  quoteId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  companyName: string;
  notes: string;
}): CommercialDocumentModel {
  return {
    variant: 'quote',
    title: 'Rental Quote',
    documentNumber: quoteId,
    statusLabel: 'Requested',
    issuedAtLabel: formatDocumentDate(new Date().toISOString()),
    rentalPeriodLabel: `${startDate} – ${endDate}`,
    branding: {
      companyName: 'Dealernet',
      eyebrow: 'Equipment Rental',
      supportEmail: 'quotes@dia.example',
      supportPhone: '+1 (800) 555-0199',
    },
    customer: {
      name: contactName,
      company: companyName || undefined,
      email: contactEmail,
      phone: contactPhone || undefined,
    },
    jobSite: {
      name: asset.branch_name || undefined,
      reference: asset.asset_category_name || undefined,
    },
    lineItems: [
      {
        title: asset.name,
        description: [asset.make, asset.year, asset.identifier].filter(Boolean).join(' · ') || undefined,
        quantity: 1,
        rentalPeriod: `${startDate} – ${endDate}`,
        rateLabel: quote.periodsLabel,
        amount: quote.baseAmount,
      },
    ],
    subtotalAmount: quote.baseAmount,
    fees: [{ label: 'Environmental fee (5%)', amount: quote.envFee }],
    taxes: [{ label: 'Tax (8.5%)', amount: quote.taxAmount }],
    totalAmount: quote.total,
    notes: notes || undefined,
  };
}

// ---------------------------------------------------------------------------
// Quote calculation helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD string to a UTC midnight Date. */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Returns the number of calendar days between two YYYY-MM-DD strings (min 1). */
export function calcDaysBetween(startDate: string, endDate: string): number {
  const diff = parseLocalDate(endDate).getTime() - parseLocalDate(startDate).getTime();
  return Math.max(1, Math.round(diff / 86_400_000));
}

/** Formats a number as USD currency string. */
function fmtCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

const ENV_FEE_RATE = 0.05;   // 5 % environmental fee
const TAX_RATE = 0.085;       // 8.5 % tax on (base + env fee)

/**
 * Computes the live quote breakdown for an asset over a date range.
 *
 * Rate selection:
 *   >= 28 days → monthly_rate (prorated by 30-day period)
 *   >= 7 days  → weekly_rate  (prorated by 7-day period)
 *   < 7 days   → daily_rate
 *
 * Returns null when no rate data is available.
 */
export function calcQuote(
  asset: Pick<StorefrontAsset, 'daily_rate' | 'weekly_rate' | 'monthly_rate'>,
  startDate: string,
  endDate: string,
): QuoteBreakdown | null {
  const days = calcDaysBetween(startDate, endDate);
  let baseAmount = 0;
  let rateType: QuoteBreakdown['rateType'] = 'daily';
  let periodsLabel = '';

  if (days >= 28 && asset.monthly_rate != null && asset.monthly_rate > 0) {
    const months = days / 30;
    baseAmount = months * asset.monthly_rate;
    rateType = 'monthly';
    periodsLabel = `${months.toFixed(1)} months × ${fmtCurrency(asset.monthly_rate)}/mo`;
  } else if (days >= 7 && asset.weekly_rate != null && asset.weekly_rate > 0) {
    const weeks = days / 7;
    baseAmount = weeks * asset.weekly_rate;
    rateType = 'weekly';
    periodsLabel = `${weeks.toFixed(1)} weeks × ${fmtCurrency(asset.weekly_rate)}/wk`;
  } else if (asset.daily_rate != null && asset.daily_rate > 0) {
    baseAmount = days * asset.daily_rate;
    rateType = 'daily';
    periodsLabel = `${days} day${days !== 1 ? 's' : ''} × ${fmtCurrency(asset.daily_rate)}/day`;
  } else {
    return null;
  }

  baseAmount = Math.round(baseAmount * 100) / 100;
  const envFee = Math.round(baseAmount * ENV_FEE_RATE * 100) / 100;
  const subtotal = baseAmount + envFee;
  const taxAmount = Math.round(subtotal * TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;

  return { days, rateType, periodsLabel, baseAmount, envFee, taxAmount, total };
}

/** Returns today's date as YYYY-MM-DD. */
function todayStr(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Returns a date offset from today as YYYY-MM-DD. */
function offsetDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function readStoredConfirmation(): StoredConfirmation | null {
  try {
    const raw = sessionStorage.getItem(STOREFRONT_QUOTE_KEY);
    return raw ? (JSON.parse(raw) as StoredConfirmation) : null;
  } catch {
    return null;
  }
}

function getInitialStorefrontState(): StorefrontInitialState {
  const storedConfirmation = readStoredConfirmation();
  return {
    startDate: storedConfirmation?.startDate ?? todayStr(),
    endDate: storedConfirmation?.endDate ?? offsetDaysStr(7),
    categoryFilter: storedConfirmation?.categoryId ?? '',
    branchFilter: storedConfirmation?.branchId ?? '',
    storedConfirmation,
  };
}

// ---------------------------------------------------------------------------
// Main screen component
// ---------------------------------------------------------------------------

export function StorefrontScreen() {
  const initialState = useMemo(() => getInitialStorefrontState(), []);
  const [startDate, setStartDate] = useState<string>(initialState.startDate);
  const [endDate, setEndDate] = useState<string>(initialState.endDate);
  const [categoryFilter, setCategoryFilter] = useState<string>(initialState.categoryFilter);
  const [branchFilter, setBranchFilter] = useState<string>(initialState.branchFilter);

  const [assets, setAssets] = useState<StorefrontAsset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Durable confirmation — survives panel close and page reload via sessionStorage.
  const [storedConfirmation, setStoredConfirmation] = useState<StoredConfirmation | null>(initialState.storedConfirmation);

  // Quote-request form state
  const [selectedAsset, setSelectedAsset] = useState<StorefrontAsset | null>(null);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [notes, setNotes] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' });
  const [submittedQuoteDocument, setSubmittedQuoteDocument] = useState<CommercialDocumentModel | null>(null);

  // Derived: unique categories and branches from catalog
  const categories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assets) {
      if (a.asset_category_id && a.asset_category_name) {
        seen.set(a.asset_category_id, a.asset_category_name);
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [assets]);

  const branches = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of assets) {
      if (a.branch_id && a.branch_name) {
        seen.set(a.branch_id, a.branch_name);
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [assets]);

  // Filtered assets (client-side by category/branch)
  const filteredAssets = useMemo(
    () =>
      assets.filter(
        (a) =>
          (!categoryFilter || a.asset_category_id === categoryFilter) &&
          (!branchFilter || a.branch_id === branchFilter),
      ),
    [assets, categoryFilter, branchFilter],
  );

  // -------------------------------------------------------------------------
  // Data fetch
  // -------------------------------------------------------------------------
  const fetchAvailability = useCallback(async (start: string, end: string) => {
    if (!start || !end || start >= end) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.rpc('portal_storefront_get_availability', {
        p_start_date: start,
        p_end_date: end,
        p_category_id: null,
        p_branch_id: null,
      });
      if (error) throw error;
      setAssets((data ?? []) as StorefrontAsset[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load equipment.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAvailability(startDate, endDate);
  }, [startDate, endDate, fetchAvailability]);

  // -------------------------------------------------------------------------
  // Quote request submission
  // -------------------------------------------------------------------------
  const handleSubmitQuote = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!selectedAsset) return;

      const quote = calcQuote(selectedAsset, startDate, endDate);

      setSubmitState({ status: 'submitting' });
      try {
        const { data, error } = await supabase.rpc('portal_storefront_submit_quote', {
          p_asset_id:          selectedAsset.entity_id,
          p_asset_category_id: selectedAsset.asset_category_id,
          p_branch_id:         selectedAsset.branch_id,
          p_start_date:        startDate,
          p_end_date:          endDate,
          p_contact_name:      contactName,
          p_contact_email:     contactEmail,
          p_contact_phone:     contactPhone || null,
          p_company_name:      companyName || null,
          p_notes:             notes || null,
          p_rate_type:         quote?.rateType ?? null,
          p_base_amount:       quote?.baseAmount ?? null,
          p_env_fee:           quote?.envFee ?? null,
          p_damage_waiver:     null,
          p_tax_amount:        quote?.taxAmount ?? null,
          p_total_amount:      quote?.total ?? null,
        });
        if (error) throw error;
        const result = Array.isArray(data) ? data[0] : data;
        const quoteId = (result as { quote_request_id?: string })?.quote_request_id ?? '';
        const confirmation: StoredConfirmation = {
          quoteId,
          assetName: selectedAsset.name,
          startDate,
          endDate,
          branchId: selectedAsset.branch_id || undefined,
          branchName: selectedAsset.branch_name || undefined,
          categoryId: selectedAsset.asset_category_id || undefined,
          categoryName: selectedAsset.asset_category_name || undefined,
        };
        try {
          sessionStorage.setItem(STOREFRONT_QUOTE_KEY, JSON.stringify(confirmation));
        } catch {
          // sessionStorage unavailable — skip persistence silently
        }
        setStoredConfirmation(confirmation);
        setSubmitState({
          status: 'success',
          quoteId,
        });
        if (quote && result && typeof (result as { quote_request_id?: string }).quote_request_id === 'string') {
          setSubmittedQuoteDocument(
            buildStorefrontQuoteDocumentModel({
              asset: selectedAsset,
              startDate,
              endDate,
              quote,
              quoteId: (result as { quote_request_id?: string }).quote_request_id ?? '',
              contactName,
              contactEmail,
              contactPhone,
              companyName,
              notes,
            }),
          );
        }
        // Reset form
        setContactName('');
        setContactEmail('');
        setContactPhone('');
        setCompanyName('');
        setNotes('');
      } catch (err) {
        setSubmitState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to submit quote request.',
        });
      }
    },
    [selectedAsset, startDate, endDate, contactName, contactEmail, contactPhone, companyName, notes],
  );

  const handleSelectAsset = useCallback((asset: StorefrontAsset) => {
    setSelectedAsset(asset);
    setSubmitState({ status: 'idle' });
    setSubmittedQuoteDocument(null);
  }, []);

  const handleCloseForm = useCallback(() => {
    setSelectedAsset(null);
    setSubmitState({ status: 'idle' });
    setSubmittedQuoteDocument(null);
  }, []);

  const handleDismissConfirmation = useCallback(() => {
    setStoredConfirmation(null);
    try {
      sessionStorage.removeItem(STOREFRONT_QUOTE_KEY);
    } catch {
      // ignore
    }
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b shadow-sm px-4 sm:px-8 py-4 flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <Truck className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight">Dealernet</h1>
          <p className="text-xs text-muted-foreground">Equipment Rental</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-8 py-8 space-y-8">
        {/* Hero / Date Range Picker */}
        <section className="space-y-2">
          <h2 className="text-2xl font-bold">Browse & Quote Equipment</h2>
          <p className="text-muted-foreground">
            Select your rental dates to check real-time availability and get an instant price quote.
          </p>
        </section>

        {/* Controls */}
        <div className="bg-white rounded-xl border shadow-sm p-4 sm:p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Start date */}
            <div className="space-y-1">
              <Label htmlFor="start-date" className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
                Rental Start
              </Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                min={todayStr()}
                onChange={(e) => {
                  const val = e.target.value;
                  setStartDate(val);
                  if (val && endDate && val >= endDate) {
                    setEndDate(offsetDaysStr(7));
                  }
                }}
                data-testid="input-start-date"
              />
            </div>

            {/* End date */}
            <div className="space-y-1">
              <Label htmlFor="end-date" className="flex items-center gap-1.5 text-sm font-medium">
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
                Rental End
              </Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                min={startDate || todayStr()}
                onChange={(e) => setEndDate(e.target.value)}
                data-testid="input-end-date"
              />
            </div>

            {/* Category filter */}
            <div className="space-y-1">
              <Label htmlFor="category-filter" className="text-sm font-medium">
                Category
              </Label>
              <div className="relative">
                <select
                  id="category-filter"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm appearance-none pr-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  data-testid="select-category"
                >
                  <option value="">All Categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>

            {/* Branch filter */}
            <div className="space-y-1">
              <Label htmlFor="branch-filter" className="text-sm font-medium">
                Branch / Location
              </Label>
              <div className="relative">
                <select
                  id="branch-filter"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm appearance-none pr-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  data-testid="select-branch"
                >
                  <option value="">All Branches</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>
          </div>

          {/* Date validation banner */}
          {startDate && endDate && startDate >= endDate && (
            <Alert variant="destructive" data-testid="date-validation-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Invalid date range</AlertTitle>
              <AlertDescription>End date must be after start date.</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Durable quote confirmation banner – survives panel close and page reload */}
        {storedConfirmation && (
          <div
            className="flex items-start justify-between gap-4 rounded-lg border border-green-200 bg-green-50 p-4"
            data-testid="confirmation-banner"
          >
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />
              <div>
                <p className="font-semibold text-green-800">Quote request on file</p>
                <p className="text-sm text-green-700">
                  {storedConfirmation.assetName}
                  {(storedConfirmation.categoryName || storedConfirmation.branchName) && (
                    <>
                      {' '}&middot;{' '}
                      {/* category · branch — mirrors the order used in the asset card location line */}
                      <span data-testid="confirmation-banner-scope">
                        {storedConfirmation.categoryName}
                        {storedConfirmation.categoryName && storedConfirmation.branchName && <>{' '}&middot;{' '}</>}
                        {storedConfirmation.branchName}
                      </span>
                    </>
                  )}
                  {' '}&middot; {storedConfirmation.startDate}&nbsp;–&nbsp;{storedConfirmation.endDate}
                  {' '}&middot; Reference:{' '}
                  <span data-testid="confirmation-banner-quote-id" className="font-mono">
                    {storedConfirmation.quoteId}
                  </span>
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-green-700 hover:text-green-900"
              onClick={handleDismissConfirmation}
              data-testid="dismiss-confirmation-btn"
            >
              Start new quote
            </Button>
          </div>
        )}

        {/* Load error */}
        {loadError && (
          <Alert variant="destructive" data-testid="load-error">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Could not load equipment</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground" data-testid="loading-indicator">
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            <span>Checking availability…</span>
          </div>
        )}

        {/* Equipment grid */}
        {!isLoading && !loadError && (
          <section aria-label="Equipment catalog" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {filteredAssets.length === 0
                ? 'No equipment found for the selected filters.'
                : `${filteredAssets.filter((a) => a.is_available).length} of ${filteredAssets.length} items available for your dates`}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredAssets.map((asset) => (
                <AssetCard
                  key={asset.entity_id}
                  asset={asset}
                  startDate={startDate}
                  endDate={endDate}
                  onRequestQuote={handleSelectAsset}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Quote request panel */}
      {selectedAsset && (
        <QuoteRequestPanel
          asset={selectedAsset}
          startDate={startDate}
          endDate={endDate}
          contactName={contactName}
          contactEmail={contactEmail}
          contactPhone={contactPhone}
          companyName={companyName}
          notes={notes}
          submitState={submitState}
          onContactNameChange={setContactName}
          onContactEmailChange={setContactEmail}
          onContactPhoneChange={setContactPhone}
          onCompanyNameChange={setCompanyName}
          onNotesChange={setNotes}
          onSubmit={handleSubmitQuote}
          onClose={handleCloseForm}
          submittedQuoteDocument={submittedQuoteDocument}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asset card
// ---------------------------------------------------------------------------

interface AssetCardProps {
  asset: StorefrontAsset;
  startDate: string;
  endDate: string;
  onRequestQuote: (asset: StorefrontAsset) => void;
}

function AssetCard({ asset, startDate, endDate, onRequestQuote }: AssetCardProps) {
  const quote = useMemo(
    () => (startDate && endDate && startDate < endDate ? calcQuote(asset, startDate, endDate) : null),
    [asset, startDate, endDate],
  );

  const isDateRangeValid = startDate && endDate && startDate < endDate;

  return (
    <Card
      className="overflow-hidden hover:shadow-md transition-shadow"
      data-testid={`asset-card-${asset.entity_id}`}
    >
      {/* Image placeholder */}
      {asset.image_url ? (
        <img
          src={asset.image_url}
          alt={asset.name}
          className="w-full h-48 object-cover"
        />
      ) : (
        <div className="w-full h-32 bg-muted flex items-center justify-center text-muted-foreground text-sm">
          No image
        </div>
      )}

      <CardContent className="p-4 space-y-3">
        {/* Title + availability badge */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold leading-snug">{asset.name}</h3>
            <p className="text-xs text-muted-foreground">
              {[asset.make, asset.year, asset.identifier].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Badge
            variant={asset.is_available ? 'default' : 'secondary'}
            data-testid={`availability-badge-${asset.entity_id}`}
          >
            {asset.is_available ? 'Available' : 'Unavailable'}
          </Badge>
        </div>

        {/* Location */}
        {(asset.branch_name || asset.asset_category_name) && (
          <p className="text-xs text-muted-foreground">
            {[asset.asset_category_name, asset.branch_name].filter(Boolean).join(' · ')}
          </p>
        )}

        {/* Live quote breakdown */}
        {quote ? (
          <div className="rounded-lg bg-muted/50 p-3 space-y-1.5 text-sm" data-testid={`quote-breakdown-${asset.entity_id}`}>
            <div className="flex justify-between text-muted-foreground">
              <span>Rental ({quote.periodsLabel})</span>
              <span>{fmtCurrency(quote.baseAmount)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Environmental fee (5%)</span>
              <span>{fmtCurrency(quote.envFee)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tax (8.5%)</span>
              <span>{fmtCurrency(quote.taxAmount)}</span>
            </div>
            <div className="flex justify-between font-semibold border-t pt-1.5">
              <span>Estimated total</span>
              <span data-testid={`quote-total-${asset.entity_id}`}>{fmtCurrency(quote.total)}</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            {/* Static rates when no date range */}
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Base rates
              </p>
              <div className="flex gap-4">
                {asset.daily_rate != null && (
                  <div className="text-center">
                    <p className="font-bold text-sm">{fmtCurrency(asset.daily_rate)}</p>
                    <p className="text-xs text-muted-foreground">day</p>
                  </div>
                )}
                {asset.weekly_rate != null && (
                  <div className="text-center">
                    <p className="font-bold text-sm">{fmtCurrency(asset.weekly_rate)}</p>
                    <p className="text-xs text-muted-foreground">week</p>
                  </div>
                )}
                {asset.monthly_rate != null && (
                  <div className="text-center">
                    <p className="font-bold text-sm">{fmtCurrency(asset.monthly_rate)}</p>
                    <p className="text-xs text-muted-foreground">month</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <Button
          className="w-full"
          disabled={!asset.is_available || !isDateRangeValid}
          onClick={() => onRequestQuote(asset)}
          data-testid={`request-quote-btn-${asset.entity_id}`}
        >
          {asset.is_available ? 'Request Quote' : 'Unavailable for Dates'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Quote request panel (slide-in / modal-like)
// ---------------------------------------------------------------------------

interface QuoteRequestPanelProps {
  asset: StorefrontAsset;
  startDate: string;
  endDate: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  companyName: string;
  notes: string;
  submitState: SubmitState;
  onContactNameChange: (v: string) => void;
  onContactEmailChange: (v: string) => void;
  onContactPhoneChange: (v: string) => void;
  onCompanyNameChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
  submittedQuoteDocument: CommercialDocumentModel | null;
}

function QuoteRequestPanel({
  asset,
  startDate,
  endDate,
  contactName,
  contactEmail,
  contactPhone,
  companyName,
  notes,
  submitState,
  onContactNameChange,
  onContactEmailChange,
  onContactPhoneChange,
  onCompanyNameChange,
  onNotesChange,
  onSubmit,
  onClose,
  submittedQuoteDocument,
}: QuoteRequestPanelProps) {
  const quote = useMemo(
    () => (startDate && endDate && startDate < endDate ? calcQuote(asset, startDate, endDate) : null),
    [asset, startDate, endDate],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      data-testid="quote-request-panel"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold">Request a Quote</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {asset.name}
                {asset.branch_name ? ` · ${asset.branch_name}` : ''}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" data-testid="close-panel-btn">
              ✕
            </Button>
          </div>

          {/* Dates + quote summary */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Quote Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Rental period</span>
                <span className="font-medium">
                  {startDate} <span aria-label="to">&ndash;</span> {endDate}
                </span>
              </div>
              {quote && (
                <>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Base rental ({quote.periodsLabel})</span>
                    <span>{fmtCurrency(quote.baseAmount)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Environmental fee (5%)</span>
                    <span>{fmtCurrency(quote.envFee)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Tax (8.5%)</span>
                    <span>{fmtCurrency(quote.taxAmount)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-base border-t pt-2">
                    <span>Estimated total</span>
                    <span data-testid="panel-quote-total">{fmtCurrency(quote.total)}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Success state */}
          {submitState.status === 'success' && (
            <div className="space-y-4">
              <Alert data-testid="submit-success">
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Quote request received!</AlertTitle>
                <AlertDescription>
                  Our team will be in touch shortly. Reference: {submitState.quoteId}
                </AlertDescription>
              </Alert>

              {submittedQuoteDocument ? (
                <div
                  className="space-y-3"
                  data-testid="quote-document-preview"
                  id="quote-document-preview"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">Quote document preview</p>
                      <p className="text-xs text-muted-foreground">
                        Mobile-friendly and print-ready from the submitted commercial snapshot.
                      </p>
                    </div>
                  </div>
                  <CommercialDocument model={submittedQuoteDocument} shareUrl={typeof window !== 'undefined' ? `${window.location.href}#quote-document-preview` : undefined} />
                </div>
              ) : null}
            </div>
          )}

          {/* Error state */}
          {submitState.status === 'error' && (
            <Alert variant="destructive" data-testid="submit-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Submission failed</AlertTitle>
              <AlertDescription>{submitState.message}</AlertDescription>
            </Alert>
          )}

          {/* Contact form (hidden after success) */}
          {submitState.status !== 'success' && (
            <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" data-testid="quote-form">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label htmlFor="contact-name">Your name *</Label>
                  <Input
                    id="contact-name"
                    value={contactName}
                    onChange={(e) => onContactNameChange(e.target.value)}
                    placeholder="Jane Smith"
                    required
                    data-testid="input-contact-name"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-email">Email *</Label>
                  <Input
                    id="contact-email"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => onContactEmailChange(e.target.value)}
                    placeholder="jane@company.com"
                    required
                    data-testid="input-contact-email"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="contact-phone">Phone</Label>
                  <Input
                    id="contact-phone"
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => onContactPhoneChange(e.target.value)}
                    placeholder="+1 (555) 000-0000"
                    data-testid="input-contact-phone"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="company-name">Company</Label>
                  <Input
                    id="company-name"
                    value={companyName}
                    onChange={(e) => onCompanyNameChange(e.target.value)}
                    placeholder="Acme Corp"
                    data-testid="input-company-name"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="notes">Additional notes</Label>
                <textarea
                  id="notes"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none h-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  placeholder="Delivery requirements, job site details, etc."
                  data-testid="input-notes"
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={submitState.status === 'submitting'}
                data-testid="submit-quote-btn"
              >
                {submitState.status === 'submitting' ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Submitting…
                  </span>
                ) : (
                  'Submit Quote Request'
                )}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
