import { describe, expect, it } from 'vitest';
import {
  MARKET_TRANSPORT_PACK_TAGS,
  buildComplianceExceptionCards,
  buildWeeklyTransportKpiPack,
} from './market-transport-pack';

describe('market transport pack helpers', () => {
  // ── Tag export ────────────────────────────────────────────────────────────

  it('exports the correct operating-model tags for t5 and t6', () => {
    expect(MARKET_TRANSPORT_PACK_TAGS).toContain('market-logistics-dispatcher:t5');
    expect(MARKET_TRANSPORT_PACK_TAGS).toContain('market-logistics-dispatcher:t6');
  });

  // ── KPI pack — aggregation ─────────────────────────────────────────────────

  it('builds KPI pack from a well-formed efficiency summary row', () => {
    const pack = buildWeeklyTransportKpiPack(
      [
        {
          total_routes: 40,
          loaded_routes: 36,
          empty_routes: 4,
          load_utilization_pct: 90.0,
          active_routes: 5,
          completed_routes: 30,
          missing_driver_count: 1,
          overdue_count: 3,
          eld_warning_count: 2,
          eld_violation_count: 1,
          stale_position_count: 4,
        },
      ],
      [],
    );

    expect(pack.totalRoutes).toBe(40);
    expect(pack.overdueCount).toBe(3);
    expect(pack.missingDriverCount).toBe(1);
    expect(pack.loadUtilizationPct).toBe(90.0);
    expect(pack.eldWarningCount).toBe(2);
    expect(pack.eldViolationCount).toBe(1);
    expect(pack.stalePositionCount).toBe(4);
    expect(pack.outsideHaulFeedMissing).toBe(true);
    expect(pack.sourceExceptions).toHaveLength(0);
  });

  it('calculates on-time percentage from completed and overdue counts', () => {
    const pack = buildWeeklyTransportKpiPack(
      [{ total_routes: 20, completed_routes: 18, overdue_count: 2 }],
      [],
    );
    // total_routes = 20 (denominator); on-time = (18 - 2) / 20 * 100 = 80
    expect(pack.onTimePct).toBe(80);
  });

  it('returns null on-time pct when no delivered-or-scope routes exist', () => {
    const pack = buildWeeklyTransportKpiPack(
      [{ total_routes: 0, completed_routes: 0, overdue_count: 0 }],
      [],
    );
    expect(pack.onTimePct).toBeNull();
  });

  it('flags gap when efficiency summary is empty', () => {
    const pack = buildWeeklyTransportKpiPack([], []);
    expect(pack.sourceExceptions.some((e) => e.includes('returned no rows'))).toBe(true);
    expect(pack.totalRoutes).toBe(0);
  });

  it('flags gap when summary returns zero routes', () => {
    const pack = buildWeeklyTransportKpiPack(
      [{ total_routes: 0 }],
      [],
    );
    expect(pack.sourceExceptions.some((e) => e.includes('zero routes'))).toBe(true);
  });

  it('falls back to overdue-route feed length when summary overdue_count is absent', () => {
    const pack = buildWeeklyTransportKpiPack(
      [{ total_routes: 10, completed_routes: 7 }],
      [
        { line_id: 'r-1', exception_state: 'overdue' },
        { line_id: 'r-2', exception_state: 'overdue' },
      ],
    );
    expect(pack.overdueCount).toBe(2);
  });

  it('always sets outsideHaulFeedMissing to true (feed not yet available)', () => {
    const pack = buildWeeklyTransportKpiPack([{ total_routes: 5 }], []);
    expect(pack.outsideHaulFeedMissing).toBe(true);
  });

  it('handles null and non-array efficiency summary input gracefully', () => {
    expect(buildWeeklyTransportKpiPack(null, null).sourceExceptions.length).toBeGreaterThan(0);
    expect(buildWeeklyTransportKpiPack(undefined, undefined).sourceExceptions.length).toBeGreaterThan(0);
    expect(buildWeeklyTransportKpiPack({}, {}).sourceExceptions.length).toBeGreaterThan(0);
  });

  // ── Compliance exception cards — HOS / ELD ────────────────────────────────

  it('builds HOS out-of-hours exception card with source evidence', () => {
    const cards = buildComplianceExceptionCards(
      [
        {
          line_id: 'line-42',
          assigned_driver: 'driver-7',
          assigned_truck: 'truck-12',
          asset_name: 'Excavator 100',
          departure_at: '2026-06-10T06:00:00Z',
          driver_log_status: 'out_of_hours',
          eld_compliance_status: 'compliant',
        },
      ],
      [],
      [],
    );

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.exceptionType).toBe('hos_out_of_hours');
    expect(card.label).toContain('HOS');
    expect(card.label).toContain('out of hours');
    expect(card.sourceRef).toBe('driver-7');
    expect(card.reviewPath).toBe('/entities/rental_contract_line/line-42');
    expect(card.missingSourceReason).toBeNull();
  });

  it('builds HOS missing log exception card', () => {
    const cards = buildComplianceExceptionCards(
      [
        {
          line_id: 'line-55',
          assigned_driver: 'driver-8',
          driver_log_status: 'missing',
          eld_compliance_status: 'unknown',
        },
      ],
      [],
      [],
    );
    const card = cards[0];
    expect(card.exceptionType).toBe('hos_missing');
    expect(card.label).toContain('missing');
  });

  it('builds ELD violation card alongside HOS on same route', () => {
    const cards = buildComplianceExceptionCards(
      [
        {
          line_id: 'line-99',
          assigned_driver: 'driver-9',
          driver_log_status: 'out_of_hours',
          eld_compliance_status: 'violation',
        },
      ],
      [],
      [],
    );
    expect(cards.some((c) => c.exceptionType === 'eld_violation')).toBe(true);
    expect(cards.some((c) => c.exceptionType === 'hos_out_of_hours')).toBe(true);
    expect(cards).toHaveLength(2);
  });

  it('builds ELD warning card', () => {
    const cards = buildComplianceExceptionCards(
      [
        {
          line_id: 'line-11',
          assigned_driver: 'driver-11',
          driver_log_status: 'current',
          eld_compliance_status: 'warning',
        },
      ],
      [],
      [],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].exceptionType).toBe('eld_warning');
  });

  it('flags missing source reason when driver source is absent', () => {
    const cards = buildComplianceExceptionCards(
      [
        {
          line_id: 'line-77',
          assigned_driver: null,
          driver_log_status: 'out_of_hours',
          eld_compliance_status: 'unknown',
        },
      ],
      [],
      [],
    );
    expect(cards[0].missingSourceReason).toContain('driver source missing');
  });

  it('returns no HOS/ELD cards when all routes have compliant log statuses', () => {
    const cards = buildComplianceExceptionCards(
      [
        { line_id: 'line-ok', driver_log_status: 'current', eld_compliance_status: 'compliant' },
      ],
      [],
      [],
    );
    expect(cards).toHaveLength(0);
  });

  // ── Compliance exception cards — DVIR ─────────────────────────────────────

  it('builds DVIR unsafe-to-drive card with defect detail', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [
        {
          id: 'dvir-1',
          route_id: 'route-22',
          driver_id: 'driver-3',
          truck_id: 'truck-5',
          is_safe_to_drive: false,
          requires_review: true,
          defects: [{ type: 'brake_failure' }, { description: 'cracked windshield' }],
          submitted_at: '2026-06-11T07:00:00Z',
        },
      ],
      [],
    );

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.exceptionType).toBe('dvir_unsafe');
    expect(card.label).toContain('unsafe');
    expect(card.sourceRef).toBe('truck-5');
    expect(card.detail).toContain('brake_failure');
    expect(card.detail).toContain('cracked windshield');
    expect(card.reviewPath).toContain('/dispatch/live');
    expect(card.missingSourceReason).toBeNull();
  });

  it('builds DVIR defect-flagged card when vehicle is safe but defects require review', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [
        {
          id: 'dvir-2',
          route_id: 'route-33',
          truck_id: 'truck-6',
          is_safe_to_drive: true,
          requires_review: true,
          defects: ['oil_leak'],
          submitted_at: '2026-06-12T06:30:00Z',
        },
      ],
      [],
    );
    expect(cards[0].exceptionType).toBe('dvir_defect');
    expect(cards[0].detail).toContain('oil_leak');
  });

  it('flags missing source reason when DVIR is missing route link', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [
        {
          id: 'dvir-3',
          route_id: null,
          driver_id: 'driver-4',
          truck_id: 'truck-7',
          is_safe_to_drive: false,
          requires_review: true,
          defects: [],
        },
      ],
      [],
    );
    expect(cards[0].missingSourceReason).toContain('route link missing');
    expect(cards[0].reviewPath).toBeNull();
  });

  it('handles empty defects array without error', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [
        {
          id: 'dvir-4',
          route_id: 'route-44',
          is_safe_to_drive: false,
          requires_review: true,
          defects: [],
        },
      ],
      [],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].detail ?? '').not.toContain('Defects');
  });

  // ── Compliance exception cards — stop exceptions ──────────────────────────

  it('builds eta_delay stop exception card with delay minutes and customer context', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [],
      [
        {
          exception_id: 'exc-1',
          route_id: 'route-10',
          route_date: '2026-06-09',
          stop_type: 'delivery',
          exception_type: 'eta_delay',
          customer_name: 'Acme Construction',
          address: '123 Main St',
          estimated_delay_minutes: 45,
          requires_human_review: true,
          submitted_at: '2026-06-09T13:00:00Z',
        },
      ],
    );

    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.exceptionType).toBe('stop_exception');
    expect(card.label).toContain('ETA delay');
    expect(card.detail).toContain('Acme Construction');
    expect(card.detail).toContain('45 min');
    expect(card.reviewPath).toContain('/dispatch/live');
    expect(card.date).toBe('2026-06-09');
  });

  it('builds damage stop exception card', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [],
      [
        {
          exception_id: 'exc-2',
          route_id: 'route-20',
          exception_type: 'damage',
          requires_human_review: true,
          notes: 'Forklift damage to equipment',
        },
      ],
    );
    expect(cards[0].label).toContain('damage');
    expect(cards[0].detail).toContain('Forklift damage');
  });

  it('flags missing exception source record when exception_id is absent', () => {
    const cards = buildComplianceExceptionCards(
      [],
      [],
      [
        {
          exception_id: null,
          route_id: 'route-30',
          exception_type: 'access_issue',
          requires_human_review: true,
        },
      ],
    );
    expect(cards[0].missingSourceReason).toContain('exception source record missing');
  });

  it('returns empty array when all inputs are empty', () => {
    expect(buildComplianceExceptionCards([], [], [])).toHaveLength(0);
    expect(buildComplianceExceptionCards(null, null, null)).toHaveLength(0);
    expect(buildComplianceExceptionCards(undefined, undefined, undefined)).toHaveLength(0);
  });

  it('accumulates cards across all three exception feeds', () => {
    const cards = buildComplianceExceptionCards(
      [{ line_id: 'l-1', driver_log_status: 'out_of_hours', eld_compliance_status: 'warning' }],
      [{ id: 'dv-1', route_id: 'r-1', is_safe_to_drive: false, requires_review: true, defects: [] }],
      [{ exception_id: 'ex-1', route_id: 'r-2', exception_type: 'eta_delay', requires_human_review: true }],
    );
    // HOS (1) + ELD warning (1) + DVIR (1) + stop exc (1)
    expect(cards.length).toBeGreaterThanOrEqual(4);
  });
});
