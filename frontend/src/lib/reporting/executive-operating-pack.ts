/**
 * Monthly Executive Operating Pack — assembly library
 *
 * Collates cross-branch P&L, utilization, uptime, and exception inputs from
 * existing reporting views into a monthly pack suitable for leadership or
 * board review.
 *
 * Operating-model tag: operations-executive:t2
 * Task: Assemble the monthly operating pack for leadership or board review
 *       from branch P&L, utilization, uptime, and exception data.
 * Agentic angle: automate — bounded report collation; executive still owns
 *   interpretation and commitments; if required sources are incomplete the
 *   pack surfaces exceptions explicitly rather than hiding them.
 */

import type { DataSourceDefinition } from '@/engine/types';
import type {
  AssetAnalyticsRow,
  BranchUtilizationRow,
  InspectionExceptionRow,
  PMDueAssetRow,
} from './branch-performance-pack';

export const EXECUTIVE_OPERATING_PACK_TAG = 'operations-executive:t2';

// ── Assembled section types ──────────────────────────────────────────────────

export interface BranchPLSummaryItem {
  branchName: string;
  totalRevenue: number;
  avgRoiPct: number | null;
  assetCount: number;
  sourceException: string | null;
}

export interface BranchUtilizationSummaryItem {
  branchId: string;
  branchName: string;
  onRentCount: number;
  utilizationRatePct: number | null;
  lastUpdated: string | null;
  /** True when the utilization freshness timestamp is absent — used for pack-level stale detection. */
  isStale: boolean;
  sourceException: string | null;
}

export interface UptimeItem {
  assetId: string | null;
  assetName: string;
  branchName: string | null;
  totalDowntimeMinutes: number;
  downtimePct: number | null;
  roiStatus: string | null;
  sourceRef: string | null;
  sourceException: string | null;
}

export interface ExecutiveExceptionItem {
  id: string;
  label: string;
  category: 'inspection' | 'pm_due';
  severity: 'critical' | 'warning';
  assetId: string | null;
  detail: string;
  sourceRef: string | null;
  missingSourceReason: string | null;
}

export interface ExecutiveOperatingPack {
  plSummary: BranchPLSummaryItem[];
  utilizationSummary: BranchUtilizationSummaryItem[];
  uptimeSummary: UptimeItem[];
  exceptions: ExecutiveExceptionItem[];
  packSourceExceptions: string[];
  packGeneratedAt: string;
  operatingModelTag: string;
}

// ── Data source definitions ──────────────────────────────────────────────────

/**
 * All data sources reuse existing reporting views to avoid metric drift.
 * No new views or tables are introduced; the executive pack is assembled
 * exclusively from the same sources used by branch-level reporting.
 */
export const EXECUTIVE_OPERATING_PACK_SOURCES: Record<string, DataSourceDefinition> = {
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
      'asset_id, asset_name, branch_name, lifetime_revenue, utilization_pct, downtime_pct, total_downtime_minutes, roi_pct, roi_status, last_order_at',
    order: [
      { column: 'total_downtime_minutes', ascending: false },
      { column: 'lifetime_revenue', ascending: false },
    ],
    limit: 50,
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
    limit: 30,
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
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

const STALE_UTIL_EXCEPTION = 'utilization freshness timestamp missing — data may be stale';

// ── Assembly functions ───────────────────────────────────────────────────────

/**
 * Builds a cross-branch P&L summary by grouping asset analytics rows by branch.
 * Revenue and ROI are aggregated from the same per-asset view used by branch-level
 * reporting so executive totals remain consistent with branch-level numbers.
 */
export function buildBranchPLSummary(assetAnalyticsRows: unknown): BranchPLSummaryItem[] {
  const rows = asArray<AssetAnalyticsRow>(assetAnalyticsRows);
  if (rows.length === 0) return [];

  const byBranch = new Map<string, { totalRevenue: number; roiPcts: number[]; count: number }>();

  for (const row of rows) {
    const name = row.branch_name || 'Unknown branch';
    const existing = byBranch.get(name) ?? { totalRevenue: 0, roiPcts: [], count: 0 };
    existing.totalRevenue += asNumber(row.lifetime_revenue) ?? 0;
    const roi = asNumber(row.roi_pct);
    if (roi !== null) existing.roiPcts.push(roi);
    existing.count += 1;
    byBranch.set(name, existing);
  }

  return Array.from(byBranch.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([branchName, summary]) => {
      const avgRoiPct =
        summary.roiPcts.length > 0
          ? summary.roiPcts.reduce((a, b) => a + b, 0) / summary.roiPcts.length
          : null;

      const sourceException =
        summary.totalRevenue === 0 && summary.count > 0
          ? 'no lifetime revenue recorded — P&L data may be incomplete'
          : null;

      return {
        branchName,
        totalRevenue: summary.totalRevenue,
        avgRoiPct: avgRoiPct !== null ? Math.round(avgRoiPct * 10) / 10 : null,
        assetCount: summary.count,
        sourceException,
      };
    });
}

/**
 * Builds the network-wide utilization summary, one row per branch.
 * Missing freshness timestamps are surfaced as per-branch source exceptions.
 */
export function buildNetworkUtilizationSummary(
  branchUtilizationRows: unknown,
): BranchUtilizationSummaryItem[] {
  const rows = asArray<BranchUtilizationRow>(branchUtilizationRows);
  if (rows.length === 0) return [];

  return rows.map((row) => {
    const isStale = Boolean(!row.branch_id ? false : !row.last_updated);
    const sourceException =
      !row.branch_id
        ? 'branch source record missing'
        : !row.last_updated
          ? STALE_UTIL_EXCEPTION
          : null;

    return {
      branchId: row.branch_id || 'unknown-branch',
      branchName: row.branch_name || 'Unknown branch',
      onRentCount: asNumber(row.on_rent_count) || 0,
      utilizationRatePct: asNumber(row.utilization_rate_pct),
      lastUpdated: row.last_updated || null,
      isStale,
      sourceException,
    };
  });
}

/**
 * Builds the network uptime summary: top high-downtime assets across all branches.
 * Sorted descending by total_downtime_minutes (already sorted by the data source).
 */
export function buildNetworkUptimeSummary(assetAnalyticsRows: unknown): UptimeItem[] {
  const rows = asArray<AssetAnalyticsRow>(assetAnalyticsRows);

  return rows
    .filter((row) => (asNumber(row.total_downtime_minutes) ?? 0) > 0)
    .slice(0, 10)
    .map((row) => {
      const sourceException =
        !row.asset_id
          ? 'asset source record missing'
          : row.downtime_pct === null || row.downtime_pct === undefined
            ? 'downtime percentage missing'
            : null;

      return {
        assetId: row.asset_id || null,
        assetName: row.asset_name || row.asset_id || 'Unknown asset',
        branchName: row.branch_name || null,
        totalDowntimeMinutes: asNumber(row.total_downtime_minutes) ?? 0,
        downtimePct: asNumber(row.downtime_pct),
        roiStatus: row.roi_status || null,
        sourceRef: row.asset_id ? `/entities/asset/${row.asset_id}` : null,
        sourceException,
      };
    });
}

/**
 * Builds the notable exceptions section from failed inspections and overdue PM assets.
 * Reuses the same inspection and PM source views used by branch-level reporting.
 */
export function buildExecutiveExceptions(
  inspectionRows: unknown,
  pmDueRows: unknown,
): ExecutiveExceptionItem[] {
  const exceptions: ExecutiveExceptionItem[] = [];

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
      id:
        row.service_record_id ||
        `inspection-${row.asset_id || 'unknown'}-${row.opened_at || 'unknown'}`,
      label: row.service_name || row.service_type || 'Failed inspection',
      category: 'inspection',
      severity: 'critical',
      assetId: row.asset_id || null,
      detail: `Outcome: fail · Recorded: ${row.completed_at || row.opened_at || row.service_sort_at || 'unknown'}`,
      sourceRef: row.service_record_id
        ? `/entities/inspection/${row.service_record_id}`
        : null,
      missingSourceReason,
    });
  }

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

  return exceptions;
}

/**
 * Main assembler. Combines all four sections into the executive operating pack.
 * Missing or stale inputs are surfaced in packSourceExceptions rather than
 * silently omitted, so the pack always fails explicitly when coverage is incomplete.
 */
export function buildExecutiveOperatingPack(
  branchUtilization: unknown,
  assetAnalytics: unknown,
  inspectionExceptions: unknown,
  pmDueAssets: unknown,
): ExecutiveOperatingPack {
  const plSummary = buildBranchPLSummary(assetAnalytics);
  const utilizationSummary = buildNetworkUtilizationSummary(branchUtilization);
  const uptimeSummary = buildNetworkUptimeSummary(assetAnalytics);
  const exceptions = buildExecutiveExceptions(inspectionExceptions, pmDueAssets);

  const packSourceExceptions: string[] = [];

  if (asArray(branchUtilization).length === 0) {
    packSourceExceptions.push(
      'Branch utilization source returned no rows — utilization section is empty',
    );
  } else if (utilizationSummary.some((m) => m.isStale)) {
    packSourceExceptions.push(
      'One or more branches are missing a utilization freshness timestamp',
    );
  }

  if (asArray(assetAnalytics).length === 0) {
    packSourceExceptions.push(
      'Asset analytics source returned no rows — P&L and uptime sections are empty',
    );
  }

  if (asArray(inspectionExceptions).length === 0 && asArray(pmDueAssets).length === 0) {
    packSourceExceptions.push(
      'Both inspection and PM sources returned no rows — verify exception sources are current',
    );
  }

  return {
    plSummary,
    utilizationSummary,
    uptimeSummary,
    exceptions,
    packSourceExceptions,
    packGeneratedAt: new Date().toISOString(),
    operatingModelTag: EXECUTIVE_OPERATING_PACK_TAG,
  };
}
