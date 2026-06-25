/**
 * Inventory Fleet Availability Calendar
 *
 * Displays per-asset availability for a requested date window with:
 *  - Branch, category, and status filter controls
 *  - Conflict badges/tooltips (on_rent, maintenance, inspection_hold, transfer)
 *  - Groups results by branch → category for easy scanning
 *
 * Data is fetched via the fleet_get_availability_calendar RPC (see
 * supabase/migrations/20260610191000_fleet_availability_calendar.sql).
 * The same overlap algorithm used here for display is exported from
 * src/lib/fleetAvailability.ts and should be reused by write-path
 * reservation/maintenance validation.
 *
 * Route: /inventory/calendar
 * Auth: requires authenticated session (RPC enforces authenticated role)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  CalendarDays,
  Filter,
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';
import {
  CONFLICT_REASON_LABELS,
  conflictReasonVariant,
  type AvailabilityCalendarRow,
  type ConflictReason,
} from '@/lib/fleetAvailability';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/inventory/calendar')({
  component: InventoryCalendarPage,
});

function InventoryCalendarPage() {
  return <InventoryCalendarScreen />;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Today's date as YYYY-MM-DD in local time. */
function todayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** N days after a YYYY-MM-DD string, using local calendar arithmetic to match HTML date inputs. */
function addDays(dateStr: string, days: number): string {
  const [y, mo, dy] = dateStr.split('-').map(Number);
  const d = new Date(y, mo - 1, dy + days);
  const yr = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilterState = {
  startDate: string;
  endDate: string;
  branchId: string;
  categoryId: string;
  status: string;
};

type GroupedAssets = Map<
  string, // branch_name
  Map<
    string, // category_name
    AvailabilityCalendarRow[]
  >
>;

type NamedOption = {
  id: string;
  label: string;
};

type NextAction = {
  href: string;
  label: string;
};

const STATUS_FILTER_LABELS: Record<string, string> = {
  available: 'Available only',
  unavailable: 'Unavailable only',
  in_maintenance: 'In Maintenance',
  on_inspection_hold: 'Inspection Hold',
  on_transfer: 'On Transfer',
};

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchCalendar(filters: FilterState): Promise<AvailabilityCalendarRow[]> {
  const params: Record<string, unknown> = {};
  if (filters.startDate) params.p_start_date = filters.startDate;
  if (filters.endDate) params.p_end_date = filters.endDate;
  if (filters.branchId) params.p_branch_id = filters.branchId;
  if (filters.categoryId) params.p_category_id = filters.categoryId;
  if (filters.status) params.p_status = filters.status;

  const { data, error } = await supabase.rpc('fleet_get_availability_calendar', params);

  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => ({
    entity_id: String(row.entity_id ?? ''),
    name: String(row.name ?? ''),
    identifier: row.identifier != null ? String(row.identifier) : null,
    branch_id: row.branch_id != null ? String(row.branch_id) : null,
    branch_name: row.branch_name != null ? String(row.branch_name) : null,
    asset_category_id: row.asset_category_id != null ? String(row.asset_category_id) : null,
    asset_category_name: row.asset_category_name != null ? String(row.asset_category_name) : null,
    operational_status: String(row.operational_status ?? 'available'),
    maintenance_due_status: String(row.maintenance_due_status ?? 'none'),
    is_available: Boolean(row.is_available),
    conflict_reason: (row.conflict_reason as ConflictReason | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupAssets(rows: AvailabilityCalendarRow[]): GroupedAssets {
  const grouped: GroupedAssets = new Map();
  for (const row of rows) {
    const branch = row.branch_name ?? 'Unknown Branch';
    const category = row.asset_category_name ?? 'Uncategorised';
    if (!grouped.has(branch)) grouped.set(branch, new Map());
    const byCategory = grouped.get(branch)!;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(row);
  }
  return grouped;
}

function mergeNamedOptions(
  current: Record<string, string>,
  rows: AvailabilityCalendarRow[],
  idKey: 'branch_id' | 'asset_category_id',
  labelKey: 'branch_name' | 'asset_category_name',
): Record<string, string> {
  const next = { ...current };
  for (const row of rows) {
    const id = row[idKey];
    const label = row[labelKey];
    if (id && label) next[id] = label;
  }
  return next;
}

function sortNamedOptions(options: Record<string, string>): NamedOption[] {
  return Object.entries(options)
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function validateFilters(filters: FilterState): string | null {
  if (!filters.startDate || !filters.endDate) {
    return 'Both start and end dates are required.';
  }
  if (filters.startDate > filters.endDate) {
    return 'Start date must be on or before end date.';
  }
  return null;
}

function buildScopedHref(
  path: string,
  filters: FilterState,
  row: AvailabilityCalendarRow,
  extraParams: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  const branchId = filters.branchId || row.branch_id;
  const categoryId = filters.categoryId || row.asset_category_id;
  if (branchId) params.set('branch_id', branchId);
  if (categoryId) params.set('category_id', categoryId);
  if (filters.startDate) params.set('start_date', filters.startDate);
  if (filters.endDate) params.set('end_date', filters.endDate);
  if (row.entity_id) params.set('asset_id', row.entity_id);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function getNextAction(row: AvailabilityCalendarRow, filters: FilterState): NextAction {
  if (row.conflict_reason === 'maintenance' || row.maintenance_due_status !== 'none') {
    return {
      href: buildScopedHref('/entities/maintenance_record', filters, row),
      label: 'Open maintenance',
    };
  }
  if (row.conflict_reason === 'transfer' || row.operational_status === 'on_transfer') {
    return {
      href: buildScopedHref('/entities/transfer', filters, row),
      label: 'Start transfer',
    };
  }
  if (row.conflict_reason === 'inspection_hold' || row.operational_status === 'on_inspection_hold') {
    return {
      href: buildScopedHref('/rental/returns', filters, row),
      label: 'Start return',
    };
  }
  if (row.conflict_reason === 'on_rent') {
    return {
      href: buildScopedHref('/rental/contracts', filters, row),
      label: 'Open contract',
    };
  }
  return {
    href: buildScopedHref('/rental/quoting', filters, row, {
      planned_start: filters.startDate,
      planned_end: filters.endDate,
    }),
    label: 'Create rental order',
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AssetAvailabilityBadge({ row }: { row: AvailabilityCalendarRow }) {
  if (row.is_available) {
    return (
      <Badge variant="outline" className="text-green-700 border-green-500 bg-green-50">
        Available
      </Badge>
    );
  }
  const reason = row.conflict_reason;
  if (!reason) {
    return <Badge variant="secondary">Unavailable</Badge>;
  }
  const label = CONFLICT_REASON_LABELS[reason] ?? reason;
  const variant = conflictReasonVariant(reason);
  return <Badge variant={variant}>{label}</Badge>;
}

function MaintenanceDueBadge({ status }: { status: string }) {
  if (status === 'overdue') {
    return (
      <Badge variant="destructive" className="text-xs">
        Maint. Overdue
      </Badge>
    );
  }
  if (status === 'due') {
    return (
      <Badge variant="secondary" className="text-xs">
        Maint. Due
      </Badge>
    );
  }
  return null;
}

function AssetRow({ row, filters }: { row: AvailabilityCalendarRow; filters: FilterState }) {
  const nextAction = getNextAction(row, filters);

  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-sm">{row.name}</span>
        {row.identifier && (
          <span className="text-xs text-muted-foreground">#{row.identifier}</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <MaintenanceDueBadge status={row.maintenance_due_status} />
        <AssetAvailabilityBadge row={row} />
        <Button asChild size="sm" variant={row.is_available ? 'default' : 'outline'}>
          <a href={nextAction.href}>{nextAction.label}</a>
        </Button>
      </div>
    </div>
  );
}

function CategorySection({
  categoryName,
  assets,
  filters,
}: {
  categoryName: string;
  assets: AvailabilityCalendarRow[];
  filters: FilterState;
}) {
  const available = assets.filter((a) => a.is_available).length;
  const total = assets.length;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {categoryName}
        </h4>
        <span className="text-xs text-muted-foreground">
          {available} / {total} available
        </span>
      </div>
      <div>
        {assets.map((row) => (
          <AssetRow key={row.entity_id} row={row} filters={filters} />
        ))}
      </div>
    </div>
  );
}

function BranchSection({
  branchName,
  categories,
  filters,
}: {
  branchName: string;
  categories: Map<string, AvailabilityCalendarRow[]>;
  filters: FilterState;
}) {
  const allAssets = Array.from(categories.values()).flat();
  const available = allAssets.filter((a) => a.is_available).length;
  const total = allAssets.length;

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{branchName}</CardTitle>
          <div className="flex items-center gap-2">
            {available === total ? (
              <span className="flex items-center gap-1 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4" />
                All available
              </span>
            ) : (
              <span className="flex items-center gap-1 text-sm text-amber-600">
                <AlertCircle className="h-4 w-4" />
                {total - available} conflict{total - available !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <CardDescription>
          {available} of {total} assets available for this window
        </CardDescription>
      </CardHeader>
      <CardContent>
        {Array.from(categories.entries()).map(([categoryName, assets]) => (
          <CategorySection
            key={categoryName}
            categoryName={categoryName}
            assets={assets}
            filters={filters}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ScopeBadge({ label }: { label: string }) {
  return <Badge variant="secondary">{label}</Badge>;
}

// ---------------------------------------------------------------------------
// Summary bar
// ---------------------------------------------------------------------------

function SummaryBar({ rows }: { rows: AvailabilityCalendarRow[] }) {
  const total = rows.length;
  const available = rows.filter((r) => r.is_available).length;
  const byReason = new Map<string, number>();
  for (const row of rows) {
    if (!row.is_available && row.conflict_reason) {
      byReason.set(row.conflict_reason, (byReason.get(row.conflict_reason) ?? 0) + 1);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-muted/40 rounded-lg border text-sm">
      <span className="font-medium">
        {total} asset{total !== 1 ? 's' : ''}
      </span>
      <Badge variant="outline" className="text-green-700 border-green-500 bg-green-50">
        {available} available
      </Badge>
      {Array.from(byReason.entries()).map(([reason, count]) => (
        <Badge key={reason} variant={conflictReasonVariant(reason as ConflictReason)}>
          {count} {CONFLICT_REASON_LABELS[reason as ConflictReason] ?? reason}
        </Badge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function InventoryCalendarScreen() {
  const today = useMemo(() => todayLocalDate(), []);
  const defaultEnd = useMemo(() => addDays(today, 7), [today]);

  const [filters, setFilters] = useState<FilterState>({
    startDate: today,
    endDate: defaultEnd,
    branchId: '',
    categoryId: '',
    status: '',
  });

  const [rows, setRows] = useState<AvailabilityCalendarRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchNames, setBranchNames] = useState<Record<string, string>>({});
  const [categoryNames, setCategoryNames] = useState<Record<string, string>>({});

  const load = useCallback(async (f: FilterState) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchCalendar(f);
      setRows(result);
      setBranchNames((prev) => mergeNamedOptions(prev, result, 'branch_id', 'branch_name'));
      setCategoryNames((prev) => mergeNamedOptions(prev, result, 'asset_category_id', 'asset_category_name'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Run once on mount with the initial filter snapshot; subsequent loads are
  // triggered explicitly via handleApply so the user controls when data refreshes.
  useEffect(() => {
    load(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only load
  }, []);

  const grouped = useMemo(() => groupAssets(rows), [rows]);
  const branchOptions = useMemo(() => sortNamedOptions(branchNames), [branchNames]);
  const categoryOptions = useMemo(() => sortNamedOptions(categoryNames), [categoryNames]);
  const selectedBranchLabel = filters.branchId
    ? branchNames[filters.branchId] ?? 'Selected branch'
    : 'All branches';
  const selectedCategoryLabel = filters.categoryId
    ? categoryNames[filters.categoryId] ?? 'Selected category'
    : 'All categories';
  const selectedStatusLabel = filters.status
    ? STATUS_FILTER_LABELS[filters.status] ?? 'Selected status'
    : 'All statuses';

  function updateFilter(key: keyof FilterState, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function clearScopeFilters() {
    const nextFilters = {
      ...filters,
      branchId: '',
      categoryId: '',
    };
    setFilters(nextFilters);

    const validationError = validateFilters(nextFilters);
    if (validationError) {
      setError(validationError);
      return;
    }

    void load(nextFilters);
  }

  function handleApply() {
    const validationError = validateFilters(filters);
    if (validationError) {
      setError(validationError);
      return;
    }
    void load(filters);
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <CalendarDays className="h-6 w-6" />
          Fleet Availability Calendar
        </h1>
        <p className="text-muted-foreground">
          View asset availability by date window with conflict detection.
          Blocked assets show their reason (on rent, maintenance, inspection hold, etc.).
        </p>
      </div>

      {/* Filter panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 items-end">
            <div className="space-y-1">
              <Label htmlFor="cal-start-date">Start date</Label>
              <Input
                id="cal-start-date"
                type="date"
                value={filters.startDate}
                onChange={(e) => updateFilter('startDate', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cal-end-date">End date</Label>
              <Input
                id="cal-end-date"
                type="date"
                value={filters.endDate}
                onChange={(e) => updateFilter('endDate', e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cal-branch">Branch</Label>
              <select
                id="cal-branch"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={filters.branchId}
                onChange={(e) => updateFilter('branchId', e.target.value)}
              >
                <option value="">All branches</option>
                {branchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cal-category">Category</Label>
              <select
                id="cal-category"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={filters.categoryId}
                onChange={(e) => updateFilter('categoryId', e.target.value)}
              >
                <option value="">All categories</option>
                {categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cal-status">Status</Label>
              <select
                id="cal-status"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={filters.status}
                onChange={(e) => updateFilter('status', e.target.value)}
              >
                <option value="">All</option>
                <option value="available">Available only</option>
                <option value="unavailable">Unavailable only</option>
                <option value="in_maintenance">In Maintenance</option>
                <option value="on_inspection_hold">Inspection Hold</option>
                <option value="on_transfer">On Transfer</option>
              </select>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={handleApply} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading…
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Apply
                </>
              )}
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Current scope</span>
            <ScopeBadge label={`Branch: ${selectedBranchLabel}`} />
            <ScopeBadge label={`Category: ${selectedCategoryLabel}`} />
            <ScopeBadge label={`Status: ${selectedStatusLabel}`} />
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Unable to load availability</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{error}</p>
            <p>
              Retry this scope, or clear the branch/category filters if you need a broader view before handing the
              asset off to maintenance, transfer, or rental.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleApply}>
                Retry
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={clearScopeFilters}>
                Clear scope filters
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Results */}
      {!isLoading && !error && rows.length > 0 && (
        <>
          <SummaryBar rows={rows} />
          {Array.from(grouped.entries()).map(([branchName, categories]) => (
            <BranchSection
              key={branchName}
              branchName={branchName}
              categories={categories}
              filters={filters}
            />
          ))}
        </>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground space-y-4">
            <div className="space-y-1">
              <p className="font-medium text-foreground">No assets found for the selected filters.</p>
              <p>
                Try widening the date window, clearing one of the scope filters, or start from the broader asset lists
                before creating an order, transfer, or maintenance handoff.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={clearScopeFilters}>
                Clear scope filters
              </Button>
              <Button asChild type="button" size="sm" variant="secondary">
                <a href="/entities/asset">View assets</a>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading availability…</span>
        </div>
      )}
    </div>
  );
}
