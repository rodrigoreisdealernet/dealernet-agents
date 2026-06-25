/**
 * Reporting Metric Catalog — governed query contract
 *
 * Every metric a business user may add to a self-service dashboard is listed
 * here.  The catalog is the trust boundary: the dashboard builder only ever
 * queries the semantic-layer views named in this file, never raw operational
 * tables.  Requests for a metric key that does not appear in this catalog are
 * rejected with a clear error message (ADR-0044).
 */

export type MetricSubject =
  | 'fleet_performance'
  | 'financial_health'
  | 'order_fulfillment'
  | 'customer_performance';

export type MetricFormat = 'number' | 'percent' | 'currency' | 'count';

/**
 * A single approved KPI metric in the governed catalog.
 */
export interface CatalogMetric {
  /** Unique stable key — used in saved dashboard configurations. */
  key: string;
  /** Human-readable label shown in the builder and on tiles. */
  label: string;
  /** Brief description of what the metric measures. */
  description: string;
  /** Subject area for grouping in the catalog sidebar. */
  subject: MetricSubject;
  /**
   * Semantic-layer view to query.
   * This must be one of the approved reporting views — not a raw operational
   * table.  The dashboard builder enforces this at render time.
   */
  source: string;
  /** Column in that view that carries the primary numeric value. */
  valueColumn: string;
  /** Optional dimension column used as the row label (e.g. branch_name). */
  dimensionColumn?: string;
  /** How to format the value for display. */
  format: MetricFormat;
  /**
   * Route to navigate to when the user drills down from a KPI tile.
   * Must map to an existing governed analytics route.
   */
  drillDownTo?: string;
  /** Icon name from the allowed StatCard icon map. */
  icon?: string;
}

export const SUBJECT_LABELS: Record<MetricSubject, string> = {
  fleet_performance: 'Fleet Performance',
  financial_health: 'Financial Health',
  order_fulfillment: 'Order Fulfillment',
  customer_performance: 'Customer Performance',
};

/**
 * Operator-friendly display labels for the semantic-layer views used in the
 * metric catalog.  Keyed by the internal view name stored in
 * `CatalogMetric.source`.
 *
 * These labels are shown in operator-facing UI.  The raw view names are
 * internal database identifiers and must not be surfaced directly to
 * business users.
 */
export const SOURCE_VIEW_LABELS: Record<string, string> = {
  v_home_dashboard_kpis: 'Fleet & Operations Overview',
  v_branch_utilization: 'Branch Performance',
  v_asset_analytics_current: 'Asset-Level Analytics',
  v_asset_category_downtime_summary: 'Fleet Downtime Analytics',
};

/**
 * The complete catalog of metrics a business user may add to a dashboard.
 *
 * Adding a new metric here is the only approved path — PRs that query views
 * not listed in this file bypass the governed contract.
 */
export const METRIC_CATALOG: CatalogMetric[] = [
  // ── Fleet Performance ────────────────────────────────────────────────────
  {
    key: 'fleet_utilization_pct',
    label: 'Fleet Utilization',
    description: 'Percentage of assets currently on rent across all branches.',
    subject: 'fleet_performance',
    source: 'v_home_dashboard_kpis',
    valueColumn: 'fleet_utilization_pct',
    format: 'percent',
    drillDownTo: '/analytics/fleet',
    icon: 'ChartColumnIncreasing',
  },
  {
    key: 'assets_on_rent',
    label: 'Assets On Rent',
    description: 'Number of serialized assets currently out on active rental contracts.',
    subject: 'fleet_performance',
    source: 'v_home_dashboard_kpis',
    valueColumn: 'assets_on_rent',
    format: 'count',
    drillDownTo: '/analytics/fleet',
    icon: 'Truck',
  },
  {
    key: 'available_assets',
    label: 'Available Assets',
    description: 'Serialized assets that are available for immediate rental.',
    subject: 'fleet_performance',
    source: 'v_home_dashboard_kpis',
    valueColumn: 'available_assets',
    format: 'count',
    drillDownTo: '/rental/availability',
    icon: 'SearchCheck',
  },
  {
    key: 'open_maintenance_count',
    label: 'Open Maintenance',
    description: 'Assets currently held for maintenance or inspection.',
    subject: 'fleet_performance',
    source: 'v_home_dashboard_kpis',
    valueColumn: 'open_maintenance_count',
    format: 'count',
    drillDownTo: '/entities/maintenance_record',
    icon: 'Wrench',
  },
  // ── Financial Health ─────────────────────────────────────────────────────
  {
    key: 'period_revenue',
    label: 'Period Revenue',
    description: 'Total invoiced revenue recognized in the current reporting period.',
    subject: 'financial_health',
    source: 'v_home_dashboard_kpis',
    valueColumn: 'period_revenue',
    format: 'currency',
    drillDownTo: '/analytics/enterprise-financials',
    icon: 'CircleDollarSign',
  },
  {
    key: 'overdue_returns_count',
    label: 'Overdue Returns',
    description: 'Rental contracts with a scheduled return date in the past.',
    subject: 'order_fulfillment',
    source: 'v_home_dashboard_kpis',
    valueColumn: 'overdue_returns_count',
    format: 'count',
    drillDownTo: '/rental/returns',
    icon: 'AlertTriangle',
  },
  // ── Order Fulfillment ────────────────────────────────────────────────────
  {
    key: 'branch_utilization_rate',
    label: 'Branch Utilization Rate',
    description: 'Utilization rate per branch — percentage of fleet currently on rent.',
    subject: 'fleet_performance',
    source: 'v_branch_utilization',
    valueColumn: 'utilization_rate_pct',
    dimensionColumn: 'branch_name',
    format: 'percent',
    drillDownTo: '/analytics/fleet',
    icon: 'Building2',
  },
  {
    key: 'branch_on_rent_count',
    label: 'Branch On-Rent Count',
    description: 'Count of assets currently on rent at each branch.',
    subject: 'fleet_performance',
    source: 'v_branch_utilization',
    valueColumn: 'on_rent_count',
    dimensionColumn: 'branch_name',
    format: 'count',
    drillDownTo: '/analytics/fleet',
    icon: 'Building2',
  },
  // ── Customer Performance ─────────────────────────────────────────────────
  {
    key: 'asset_lifetime_revenue',
    label: 'Asset Lifetime Revenue',
    description: 'Cumulative invoice revenue per serialized asset.',
    subject: 'customer_performance',
    source: 'v_asset_analytics_current',
    valueColumn: 'lifetime_revenue',
    dimensionColumn: 'asset_name',
    format: 'currency',
    drillDownTo: '/analytics/fleet',
    icon: 'CircleDollarSign',
  },
  {
    key: 'asset_roi_pct',
    label: 'Asset ROI',
    description: 'Return on investment per serialized asset based on cost basis and lifetime revenue.',
    subject: 'fleet_performance',
    source: 'v_asset_analytics_current',
    valueColumn: 'roi_pct',
    dimensionColumn: 'asset_name',
    format: 'percent',
    drillDownTo: '/analytics/fleet',
    icon: 'ChartColumnIncreasing',
  },
  {
    key: 'category_total_downtime',
    label: 'Category Downtime',
    description: 'Total downtime minutes per asset category from maintenance and inspection events.',
    subject: 'fleet_performance',
    source: 'v_asset_category_downtime_summary',
    valueColumn: 'total_downtime_minutes',
    dimensionColumn: 'asset_category_name',
    format: 'number',
    drillDownTo: '/analytics/fleet',
    icon: 'AlertCircle',
  },
];

/** Fast lookup by key. */
const _catalogIndex: Map<string, CatalogMetric> = new Map(
  METRIC_CATALOG.map((m) => [m.key, m])
);

/**
 * Look up a metric by key.
 * Returns `undefined` if the key is not in the approved catalog — callers
 * must surface a clear error to the user rather than silently falling back.
 */
export function getMetric(key: string): CatalogMetric | undefined {
  return _catalogIndex.get(key);
}

/**
 * Check whether a key belongs to the approved catalog.
 * Use this as the contract gate before rendering any tile or issuing a query.
 */
export function isApprovedMetric(key: string): boolean {
  return _catalogIndex.has(key);
}

/**
 * Return all metrics grouped by subject area.
 */
export function metricsBySubject(): Record<MetricSubject, CatalogMetric[]> {
  const result: Record<MetricSubject, CatalogMetric[]> = {
    fleet_performance: [],
    financial_health: [],
    order_fulfillment: [],
    customer_performance: [],
  };
  for (const metric of METRIC_CATALOG) {
    result[metric.subject].push(metric);
  }
  return result;
}

// ── Saved dashboard configuration ─────────────────────────────────────────

/**
 * A dashboard saved by a business user.  Only `metricKeys` that appear in
 * METRIC_CATALOG are valid; any others are rejected at render time with a
 * clear unsupported-metric error.
 */
export interface SavedDashboard {
  id: string;
  name: string;
  /** Ordered list of metric keys from the catalog. */
  metricKeys: string[];
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'wynne_saved_dashboards';

export function loadSavedDashboards(): SavedDashboard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SavedDashboard[];
  } catch {
    return [];
  }
}

export function saveDashboard(dashboard: SavedDashboard): void {
  const all = loadSavedDashboards();
  const idx = all.findIndex((d) => d.id === dashboard.id);
  if (idx >= 0) {
    all[idx] = dashboard;
  } else {
    all.push(dashboard);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function deleteDashboard(id: string): void {
  const all = loadSavedDashboards().filter((d) => d.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Maximum tiles allowed on a single dashboard. */
export const MAX_TILES = 12;
