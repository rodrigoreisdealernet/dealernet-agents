/**
 * Job-Site Portal – Equipment Catalog Requisition
 *
 * Standalone, no-chrome route accessible via a shareable URL.
 * URL: /portal/catalog/:jobSiteId[?scope=<token>]
 *
 * The root layout auth guard is bypassed for all /portal/* routes, so this
 * page is viewable by site foremen without staff authentication.  Writes are
 * gated by the portal scope token bound to the job site
 * (portal_contract_scope_tokens).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  Package,
  Search,
  CalendarDays,
  Truck,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  X,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/portal/catalog/$jobSiteId')({
  component: PortalCatalogPage,
});

function PortalCatalogPage() {
  const { jobSiteId } = Route.useParams();
  return <PortalCatalogScreen jobSiteId={jobSiteId} />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatalogAsset = {
  assetId: string;
  name: string;
  make: string | null;
  model: string | null;
  year: string | null;
  identifier: string | null;
  categoryId: string | null;
  branchId: string | null;
  dailyRate: string | null;
  weeklyRate: string | null;
  monthlyRate: string | null;
  imageUrl: string | null;
  status: string;
  fuelType: string | null;
  meterType: string | null;
  condition: string | null;
  tags: string[];
  specs: Record<string, unknown> | null;
  inventoryKind: string | null;
  inventoryEntityType: string | null;
};

export type CatalogCategory = {
  id: string;
  name: string;
};

type RequisitionFormState = {
  startDate: string;
  endDate: string;
  dispatchYard: string;
  notes: string;
};

type RequisitionSuccessState = {
  id: string;
  assetName: string;
  jobSiteId: string;
  startDate: string;
  endDate: string;
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCatalogAssets(jobSiteId: string, scopeToken: string | null): Promise<CatalogAsset[]> {
  const { data, error } = await supabase.rpc('portal_get_catalog_assets', {
    p_job_site_id: jobSiteId,
    // Passing '' when scopeToken is null is intentional: the RPC validates
    // the token server-side and returns 42501 for anon/authenticated callers
    // that supply an empty/missing token. The error surfaces via load-error.
    p_scope_token: scopeToken ?? '',
  });

  if (error) throw new Error(error.message);

  return (data ?? []).map((row: Record<string, unknown>) => ({
    assetId: String(row.asset_id ?? ''),
    name: String(row.name ?? ''),
    make: row.make != null ? String(row.make) : null,
    model: row.model != null ? String(row.model) : null,
    year: row.year != null ? String(row.year) : null,
    identifier: row.identifier != null ? String(row.identifier) : null,
    categoryId: row.category_id != null ? String(row.category_id) : null,
    branchId: row.branch_id != null ? String(row.branch_id) : null,
    dailyRate: row.daily_rate != null ? String(row.daily_rate) : null,
    weeklyRate: row.weekly_rate != null ? String(row.weekly_rate) : null,
    monthlyRate: row.monthly_rate != null ? String(row.monthly_rate) : null,
    imageUrl: row.image_url != null ? String(row.image_url) : null,
    status: String(row.status ?? ''),
    fuelType: row.fuel_type != null ? String(row.fuel_type) : null,
    meterType: row.meter_type != null ? String(row.meter_type) : null,
    condition: row.condition != null ? String(row.condition) : null,
    tags: Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    specs: row.specs != null && typeof row.specs === 'object'
      ? (row.specs as Record<string, unknown>)
      : null,
    inventoryKind: row.inventory_kind != null ? String(row.inventory_kind) : null,
    inventoryEntityType: row.inventory_entity_type != null ? String(row.inventory_entity_type) : null,
  }));
}

function extractScopeToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('scope');
    return token && token.trim().length > 0 ? token.trim() : null;
  } catch {
    return null;
  }
}

function deriveCategories(assets: CatalogAsset[]): CatalogCategory[] {
  // Category names default to the raw category_id value (e.g. 'cat-earthmoving').
  // A future enhancement should fetch human-readable names from the
  // asset_category entity type and join them here or via the catalog view.
  const seen = new Map<string, string>();
  for (const asset of assets) {
    if (asset.categoryId && !seen.has(asset.categoryId)) {
      seen.set(asset.categoryId, asset.categoryId);
    }
  }
  return Array.from(seen.entries()).map(([id]) => ({ id, name: id }));
}

export function formatRate(rate: string | null): string {
  if (!rate) return '—';
  const n = parseFloat(rate);
  if (Number.isNaN(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AssetCard({
  asset,
  onSelect,
}: {
  asset: CatalogAsset;
  onSelect: (asset: CatalogAsset) => void;
}) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-shadow"
      data-testid={`catalog-asset-${asset.assetId}`}
      onClick={() => onSelect(asset)}
    >
      <CardContent className="p-4">
        {asset.imageUrl && (
          <img
            src={asset.imageUrl}
            alt={asset.name}
            className="w-full h-28 object-contain mb-3 rounded bg-muted"
          />
        )}
        <p className="font-semibold text-sm leading-tight">{asset.name}</p>
        {(asset.make || asset.model || asset.year) && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {[asset.make, asset.model, asset.year].filter(Boolean).join(' · ')}
          </p>
        )}
        {asset.identifier && (
          <p className="text-xs text-muted-foreground">{asset.identifier}</p>
        )}
        <div className="flex items-center justify-between mt-3">
          <div className="text-xs text-muted-foreground">
            {asset.dailyRate ? (
              <span>
                <span className="font-medium text-foreground">{formatRate(asset.dailyRate)}</span>
                /day
              </span>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1">
            Requisition
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RequisitionForm({
  asset,
  jobSiteId,
  scopeToken,
  onSuccess,
  onCancel,
}: {
  asset: CatalogAsset;
  jobSiteId: string;
  scopeToken: string | null;
  onSuccess: (success: RequisitionSuccessState) => void;
  onCancel: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  // Dates are entered and interpreted in the client's local time zone.
  // The ISO date strings (YYYY-MM-DD) sent to the RPC are timezone-neutral
  // calendar dates; the server applies them as the job site's working day.

  const [form, setForm] = useState<RequisitionFormState>({
    startDate: today,
    endDate: today,
    dispatchYard: '',
    notes: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = useCallback(
    (field: keyof RequisitionFormState) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setForm((prev) => ({ ...prev, [field]: e.target.value }));
      },
    []
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!scopeToken) {
        setError('Missing or invalid portal scope token. Ask your project coordinator for the site link.');
        return;
      }

      if (!form.startDate || !form.endDate) {
        setError('Start date and end date are required.');
        return;
      }
      if (form.endDate < form.startDate) {
        setError('End date must be on or after start date.');
        return;
      }

      setSubmitting(true);
      try {
        const { data, error: rpcError } = await supabase.rpc('portal_submit_requisition', {
          p_job_site_id: jobSiteId,
          p_asset_id: asset.assetId,
          p_start_date: form.startDate,
          p_end_date: form.endDate,
          p_dispatch_yard: form.dispatchYard || null,
          p_notes: form.notes || null,
          p_scope_token: scopeToken,
        });

        if (rpcError) throw new Error(rpcError.message);

        const created =
          Array.isArray(data) && data[0] && typeof data[0].requisition_id === 'string'
            ? data[0].requisition_id
            : null;

        if (!created) {
          throw new Error('Requisition was not returned by the server. Please try again or contact your project coordinator.');
        }

        onSuccess({
          id: created,
          assetName: asset.name,
          jobSiteId,
          startDate: form.startDate,
          endDate: form.endDate,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to submit requisition.');
      } finally {
        setSubmitting(false);
      }
    },
    [asset, form, jobSiteId, onSuccess, scopeToken]
  );

  return (
    <div data-testid="requisition-form" className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold text-sm">{asset.name}</p>
          {asset.identifier && (
            <p className="text-xs text-muted-foreground">{asset.identifier}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Close requisition form">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="req-start-date" className="text-xs">Start Date</Label>
            <Input
              id="req-start-date"
              type="date"
              value={form.startDate}
              onChange={handleChange('startDate')}
              min={today}
              required
              aria-label="Start Date, must be today or later"
              data-testid="req-start-date"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="req-end-date" className="text-xs">End Date</Label>
            <Input
              id="req-end-date"
              type="date"
              value={form.endDate}
              onChange={handleChange('endDate')}
              min={form.startDate || today}
              required
              aria-label="End Date, must be on or after start date"
              data-testid="req-end-date"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="req-dispatch-yard" className="text-xs">
            Dispatch Yard / Branch{' '}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="req-dispatch-yard"
            type="text"
            placeholder="e.g. North Yard"
            value={form.dispatchYard}
            onChange={handleChange('dispatchYard')}
            data-testid="req-dispatch-yard"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="req-notes" className="text-xs">
            Notes / Special Instructions{' '}
            <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="req-notes"
            type="text"
            placeholder="Delivery instructions, site contact…"
            value={form.notes}
            onChange={handleChange('notes')}
            data-testid="req-notes"
          />
        </div>

        {error && (
          <Alert variant="destructive" data-testid="requisition-error">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Cannot submit requisition</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={submitting}
          data-testid="req-submit-button"
        >
          {submitting ? (
            'Submitting…'
          ) : (
            <>
              <Truck className="h-4 w-4 mr-2" />
              Submit Requisition
            </>
          )}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen (exported for testing)
// ---------------------------------------------------------------------------

export interface PortalCatalogScreenProps {
  jobSiteId: string;
  /** Override the page URL for testing (defaults to window.location.href). */
  pageUrl?: string;
}

export function PortalCatalogScreen({ jobSiteId, pageUrl }: PortalCatalogScreenProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assets, setAssets] = useState<CatalogAsset[]>([]);
  const [searchText, setSearchText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<CatalogAsset | null>(null);
  const [requisitionSuccess, setRequisitionSuccess] = useState<RequisitionSuccessState | null>(null);

  const shareUrl = useMemo(
    () => pageUrl ?? (typeof window !== 'undefined' ? window.location.href : ''),
    [pageUrl]
  );
  const scopeToken = useMemo(() => extractScopeToken(shareUrl), [shareUrl]);

  const resetPortalTransientState = useCallback(() => {
    setSelectedAsset(null);
    setRequisitionSuccess(null);
  }, []);

  useEffect(() => {
    setIsLoading(true);
    setLoadError(null);
    resetPortalTransientState();
    loadCatalogAssets(jobSiteId, scopeToken)
      .then(setAssets)
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load catalog.');
      })
      .finally(() => setIsLoading(false));
  }, [jobSiteId, resetPortalTransientState, scopeToken]);

  const categories = useMemo(() => deriveCategories(assets), [assets]);

  const filteredAssets = useMemo(() => {
    const lowerSearch = searchText.toLowerCase();
    return assets.filter((a) => {
      const matchesCategory = !selectedCategory || a.categoryId === selectedCategory;
      const matchesSearch =
        !lowerSearch ||
        a.name.toLowerCase().includes(lowerSearch) ||
        (a.make ?? '').toLowerCase().includes(lowerSearch) ||
        (a.model ?? '').toLowerCase().includes(lowerSearch) ||
        (a.identifier ?? '').toLowerCase().includes(lowerSearch) ||
        (a.fuelType ?? '').toLowerCase().includes(lowerSearch) ||
        (a.meterType ?? '').toLowerCase().includes(lowerSearch) ||
        (a.condition ?? '').toLowerCase().includes(lowerSearch) ||
        a.tags.some((tag) => tag.toLowerCase().includes(lowerSearch));
      return matchesCategory && matchesSearch;
    });
  }, [assets, selectedCategory, searchText]);

  const handleSelectAsset = useCallback((asset: CatalogAsset) => {
    setRequisitionSuccess(null);
    setSelectedAsset(asset);
  }, []);

  const handleRequisitionSuccess = useCallback(
    (success: RequisitionSuccessState) => {
      setSelectedAsset(null);
      setRequisitionSuccess(success);
    },
    []
  );

  const dispatchHandoffHref = useMemo(() => {
    if (!requisitionSuccess) return '';
    const params = new URLSearchParams({
      source: 'portal_catalog',
      assetName: requisitionSuccess.assetName,
      jobSiteId: requisitionSuccess.jobSiteId,
      startDate: requisitionSuccess.startDate,
      endDate: requisitionSuccess.endDate,
    });
    return `/entities/requisition/${requisitionSuccess.id}?${params.toString()}`;
  }, [requisitionSuccess]);

  const handleRequisitionCancel = useCallback(() => {
    setSelectedAsset(null);
  }, []);

  return (
    <div className="min-h-screen bg-background" data-testid="portal-catalog-page">
      {/* Portal header */}
      <header className="border-b bg-card px-4 py-3 flex items-center gap-3 shadow-sm">
        <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center shrink-0">
          <Package className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">Equipment Catalog</p>
          <p className="text-xs text-muted-foreground truncate" data-testid="site-id-label">
            Job Site: {jobSiteId}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 space-y-4">
        {/* Requisition panel (shown when an asset is selected) */}
        {selectedAsset && (
          <Card data-testid="requisition-panel">
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Truck className="h-4 w-4 text-primary" />
                New Requisition
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <RequisitionForm
                asset={selectedAsset}
                jobSiteId={jobSiteId}
                scopeToken={scopeToken}
                onSuccess={handleRequisitionSuccess}
                onCancel={handleRequisitionCancel}
              />
            </CardContent>
          </Card>
        )}

        {/* Success alert */}
        {requisitionSuccess && !selectedAsset && (
          <Alert data-testid="requisition-success">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Requisition recorded</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                Requisition for <strong>{requisitionSuccess.assetName}</strong> submitted.
                Reference:{' '}
                <span className="font-mono text-xs">{requisitionSuccess.id}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                Dispatch has been notified and will schedule delivery.
              </p>
              <a
                href={dispatchHandoffHref}
                className="inline-flex items-center gap-1 text-xs underline hover:no-underline"
                data-testid="dispatch-handoff-link"
              >
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                View requisition detail
              </a>
            </AlertDescription>
          </Alert>
        )}

        {/* Search bar */}
        {!selectedAsset && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
            <Input
              type="search"
              placeholder="Search equipment by name, make, or ID"
              className="pl-9"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              data-testid="catalog-search-input"
            />
          </div>
        )}

        {/* Category filter */}
        {!selectedAsset && categories.length > 1 && (
          <div className="flex flex-wrap gap-2" data-testid="category-filters">
            <button
              onClick={() => setSelectedCategory('')}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                !selectedCategory
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-input text-foreground hover:bg-muted'
              }`}
              data-testid="category-all"
            >
              All Equipment
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  selectedCategory === cat.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-input text-foreground hover:bg-muted'
                }`}
                data-testid={`category-${cat.id}`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <p className="text-sm text-muted-foreground" data-testid="loading-indicator">
            Loading catalog…
          </p>
        )}

        {/* Load error */}
        {!isLoading && loadError && (
          <Alert variant="destructive" data-testid="load-error">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Unable to load catalog</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {/* Empty state */}
        {!isLoading && !loadError && filteredAssets.length === 0 && (
          <div className="text-center py-10 space-y-2" data-testid="empty-state">
            <Package className="h-10 w-10 mx-auto text-muted-foreground/50" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {assets.length === 0
                ? 'No equipment is currently available for requisition.'
                : 'No equipment matches your search or filter.'}
            </p>
            {(searchText || selectedCategory) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchText('');
                  setSelectedCategory('');
                }}
                data-testid="clear-filters-button"
              >
                Clear filters
              </Button>
            )}
          </div>
        )}

        {/* Asset grid */}
        {!isLoading && !loadError && filteredAssets.length > 0 && !selectedAsset && (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-3"
            data-testid="asset-grid"
          >
            {filteredAssets.map((asset) => (
              <AssetCard key={asset.assetId} asset={asset} onSelect={handleSelectAsset} />
            ))}
          </div>
        )}

        {/* Availability count badge */}
        {!isLoading && !loadError && assets.length > 0 && !selectedAsset && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
            <Badge variant="secondary">
              {filteredAssets.length} of {assets.length} available
            </Badge>
          </div>
        )}
      </main>
    </div>
  );
}
