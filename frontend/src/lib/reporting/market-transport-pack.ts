/**
 * Weekly Market Transport Control Pack — assembly library
 *
 * Collates transport KPIs and compliance exception inputs from existing
 * dispatch, telematics, and DVIR sources into a reusable weekly review pack.
 *
 * Operating-model tags:
 *   market-logistics-dispatcher:t5 — Review weekly DOT, HOS, and DVIR exception
 *     patterns and decide which driver, truck, or branch issues need corrective action.
 *     Agentic angle: assist — the pack assembles evidence; the dispatcher decides action.
 *   market-logistics-dispatcher:t6 — Compile the weekly and monthly logistics KPI pack.
 *     Agentic angle: automate — KPI assembly is automated; dispatcher interprets results.
 */

import type { DataSourceDefinition } from '@/engine/types';

export const MARKET_TRANSPORT_PACK_TAGS = [
  'market-logistics-dispatcher:t5',
  'market-logistics-dispatcher:t6',
] as const;

// ── Row types (raw data from views) ─────────────────────────────────────────

export interface TransportEfficiencySummaryRow {
  total_routes?: number | null;
  loaded_routes?: number | null;
  empty_routes?: number | null;
  load_utilization_pct?: number | null;
  active_routes?: number | null;
  completed_routes?: number | null;
  missing_driver_count?: number | null;
  overdue_count?: number | null;
  eld_warning_count?: number | null;
  eld_violation_count?: number | null;
  stale_position_count?: number | null;
}

export interface DispatchRouteLiveRow {
  line_id?: string | null;
  contract_id?: string | null;
  asset_id?: string | null;
  asset_name?: string | null;
  assigned_driver?: string | null;
  assigned_truck?: string | null;
  departure_at?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  route_status?: string | null;
  exception_state?: string | null;
  branch_id?: string | null;
  updated_at?: string | null;
  telemetry_position_status?: string | null;
  eld_compliance_status?: string | null;
  driver_log_status?: string | null;
  telemetry_event_at?: string | null;
  telemetry_sync_status?: string | null;
}

export interface DvirSubmissionRow {
  id?: string | null;
  route_id?: string | null;
  driver_id?: string | null;
  truck_id?: string | null;
  odometer_reading?: number | null;
  defects?: unknown;
  is_safe_to_drive?: boolean | null;
  notes?: string | null;
  requires_review?: boolean | null;
  submitted_at?: string | null;
}

export interface RouteExceptionReviewRow {
  exception_id?: string | null;
  stop_id?: string | null;
  route_id?: string | null;
  route_date?: string | null;
  route_status?: string | null;
  stop_type?: string | null;
  contract_line_id?: string | null;
  asset_id?: string | null;
  customer_name?: string | null;
  job_site_name?: string | null;
  address?: string | null;
  exception_type?: string | null;
  is_damage_or_missing_attachment?: boolean | null;
  notes?: string | null;
  estimated_delay_minutes?: number | null;
  requires_human_review?: boolean | null;
  submitted_at?: string | null;
  resolved_at?: string | null;
  evidence_bundle?: unknown;
}

// ── Assembled output types ───────────────────────────────────────────────────

export interface WeeklyTransportKpiPack {
  /** Routes completed or in-scope for this pack period */
  totalRoutes: number;
  /** Routes not returned by expected time */
  overdueCount: number;
  /** On-time delivery rate as a percentage (null when data is incomplete) */
  onTimePct: number | null;
  /** Routes missing a driver assignment */
  missingDriverCount: number;
  /** Load utilization percentage across routes */
  loadUtilizationPct: number | null;
  /** ELD compliance warnings in scope */
  eldWarningCount: number;
  /** ELD compliance violations in scope */
  eldViolationCount: number;
  /** Routes with stale position telemetry */
  stalePositionCount: number;
  /** Aggregate source exceptions that prevent a success-shaped KPI display */
  sourceExceptions: string[];
  /**
   * True when the outside-haul spend feed is absent from the sources.
   * The pack must flag this gap rather than defaulting to zero.
   */
  outsideHaulFeedMissing: boolean;
}

export interface ComplianceExceptionCard {
  /** Stable identifier for React key — exception_id, dvir id, or synthesised value */
  id: string;
  /** One of: 'eld_violation' | 'eld_warning' | 'hos_out_of_hours' | 'hos_missing' | 'dvir_defect' | 'dvir_unsafe' | 'stop_exception' */
  exceptionType: string;
  /** Human-readable label */
  label: string;
  /** Driver, truck, branch, or route reference that anchors the exception */
  sourceRef: string | null;
  /** Route or stop date */
  date: string | null;
  /** Extra context — defect list, delay minutes, address, etc. */
  detail: string | null;
  /** Path to the underlying record, if navigable */
  reviewPath: string | null;
  /** Reason this card cannot fully support a corrective-action recommendation */
  missingSourceReason: string | null;
}

// ── Data source definitions ──────────────────────────────────────────────────

export const MARKET_TRANSPORT_PACK_SOURCES: Record<string, DataSourceDefinition> = {
  transport_efficiency_summary: {
    type: 'supabase',
    table: 'v_transport_efficiency_summary',
    select:
      'total_routes, loaded_routes, empty_routes, load_utilization_pct, active_routes, completed_routes, missing_driver_count, overdue_count, eld_warning_count, eld_violation_count, stale_position_count',
    limit: 1,
  },
  overdue_routes: {
    type: 'supabase',
    table: 'v_dispatch_route_live',
    select:
      'line_id, contract_id, asset_id, asset_name, assigned_driver, assigned_truck, departure_at, actual_start, exception_state, branch_id, eld_compliance_status, driver_log_status, telemetry_event_at, telemetry_sync_status, updated_at',
    filters: [
      { field: 'exception_state', op: 'eq', value: 'overdue' },
    ],
    order: [{ column: 'actual_start', ascending: true }],
    limit: 20,
  },
  missing_driver_routes: {
    type: 'supabase',
    table: 'v_dispatch_route_live',
    select:
      'line_id, contract_id, asset_id, asset_name, assigned_driver, assigned_truck, departure_at, actual_start, route_status, exception_state, branch_id, telemetry_position_status, eld_compliance_status, driver_log_status, telemetry_event_at, telemetry_sync_status, updated_at',
    filters: [
      { field: 'exception_state', op: 'eq', value: 'missing_driver' },
    ],
    order: [{ column: 'updated_at', ascending: false }],
    limit: 10,
  },
  stale_telemetry_routes: {
    type: 'supabase',
    table: 'v_dispatch_route_live',
    select:
      'line_id, contract_id, asset_id, asset_name, assigned_driver, assigned_truck, departure_at, actual_start, route_status, exception_state, branch_id, telemetry_position_status, eld_compliance_status, driver_log_status, telemetry_event_at, telemetry_sync_status, updated_at',
    filters: [
      { field: 'telemetry_position_status', op: 'in', value: ['stale', 'missing'] },
    ],
    order: [{ column: 'updated_at', ascending: false }],
    limit: 10,
  },
  hos_exceptions: {
    type: 'supabase',
    table: 'v_dispatch_route_live',
    select:
      'line_id, contract_id, asset_id, asset_name, assigned_driver, assigned_truck, departure_at, actual_start, route_status, branch_id, eld_compliance_status, driver_log_status, telemetry_event_at, telemetry_sync_status, updated_at',
    filters: [
      { field: 'driver_log_status', op: 'in', value: ['out_of_hours', 'missing'] },
    ],
    order: [{ column: 'updated_at', ascending: false }],
    limit: 20,
  },
  dvir_exceptions: {
    type: 'supabase',
    table: 'dvir_submissions',
    select:
      'id, route_id, driver_id, truck_id, odometer_reading, defects, is_safe_to_drive, notes, requires_review, submitted_at',
    filters: [
      { field: 'requires_review', op: 'eq', value: true },
    ],
    order: [{ column: 'submitted_at', ascending: false }],
    limit: 20,
  },
  stop_exceptions: {
    type: 'supabase',
    table: 'v_route_exception_review_bundle',
    select:
      'exception_id, stop_id, route_id, route_date, route_status, stop_type, contract_line_id, asset_id, customer_name, job_site_name, address, exception_type, is_damage_or_missing_attachment, notes, estimated_delay_minutes, requires_human_review, submitted_at',
    filters: [
      { field: 'requires_human_review', op: 'eq', value: true },
    ],
    order: [{ column: 'submitted_at', ascending: false }],
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

function parseDefects(defects: unknown): string[] {
  if (!Array.isArray(defects)) return [];
  return defects
    .map((d) => {
      if (typeof d === 'string') return d;
      if (d && typeof d === 'object' && 'description' in d) return String((d as Record<string, unknown>).description);
      if (d && typeof d === 'object' && 'type' in d) return String((d as Record<string, unknown>).type);
      return null;
    })
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

// ── Assembly functions ───────────────────────────────────────────────────────

/**
 * Assembles the weekly transport KPI pack from the efficiency summary and
 * overdue-route feeds.  Flags gaps rather than presenting success-shaped defaults.
 */
export function buildWeeklyTransportKpiPack(
  efficiencySummary: unknown,
  overdueRoutes: unknown,
): WeeklyTransportKpiPack {
  const summaryRows = asArray<TransportEfficiencySummaryRow>(efficiencySummary);
  const overdueRows = asArray<DispatchRouteLiveRow>(overdueRoutes);
  const summary = summaryRows[0] ?? {};

  const totalRoutes = asNumber(summary.total_routes) ?? 0;
  const overdueCount = asNumber(summary.overdue_count) ?? overdueRows.length;
  const completedRoutes = asNumber(summary.completed_routes) ?? 0;
  const missingDriverCount = asNumber(summary.missing_driver_count) ?? 0;
  const loadUtilizationPct = asNumber(summary.load_utilization_pct);
  const eldWarningCount = asNumber(summary.eld_warning_count) ?? 0;
  const eldViolationCount = asNumber(summary.eld_violation_count) ?? 0;
  const stalePositionCount = asNumber(summary.stale_position_count) ?? 0;

  const denominator = totalRoutes > 0 ? totalRoutes : completedRoutes + overdueCount;
  const onTimePct =
    denominator > 0
      ? Math.round((100 * Math.max(0, completedRoutes - overdueCount)) / denominator)
      : null;

  const sourceExceptions: string[] = [];
  if (summaryRows.length === 0) {
    sourceExceptions.push('Transport efficiency summary feed returned no rows — KPI totals may be incomplete');
  }
  if (totalRoutes === 0 && summaryRows.length > 0) {
    sourceExceptions.push('Transport efficiency summary reports zero routes — verify the reporting period is correct');
  }
  if (summary.total_routes !== undefined && summary.overdue_count === undefined) {
    sourceExceptions.push('Overdue-route count is missing from the efficiency summary');
  }

  return {
    totalRoutes,
    overdueCount,
    onTimePct,
    missingDriverCount,
    loadUtilizationPct,
    eldWarningCount,
    eldViolationCount,
    stalePositionCount,
    sourceExceptions,
    outsideHaulFeedMissing: true,
  };
}

/**
 * Builds compliance exception cards from ELD/HOS route flags, DVIR review
 * records, and unresolved stop exceptions.  Each card includes enough source
 * context for a dispatcher to decide whether corrective action is needed.
 */
export function buildComplianceExceptionCards(
  hosExceptions: unknown,
  dvirExceptions: unknown,
  stopExceptions: unknown,
): ComplianceExceptionCard[] {
  const cards: ComplianceExceptionCard[] = [];

  // ── HOS / ELD route-level exceptions ──────────────────────────────────────
  for (const row of asArray<DispatchRouteLiveRow>(hosExceptions)) {
    const missingReasons: string[] = [];
    if (!row.line_id) missingReasons.push('route source missing');
    if (!row.assigned_driver) missingReasons.push('driver source missing');

    const isHos = row.driver_log_status === 'out_of_hours' || row.driver_log_status === 'missing';
    const isEldViolation = row.eld_compliance_status === 'violation';
    const isEldWarning = row.eld_compliance_status === 'warning';

    if (isHos) {
      const hosType = row.driver_log_status === 'out_of_hours' ? 'hos_out_of_hours' : 'hos_missing';
      const hosLabel = row.driver_log_status === 'out_of_hours'
        ? 'HOS — driver log out of hours'
        : 'HOS — driver log missing';
      cards.push({
        id: `hos-${row.line_id ?? `unknown-${cards.length}`}`,
        exceptionType: hosType,
        label: hosLabel,
        sourceRef: row.assigned_driver ?? row.assigned_truck ?? row.branch_id ?? null,
        date: row.departure_at ?? row.actual_start ?? row.updated_at ?? null,
        detail: row.asset_name
          ? `Asset: ${row.asset_name}${row.assigned_truck ? ` · Truck: ${row.assigned_truck}` : ''}`
          : null,
        reviewPath: row.line_id ? `/entities/rental_contract_line/${row.line_id}` : null,
        missingSourceReason: missingReasons.length > 0 ? missingReasons.join('; ') : null,
      });
    }

    if (isEldViolation || isEldWarning) {
      const eldType = isEldViolation ? 'eld_violation' : 'eld_warning';
      const eldLabel = isEldViolation ? 'ELD — compliance violation' : 'ELD — compliance warning';
      cards.push({
        id: `eld-${row.line_id ?? `unknown-eld-${cards.length}`}`,
        exceptionType: eldType,
        label: eldLabel,
        sourceRef: row.assigned_driver ?? row.assigned_truck ?? row.branch_id ?? null,
        date: row.telemetry_event_at ?? row.departure_at ?? row.updated_at ?? null,
        detail: row.asset_name
          ? `Asset: ${row.asset_name}${row.assigned_truck ? ` · Truck: ${row.assigned_truck}` : ''}`
          : null,
        reviewPath: row.line_id ? `/entities/rental_contract_line/${row.line_id}` : null,
        missingSourceReason: missingReasons.length > 0 ? missingReasons.join('; ') : null,
      });
    }
  }

  // ── DVIR exceptions ───────────────────────────────────────────────────────
  for (const row of asArray<DvirSubmissionRow>(dvirExceptions)) {
    const missingReasons: string[] = [];
    if (!row.id) missingReasons.push('DVIR source record missing');
    if (!row.driver_id) missingReasons.push('driver identity missing');
    if (!row.route_id) missingReasons.push('route link missing');

    const defectList = parseDefects(row.defects);
    const isUnsafe = row.is_safe_to_drive === false;
    const exceptionType = isUnsafe ? 'dvir_unsafe' : 'dvir_defect';
    const label = isUnsafe
      ? 'DVIR — vehicle marked unsafe to drive'
      : 'DVIR — defects flagged for review';

    const detailParts: string[] = [];
    if (row.truck_id) detailParts.push(`Truck: ${row.truck_id}`);
    if (defectList.length > 0) detailParts.push(`Defects: ${defectList.join(', ')}`);
    if (row.notes) detailParts.push(row.notes);

    cards.push({
      id: `dvir-${row.id ?? `unknown-dvir-${cards.length}`}`,
      exceptionType,
      label,
      sourceRef: row.truck_id ?? (row.driver_id ? `Driver ${row.driver_id}` : null),
      date: row.submitted_at ?? null,
      detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
      reviewPath: row.route_id ? `/dispatch/live?route_id=${encodeURIComponent(row.route_id)}` : null,
      missingSourceReason: missingReasons.length > 0 ? missingReasons.join('; ') : null,
    });
  }

  // ── Stop-level exceptions with evidence ──────────────────────────────────
  for (const row of asArray<RouteExceptionReviewRow>(stopExceptions)) {
    const missingReasons: string[] = [];
    if (!row.exception_id) missingReasons.push('exception source record missing');
    if (!row.route_id) missingReasons.push('route link missing');

    const detailParts: string[] = [];
    if (row.stop_type) detailParts.push(`Stop: ${row.stop_type}`);
    if (row.customer_name) detailParts.push(row.customer_name);
    if (row.address) detailParts.push(row.address);
    if (row.estimated_delay_minutes != null) detailParts.push(`Delay: ${row.estimated_delay_minutes} min`);
    if (row.notes) detailParts.push(row.notes);

    const typeLabel: Record<string, string> = {
      eta_delay: 'Stop exception — ETA delay',
      access_issue: 'Stop exception — access issue',
      damage: 'Stop exception — damage',
      missing_attachment: 'Stop exception — missing attachment',
    };

    cards.push({
      id: `stop-exc-${row.exception_id ?? `unknown-stop-${cards.length}`}`,
      exceptionType: 'stop_exception',
      label: typeLabel[row.exception_type ?? ''] ?? `Stop exception — ${row.exception_type ?? 'unknown'}`,
      sourceRef: row.route_id ?? null,
      date: row.route_date ?? row.submitted_at ?? null,
      detail: detailParts.length > 0 ? detailParts.join(' · ') : null,
      reviewPath: row.route_id ? `/dispatch/live?route_id=${encodeURIComponent(row.route_id)}` : null,
      missingSourceReason: missingReasons.length > 0 ? missingReasons.join('; ') : null,
    });
  }

  return cards;
}
