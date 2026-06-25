import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery, executeSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext, evaluateExpression } from '@/engine/ExpressionEvaluator';
import dashboardPage from './dashboard.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('home dashboard page definitions', () => {
  it('queries home KPI snapshot from v_home_dashboard_kpis', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    buildSupabaseQuery(
      client as never,
      dashboardPage.dataSources.kpis as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_home_dashboard_kpis');
    expect(query.select).toHaveBeenCalledWith(
      'as_of, assets_on_rent, fleet_utilization_pct, overdue_returns_count, open_maintenance_count, period_revenue, prior_period_revenue, available_assets, unavailable_assets, total_assets'
    );
  });

  it('fetches dashboard KPI snapshot as a single row', async () => {
    const singleMock = vi.fn().mockResolvedValue({
      data: { assets_on_rent: 5 },
      error: null,
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: singleMock,
    };

    const client = {
      from: vi.fn().mockReturnValue(query),
    };

    const result = await executeSupabaseQuery(
      client as never,
      dashboardPage.dataSources.kpis as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_home_dashboard_kpis');
    expect(singleMock).toHaveBeenCalled();
    expect(result).toEqual({ assets_on_rent: 5 });
  });

  it('as-of pill uses formatDateTime, not the raw ISO string', () => {
    const layoutStr = JSON.stringify(dashboardPage.layout);

    // Must NOT render the raw ISO value directly
    expect(layoutStr).not.toContain('"{{data.kpis.as_of}}"');
    expect(layoutStr).not.toContain('(UTC ISO timestamp)');

    // Must use formatDateTime wrapper
    expect(layoutStr).toContain('formatDateTime(data.kpis.as_of)');

    // formatDateTime produces a human-readable short date, not a bare ISO string
    const context = createExpressionContext({
      data: { kpis: { as_of: '2026-06-06T16:02:00Z' } },
    });
    const rendered = evaluateExpression('{{formatDateTime(data.kpis.as_of)}}', context) as string;
    expect(rendered).not.toBe('2026-06-06T16:02:00Z');
    expect(rendered).toMatch(/Jun/);
  });

  it('layout uses StatCard components for all five KPI cards', () => {
    const layoutStr = JSON.stringify(dashboardPage.layout);
    const matches = layoutStr.match(/"type":"StatCard"/g);
    expect(matches?.length).toBe(5);
  });

  it('wires ops_agent_status_view and ops_finding_kpis as data sources with 15 s refetch', () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    const client = { from: vi.fn().mockReturnValue(query) };

    buildSupabaseQuery(
      client as never,
      (dashboardPage.dataSources as Record<string, ReturnType<typeof Object>>).ops_agents as never,
      createExpressionContext()
    );
    expect(client.from).toHaveBeenCalledWith('ops_agent_status_view');
    expect(query.select).toHaveBeenCalledWith(
      'agent_key, enabled, last_run_status, last_run_finished_at, pending_findings, identified_delta'
    );
    expect(
      (dashboardPage.dataSources as Record<string, { refetchInterval?: number }>).ops_agents.refetchInterval
    ).toBe(15000);

    client.from.mockClear();

    buildSupabaseQuery(
      client as never,
      (dashboardPage.dataSources as Record<string, ReturnType<typeof Object>>).ops_kpis as never,
      createExpressionContext()
    );
    expect(client.from).toHaveBeenCalledWith('ops_finding_kpis');
    expect(
      (dashboardPage.dataSources as Record<string, { refetchInterval?: number }>).ops_kpis.refetchInterval
    ).toBe(15000);
  });

  it('agentic panel agent rows deep-link to findings queue with workflow filter', () => {
    const layoutStr = JSON.stringify(dashboardPage.layout);

    // The agent row link uses the agent_key for the ?workflow= deep-link
    expect(layoutStr).toContain('/ops/findings?workflow={{agent.agent_key}}');

    // The review link uses appearance: action
    expect(layoutStr).toContain('"appearance":"action"');

    // Panel footer links back to the full ops dashboard
    expect(layoutStr).toContain('"/ops"');
  });

  it('formatOpsAgentLabel produces human-readable labels for both agentic agents', () => {
    const quoteLabel = evaluateExpression(
      "{{formatOpsAgentLabel('quote-to-order-copilot')}}",
      createExpressionContext()
    );
    expect(quoteLabel).toBe('Quote-to-Order Copilot');

    const damageLabel = evaluateExpression(
      "{{formatOpsAgentLabel('damage-returns-charge-assistant')}}",
      createExpressionContext()
    );
    expect(damageLabel).toBe('Damage & Returns Charges');
  });

  it('agentic panel uses formatDateTime for agent last_run_finished_at', () => {
    const layoutStr = JSON.stringify(dashboardPage.layout);
    expect(layoutStr).toContain('formatDateTime(agent.last_run_finished_at)');
  });
});

