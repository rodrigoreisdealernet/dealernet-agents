import { describe, expect, it } from 'vitest';
import {
  OPERATING_MODEL_TAGS,
  buildBookingConflictAssistant,
  buildOpenContractConflictQueue,
} from './bookingConflictAssistant';

describe('buildBookingConflictAssistant', () => {
  it('renders source-backed booking conflicts with alternatives and maintenance evidence', () => {
    const result = buildBookingConflictAssistant({
      orderId: 'order-1',
      quoteAvailability: [
        {
          line_entity_id: 'line-1',
          order_id: 'order-1',
          branch_id: 'branch-1',
          asset_category_id: 'cat-forklift',
          requested_quantity: 3,
          planned_start: '2026-08-01',
          planned_end: '2026-08-31',
          available_quantity: 1,
          is_available: false,
          shortage_quantity: 2,
          alternatives: [
            {
              branch_name: 'North Yard',
              asset_category_name: 'Forklifts',
              available_quantity: 4,
            },
          ],
        },
      ],
      availability: [
        {
          branch_id: 'branch-1',
          branch_name: 'South Depot',
          asset_category_id: 'cat-forklift',
          asset_category_name: 'Forklifts',
          available_assets: 1,
          unavailable_assets: 5,
          maintenance_due_assets: 1,
          maintenance_overdue_assets: 0,
        },
      ],
    });

    expect(result.noOp).toBe(false);
    expect(result.tags).toEqual(OPERATING_MODEL_TAGS);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      workflow: 'booking',
      priority: 'blocking',
      status: 'conflict',
      orderId: 'order-1',
      lineId: 'line-1',
      requiresHumanApproval: true,
    });
    expect(result.items[0].evidence.map((item) => item.label)).toEqual([
      'Availability check',
      'Maintenance readiness',
      'Suggested follow-up',
    ]);
  });
});

describe('buildOpenContractConflictQueue', () => {
  it('ranks overdue extension conflicts ahead of delivery-window follow-ups', () => {
    const result = buildOpenContractConflictQueue({
      today: '2026-07-10',
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
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'pending_execution',
          category_id: 'cat-forklift',
          asset_id: null,
          data: { planned_start: '2026-07-11' },
        },
        {
          entity_id: 'line-2',
          contract_id: 'contract-2',
          status: 'checked_out',
          category_id: 'cat-forklift',
          asset_id: 'asset-44',
          actual_end: null,
          data: { planned_end: '2026-07-08' },
        },
      ],
      availability: [
        {
          branch_id: 'branch-1',
          branch_name: 'South Depot',
          asset_category_id: 'cat-forklift',
          asset_category_name: 'Forklifts',
          available_assets: 0,
          unavailable_assets: 5,
          maintenance_due_assets: 0,
          maintenance_overdue_assets: 0,
        },
      ],
    });

    expect(result.noOp).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      workflow: 'extension',
      priority: 'blocking',
      contractId: 'contract-2',
    });
    expect(result.items[1]).toMatchObject({
      workflow: 'delivery_window',
      priority: 'review',
      contractId: 'contract-1',
    });
  });

  it('escalates uncertainty when no matching availability signal exists for an imminent extension decision', () => {
    const result = buildOpenContractConflictQueue({
      today: '2026-07-10',
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
        },
      ],
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'checked_out',
          category_id: 'cat-forklift',
          asset_id: 'asset-44',
          actual_end: null,
          data: { planned_end: '2026-07-11' },
        },
      ],
      availability: [],
    });

    expect(result.items[0]).toMatchObject({
      workflow: 'extension',
      status: 'uncertain',
    });
    expect(result.items[0].recommendation).toContain('manual branch coordination');
    expect(result.items[0].evidence.some((item) => item.source === 'uncertainty')).toBe(true);
  });

  it('returns an explicit no-op state when no materially new queue conflict exists', () => {
    const result = buildOpenContractConflictQueue({
      today: '2026-07-10',
      contracts: [
        {
          id: 'contract-1',
          entity_versions: [{ data: { contract_number: 'RC-001', branch_id: 'branch-1', order_id: 'order-1' } }],
        },
      ],
      lines: [
        {
          entity_id: 'line-1',
          contract_id: 'contract-1',
          status: 'checked_out',
          category_id: 'cat-forklift',
          asset_id: 'asset-44',
          actual_end: null,
          data: { planned_end: '2026-07-20' },
        },
      ],
      availability: [],
    });

    expect(result.noOp).toBe(true);
    expect(result.items[0].title).toBe('No materially new branch conflict');
  });
});
