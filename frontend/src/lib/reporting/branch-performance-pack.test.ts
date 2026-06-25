import { describe, expect, it } from 'vitest';
import {
  BRANCH_PERFORMANCE_PACK_TAG,
  buildBranchPerformanceMetrics,
  buildCorrectiveActions,
  buildMonthlyBranchPack,
  buildPackExceptions,
} from './branch-performance-pack';

describe('branch performance pack helpers', () => {
  it('builds performance metrics with stale-source warnings', () => {
    const metrics = buildBranchPerformanceMetrics([
      {
        branch_id: 'branch-1',
        branch_name: 'North Yard',
        on_rent_count: 12,
        utilization_rate_pct: 68.5,
        last_updated: '2026-06-01T08:00:00Z',
      },
      {
        branch_id: 'branch-2',
        branch_name: 'South Depot',
        on_rent_count: 8,
        utilization_rate_pct: 42.0,
        last_updated: null,
      },
      {
        branch_id: null,
        branch_name: 'Unknown',
        on_rent_count: 0,
        utilization_rate_pct: null,
        last_updated: null,
      },
    ]);

    expect(metrics).toHaveLength(3);
    expect(metrics[0]).toMatchObject({
      branchId: 'branch-1',
      branchName: 'North Yard',
      onRentCount: 12,
      utilizationRatePct: 68.5,
      lastUpdated: '2026-06-01T08:00:00Z',
      sourceException: null,
    });
    expect(metrics[1].sourceException).toContain('freshness timestamp missing');
    expect(metrics[2].sourceException).toContain('branch source record missing');
  });

  it('returns empty performance metrics when source has no rows', () => {
    expect(buildBranchPerformanceMetrics([])).toEqual([]);
    expect(buildBranchPerformanceMetrics(null)).toEqual([]);
    expect(buildBranchPerformanceMetrics(undefined)).toEqual([]);
  });

  it('builds exception items from failed inspections with missing-source flags', () => {
    const exceptions = buildPackExceptions(
      [
        {
          asset_id: 'asset-3',
          service_record_id: 'insp-3',
          service_name: 'Return inspection',
          service_type: 'inspection',
          outcome: 'fail',
          completed_at: '2026-06-10T14:00:00Z',
        },
        {
          asset_id: null,
          service_record_id: null,
          outcome: 'fail',
          opened_at: '2026-06-09T09:00:00Z',
        },
      ],
      [],
      [],
    );

    expect(exceptions.length).toBeGreaterThanOrEqual(2);
    const withLink = exceptions.find((e) => e.id === 'insp-3');
    expect(withLink).toBeDefined();
    expect(withLink!.category).toBe('inspection');
    expect(withLink!.severity).toBe('critical');
    expect(withLink!.sourceRef).toBe('/entities/inspection/insp-3');
    expect(withLink!.missingSourceReason).toBeNull();

    const noLink = exceptions.find((e) => e.assetId === null && e.category === 'inspection');
    expect(noLink!.missingSourceReason).toContain('both missing');
  });

  it('builds exception items from overdue and pre-due PMs', () => {
    const exceptions = buildPackExceptions(
      [],
      [
        {
          asset_id: 'asset-5',
          policy_id: 'policy-5',
          trigger_type: 'time_interval',
          label: 'Annual service',
          is_due: true,
          is_pre_due: false,
          last_maintenance_at: '2025-06-01T00:00:00Z',
        },
        {
          asset_id: 'asset-6',
          policy_id: 'policy-6',
          trigger_type: 'meter',
          label: 'Oil change',
          is_due: false,
          is_pre_due: true,
          latest_meter_value: null,
          last_maintenance_at: '2026-01-15T00:00:00Z',
        },
        {
          asset_id: 'asset-7',
          policy_id: 'policy-7',
          trigger_type: 'time_interval',
          label: 'Quarterly check',
          is_due: false,
          is_pre_due: false,
        },
      ],
      [],
    );

    // asset-7 (neither due nor pre-due) should not be included
    const overdue = exceptions.find((e) => e.id === 'pm-asset-5-policy-5');
    expect(overdue).toBeDefined();
    expect(overdue!.severity).toBe('critical');
    expect(overdue!.detail).toContain('overdue');

    const preDue = exceptions.find((e) => e.id === 'pm-asset-6-policy-6');
    expect(preDue).toBeDefined();
    expect(preDue!.severity).toBe('warning');
    expect(preDue!.missingSourceReason).toContain('meter reading missing');

    expect(exceptions.find((e) => e.id === 'pm-asset-7-policy-7')).toBeUndefined();
  });

  it('builds high-downtime exceptions from asset analytics', () => {
    const exceptions = buildPackExceptions(
      [],
      [],
      [
        {
          asset_id: 'asset-A',
          asset_name: 'Boom Lift A',
          total_downtime_minutes: 1440,
          utilization_pct: 35,
          roi_status: 'warning',
        },
        {
          asset_id: null,
          asset_name: null,
          total_downtime_minutes: 720,
          utilization_pct: null,
          roi_status: null,
        },
      ],
    );

    const highDowntime = exceptions.filter((e) => e.category === 'high_downtime');
    expect(highDowntime.length).toBeGreaterThanOrEqual(1);

    const boomLift = highDowntime.find((e) => e.assetId === 'asset-A');
    expect(boomLift!.missingSourceReason).toBeNull();

    const noId = highDowntime.find((e) => e.assetId === null);
    expect(noId!.missingSourceReason).toContain('asset source record missing');
  });

  it('does not add high-downtime exceptions for assets with zero downtime', () => {
    const exceptions = buildPackExceptions(
      [],
      [],
      [{ asset_id: 'asset-Z', total_downtime_minutes: 0 }],
    );
    expect(exceptions.filter((e) => e.category === 'high_downtime')).toHaveLength(0);
  });

  it('builds corrective action items with missing-source flags', () => {
    const actions = buildCorrectiveActions([
      {
        maintenance_record_id: 'wo-10',
        name: 'Hydraulic system rebuild',
        work_order_status: 'awaiting_approval',
        asset_id: 'asset-1',
        sell_total: 3200,
        last_updated_at: '2026-06-12T10:00:00Z',
      },
      {
        maintenance_record_id: 'wo-11',
        name: 'Tyre replacement',
        work_order_status: null,
        asset_id: 'asset-2',
        sell_total: 800,
        last_updated_at: null,
        created_at: '2026-06-08T00:00:00Z',
      },
      {
        maintenance_record_id: null,
        name: 'Unknown work',
        work_order_status: 'open',
        asset_id: null,
        sell_total: null,
        last_updated_at: null,
      },
    ]);

    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({
      workOrderId: 'wo-10',
      name: 'Hydraulic system rebuild',
      status: 'awaiting_approval',
      estimatedCost: 3200,
      missingSourceReason: null,
    });
    expect(actions[1].missingSourceReason).toContain('work order status missing');
    expect(actions[1].lastUpdated).toBe('2026-06-08T00:00:00Z');
    expect(actions[2].missingSourceReason).toContain('work order source record missing');
  });

  it('excludes completed, closed, and cancelled work orders from corrective actions', () => {
    const actions = buildCorrectiveActions([
      {
        maintenance_record_id: 'wo-open',
        name: 'Active hydraulic repair',
        work_order_status: 'open',
        asset_id: 'asset-1',
        sell_total: 2500,
        last_updated_at: '2026-06-12T10:00:00Z',
      },
      {
        maintenance_record_id: 'wo-inprogress',
        name: 'In-progress tyre replacement',
        work_order_status: 'in_progress',
        asset_id: 'asset-2',
        sell_total: 800,
        last_updated_at: '2026-06-11T08:00:00Z',
      },
      {
        maintenance_record_id: 'wo-awaiting',
        name: 'Awaiting approval service',
        work_order_status: 'awaiting_approval',
        asset_id: 'asset-3',
        sell_total: 1200,
        last_updated_at: '2026-06-10T10:00:00Z',
      },
      {
        maintenance_record_id: 'wo-completed',
        name: 'Completed engine overhaul',
        work_order_status: 'completed',
        asset_id: 'asset-4',
        sell_total: 4000,
        last_updated_at: '2026-05-20T10:00:00Z',
      },
      {
        maintenance_record_id: 'wo-closed',
        name: 'Closed brake inspection',
        work_order_status: 'closed',
        asset_id: 'asset-5',
        sell_total: 300,
        last_updated_at: '2026-05-15T10:00:00Z',
      },
      {
        maintenance_record_id: 'wo-cancelled',
        name: 'Cancelled paint touch-up',
        work_order_status: 'cancelled',
        asset_id: 'asset-6',
        sell_total: 150,
        last_updated_at: '2026-05-10T10:00:00Z',
      },
    ]);

    // Only open/actionable statuses should be included
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.workOrderId)).toEqual(['wo-open', 'wo-inprogress', 'wo-awaiting']);

    // Terminal-status records are excluded
    expect(actions.find((a) => a.workOrderId === 'wo-completed')).toBeUndefined();
    expect(actions.find((a) => a.workOrderId === 'wo-closed')).toBeUndefined();
    expect(actions.find((a) => a.workOrderId === 'wo-cancelled')).toBeUndefined();
  });

  it('assembles a full monthly branch pack and surfaces pack-level source exceptions', () => {
    const pack = buildMonthlyBranchPack(
      [
        {
          branch_id: 'branch-1',
          branch_name: 'North Yard',
          on_rent_count: 10,
          utilization_rate_pct: 55,
          last_updated: null,
        },
      ],
      [
        {
          asset_id: 'asset-A',
          asset_name: 'Scissor Lift A',
          total_downtime_minutes: 600,
          utilization_pct: 30,
          roi_status: 'ok',
        },
      ],
      [
        {
          maintenance_record_id: 'wo-1',
          name: 'Annual service',
          work_order_status: 'open',
          asset_id: 'asset-A',
          sell_total: 1200,
          last_updated_at: '2026-06-10T00:00:00Z',
        },
      ],
      [
        {
          asset_id: 'asset-B',
          service_record_id: 'insp-1',
          service_name: 'Pre-rental check',
          outcome: 'fail',
          completed_at: '2026-06-09T12:00:00Z',
        },
      ],
      [
        {
          asset_id: 'asset-C',
          policy_id: 'policy-1',
          trigger_type: 'time_interval',
          label: 'Monthly check',
          is_due: true,
          is_pre_due: false,
          last_maintenance_at: '2026-05-01T00:00:00Z',
        },
      ],
    );

    expect(pack.operatingModelTag).toBe(BRANCH_PERFORMANCE_PACK_TAG);
    expect(pack.performanceMetrics).toHaveLength(1);
    expect(pack.performanceMetrics[0].branchName).toBe('North Yard');
    expect(pack.exceptions.length).toBeGreaterThanOrEqual(2);
    expect(pack.correctiveActions).toHaveLength(1);
    expect(pack.packGeneratedAt).toBeTruthy();
    // Stale timestamp exception should be surfaced
    expect(pack.packSourceExceptions).toContain(
      'One or more branches are missing a utilization freshness timestamp',
    );
  });

  it('surfaces pack-level source exceptions when entire sources are empty', () => {
    const pack = buildMonthlyBranchPack([], [], [], [], []);

    expect(pack.performanceMetrics).toHaveLength(0);
    expect(pack.exceptions).toHaveLength(0);
    expect(pack.correctiveActions).toHaveLength(0);
    expect(pack.packSourceExceptions).toContain(
      'Branch utilization source returned no rows — performance section is empty',
    );
    expect(pack.packSourceExceptions).toContain(
      'Maintenance work-order source returned no rows — corrective-action section is empty',
    );
    expect(pack.packSourceExceptions).toContain(
      'Both inspection and PM sources returned no rows — verify exception sources are current',
    );
  });
});
