import { describe, expect, it } from 'vitest';
import {
  DISPATCH_LOOKOUT_TAGS,
  buildDispatchConflictLookout,
} from './dispatchConflictLookout';

describe('buildDispatchConflictLookout', () => {
  it('ranks overdue route slippage ahead of lower-priority dispatch conflicts', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      routes: [
        {
          line_id: 'line-checked-out',
          contract_id: 'contract-1',
          asset_name: 'Excavator 320',
          route_status: 'in_transit',
          exception_state: 'overdue',
          branch_id: 'branch-1',
          assigned_driver: 'Driver Smith',
          telemetry_position_status: 'fresh',
          telemetry_sync_status: 'applied',
          eld_compliance_status: 'compliant',
          driver_log_status: 'current',
        },
      ],
      lines: [
        {
          entity_id: 'line-checked-out',
          contract_id: 'contract-1',
          status: 'checked_out',
          category_id: 'cat-1',
          actual_end: null,
          data: { planned_end: '2026-07-09' },
        },
        {
          entity_id: 'line-pending-1',
          contract_id: 'contract-2',
          status: 'pending_execution',
          category_id: 'cat-1',
          data: { planned_start: '2026-07-11' },
        },
      ],
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
        },
        {
          id: 'contract-2',
          entity_versions: [{ data: { contract_number: 'RC-002', branch_id: 'branch-1', order_id: 'order-2' } }],
        },
      ],
      availability: [
        {
          branch_id: 'branch-1',
          branch_name: 'South Depot',
          asset_category_id: 'cat-1',
          asset_category_name: 'Excavators',
          available_assets: 0,
          unavailable_assets: 5,
          maintenance_due_assets: 1,
          maintenance_overdue_assets: 0,
          soft_down_assets: 0,
          hard_down_assets: 1,
        },
      ],
    });

    expect(result.noOp).toBe(false);
    expect(result.tags).toEqual(DISPATCH_LOOKOUT_TAGS);
    expect(result.items[0]).toMatchObject({
      workflow: 'dispatch',
      priority: 'blocking',
      status: 'conflict',
      contractId: 'contract-1',
      lineId: 'line-checked-out',
    });
    expect(result.items[0].evidence.map((item) => item.label)).toContain('Coordination path');
    const primary = result.items[0];
    expect(primary.evidence.some((item) => item.source === 'route')).toBe(true);
    expect(primary.evidence.some((item) => item.source === 'return')).toBe(true);
  });

  it('escalates uncertainty when telemetry and capacity signals cannot confirm a real conflict', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      routes: [
        {
          line_id: 'line-1',
          contract_id: 'contract-1',
          route_status: 'in_transit',
          branch_id: 'branch-1',
          assigned_driver: 'Driver Smith',
          telemetry_position_status: 'stale',
          telemetry_sync_status: 'retryable_failure',
        },
      ],
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'checked_out',
          category_id: 'cat-1',
          actual_end: null,
          data: { planned_end: '2026-07-11' },
        },
        {
          entity_id: 'line-2',
          contract_id: 'contract-2',
          status: 'pending_execution',
          category_id: 'cat-1',
          data: { planned_start: '2026-07-11' },
        },
      ],
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
        },
        {
          id: 'contract-2',
          entity_versions: [{ data: { contract_number: 'RC-002', branch_id: 'branch-1', order_id: 'order-2' } }],
        },
      ],
      availability: [],
    });

    expect(result.items.some((item) => item.status === 'uncertain')).toBe(true);
    const uncertainItem = result.items.find((item) => item.status === 'uncertain');
    expect(uncertainItem?.recommendation).toContain('manual dispatcher review');
    expect(uncertainItem?.evidence.some((item) => item.source === 'uncertainty')).toBe(true);
  });

  it('returns a capacity no-op when upcoming demand fits current availability', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'pending_execution',
          category_id: 'cat-1',
          data: { planned_start: '2026-07-11' },
        },
      ],
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
        },
      ],
      availability: [
        {
          branch_id: 'branch-1',
          asset_category_id: 'cat-1',
          available_assets: 2,
          unavailable_assets: 0,
          maintenance_due_assets: 0,
          maintenance_overdue_assets: 0,
          soft_down_assets: 0,
          hard_down_assets: 0,
        },
      ],
    });

    expect(result.noOp).toBe(true);
    expect(result.items[0].title).toBe('No materially new dispatch conflict');
  });

  it('includes market dispatcher operating model tags and contract blocker evidence', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'pending_execution',
          category_id: 'cat-1',
          data: { planned_start: '2026-07-11', blocker_reason: 'counter paperwork incomplete' },
        },
      ],
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', status: 'hold' } }],
        },
      ],
      availability: [],
    });

    expect(result.tags).toContain('market-logistics-dispatcher:t2');
    expect(result.tags).toContain('market-logistics-dispatcher:t3');
    expect(result.tags).toContain('market-logistics-dispatcher:t4');
    const blocker = result.items.find((item) => item.evidence.some((e) => e.source === 'open_contract'));
    expect(blocker).toBeDefined();
    expect(blocker?.evidence.some((e) => e.source === 'open_contract')).toBe(true);
  });

  it('threads late-return and route slippage signals into one recovery item for the same line', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      routes: [
        {
          line_id: 'line-1',
          contract_id: 'contract-1',
          asset_name: 'Excavator 320',
          route_status: 'in_transit',
          exception_state: 'overdue',
          branch_id: 'branch-1',
          assigned_driver: 'Driver Smith',
          telemetry_position_status: 'fresh',
          telemetry_sync_status: 'applied',
        },
      ],
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'checked_out',
          category_id: 'cat-1',
          actual_end: null,
          data: { planned_end: '2026-07-09' },
        },
        {
          entity_id: 'line-2',
          contract_id: 'contract-2',
          status: 'pending_execution',
          category_id: 'cat-1',
          data: { planned_start: '2026-07-11' },
        },
      ],
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
        },
        {
          id: 'contract-2',
          entity_versions: [{ data: { contract_number: 'RC-002', branch_id: 'branch-1', order_id: 'order-2' } }],
        },
      ],
      availability: [
        {
          branch_id: 'branch-1',
          asset_category_id: 'cat-1',
          available_assets: 0,
          unavailable_assets: 2,
          maintenance_due_assets: 0,
          maintenance_overdue_assets: 0,
          soft_down_assets: 0,
          hard_down_assets: 0,
        },
      ],
    });

    const sameLineItems = result.items.filter((item) => item.lineId === 'line-1');
    expect(sameLineItems).toHaveLength(1);
    expect(sameLineItems[0].summary).toContain('Combined market dispatch recovery thread');
  });

  it('surfaces a driver-callout exception with a blocking review item and requires human approval', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      routes: [
        {
          line_id: 'line-1',
          contract_id: 'contract-1',
          asset_name: 'Forklift 50',
          route_status: 'pending_departure',
          exception_state: 'missing_driver',
          branch_id: 'branch-2',
          assigned_driver: null,
          telemetry_position_status: 'fresh',
          telemetry_sync_status: 'applied',
          eld_compliance_status: 'compliant',
          driver_log_status: 'current',
        },
      ],
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'checked_out',
          category_id: 'cat-2',
          actual_end: null,
          data: { planned_end: '2026-07-11' },
        },
      ],
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-010', branch_id: 'branch-2', order_id: 'order-10' } }],
        },
      ],
      availability: [
        {
          branch_id: 'branch-2',
          asset_category_id: 'cat-2',
          available_assets: 1,
          unavailable_assets: 0,
          maintenance_due_assets: 0,
          maintenance_overdue_assets: 0,
          soft_down_assets: 0,
          hard_down_assets: 0,
        },
      ],
    });

    const calloutItem = result.items.find((item) => item.lineId === 'line-1');
    expect(calloutItem).toBeDefined();
    expect(calloutItem?.requiresHumanApproval).toBe(true);
    expect(calloutItem?.recommendation).toContain('driver assignment');
    expect(calloutItem?.evidence.some((e) => e.source === 'route')).toBe(true);
  });

  it('surfaces an urgent same-day capacity disruption and blocks any automated resequencing', () => {
    const result = buildDispatchConflictLookout({
      today: '2026-07-10',
      lines: [
        {
          entity_id: 'line-a',
          contract_id: 'contract-a',
          status: 'pending_execution',
          category_id: 'cat-3',
          data: { planned_start: '2026-07-11' },
        },
        {
          entity_id: 'line-b',
          contract_id: 'contract-b',
          status: 'pending_execution',
          category_id: 'cat-3',
          data: { planned_start: '2026-07-11' },
        },
        {
          entity_id: 'line-c',
          contract_id: 'contract-c',
          status: 'pending_execution',
          category_id: 'cat-3',
          data: { planned_start: '2026-07-12' },
        },
      ],
      contracts: [
        {
          id: 'contract-a',
          entity_versions: [{ data: { contract_number: 'RC-021', branch_id: 'branch-3', order_id: 'order-21' } }],
        },
        {
          id: 'contract-b',
          entity_versions: [{ data: { contract_number: 'RC-022', branch_id: 'branch-3', order_id: 'order-22' } }],
        },
        {
          id: 'contract-c',
          entity_versions: [{ data: { contract_number: 'RC-023', branch_id: 'branch-3', order_id: 'order-23' } }],
        },
      ],
      availability: [
        {
          branch_id: 'branch-3',
          asset_category_id: 'cat-3',
          available_assets: 0,
          unavailable_assets: 3,
          maintenance_due_assets: 1,
          maintenance_overdue_assets: 0,
          soft_down_assets: 0,
          hard_down_assets: 1,
        },
      ],
    });

    expect(result.noOp).toBe(false);
    const capacityItem = result.items.find((item) =>
      item.evidence.some((e) => e.source === 'capacity' || e.source === 'availability'),
    );
    expect(capacityItem).toBeDefined();
    expect(capacityItem?.requiresHumanApproval).toBe(true);
    expect(capacityItem?.priority).toBe('blocking');
    expect(capacityItem?.recommendation).toContain('human-approved');
  });
});
