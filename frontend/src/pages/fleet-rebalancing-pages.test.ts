import { describe, expect, it, vi } from 'vitest';
import { buildSupabaseQuery } from '@/data/queryBuilder';
import { createExpressionContext } from '@/engine/ExpressionEvaluator';
import fleetRebalancingPage from './fleet-rebalancing.json';
import type { SupabaseDataSource } from '@/engine/types';

describe('fleet-rebalancing page definitions', () => {
  it('queries v_fleet_idle_rebalancing ordered by suggested_transfer_qty descending', () => {
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
      fleetRebalancingPage.dataSources.rebalancing as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('v_fleet_idle_rebalancing');
    expect(query.select).toHaveBeenCalledWith(
      'surplus_branch_id, surplus_branch_name, asset_category_id, asset_category_name, idle_count, deficit_branch_id, deficit_branch_name, open_demand_count, demand_gap, suggested_transfer_qty'
    );
    expect(query.order).toHaveBeenCalledWith('suggested_transfer_qty', { ascending: false });
  });

  it('queries pending fleet-auditor transfer findings from ops_findings_view', () => {
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
      fleetRebalancingPage.dataSources.pending_transfers as SupabaseDataSource,
      createExpressionContext()
    );

    expect(client.from).toHaveBeenCalledWith('ops_findings_view');
    expect(query.eq).toHaveBeenCalledWith('agent_key', 'fleet-auditor');
    expect(query.eq).toHaveBeenCalledWith('status', 'pending_approval');
    expect(query.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('shows rebalancing candidates with surplus and deficit branch details', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('surplus_branch_name');
    expect(jsonStr).toContain('deficit_branch_name');
    expect(jsonStr).toContain('idle_count');
    expect(jsonStr).toContain('open_demand_count');
    expect(jsonStr).toContain('suggested_transfer_qty');
    expect(jsonStr).toContain('demand_gap');
  });

  it('explains the demand imbalance driving each recommendation', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('Demand imbalance');
    expect(jsonStr).toContain('idle');
    expect(jsonStr).toContain('unfulfilled');
  });

  it('links pending transfer findings to the finding detail for approval', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('/ops/findings/{{finding.id}}');
    expect(jsonStr).toContain('Review & approve');
  });

  it('links rebalancing opportunities to fleet-audits for transfer-finding review', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('/ops/fleet-audits');
    expect(jsonStr).toContain('Review transfer findings');
  });

  it('shows pending transfer count badge when findings are present', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('awaiting approval');
    expect(jsonStr).toContain('Pending Transfer Approvals');
  });

  it('uses formatFindingType and formatFindingStatus for pending transfers', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('formatFindingType');
    expect(jsonStr).toContain('formatFindingStatus');
  });

  it('shows an empty-state message when no rebalancing opportunities exist', () => {
    const layout = fleetRebalancingPage.layout;
    const jsonStr = JSON.stringify(layout);
    expect(jsonStr).toContain('No rebalancing opportunities detected');
  });

  it('rebalancing data source does not apply agent_key filter (view is already fleet-scoped)', () => {
    const ds = fleetRebalancingPage.dataSources.rebalancing;
    const filters = (ds as { filters?: unknown[] }).filters;
    expect(filters).toBeUndefined();
  });
});
