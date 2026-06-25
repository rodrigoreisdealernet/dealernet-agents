import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import technicianMorningQueuePage from './technician-morning-queue.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('technician morning queue page definitions', () => {
  it('queries ops_findings_view filtered to technician-morning-queue agent', () => {
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
      technicianMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: '%',
          statusFilter: 'pending_approval',
        },
      })
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'technician-morning-queue');
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
      technicianMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: 'critical',
          itemTypeFilter: '%',
          statusFilter: '%',
        },
      })
    );

    expect(query.ilike).toHaveBeenCalledWith('severity', 'critical');
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
      technicianMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: 'returned_unit',
          statusFilter: '%',
        },
      })
    );

    expect(query.ilike).toHaveBeenCalledWith('finding_type', 'returned_unit');
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
      technicianMorningQueuePage.dataSources.queueItems as SupabaseDataSource,
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
      technicianMorningQueuePage.dataSources.assets as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('entities');
    expect(query.eq).toHaveBeenCalledWith('entity_type', 'asset');
  });

  it('queries latest workflow run to detect no-op state', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { run_id: 'run-1', workflow_key: 'technician-morning-queue', status: 'no_op' },
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
      technicianMorningQueuePage.dataSources.latestRun as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_workflow_run');
    expect(query.eq).toHaveBeenCalledWith('workflow_key', 'technician-morning-queue');
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
      technicianMorningQueuePage.dataSources.latestRun as SupabaseDataSource,
      createExpressionContext()
    );

    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ run_id: 'run-1', status: 'succeeded' });
  });

  it('page layout contains no-op banner for technician notification', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('no_op');
    expect(serialized).toContain('No new technician signals');
  });

  it('page layout renders evidence list per queue item', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('Evidence');
    expect(serialized).toContain('item.evidence');
  });

  it('page layout renders stale-data callout per queue item', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('Stale data');
    expect(serialized).toContain('is_stale_data');
    expect(serialized).toContain('stale_signals');
  });

  it('page layout renders explicit priority reasons per row', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('priority_reasons');
    expect(serialized).toContain('Priority reasons');
  });

  it('page layout renders contract risk badge', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('contract_risk');
    expect(serialized).toContain('Contract risk');
  });

  it('page layout renders parts blocked badge', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('parts_blocker');
    expect(serialized).toContain('Parts blocked');
  });

  it('page layout renders return-condition evidence callout', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('has_return_condition_evidence');
    expect(serialized).toContain('Return condition evidence available');
  });

  it('view override link forwards technician queue source and filter context', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('"source":"technician-morning-queue"');
    expect(serialized).toContain('"returnPriority":"{{state.priorityFilter || \'%\'}}"');
    expect(serialized).toContain('"returnStatus":"{{state.statusFilter || \'%\'}}"');
  });

  it('page layout renders rent-ready ETA with approval callout', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('rent_ready_eta');
    expect(serialized).toContain('requires technician/foreman approval');
  });

  it('page layout links to asset entity and finding detail for drill-down and override', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('/entities/asset/{{item.contract_id}}');
    expect(serialized).toContain('/ops/findings/{{item.id}}');
  });

  it('work type filter includes all four technician item types', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('returned_unit');
    expect(serialized).toContain('pm_work');
    expect(serialized).toContain('active_repair');
    expect(serialized).toContain('rent_ready_check');
  });

  it('page state defaults statusFilter to pending_approval', () => {
    expect(technicianMorningQueuePage.state.statusFilter).toBe('pending_approval');
  });

  it('queue items are ordered by created_at descending', () => {
    const order = technicianMorningQueuePage.dataSources.queueItems.order;
    expect(order).toEqual([{ column: 'created_at', ascending: false }]);
  });

  it('queue items data source refetches every 30 seconds', () => {
    expect(technicianMorningQueuePage.dataSources.queueItems.refetchInterval).toBe(30000);
  });

  it('card badge uses formatFindingType so raw workflow tokens do not appear as display text', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('formatFindingType(item.finding_type)');
    expect(serialized).not.toContain('"children": "{{item.finding_type}}"');
  });

  it('card badge uses formatFindingStatus so raw status tokens do not appear as display text', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).toContain('formatFindingStatus(item.status)');
    expect(serialized).not.toContain('"children": "{{item.status}}"');
  });

  it('primary card title does not fall back to raw item.contract_id', () => {
    const serialized = JSON.stringify(technicianMorningQueuePage.layout);
    expect(serialized).not.toContain('item.contract_id ||');
  });
});
