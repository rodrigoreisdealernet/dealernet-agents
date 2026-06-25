import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import branchMorningBriefPage from './branch-morning-brief.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('branch morning brief page definitions', () => {
  it('queries ops_findings_view filtered to branch-morning-brief agent', () => {
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
      branchMorningBriefPage.dataSources.briefItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: '%',
          statusFilter: 'pending_approval',
        },
      })
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'branch-morning-brief');
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
      branchMorningBriefPage.dataSources.briefItems as SupabaseDataSource,
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
      branchMorningBriefPage.dataSources.briefItems as SupabaseDataSource,
      createExpressionContext({
        state: {
          priorityFilter: '%',
          itemTypeFilter: 'dispatch_exception',
          statusFilter: '%',
        },
      })
    );

    expect(query.ilike).toHaveBeenCalledWith('finding_type', 'dispatch_exception');
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
      branchMorningBriefPage.dataSources.briefItems as SupabaseDataSource,
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

  it('queries latest workflow run to detect no-op state', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { run_id: 'run-1', workflow_key: 'branch-morning-brief', status: 'no_op' },
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
      branchMorningBriefPage.dataSources.latestRun as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_workflow_run');
    expect(query.eq).toHaveBeenCalledWith('workflow_key', 'branch-morning-brief');
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
      branchMorningBriefPage.dataSources.latestRun as SupabaseDataSource,
      createExpressionContext()
    );

    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ run_id: 'run-1', status: 'succeeded' });
  });

  it('page layout contains no-op banner for manager notification', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('no_op');
    expect(serialized).toContain('No new branch signals');
  });

  it('page layout renders evidence list per brief item', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('Evidence');
    expect(serialized).toContain('briefItem.evidence');
  });

  it('page layout renders stale-data callout per brief item', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('Stale data');
    expect(serialized).toContain('is_stale_data');
    expect(serialized).toContain('stale_signals');
  });

  it('page layout renders owner/team with human-approval callout context', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('owner_team');
    expect(serialized).toContain('Owner:');
  });

  it('page layout links to finding detail for drill-down', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('/ops/findings/{{briefItem.id}}');
  });

  it('page layout renders operating-model tags per brief item', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('operating_model_tags');
  });

  it('signal type filter includes all seven operating-model item types', () => {
    const serialized = JSON.stringify(branchMorningBriefPage.layout);
    expect(serialized).toContain('contract_exception');
    expect(serialized).toContain('ap_hold');
    expect(serialized).toContain('utilization_outlier');
    expect(serialized).toContain('dispatch_exception');
    expect(serialized).toContain('maintenance_blocker');
    expect(serialized).toContain('unavailable_unit');
    expect(serialized).toContain('customer_followup');
  });

  it('page state defaults statusFilter to pending_approval', () => {
    expect(branchMorningBriefPage.state.statusFilter).toBe('pending_approval');
  });

  it('brief items are ordered by created_at descending', () => {
    const order = branchMorningBriefPage.dataSources.briefItems.order;
    expect(order).toEqual([{ column: 'created_at', ascending: false }]);
  });

  it('brief items data source refetches every 30 seconds', () => {
    expect(branchMorningBriefPage.dataSources.briefItems.refetchInterval).toBe(30000);
  });
});
