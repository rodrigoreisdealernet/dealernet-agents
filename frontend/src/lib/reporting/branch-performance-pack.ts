/**
 * Monthly Branch Performance Pack — assembly library
 *
 * Collates branch utilization, exception, and corrective-action inputs from
 * existing reporting views into a reusable monthly review pack.
 *
 * Operating-model tag: branch-operations-manager:t7
 * Task: Assemble the branch performance and exception pack for monthly regional review.
 * Agentic angle: automate — bounded report collation; human manager edits/approves before regional use.
 */

import type { DataSourceDefinition } from '@/engine/types';

export const BRANCH_PERFORMANCE_PACK_TAG = 'branch-operations-manager:t7';

/**
 * Work order statuses treated as open/actionable for the corrective-actions section.
 * Records with any other status (completed, closed, cancelled) are excluded.
 */
export const OPEN_WORK_ORDER_STATUSES = ['open', 'in_progress', 'awaiting_approval', 'pending'];

// ── Row types (raw data from views) ─────────────────────────────────────────

export interface BranchUtilizationRow {
  branch_id?: string | null;
  branch_name?: string | null;
  on_rent_count?: number | null;
  utilization_rate_pct?: number | null;
  last_updated?: string | null;
}

export interface AssetAnalyticsRow {
  asset_id?: string | null;
  asset_name?: string | null;
  asset_category_name?: string | null;
  branch_name?: string | null;
  lifetime_revenue?: number | null;
  utilization_pct?: number | null;
  downtime_pct?: number | null;
  total_downtime_minutes?: number | null;
  rental_frequency?: number | null;
  roi_pct?: number | null;
  roi_status?: string | null;
  last_order_at?: string | null;
}

export interface WorkOrderRow {
  maintenance_record_id?: string | null;
  name?: string | null;
  work_order_status?: string | null;
  maintenance_type?: string | null;
  asset_id?: string | null;
  internal_subtotal?: number | null;
  sell_total?: number | null;
  created_at?: string | null;
  last_updated_at?: string | null;
}

export interface InspectionExceptionRow {
  asset_id?: string | null;
  service_record_id?: string | null;
  service_name?: string | null;
  service_type?: string | null;
  outcome?: string | null;
  status?: string | null;
  opened_at?: string | null;
  completed_at?: string | null;
  service_sort_at?: string | null;
}

export interface PMDueAssetRow {
  asset_id?: string | null;
  policy_id?: string | null;
  trigger_type?: string | null;
  label?: string | null;
  latest_meter_value?: number | null;
  latest_meter_at?: string | null;
  last_maintenance_at?: string | null;
  is_due?: boolean | null;
  is_pre_due?: boolean | null;
}

// ── Assembled card types ─────────────────────────────────────────────────────

export interface BranchPerformanceMetric {
  branchId: string;
  branchName: string;
  onRentCount: number;
  utilizationRatePct: number | null;
  lastUpdated: string | null;
  sourceException: string | null;
}

export interface ExceptionItem {
  id: string;
  label: string;
  category: 'inspection' | 'pm_due' | 'high_downtime';
  severity: 'critical' | 'warning';
  assetId: string | null;
  detail: string;
  sourceRef: string | null;
  missingSourceReason: string | null;
}

export interface CorrectiveActionItem {
  workOrderId: string;
  name: string;
  status: string;
  assetId: string | null;
  estimatedCost: number | null;
  lastUpdated: string | null;
  missingSourceReason: string | null;
}

export interface MonthlyBranchPack {
  performanceMetrics: BranchPerformanceMetric[];
  exceptions: ExceptionItem[];
  correctiveActions: CorrectiveActionItem[];
  packSourceExceptions: string[];
  packGeneratedAt: string;
  operatingModelTag: string;
}

// ── Data source definitions ──────────────────────────────────────────────────

export const BRANCH_PERFORMANCE_PACK_SOURCES: Record<string, DataSourceDefinition> = {
  branch_utilization: {
    type: 'supabase',
    table: 'v_branch_utilization',
    select: 'branch_id, branch_name, on_rent_count, utilization_rate_pct, last_updated',
    order: [{ column: 'branch_name', ascending: true }],
  },
  asset_analytics: {
    type: 'supabase',
    table: 'v_asset_analytics_current',
    select:
      'asset_id, asset_name, asset_category_name, branch_name, lifetime_revenue, utilization_pct, downtime_pct, total_downtime_minutes, rental_frequency, roi_pct, roi_status, last_order_at',
    order: [
      { column: 'total_downtime_minutes', ascending: false },
      { column: 'lifetime_revenue', ascending: false },
    ],
    limit: 20,
  },
  work_orders: {
    type: 'supabase',
    table: 'v_maintenance_work_order_billing',
    select:
      'maintenance_record_id, name, work_order_status, maintenance_type, asset_id, internal_subtotal, sell_total, created_at, last_updated_at',
    filters: [
      { field: 'work_order_status', op: 'in', value: OPEN_WORK_ORDER_STATUSES },
    ],
    order: [
      { column: 'sell_total', ascending: false },
      { column: 'last_updated_at', ascending: false },
    ],
    limit: 30,
  },
  inspection_exceptions: {
    type: 'supabase',
    table: 'v_asset_service_history',
    select:
      'asset_id, service_record_id, service_name, service_type, outcome, status, opened_at, completed_at, service_sort_at',
    filters: [
      { field: 'service_record_type', op: 'eq', value: 'inspection' },
      { field: 'outcome', op: 'eq', value: 'fail' },
    ],
    order: [{ column: 'service_sort_at', ascending: false }],
    limit: 20,
  },
  pm_due_assets: {
    type: 'supabase',
    table: 'v_pm_due_assets',
    select:
      'asset_id, policy_id, trigger_type, label, latest_meter_value, latest_meter_at, last_maintenance_at, is_due, is_pre_due',
    order: [
      { column: 'is_due', ascending: false },
      { column: 'is_pre_due', ascending: false },
      { column: 'asset_id', ascending: true },
    ],
    limit: 30,
  },
};

// ── Internal helpers ─────────────────────────────────────────────────────────

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? null : numeric;
}

const STALE_TIMESTAMP_EXCEPTION = 'utilization freshness timestamp missing — data may be stale';

// ── Assembly functions ───────────────────────────────────────────────────────

export function buildBranchPerformanceMetrics(rows: unknown): BranchPerformanceMetric[] {
  const utilRows = asArray<BranchUtilizationRow>(rows);

  if (utilRows.length === 0) {
    return [];
  }

  return utilRows.map((row) => {
    const sourceException =
      !row.branch_id
        ? 'branch source record missing'
        : !row.last_updated
          ? STALE_TIMESTAMP_EXCEPTION
          : null;

    return {
      branchId: row.branch_id || 'unknown-branch',
      branchName: row.branch_name || 'Unknown branch',
      onRentCount: asNumber(row.on_rent_count) || 0,
      utilizationRatePct: asNumber(row.utilization_rate_pct),
      lastUpdated: row.last_updated || null,
      sourceException,
    };
  });
}

export function buildPackExceptions(
  inspectionRows: unknown,
  pmDueRows: unknown,
  assetAnalyticsRows: unknown,
): ExceptionItem[] {
  const exceptions: ExceptionItem[] = [];

  // Failed inspections
  for (const row of asArray<InspectionExceptionRow>(inspectionRows)) {
    const missingSourceReason =
      !row.asset_id && !row.service_record_id
        ? 'asset link and inspection source record both missing'
        : !row.asset_id
          ? 'asset link missing'
          : !row.service_record_id
            ? 'inspection source record missing'
            : null;

    exceptions.push({
      id: row.service_record_id || `inspection-${row.asset_id || 'unknown'}-${row.opened_at || 'unknown'}`,
      label: row.service_name || row.service_type || 'Failed inspection',
      category: 'inspection',
      severity: 'critical',
      assetId: row.asset_id || null,
      detail: `Outcome: fail · Recorded: ${row.completed_at || row.opened_at || row.service_sort_at || 'unknown'}`,
      sourceRef: row.service_record_id ? `/entities/inspection/${row.service_record_id}` : null,
      missingSourceReason,
    });
  }

  // Overdue or pre-due PMs
  for (const row of asArray<PMDueAssetRow>(pmDueRows)) {
    if (!row.is_due && !row.is_pre_due) continue;

    const missingSourceReason =
      !row.asset_id
        ? 'asset source record missing'
        : row.trigger_type === 'meter' &&
            (row.latest_meter_value === null || row.latest_meter_value === undefined)
          ? 'meter reading missing — PM due status may be inaccurate'
          : null;

    exceptions.push({
      id: row.policy_id
        ? `pm-${row.asset_id || 'unknown'}-${row.policy_id}`
        : `pm-${row.asset_id || 'unknown'}-${row.label || 'unknown'}`,
      label: row.label || 'Preventive maintenance',
      category: 'pm_due',
      severity: row.is_due ? 'critical' : 'warning',
      assetId: row.asset_id || null,
      detail: row.is_due
        ? `PM overdue · Last maintained: ${row.last_maintenance_at || 'unknown'}`
        : `PM coming due · Last maintained: ${row.last_maintenance_at || 'unknown'}`,
      sourceRef: row.asset_id ? `/entities/asset/${row.asset_id}` : null,
      missingSourceReason,
    });
  }

  // High-downtime assets (top candidates by total_downtime_minutes)
  const analyticsRows = asArray<AssetAnalyticsRow>(assetAnalyticsRows);
  const highDowntime = analyticsRows
    .filter((row) => (asNumber(row.total_downtime_minutes) || 0) > 0)
    .slice(0, 5);

  for (const row of highDowntime) {
    const missingSourceReason =
      !row.asset_id
        ? 'asset source record missing'
        : row.utilization_pct === null || row.utilization_pct === undefined
          ? 'utilization data missing'
          : null;

    exceptions.push({
      id: `downtime-${row.asset_id || 'unknown'}`,
      label: `High downtime: ${row.asset_name || row.asset_id || 'Unknown asset'}`,
      category: 'high_downtime',
      severity: 'warning',
      assetId: row.asset_id || null,
      detail: `${asNumber(row.total_downtime_minutes) || 0} downtime min · Utilization ${row.utilization_pct !== null && row.utilization_pct !== undefined ? `${row.utilization_pct}%` : 'unavailable'} · ROI ${row.roi_status || 'unknown'}`,
      sourceRef: row.asset_id ? `/entities/asset/${row.asset_id}` : null,
      missingSourceReason,
    });
  }

  return exceptions;
}

export function buildCorrectiveActions(rows: unknown): CorrectiveActionItem[] {
  // Defense-in-depth: exclude terminal-status records at the helper level so that
  // direct calls (e.g. tests, future callers) are also protected, even though the
  // data source already applies the same constraint via the server-side `in` filter.
  // Null status is treated as open (consistent with the schema default) and passes
  // through with a missingSourceReason set below.
  const actionableRows = asArray<WorkOrderRow>(rows).filter(
    (row) => !row.work_order_status || OPEN_WORK_ORDER_STATUSES.includes(row.work_order_status),
  );

  return actionableRows.map((row) => {
    const missingSourceReason =
      !row.maintenance_record_id
        ? 'work order source record missing'
        : !row.work_order_status
          ? 'work order status missing'
          : null;

    return {
      workOrderId: row.maintenance_record_id || 'unknown-wo',
      name: row.name || 'Unnamed work order',
      status: row.work_order_status || 'unknown',
      assetId: row.asset_id || null,
      estimatedCost: asNumber(row.sell_total),
      lastUpdated: row.last_updated_at || row.created_at || null,
      missingSourceReason,
    };
  });
}

export function buildMonthlyBranchPack(
  branchUtilization: unknown,
  assetAnalytics: unknown,
  workOrders: unknown,
  inspectionExceptions: unknown,
  pmDueAssets: unknown,
): MonthlyBranchPack {
  const performanceMetrics = buildBranchPerformanceMetrics(branchUtilization);
  const exceptions = buildPackExceptions(inspectionExceptions, pmDueAssets, assetAnalytics);
  const correctiveActions = buildCorrectiveActions(workOrders);

  const packSourceExceptions: string[] = [];

  if (asArray(branchUtilization).length === 0) {
    packSourceExceptions.push('Branch utilization source returned no rows — performance section is empty');
  }
  if (
    performanceMetrics.some(
      (m) => m.sourceException === STALE_TIMESTAMP_EXCEPTION,
    )
  ) {
    packSourceExceptions.push('One or more branches are missing a utilization freshness timestamp');
  }
  if (asArray(workOrders).length === 0) {
    packSourceExceptions.push('Maintenance work-order source returned no rows — corrective-action section is empty');
  }
  if (asArray(inspectionExceptions).length === 0 && asArray(pmDueAssets).length === 0) {
    packSourceExceptions.push('Both inspection and PM sources returned no rows — verify exception sources are current');
  }

  return {
    performanceMetrics,
    exceptions,
    correctiveActions,
    packSourceExceptions,
    packGeneratedAt: new Date().toISOString(),
    operatingModelTag: BRANCH_PERFORMANCE_PACK_TAG,
  };
}
