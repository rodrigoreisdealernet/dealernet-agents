/**
 * Self-Service Dashboard Builder
 *
 * Lets a business user assemble and save a custom KPI dashboard from the
 * governed reporting metric catalog.  All data queries run against the
 * semantic-layer views defined in the catalog — never raw operational tables
 * (ADR-0044).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';
import {
  METRIC_CATALOG,
  SUBJECT_LABELS,
  SOURCE_VIEW_LABELS,
  MAX_TILES,
  getMetric,
  isApprovedMetric,
  loadSavedDashboards,
  metricsBySubject,
  saveDashboard,
  deleteDashboard,
  type CatalogMetric,
  type MetricSubject,
  type SavedDashboard,
} from '@/lib/reporting/metric-catalog';

export const Route = createFileRoute('/analytics/dashboards')({
  component: DashboardBuilderPage,
});

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatValue(value: unknown, format: CatalogMetric['format']): string {
  if (value === null || value === undefined) return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  switch (format) {
    case 'percent':
      return `${num.toFixed(1)}%`;
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(num);
    case 'count':
      return num.toLocaleString();
    default:
      return num.toLocaleString();
  }
}

// ── KPI tile using a single-row semantic-layer source ────────────────────────

interface SingleKpiTileProps {
  metric: CatalogMetric;
  onRemove?: () => void;
}

function SingleKpiTile({ metric, onRemove }: SingleKpiTileProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard_kpi', metric.source, metric.valueColumn],
    queryFn: async () => {
      const { data: rows, error: qErr } = await supabase
        .from(metric.source)
        .select(metric.valueColumn)
        .limit(1)
        .single();
      if (qErr) throw qErr;
      return rows;
    },
    retry: false,
  });

  const displayValue = isLoading
    ? '…'
    : error
      ? 'Error'
      : formatValue(
          data ? (data as unknown as Record<string, unknown>)[metric.valueColumn] : null,
          metric.format
        );

  return (
    <Card className="relative">
      {onRemove && (
        <button
          aria-label={`Remove ${metric.label}`}
          onClick={onRemove}
          className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
        >
          ✕
        </button>
      )}
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {metric.label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{displayValue}</p>
        <p className="mt-1 text-xs text-muted-foreground">{metric.description}</p>
        {metric.drillDownTo && (
          <Link
            to={metric.drillDownTo}
            className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
          >
            View details →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

// ── Multi-row KPI tile (aggregated first row for dimension metrics) ────────────

interface MultiRowKpiTileProps {
  metric: CatalogMetric;
  onRemove?: () => void;
}

function MultiRowKpiTile({ metric, onRemove }: MultiRowKpiTileProps) {
  const selectCols = metric.dimensionColumn
    ? `${metric.dimensionColumn},${metric.valueColumn}`
    : metric.valueColumn;

  const { data: rows, isLoading, error } = useQuery({
    queryKey: ['dashboard_kpi_multi', metric.source, selectCols],
    queryFn: async () => {
      const { data: r, error: qErr } = await supabase
        .from(metric.source)
        .select(selectCols)
        .order(metric.valueColumn, { ascending: false })
        .limit(5);
      if (qErr) throw qErr;
      return (r ?? []) as unknown as Record<string, unknown>[];
    },
    retry: false,
  });

  const topRow = rows?.[0];
  const displayValue = isLoading
    ? '…'
    : error
      ? 'Error'
      : topRow
        ? formatValue(topRow[metric.valueColumn], metric.format)
        : '—';

  const dimensionLabel =
    !isLoading && topRow && metric.dimensionColumn
      ? String(topRow[metric.dimensionColumn] ?? '')
      : '';

  return (
    <Card className="relative">
      {onRemove && (
        <button
          aria-label={`Remove ${metric.label}`}
          onClick={onRemove}
          className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
        >
          ✕
        </button>
      )}
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {metric.label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tabular-nums">{displayValue}</p>
        {dimensionLabel && (
          <p className="mt-1 text-xs text-muted-foreground">{dimensionLabel}</p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{metric.description}</p>
        {metric.drillDownTo && (
          <Link
            to={metric.drillDownTo}
            className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
          >
            View details →
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

// ── Unsupported metric tile ───────────────────────────────────────────────────

function UnsupportedMetricTile({ metricKey, onRemove }: { metricKey: string; onRemove?: () => void }) {
  return (
    <Card className="relative border-destructive">
      {onRemove && (
        <button
          aria-label={`Remove unsupported metric ${metricKey}`}
          onClick={onRemove}
          className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
        >
          ✕
        </button>
      )}
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-destructive uppercase tracking-wide">
          Unsupported Metric
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Alert variant="destructive">
          <AlertTitle>Metric not in catalog</AlertTitle>
          <AlertDescription>
            <code>{metricKey}</code> is not an approved metric.  Remove this tile
            to keep the dashboard within the governed reporting contract.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

// ── Dashboard canvas ──────────────────────────────────────────────────────────

interface DashboardCanvasProps {
  metricKeys: string[];
  onRemove: (key: string) => void;
}

function DashboardCanvas({ metricKeys, onRemove }: DashboardCanvasProps) {
  if (metricKeys.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/30 p-8 text-center">
        <div>
          <p className="text-sm font-medium text-muted-foreground">No KPIs selected</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add metrics from the catalog on the left to build your dashboard.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {metricKeys.map((key) => {
        if (!isApprovedMetric(key)) {
          return (
            <UnsupportedMetricTile
              key={key}
              metricKey={key}
              onRemove={() => onRemove(key)}
            />
          );
        }
        const metric = getMetric(key)!;
        if (metric.dimensionColumn) {
          return (
            <MultiRowKpiTile
              key={key}
              metric={metric}
              onRemove={() => onRemove(key)}
            />
          );
        }
        return (
          <SingleKpiTile
            key={key}
            metric={metric}
            onRemove={() => onRemove(key)}
          />
        );
      })}
    </div>
  );
}

// ── Catalog sidebar ───────────────────────────────────────────────────────────

interface CatalogSidebarProps {
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  atLimit: boolean;
}

function CatalogSidebar({ selectedKeys, onToggle, atLimit }: CatalogSidebarProps) {
  const grouped = useMemo(() => metricsBySubject(), []);
  const subjects = Object.keys(SUBJECT_LABELS) as MetricSubject[];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm font-semibold">Metric Catalog</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Select up to {MAX_TILES} approved KPIs to add to your dashboard.
        </p>
      </div>
      {subjects.map((subject) => {
        const metrics = grouped[subject];
        if (!metrics.length) return null;
        return (
          <div key={subject}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {SUBJECT_LABELS[subject]}
            </p>
            <div className="flex flex-col gap-1">
              {metrics.map((m) => {
                const selected = selectedKeys.has(m.key);
                const disabled = !selected && atLimit;
                return (
                  <button
                    key={m.key}
                    onClick={() => !disabled && onToggle(m.key)}
                    disabled={disabled}
                    aria-pressed={selected}
                    className={[
                      'flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
                      selected
                        ? 'bg-primary text-primary-foreground'
                        : disabled
                          ? 'cursor-not-allowed opacity-40'
                          : 'hover:bg-accent hover:text-accent-foreground',
                    ].join(' ')}
                  >
                    <span>{m.label}</span>
                    {selected ? (
                      <Badge variant="secondary" className="ml-2 shrink-0 text-xs">
                        Added
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Saved dashboards list ─────────────────────────────────────────────────────

interface SavedDashboardsListProps {
  dashboards: SavedDashboard[];
  activeDashboardId: string | null;
  onLoad: (d: SavedDashboard) => void;
  onDelete: (id: string) => void;
}

function SavedDashboardsList({
  dashboards,
  activeDashboardId,
  onLoad,
  onDelete,
}: SavedDashboardsListProps) {
  if (dashboards.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No saved dashboards yet.  Assemble a dashboard above and click Save.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {dashboards.map((d) => {
        const unsupportedCount = d.metricKeys.filter((k) => !isApprovedMetric(k)).length;
        return (
          <div
            key={d.id}
            className="flex items-center justify-between rounded-md border border-border p-3"
          >
            <div>
              <p className="text-sm font-medium">{d.name}</p>
              <p className="text-xs text-muted-foreground">
                {d.metricKeys.length} metric{d.metricKeys.length !== 1 ? 's' : ''}
                {unsupportedCount > 0 && (
                  <span className="ml-2 text-destructive">
                    • {unsupportedCount} unsupported
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={activeDashboardId === d.id ? 'default' : 'outline'}
                onClick={() => onLoad(d)}
              >
                {activeDashboardId === d.id ? 'Loaded' : 'Load'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onDelete(d.id)}
              >
                Delete
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function DashboardBuilderScreen() {
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [dashboardName, setDashboardName] = useState('');
  const [savedDashboards, setSavedDashboards] = useState<SavedDashboard[]>([]);
  const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Load saved dashboards on mount
  useEffect(() => {
    setSavedDashboards(loadSavedDashboards());
  }, []);

  const savedDashboardsIndex = useMemo(
    () => new Map(savedDashboards.map((d) => [d.id, d])),
    [savedDashboards]
  );
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const atLimit = selectedKeys.length >= MAX_TILES;

  const handleToggle = useCallback(
    (key: string) => {
      setSelectedKeys((prev) =>
        prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      );
      setSaveSuccess(false);
    },
    []
  );

  const handleRemove = useCallback((key: string) => {
    setSelectedKeys((prev) => prev.filter((k) => k !== key));
    setSaveSuccess(false);
  }, []);

  const handleSave = useCallback(() => {
    setSaveError(null);
    setSaveSuccess(false);

    const trimmed = dashboardName.trim();
    if (!trimmed) {
      setSaveError('Please enter a name for your dashboard before saving.');
      return;
    }
    if (selectedKeys.length === 0) {
      setSaveError('Add at least one metric before saving.');
      return;
    }

    // Reject unsupported keys — prevent bypassing the reporting contract
    const unsupported = selectedKeys.filter((k) => !isApprovedMetric(k));
    if (unsupported.length > 0) {
      setSaveError(
        `Cannot save: the following metric keys are not in the approved catalog — ${unsupported.join(', ')}.`
      );
      return;
    }

    const now = new Date().toISOString();
    const id = activeDashboardId ?? `dashboard-${Date.now()}`;
    const dashboard: SavedDashboard = {
      id,
      name: trimmed,
      metricKeys: [...selectedKeys],
      createdAt: activeDashboardId
        ? savedDashboardsIndex.get(activeDashboardId)?.createdAt ?? now
        : now,
      updatedAt: now,
    };

    saveDashboard(dashboard);
    const updated = loadSavedDashboards();
    setSavedDashboards(updated);
    setActiveDashboardId(id);
    setSaveSuccess(true);
  }, [dashboardName, selectedKeys, activeDashboardId, savedDashboardsIndex]);

  const handleLoad = useCallback((d: SavedDashboard) => {
    setSelectedKeys(d.metricKeys);
    setDashboardName(d.name);
    setActiveDashboardId(d.id);
    setSaveError(null);
    setSaveSuccess(false);
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      deleteDashboard(id);
      const updated = loadSavedDashboards();
      setSavedDashboards(updated);
      if (activeDashboardId === id) {
        setActiveDashboardId(null);
        setSelectedKeys([]);
        setDashboardName('');
      }
    },
    [activeDashboardId]
  );

  const handleNew = useCallback(() => {
    setSelectedKeys([]);
    setDashboardName('');
    setActiveDashboardId(null);
    setSaveError(null);
    setSaveSuccess(false);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard Builder</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Assemble a custom KPI view from approved metrics.  All data comes
            from the governed reporting layer — unsupported configurations are
            rejected before any query runs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleNew}>
          + New Dashboard
        </Button>
      </div>

      {/* Builder layout: catalog sidebar + canvas */}
      <div className="grid gap-6 md:grid-cols-[260px_1fr]">
        {/* Catalog sidebar */}
        <aside
          className="rounded-lg border border-border bg-card p-4"
          tabIndex={0}
          aria-label="Metric Catalog"
        >
          <CatalogSidebar
            selectedKeys={selectedSet}
            onToggle={handleToggle}
            atLimit={atLimit}
          />
          {atLimit && (
            <p className="mt-3 text-xs text-muted-foreground">
              Maximum of {MAX_TILES} KPIs reached.  Remove a tile to add another.
            </p>
          )}
        </aside>

        {/* Canvas */}
        <div className="flex flex-col gap-4">
          <DashboardCanvas metricKeys={selectedKeys} onRemove={handleRemove} />

          {/* Save bar */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
            <div className="flex-1 min-w-0 w-full sm:min-w-[140px]">
              <Label htmlFor="dashboard-name" className="text-xs">
                Dashboard name
              </Label>
              <Input
                id="dashboard-name"
                value={dashboardName}
                onChange={(e) => {
                  setDashboardName(e.target.value);
                  setSaveError(null);
                  setSaveSuccess(false);
                }}
                placeholder="e.g. Fleet Weekly Review"
                className="mt-1"
              />
            </div>
            <Button onClick={handleSave}>
              {activeDashboardId ? 'Update Dashboard' : 'Save Dashboard'}
            </Button>
          </div>

          {saveError && (
            <Alert variant="destructive">
              <AlertTitle>Cannot save dashboard</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
          {saveSuccess && (
            <Alert>
              <AlertTitle>Dashboard saved</AlertTitle>
              <AlertDescription>
                &ldquo;{dashboardName}&rdquo; has been saved and is available below.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      {/* Saved dashboards */}
      <section>
        <h2 className="mb-3 text-base font-semibold">Saved Dashboards</h2>
        <SavedDashboardsList
          dashboards={savedDashboards}
          activeDashboardId={activeDashboardId}
          onLoad={handleLoad}
          onDelete={handleDelete}
        />
      </section>

      {/* Catalog reference */}
      <section>
        <h2 className="mb-3 text-base font-semibold">Approved Metric Reference</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          The following {METRIC_CATALOG.length} metrics are approved for use in dashboards.
          All queries run against semantic-layer views — not raw operational tables.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Metric</th>
                <th className="px-4 py-2 text-left font-medium">Subject Area</th>
                <th className="px-4 py-2 text-left font-medium">Data Source</th>
                <th className="px-4 py-2 text-left font-medium">Format</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_CATALOG.map((m, i) => (
                <tr key={m.key} className={i % 2 === 0 ? '' : 'bg-muted/20'}>
                  <td className="px-4 py-2 font-medium">{m.label}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {SUBJECT_LABELS[m.subject]}
                  </td>
                  <td
                    className="px-4 py-2 text-muted-foreground"
                    title={m.source}
                  >
                    {SOURCE_VIEW_LABELS[m.source] ?? m.source}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{m.format}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DashboardBuilderPage() {
  return <DashboardBuilderScreen />;
}
