import { describe, expect, it } from 'vitest';
import {
  buildDispositionCaseCards,
  buildInspectionExceptionCards,
  buildWeeklyShopKpiPack,
} from './service-maintenance-pack';

describe('service maintenance pack helpers', () => {
  it('builds inspection exception cards with review links and missing-source warnings', () => {
    const cards = buildInspectionExceptionCards([
      {
        asset_id: 'asset-7',
        service_record_id: 'inspection-7',
        service_name: 'Return inspection',
        outcome: 'fail',
        completed_at: '2026-06-12T10:30:00Z',
      },
      {
        asset_id: null,
        service_record_id: null,
        outcome: null,
      },
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      assetId: 'asset-7',
      inspectionId: 'inspection-7',
      reviewPath: '/entities/inspection/inspection-7',
      comparisonPath: '/rental/inspection-comparison?asset_id=asset-7',
      missingSourceReason: null,
    });
    expect(cards[1].missingSourceReason).toContain('asset link missing');
    expect(cards[1].missingSourceReason).toContain('inspection source record missing');
    expect(cards[1].missingSourceReason).toContain('inspection outcome missing');
  });

  it('pairs disposition cases with related work-order spend and flags missing context', () => {
    const cases = buildDispositionCaseCards(
      [
        {
          asset_id: 'asset-1',
          asset_name: 'Boom Lift 1',
          branch_name: 'North Yard',
          asset_category_name: 'Boom lifts',
          lifetime_revenue: 12000,
          utilization_pct: 41.5,
          downtime_pct: 12.5,
          total_downtime_minutes: 900,
          rental_frequency: 4,
          roi_pct: -6,
          roi_status: 'warning',
          last_order_at: '2026-06-11T09:00:00Z',
        },
        {
          asset_id: 'asset-2',
          asset_name: 'Boom Lift 2',
          utilization_pct: null,
          last_order_at: null,
        },
      ],
      [
        {
          maintenance_record_id: 'wo-1',
          asset_id: 'asset-1',
          name: 'Hydraulic rebuild',
          work_order_status: 'awaiting_approval',
          sell_total: 4800,
        },
      ],
    );

    expect(cases[0]).toMatchObject({
      assetId: 'asset-1',
      workOrderId: 'wo-1',
      workOrderName: 'Hydraulic rebuild',
      workOrderSellTotal: 4800,
      missingSourceReasons: [],
    });
    expect(cases[1].missingSourceReasons).toContain('utilization source missing');
    expect(cases[1].missingSourceReasons).toContain('recent utilization context missing');
    expect(cases[1].missingSourceReasons).toContain('maintenance spend context missing');
  });

  it('collates weekly KPI counts and explicit source exceptions', () => {
    const pack = buildWeeklyShopKpiPack(
      [
        { asset_id: 'asset-1', trigger_type: 'meter', is_due: true, latest_meter_value: null },
        { asset_id: 'asset-2', trigger_type: 'time_interval', is_due: false, is_pre_due: true },
      ],
      [
        {
          asset_category_id: 'cat-1',
          total_downtime_minutes: 600,
          last_downtime_recorded_at: null,
        },
      ],
      [
        { maintenance_record_id: 'wo-1', sell_total: 1250 },
        { maintenance_record_id: 'wo-2', sell_total: 750 },
      ],
      [{ service_record_id: 'inspection-1' }],
    );

    expect(pack).toMatchObject({
      duePmCount: 1,
      preDuePmCount: 1,
      inspectionExceptionCount: 1,
      trackedMaintenanceSpend: 2000,
      categoryDowntimeMinutes: 600,
    });
    expect(pack.sourceExceptions).toContain('1 PM due assets are missing fresh meter readings');
    expect(pack.sourceExceptions).toContain('At least one downtime category is missing a freshness timestamp');
  });
});
