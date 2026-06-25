import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import shopMorningQueuePage from './shop-morning-queue.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('shop morning queue page definitions', () => {
  it('queries ops_findings_view filtered to shop-morning-queue agent', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: '%',
          statusFilter: 'pending_approval',
        },
      })
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'shop-morning-queue');
  });

  it('applies priority filter as ilike on severity column', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: 'high',
          itemTypeFilter: '%',
          statusFilter: '%',
        },
      })
    );

    expect(query.ilike).toHaveBeenCalledWith('severity', 'high');
  });

  it('applies item type filter as ilike on finding_type column', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: 'pm_due',
          statusFilter: '%',
        },
      })
    );

    expect(query.ilike).toHaveBeenCalledWith('finding_type', 'pm_due');
  });

  it('applies status filter as ilike on status column', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: '%',
          statusFilter: 'pending_approval',
        },
      })
    );

    expect(query.ilike).toHaveBeenCalledWith('status', 'pending_approval');
  });

  it('queries assets for human-readable asset names', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.assets as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenCalledWith('entity_type', 'asset');
  });

  it('queries latest workflow run to detect no-op state', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { run_id: 'run-1', workflow_key: 'shop-morning-queue', status: 'no_op' },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    await executeSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.latestRun as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_workflow_run');
    expect(query.eq).toHaveBeenCalledWith('workflow_key', 'shop-morning-queue');
    expect(query.order).toHaveBeenCalledWith('started_at', { ascending: false });
  });

  it('latestRun data source uses single:true', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { run_id: 'run-1', status: 'succeeded' },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    const result = await executeSupabaseQuery(
      client as never,
      shopMorningQueuePage.dataSources.latestRun as SupabaseDataSource,
      createExpressionContext()
    );

    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ run_id: 'run-1', status: 'succeeded' });
  });

  it('page layout contains no-op banner for manager notification', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('no_op');
    expect(serialized).toContain('No new shop signals');
  });

  it('page layout renders evidence list per queue item', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('Evidence');
    expect(serialized).toContain('item.evidence');
  });

  it('page layout renders stale-data callout per queue item', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('Stale data');
    expect(serialized).toContain('is_stale_data');
    expect(serialized).toContain('stale_signals');
  });

  it('page layout renders return-to-fleet ETA with human-approval callout', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('return_to_fleet_eta');
    expect(serialized).toContain('requires manager approval');
  });

  it('page layout links to asset entity and finding detail for drill-down', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('/entities/asset/{{item.contract_id}}');
    expect(serialized).toContain('/ops/findings/{{item.id}}');
  });

  it('queue type filter includes all four operating-model item types', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('pm_due');
    expect(serialized).toContain('work_order_priority');
    expect(serialized).toContain('not_available_unit');
    expect(serialized).toContain('parts_blocker');
  });

  it('page state defaults statusFilter to pending_approval', () => {
    expect(shopMorningQueuePage.state.statusFilter).toBe('pending_approval');
  });

  it('queue items are ordered by created_at descending', () => {
    const order = shopMorningQueuePage.dataSources.queueItems.order;
    expect(order).toEqual([{ column: 'created_at', ascending: false }]);
  });

  it('queue items data source refetches every 30 seconds', () => {
    expect(shopMorningQueuePage.dataSources.queueItems.refetchInterval).toBe(30000);
  });

  it('card badge uses formatFindingType so raw workflow tokens do not appear as display text', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('formatFindingType(item.finding_type)');
    expect(serialized).not.toContain('"children": "{{item.finding_type}}"');
  });

  it('card badge uses formatFindingStatus so raw status tokens do not appear as display text', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).toContain('formatFindingStatus(item.status)');
    expect(serialized).not.toContain('"children": "{{item.status}}"');
  });

  it('primary card title does not fall back to raw item.contract_id', () => {
    const serialized = JSON.stringify(shopMorningQueuePage.layout);
    expect(serialized).not.toContain('item.contract_id ||');
  });
});
