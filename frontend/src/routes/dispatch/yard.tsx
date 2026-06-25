import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';
import { cn } from '@/lib/utils';

type DisplayMode = 'office' | 'tv' | 'tablet' | 'mobile';
type TimeWindow = 'all' | '24h' | '3d' | '7d';
type YardLaneKey = 'going_out' | 'coming_in' | 'needs_review' | 'maintenance';
type YardInlineActionKey = 'mark_available' | 'open_maintenance' | 'complete_maintenance';

type LiveYardActivityRow = {
  activity_id: string;
  lane_key: YardLaneKey;
  lane_sort_order: number;
  source_entity_type: string;
  source_entity_id: string;
  activity_status: string;
  branch_id: string | null;
  branch_name: string | null;
  location_id: string | null;
  location_name: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  due_at: string | null;
  sort_at: string | null;
  is_overdue: boolean;
  is_needs_review: boolean;
  needs_review_reason: string | null;
  order_id: string | null;
  order_line_id: string | null;
  order_number: string | null;
  contract_id: string | null;
  contract_line_id: string | null;
  contract_number: string | null;
  maintenance_record_id: string | null;
  maintenance_status: string | null;
  asset_id: string | null;
  asset_name: string | null;
  asset_category_id: string | null;
  asset_category_name: string | null;
  job_site_id: string | null;
  job_site_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  quantity: number | null;
  status_detail: string | null;
};

type YardBoardItem = {
  id: string;
  lane: YardLaneKey;
  title: string;
  subtitle: string;
  status: string;
  statusDetail: string | null;
  branchId: string | null;
  branchName: string;
  scheduledAt: string | null;
  sortAt: string | null;
  overdue: boolean;
  needsReview: boolean;
  href: string | null;
  sourceEntityType: string;
  sourceEntityId: string;
  actions: YardInlineActionKey[];
};

type YardBoardLane = {
  key: YardLaneKey;
  title: string;
  description: string;
  emptyMessage: string;
  items: YardBoardItem[];
};

const AUTO_REFRESH_MS = 15_000;

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  office: 'Office',
  tv: 'TV',
  tablet: 'Tablet',
  mobile: 'Mobile',
};

const TIME_WINDOW_LABELS: Record<TimeWindow, string> = {
  all: 'All active',
  '24h': 'Next 24 hours',
  '3d': 'Next 3 days',
  '7d': 'Next 7 days',
};

const LANE_CONFIG: Array<Pick<YardBoardLane, 'key' | 'title' | 'description' | 'emptyMessage'>> = [
  {
    key: 'going_out',
    title: 'Going Out',
    description: 'Upcoming pending order lines awaiting yard prep and checkout.',
    emptyMessage: 'No outbound yard work in the selected window.',
  },
  {
    key: 'coming_in',
    title: 'Coming In',
    description: 'Checked-out lines expected back into the yard.',
    emptyMessage: 'No inbound returns match the current filters.',
  },
  {
    key: 'needs_review',
    title: 'Needs Review',
    description: 'Assets already held for inspection or return review.',
    emptyMessage: 'No assets currently need review.',
  },
  {
    key: 'maintenance',
    title: 'Maintenance',
    description: 'Assets blocked for maintenance follow-up.',
    emptyMessage: 'No assets currently in maintenance.',
  },
];

const INLINE_ACTION_LABELS: Record<YardInlineActionKey, string> = {
  mark_available: 'Release to Available',
  open_maintenance: 'Send to Maintenance',
  complete_maintenance: 'Complete Maintenance',
};

const INLINE_ACTION_SUCCESS_MESSAGES: Record<YardInlineActionKey, string> = {
  mark_available: 'Inspection review resolved and the asset returned to available inventory.',
  open_maintenance: 'Maintenance work order opened from the Live Yard review lane.',
  complete_maintenance: 'Maintenance completed and the asset returned to available inventory.',
};

const LIVE_YARD_SELECT = [
  'activity_id',
  'lane_key',
  'lane_sort_order',
  'source_entity_type',
  'source_entity_id',
  'activity_status',
  'branch_id',
  'branch_name',
  'location_id',
  'location_name',
  'scheduled_start_at',
  'scheduled_end_at',
  'due_at',
  'sort_at',
  'is_overdue',
  'is_needs_review',
  'needs_review_reason',
  'order_id',
  'order_line_id',
  'order_number',
  'contract_id',
  'contract_line_id',
  'contract_number',
  'maintenance_record_id',
  'maintenance_status',
  'asset_id',
  'asset_name',
  'asset_category_id',
  'asset_category_name',
  'job_site_id',
  'job_site_name',
  'customer_id',
  'customer_name',
  'quantity',
  'status_detail',
].join(', ');

export const Route = createFileRoute('/dispatch/yard')({
  component: LiveYardViewPage,
});

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59Z` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isWithinTimeWindow(value: string | null, window: TimeWindow, now: Date): boolean {
  if (window === 'all' || !value) return true;
  const parsed = parseDateOrNull(value);
  if (!parsed) return true;
  const diffMs = parsed.getTime() - now.getTime();
  if (diffMs < 0) return false;
  const limits: Record<Exclude<TimeWindow, 'all'>, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  return diffMs <= limits[window];
}

function formatScheduledTime(value: string | null): string {
  if (!value) return 'No scheduled time';
  const parsed = parseDateOrNull(value);
  return parsed ? parsed.toLocaleString() : value;
}

function compareNullableDates(left: string | null, right: string | null): number {
  const leftTime = parseDateOrNull(left)?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = parseDateOrNull(right)?.getTime() ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

async function fetchRows<T>(promise: PromiseLike<{ data: T[] | null; error: { message?: string } | null }>): Promise<T[]> {
  const { data, error } = await promise;
  if (error) {
    throw new Error(error.message || 'Unable to load live yard data.');
  }
  return data ?? [];
}

function rowScheduledAt(row: LiveYardActivityRow): string | null {
  return row.scheduled_start_at || row.due_at || row.sort_at || row.scheduled_end_at || null;
}

function rowHref(row: LiveYardActivityRow): string | null {
  if (row.maintenance_record_id) return `/entities/maintenance_record/${row.maintenance_record_id}`;
  if (row.contract_id) return `/rental/contracts/${row.contract_id}`;
  if (row.order_id) return `/rental/orders/${row.order_id}`;
  if (row.asset_id) return `/entities/asset/${row.asset_id}`;
  return null;
}

function rowActions(row: LiveYardActivityRow): YardInlineActionKey[] {
  if (row.lane_key === 'needs_review' && row.source_entity_type === 'asset') {
    return ['mark_available', 'open_maintenance'];
  }
  if (row.lane_key === 'maintenance' && row.source_entity_type === 'maintenance_record') {
    return ['complete_maintenance'];
  }
  return [];
}

function rowTitle(row: LiveYardActivityRow): string {
  if (row.lane_key === 'going_out' && row.source_entity_type === 'rental_order_line') {
    return `${row.order_number || row.source_entity_id} · ${row.asset_category_name || 'Uncategorised'}`;
  }
  if (row.lane_key === 'going_out') {
    return `${row.asset_name || row.asset_category_name || 'Unassigned asset'} · ${row.contract_number || row.contract_id || 'Contract'}`;
  }
  if (row.lane_key === 'coming_in') {
    return `${row.asset_name || row.asset_category_name || 'Unassigned asset'} · ${row.contract_number || row.contract_id || 'Contract'}`;
  }
  return row.asset_name || row.maintenance_record_id || row.source_entity_id;
}

function rowSubtitle(row: LiveYardActivityRow): string {
  if (row.lane_key === 'going_out' || row.lane_key === 'coming_in') {
    const customer = row.customer_name || 'Unknown customer';
    const jobSite = row.job_site_name || 'No job site';
    return `${customer} • ${jobSite}`;
  }
  return row.asset_category_name || row.status_detail || (row.lane_key === 'maintenance' ? 'Maintenance queue' : 'Inspection hold');
}

function rowBranchName(row: LiveYardActivityRow): string {
  return row.branch_name || row.location_name || row.branch_id || row.location_id || 'Unassigned location';
}

function sortRows(rows: LiveYardActivityRow[]): LiveYardActivityRow[] {
  return [...rows].sort((left, right) => (
    left.lane_sort_order - right.lane_sort_order
    || compareNullableDates(left.sort_at, right.sort_at)
    || left.activity_id.localeCompare(right.activity_id)
  ));
}

async function loadBoardData(): Promise<LiveYardActivityRow[]> {
  const rows = await fetchRows<LiveYardActivityRow>(
    supabase
      .from('v_live_yard_activity_current')
      .select(LIVE_YARD_SELECT)
  );

  return sortRows(rows);
}

function buildBoardLanes(rows: LiveYardActivityRow[], locationFilter: string, timeWindow: TimeWindow, now: Date): YardBoardLane[] {
  const filteredItems = rows
    .map<YardBoardItem>((row) => ({
      id: row.activity_id,
      lane: row.lane_key,
      title: rowTitle(row),
      subtitle: rowSubtitle(row),
      status: row.activity_status,
      statusDetail: row.status_detail,
      branchId: row.branch_id || row.location_id,
      branchName: rowBranchName(row),
      scheduledAt: rowScheduledAt(row),
      sortAt: row.sort_at,
      overdue: Boolean(row.is_overdue),
      needsReview: Boolean(row.is_needs_review),
      href: rowHref(row),
      sourceEntityType: row.source_entity_type,
      sourceEntityId: row.source_entity_id,
      actions: rowActions(row),
    }))
    .filter((item) => {
      if (locationFilter && item.branchId !== locationFilter) return false;
      return isWithinTimeWindow(item.scheduledAt, timeWindow, now);
    })
    .sort((left, right) => compareNullableDates(left.sortAt, right.sortAt) || left.id.localeCompare(right.id));

  return LANE_CONFIG.map((lane) => ({
    ...lane,
    items: filteredItems.filter((item) => item.lane === lane.key),
  }));
}

function LiveYardViewPage() {
  return <LiveYardViewScreen />;
}

export function LiveYardViewScreen() {
  const [rows, setRows] = useState<LiveYardActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>('office');
  const [locationFilter, setLocationFilter] = useState('');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);

  const refreshBoard = useCallback(async () => {
    try {
      setLoadError(null);
      const nextRows = await loadBoardData();
      setRows(nextRows);
      setRefreshedAt(new Date());
    } catch (refreshError) {
      setLoadError(refreshError instanceof Error ? refreshError.message : 'Unable to load live yard view.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshBoard();
    const timerId = window.setInterval(() => {
      void refreshBoard();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timerId);
  }, [refreshBoard]);

  const locationOptions = useMemo(() => (
    Array.from(
      rows.reduce((seen, row) => {
        const value = row.branch_id || row.location_id;
        const label = rowBranchName(row);
        if (value && !seen.has(value)) {
          seen.set(value, { value, label });
        }
        return seen;
      }, new Map<string, { value: string; label: string }>())
    ).map(([, branch]) => branch)
  ), [rows]);

  const lanes = useMemo(
    () => buildBoardLanes(rows, locationFilter, timeWindow, new Date()),
    [locationFilter, rows, timeWindow]
  );

  const handleInlineAction = useCallback(async (item: YardBoardItem, action: YardInlineActionKey) => {
    const actionToken = `${item.id}:${action}`;
    try {
      setPendingActionKey(actionToken);
      setActionError(null);
      setActionFeedback(null);
      const { error } = await supabase.rpc('rental_apply_live_yard_action', {
        p_source_entity_type: item.sourceEntityType,
        p_source_entity_id: item.sourceEntityId,
        p_action: action,
        p_expected_lane_key: item.lane,
        p_expected_activity_status: item.status,
      });

      if (error) {
        throw new Error(error.message);
      }

      await refreshBoard();
      setActionFeedback(INLINE_ACTION_SUCCESS_MESSAGES[action]);
    } catch (inlineActionError) {
      setActionError(
        inlineActionError instanceof Error
          ? inlineActionError.message
          : 'Unable to apply the requested Live Yard action.'
      );
    } finally {
      setPendingActionKey(null);
    }
  }, [refreshBoard]);

  const boardGridClassName = useMemo(() => {
    switch (displayMode) {
      case 'tv':
        return 'grid gap-6 xl:grid-cols-2 2xl:grid-cols-4';
      case 'tablet':
        return 'grid gap-4 md:grid-cols-2';
      case 'mobile':
        return 'grid gap-4';
      default:
        return 'grid gap-4 xl:grid-cols-2 2xl:grid-cols-4';
    }
  }, [displayMode]);

  const headingClassName = displayMode === 'tv' ? 'text-4xl' : 'text-3xl';
  const laneCountClassName = displayMode === 'tv' ? 'text-4xl' : 'text-3xl';
  const itemPaddingClassName = displayMode === 'tv' ? 'p-4' : 'p-3';

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className={cn('font-semibold tracking-tight', headingClassName)}>Live Yard View</h1>
          <p className="text-sm text-muted-foreground">Loading yard board…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="live-yard-view-screen">
      <div className="space-y-2">
        <h1 className={cn('font-semibold tracking-tight', headingClassName)}>Live Yard View</h1>
        <p className="text-sm text-muted-foreground">
          Shared live board for outbound prep, inbound returns, review holds, and maintenance blockers.
        </p>
        <p className="text-sm text-muted-foreground">
          Auto-updates every 15 seconds{refreshedAt ? ` • Last refresh ${refreshedAt.toLocaleTimeString()}` : ''}.
        </p>
        {actionFeedback ? (
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {actionFeedback}
          </p>
        ) : null}
      </div>

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>Unable to load Live Yard View</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertTitle>Live Yard action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Board Controls</CardTitle>
          <CardDescription>Switch display modes and adjust board scope without stopping live refresh.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-2">
            <Label htmlFor="yard-location-filter">Location</Label>
            <select
              id="yard-location-filter"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
            >
              <option value="">All locations</option>
              {locationOptions.map((branch) => (
                <option key={branch.value} value={branch.value}>{branch.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="yard-time-window-filter">Time window</Label>
            <select
              id="yard-time-window-filter"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={timeWindow}
              onChange={(event) => setTimeWindow(event.target.value as TimeWindow)}
            >
              {Object.entries(TIME_WINDOW_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label>Display mode</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Display mode">
              {Object.entries(DISPLAY_MODE_LABELS).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={displayMode === value ? 'default' : 'outline'}
                  aria-pressed={displayMode === value}
                  onClick={() => setDisplayMode(value as DisplayMode)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className={boardGridClassName}>
        {lanes.map((lane) => (
          <Card
            key={lane.key}
            data-testid={`yard-lane-${lane.key}`}
            className={cn(displayMode === 'tv' ? 'min-h-[32rem]' : 'min-h-[24rem]')}
          >
            <CardHeader className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle>{lane.title}</CardTitle>
                  <CardDescription>{lane.description}</CardDescription>
                </div>
                <div className="text-right">
                  <div
                    className={cn('font-semibold leading-none', laneCountClassName)}
                    data-testid={`yard-lane-count-${lane.key}`}
                  >
                    {lane.items.length}
                  </div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">items</div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {lane.items.length > 0 ? lane.items.map((item) => {
                const isPending = item.actions.some((action) => pendingActionKey === `${item.id}:${action}`);
                return (
                  <div
                    key={item.id}
                    data-testid="yard-item-card"
                    className={cn('space-y-3 rounded-lg border bg-muted/20', itemPaddingClassName)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className={cn('font-medium', displayMode === 'tv' ? 'text-lg' : 'text-base')}>{item.title}</p>
                        <p className="text-sm text-muted-foreground">{item.subtitle}</p>
                        {item.statusDetail ? (
                          <p className="text-xs text-muted-foreground">{item.statusDetail}</p>
                        ) : null}
                      </div>
                      <Badge variant="outline">{item.status}</Badge>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{item.branchName}</Badge>
                      {item.needsReview ? <Badge>Review</Badge> : null}
                      {item.overdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    </div>

                    {item.actions.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {item.actions.map((action) => (
                          <Button
                            key={action}
                            type="button"
                            size="sm"
                            variant={action === 'complete_maintenance' ? 'default' : 'outline'}
                            disabled={isPending}
                            onClick={() => void handleInlineAction(item, action)}
                          >
                            {pendingActionKey === `${item.id}:${action}` ? 'Updating…' : INLINE_ACTION_LABELS[action]}
                          </Button>
                        ))}
                      </div>
                    ) : null}

                    <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                      <span>{formatScheduledTime(item.scheduledAt)}</span>
                      {item.href ? (
                        <a className="font-medium text-foreground underline-offset-4 hover:underline" href={item.href}>
                          Open
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              }) : (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {lane.emptyMessage}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
