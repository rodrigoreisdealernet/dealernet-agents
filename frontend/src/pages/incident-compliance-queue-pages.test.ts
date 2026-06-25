import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext, evaluateExpression } from '@/engine/ExpressionEvaluator';
import incidentComplianceQueuePage from './ops-incident-compliance-queue.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('incident compliance queue page definitions', () => {
  it('filters findings to the incident-compliance-queue agent and obligation/status state', () => {
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
      incidentComplianceQueuePage.dataSources.findings as SupabaseDataSource,
      createExpressionContext({
        state: {
          obligationFilter: 'post_accident_testing',
          statusFilter: 'pending_approval',
        },
      })
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'incident-compliance-queue');
    expect(query.ilike).toHaveBeenCalledWith('finding_type', 'post_accident_testing');
    expect(query.ilike).toHaveBeenCalledWith('status', 'pending_approval');
  });

  it('orders queue items newest-first and refetches every 15 seconds', () => {
    expect(incidentComplianceQueuePage.dataSources.findings.order).toEqual([
      { column: 'created_at', ascending: false },
    ]);
    expect(incidentComplianceQueuePage.dataSources.findings.refetchInterval).toBe(15000);
  });

  it('renders required branch, employee, equipment, due time, rule, evidence, and human-approval content', () => {
    const serialized = JSON.stringify(incidentComplianceQueuePage.layout);

    expect(serialized).toContain('Branch:');
    expect(serialized).toContain('Employee:');
    expect(serialized).toContain('Equipment:');
    expect(serialized).toContain('Due time:');
    expect(serialized).toContain('Cited rule:');
    expect(serialized).toContain('Linked evidence');
    expect(serialized).toContain('Human disposition required');
  });

  it('fails closed when no rows are returned and calls out blockers explicitly', () => {
    const serialized = JSON.stringify(incidentComplianceQueuePage.layout);

    expect(serialized).toContain('Fail closed');
    expect(serialized).toContain('Compliance blocker');
    expect(serialized).toContain('Missing deadline — blocked');
    expect(serialized).toContain('Missing rule citation — blocked');
  });

  it('open case link preserves queue source and return filters', () => {
    const serialized = JSON.stringify(incidentComplianceQueuePage.layout);

    expect(serialized).toContain('"source":"incident-compliance-queue"');
    expect(serialized).toContain('"returnObligation":"{{state.obligationFilter || \'%\'}}"');
    expect(serialized).toContain('"returnStatus":"{{state.statusFilter || \'pending_approval\'}}"');
  });

  it('maps incident workflow helpers to a dedicated label and route', async () => {
    expect(
      evaluateExpression("{{formatOpsAgentLabel('incident-compliance-queue')}}", createExpressionContext())
    ).toBe('Incident Compliance Queue');

    expect(
      evaluateExpression("{{getOpsWorkflowRoute('incident-compliance-queue')}}", createExpressionContext())
    ).toBe('/ops/incident-compliance-queue?status=pending_approval');

    const singleMock = vi.fn().mockResolvedValue({
      data: {
        id: 'finding-1',
        agent_key: 'incident-compliance-queue',
      },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    await executeSupabaseQuery(
      client as never,
      {
        type: 'supabase',
        table: 'ops_findings_view',
        select: 'id, agent_key',
        filters: [{ field: 'id', op: 'eq', value: 'finding-1' }],
        single: true,
      } as SupabaseDataSource,
      createExpressionContext()
    );

    expect(singleMock).toHaveBeenCalled();
  });
});
