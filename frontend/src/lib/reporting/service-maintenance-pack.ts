import type { DataSourceDefinition } from '@/engine/types';

export const SERVICE_MAINTENANCE_PACK_TAGS = [
  'service-maintenance-manager:t4',
  'service-maintenance-manager:t5',
  'service-maintenance-manager:t7',
] as const;

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

export interface MaintenanceReviewWorkOrderRow {
  maintenance_record_id?: string | null;
  name?: string | null;
  work_order_status?: string | null;
  maintenance_type?: string | null;
  asset_id?: string | null;
  cost_line_count?: number | null;
  internal_subtotal?: number | null;
  sell_total?: number | null;
  created_at?: string | null;
  last_updated_at?: string | null;
}

export interface DispositionCandidateRow {
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

export interface PMDueAssetRow {
  asset_id?: string | null;
  policy_id?: string | null;
  trigger_type?: string | null;
  threshold?: number | null;
  interval_days?: number | null;
  lead_window_days?: number | null;
  label?: string | null;
  latest_meter_value?: number | null;
  latest_meter_at?: string | null;
  rental_completion_count?: number | null;
  last_completion_at?: string | null;
  last_maintenance_at?: string | null;
  is_due?: boolean | null;
  is_pre_due?: boolean | null;
}

export interface CategoryDowntimeRow {
  asset_category_id?: string | null;
  asset_category_name?: string | null;
  asset_count?: number | null;
  downtime_intervals?: number | null;
  total_downtime_minutes?: number | null;
  average_interval_minutes?: number | null;
  maintenance_downtime_minutes?: number | null;
  inspection_downtime_minutes?: number | null;
  last_downtime_recorded_at?: string | null;
}

export interface InspectionExceptionCard {
  assetId: string;
  inspectionId: string | null;
  inspectionLabel: string;
  reviewPath: string | null;
  comparisonPath: string;
  recordedAt: string | null;
  missingSourceReason: string | null;
}

export interface DispositionCaseCard {
  assetId: string;
  assetName: string;
  branchName: string;
  categoryName: string;
  lifetimeRevenue: number;
  utilizationPct: number | null;
  downtimePct: number | null;
  totalDowntimeMinutes: number;
  rentalFrequency: number;
  roiPct: number | null;
  roiStatus: string;
  lastOrderAt: string | null;
  workOrderId: string | null;
  workOrderName: string | null;
  workOrderStatus: string | null;
  workOrderSellTotal: number | null;
  missingSourceReasons: string[];
}

export interface WeeklyShopKpiPack {
  duePmCount: number;
  preDuePmCount: number;
  inspectionExceptionCount: number;
  trackedMaintenanceSpend: number;
  categoryDowntimeMinutes: number;
  sourceExceptions: string[];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? null : numeric;
}

export const SERVICE_MAINTENANCE_PACK_SOURCES: Record<string, DataSourceDefinition> = {
  inspection_exceptions: {
    type: 'supabase',
    table: 'v_asset_service_history',
    select: 'asset_id, service_record_id, service_name, service_type, outcome, status, opened_at, completed_at, service_sort_at',
    filters: [
      { field: 'service_record_type', op: 'eq', value: 'inspection' },
      { field: 'outcome', op: 'eq', value: 'fail' },
    ],
    order: [{ column: 'service_sort_at', ascending: false }],
    limit: 12,
  },
  maintenance_review_work_orders: {
    type: 'supabase',
    table: 'v_maintenance_work_order_billing',
    select:
      'maintenance_record_id, name, work_order_status, maintenance_type, asset_id, cost_line_count, internal_subtotal, sell_total, created_at, last_updated_at',
    order: [
      { column: 'sell_total', ascending: false },
      { column: 'last_updated_at', ascending: false },
    ],
    limit: 20,
  },
  disposition_candidates: {
    type: 'supabase',
    table: 'v_asset_analytics_current',
    select:
      'asset_id, asset_name, asset_category_name, branch_name, lifetime_revenue, utilization_pct, downtime_pct, total_downtime_minutes, rental_frequency, roi_pct, roi_status, last_order_at',
    order: [
      { column: 'total_downtime_minutes', ascending: false },
      { column: 'lifetime_revenue', ascending: false },
    ],
    limit: 12,
  },
  pm_due_assets: {
    type: 'supabase',
    table: 'v_pm_due_assets',
    select:
      'asset_id, policy_id, trigger_type, threshold, interval_days, lead_window_days, label, latest_meter_value, latest_meter_at, rental_completion_count, last_completion_at, last_maintenance_at, is_due, is_pre_due',
    order: [
      { column: 'is_due', ascending: false },
      { column: 'is_pre_due', ascending: false },
      { column: 'asset_id', ascending: true },
    ],
    limit: 40,
  },
  shop_category_downtime: {
    type: 'supabase',
    table: 'v_asset_category_downtime_summary',
    select:
      'asset_category_id, asset_category_name, asset_count, downtime_intervals, total_downtime_minutes, average_interval_minutes, maintenance_downtime_minutes, inspection_downtime_minutes, last_downtime_recorded_at',
    order: [{ column: 'total_downtime_minutes', ascending: false }],
    limit: 12,
  },
};

export function buildInspectionExceptionCards(rows: unknown): InspectionExceptionCard[] {
  return asArray<InspectionExceptionRow>(rows).map((row) => {
    const missingReasons: string[] = [];
    if (!row.asset_id) missingReasons.push('asset link missing');
    if (!row.service_record_id) missingReasons.push('inspection source record missing');
    if (!row.outcome) missingReasons.push('inspection outcome missing');

    return {
      assetId: row.asset_id || 'unknown-asset',
      inspectionId: row.service_record_id || null,
      inspectionLabel: row.service_name || row.service_type || 'Inspection exception',
      reviewPath: row.service_record_id ? `/entities/inspection/${row.service_record_id}` : null,
      comparisonPath: `/rental/inspection-comparison?asset_id=${encodeURIComponent(row.asset_id || '')}`,
      recordedAt: row.completed_at || row.opened_at || row.service_sort_at || null,
      missingSourceReason: missingReasons.length > 0 ? missingReasons.join('; ') : null,
    };
  });
}

export function buildDispositionCaseCards(
  candidates: unknown,
  workOrders: unknown,
): DispositionCaseCard[] {
  const orderRows = asArray<MaintenanceReviewWorkOrderRow>(workOrders);

  return asArray<DispositionCandidateRow>(candidates).map((candidate) => {
    const relatedWorkOrder =
      orderRows.find((row) => row.asset_id && row.asset_id === candidate.asset_id) || null;
    const missingSourceReasons: string[] = [];

    if (!candidate.asset_id) missingSourceReasons.push('asset source missing');
    if (candidate.utilization_pct === null || candidate.utilization_pct === undefined) {
      missingSourceReasons.push('utilization source missing');
    }
    if (!candidate.last_order_at) missingSourceReasons.push('recent utilization context missing');
    if (!relatedWorkOrder) missingSourceReasons.push('maintenance spend context missing');

    return {
      assetId: candidate.asset_id || 'unknown-asset',
      assetName: candidate.asset_name || candidate.asset_id || 'Unknown asset',
      branchName: candidate.branch_name || 'Unknown branch',
      categoryName: candidate.asset_category_name || 'Unassigned category',
      lifetimeRevenue: asNumber(candidate.lifetime_revenue) || 0,
      utilizationPct: asNumber(candidate.utilization_pct),
      downtimePct: asNumber(candidate.downtime_pct),
      totalDowntimeMinutes: asNumber(candidate.total_downtime_minutes) || 0,
      rentalFrequency: asNumber(candidate.rental_frequency) || 0,
      roiPct: asNumber(candidate.roi_pct),
      roiStatus: candidate.roi_status || 'unknown',
      lastOrderAt: candidate.last_order_at || null,
      workOrderId: relatedWorkOrder?.maintenance_record_id || null,
      workOrderName: relatedWorkOrder?.name || null,
      workOrderStatus: relatedWorkOrder?.work_order_status || null,
      workOrderSellTotal: asNumber(relatedWorkOrder?.sell_total),
      missingSourceReasons,
    };
  });
}

export function buildWeeklyShopKpiPack(
  pmDueAssets: unknown,
  categoryDowntime: unknown,
  workOrders: unknown,
  inspectionExceptions: unknown,
): WeeklyShopKpiPack {
  const pmRows = asArray<PMDueAssetRow>(pmDueAssets);
  const downtimeRows = asArray<CategoryDowntimeRow>(categoryDowntime);
  const workOrderRows = asArray<MaintenanceReviewWorkOrderRow>(workOrders);
  const inspectionRows = asArray<InspectionExceptionRow>(inspectionExceptions);

  const duePmCount = pmRows.filter((row) => row.is_due).length;
  const preDuePmCount = pmRows.filter((row) => !row.is_due && row.is_pre_due).length;
  const inspectionExceptionCount = inspectionRows.length;
  const trackedMaintenanceSpend = workOrderRows.reduce(
    (sum, row) => sum + (asNumber(row.sell_total) || 0),
    0,
  );
  const categoryDowntimeMinutes = downtimeRows.reduce(
    (sum, row) => sum + (asNumber(row.total_downtime_minutes) || 0),
    0,
  );

  const sourceExceptions: string[] = [];
  const missingMeterCount = pmRows.filter(
    (row) => row.trigger_type === 'meter' && (row.latest_meter_value === null || row.latest_meter_value === undefined),
  ).length;
  if (missingMeterCount > 0) {
    sourceExceptions.push(`${missingMeterCount} PM due assets are missing fresh meter readings`);
  }
  if (downtimeRows.length === 0) {
    sourceExceptions.push('Downtime rollup source returned no rows');
  }
  if (downtimeRows.some((row) => !row.last_downtime_recorded_at)) {
    sourceExceptions.push('At least one downtime category is missing a freshness timestamp');
  }
  if (workOrderRows.length === 0) {
    sourceExceptions.push('Maintenance work-order billing source returned no rows');
  }

  return {
    duePmCount,
    preDuePmCount,
    inspectionExceptionCount,
    trackedMaintenanceSpend,
    categoryDowntimeMinutes,
    sourceExceptions,
  };
}
